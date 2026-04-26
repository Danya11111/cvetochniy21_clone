# Рассылка (broadcast): диагностика и «0 доставок»

## Поток

Сообщение в **теме рассылки** (`TELEGRAM_BROADCAST_TOPIC_*`) от пользователя с правами → `broadcast-service` создаёт кампанию → очередь `broadcast_deliveries` → `copyMessage` к получателям (см. `backend/broadcast-service.js`).

### Устойчивый audit триггеров (SQLite)

- Таблица **`broadcast_trigger_audit`**: каждая значимая попытка запуска из **темы рассылки** (`startCampaignFromTopicMessage`) пишет строку с **`result_code`** (например `OK_JOB_SCHEDULED`, `TRANSPORT_PREFLIGHT_FAILED`, `DUPLICATE_TRIGGER`, `CAMPAIGN_CREATE_FAILED`, `JOB_ALREADY_ACTIVE`, …), ссылками на **`source_chat_id` / `source_thread_id` / `source_message_id`**, **`topic_test_mode`**, опционально **`campaign_id`**, **`audience_estimate`**, причинами **`transport_preflight_reason`** / **`job_not_scheduled_reason`**. Текст сообщения и контент не сохраняются.
- **`actor_telegram_id`** хранится **только в БД** (для разборов через SQL); в **`/api/health/ops`** и JSON диагностики **не отдаётся** (без PII в API).
- **In-memory** `broadcastOps.lastBroadcastTriggerOutcome` — только текущий процесс; после рестарта смотрите **`lastPersistedTriggerOutcome`** / **`recentTriggerOutcomes`** или прямой SQL по `broadcast_trigger_audit`.
- Логи: **`[BroadcastTriggerAudit] recorded`** / **`[BroadcastTriggerAudit] record_failed`**.

### Устойчивый lifecycle кампании (`broadcast_campaign_events`)

- **Отдельно от trigger audit**: таблица **`broadcast_campaign_events`** — append-only события **после** появления строки в **`broadcast_campaigns`**: создание, enqueue, старт job, первая попытка/успех, волны (редко: первая и каждая 5-я), пауза/возобновление транспорта, summary, **DONE** / **DONE_INCOMPLETE**, recovery / abandon, auto-resume job, **`JOB_EXCEPTION`**. Без текста сообщений и без id получателей; в **`details_json`** — только агрегаты (например `waveIndex`, `queue_remaining`, `reason`).
- **Связка с триггером**: `broadcast_trigger_audit` отвечает на «была ли попытка старта и с каким `result_code`»; **`CAMPAIGN_CREATED`** в lifecycle — «строка кампании реально создана в этой попытке» (не дубликат).
- Health: **`broadcastOps.lastPersistedCampaignEvent`**, **`recentCampaignEvents`** (до 5), **`campaignLifecycleEventCount`**, **`broadcastCampaignEventError`**; в **`broadcastLastRun`** — **`lastPersistedLifecycleEventCode`** / **`lastPersistedLifecycleEventAt`** (последнее событие по **`campaignId`** из last-run).
- Логи: **`[BroadcastCampaignEvent] recorded`** / **`[BroadcastCampaignEvent] record_failed`**.

### Lifecycle и рестарт процесса

- При **старте Node** выполняется **`runStartupBroadcastRecovery`**: выбираются кампании со статусом **`RUNNING`** или **`PAUSED_TRANSPORT`** (последняя — после circuit breaker по транспорту), для каждой решается (см. `computeBroadcastRecoveryAction`): возобновить доставку (`resume_delivery`), догнать только итог/summary (`resume_finalize`), **прервать** «пустую» зависшую кампанию без строк в `broadcast_deliveries` старше порога (`abandon_empty` → `DONE`), или подождать (`skip`, например только что созданная кампания до enqueue).
- **Preflight транспорта** перед созданием кампании: если `shouldBlockBroadcastTrigger` (см. `telegram-transport-health`) — триггер **не** создаёт `broadcast_campaigns`, ответ с ошибкой `TRANSPORT_PREFLIGHT_FAILED`, в health — `broadcastOps.lastPreflightBlock`. Успешный **активный probe** (`getMe` по тому же пути, что и приложение) в пределах `TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS` может **снять блок** при «залипшем» пассивном `degraded` (`allowedByActiveProbe` в логике preflight).
- **Активный transport probe** (`backend/telegram-transport-probe.js`): периодический дешёвый `getMe` через `telegramClient`, обновляет passive snapshot через тот же `recordOutboundApi`, ведёт отдельное состояние probe (см. `transportProbe` в health). Интервал / backoff настраиваются env; при успехе после деградации — лог `[TelegramTransport] recovered_by_probe`.
- **Авто-resume `PAUSED_TRANSPORT`**: после успешного probe (и периодический sweep) вызывается `tryAutoResumePausedTransportCampaigns` — ставит job с `resumeFromDb: true` без повторного enqueue, с глобальным и per-campaign cooldown (см. `BROADCAST_PAUSED_*` в env). Логи `[BroadcastRecovery] paused_transport_*`.
- **Circuit breaker доставки**: после волны, если накоплен streak transport-like ошибок `copyMessage` ≥ `BROADCAST_TRANSPORT_BREAKER_COPY_STREAK`, кампания переводится в **`PAUSED_TRANSPORT`**, поля **`delivery_transport_pause_at`** / **`delivery_transport_pause_reason`**; очередь не сбрасывается. При восстановлении транспорта recovery/job снимает паузу и продолжает с БД (`resumeFromDb`), **`DELIVERED`** не пересоздаются.
- **Resume** идёт с `resumeFromDb: true`: повторно **не** вызывается массовый `INSERT` получателей — строки уже в БД, уже **`DELIVERED` не трогаются** (воркер читает только `PENDING` / готовый `RETRY_WAIT`).
- На один `campaign_id` одновременно допускается **не больше одного** job: при втором триггере/recovery — `campaign_job_already_active`, в health видно `broadcastLifecycle.activeCampaignDeliveryJobs`.
- В **`broadcast_campaigns`** хранится **`topic_test_mode`** (0/1), чтобы после рестарта восстановить тот же смысл test/production для итогов и метрик.

### Прогресс и исключения в волне

- В **`broadcast_campaigns`** (миграция): **`delivery_enqueue_completed_at`**, **`delivery_last_progress_at`**, **`delivery_first_attempt_at`**, **`delivery_first_delivered_at`**, **`delivery_wave_count`**, **`delivery_internal_exception_count`** — без PII, для воронки trigger → enqueue → волна → первая попытка → первая доставка и для heartbeat.
- Исключение при обработке **одного** получателя **не рвёт** волну и job: `safeDeliverOneRecipient` логирует `BROADCAST_DELIVERY_INTERNAL_EXCEPTION`, увеличивает счётчики, ставит получателю **`RETRY_WAIT`** с кодом **`INTERNAL_EXCEPTION`** (ретраи как у transient).
- В **`broadcastLastRun.metricsTotals`** добавлено **`broadcast_internal_exceptions`** (за job); в **`outcomeInterpretation.tags`** может быть **`INTERNAL_HANDLER_EXCEPTIONS`**.

## `ADMIN_TELEGRAM_IDS` и `TELEGRAM_ADMIN_IDS` (без путаницы)

Оба ключа **читаются кодом** (`backend/config.js`, `backend/admin-auth.js`, `broadcast-service`):

| Переменная | Роль |
|------------|------|
| `ADMIN_TELEGRAM_IDS` | CSV, **union с дефолтным whitelist** — доступ к Mini App админке (initData). |
| `TELEGRAM_ADMIN_IDS` | Отдельный CSV **без union**: в `admin-auth` объединяется с `ADMIN_TELEGRAM_IDS` для той же проверки доступа; в **`broadcast-service`** используется **только он** как allowlist, кто может **запускать** рассылку из темы. **Пустой список** → разрешён любой участник форума (`isAdmin`: пустой `trusted`). |

## Env, влияющие на поведение

| Переменная | Смысл |
|------------|--------|
| `BROADCASTS_ENABLED` | Включена ли обработка рассылок в webhook |
| `TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED` | Без `true` исходящие вызовы Bot API (в т.ч. copyMessage) не выполняются |
| `TELEGRAM_BROADCAST_TOPIC_THREAD_ID` | Должен совпадать с темой, иначе сообщения не классифицируются как рассылка (`threadsConfigured.broadcast` в health) |
| `BROADCAST_TOPIC_TEST_MODE` | Если `true`, получатели — только `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`, не вся база |
| `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` | CSV числовых id; при пустом списке в test mode рассылка **не стартует** (сообщение в тему + лог `[BroadcastFlow] SKIP_TEST_MODE_EMPTY_RECIPIENTS`) |
| `BROADCAST_*` (tuning) | Скорость, параллелизм, retry — см. `deploy/env.example` и раздел **Профили throughput** ниже |
| `BROADCAST_TRANSPORT_BREAKER_COPY_STREAK` | Порог подряд transport-like ошибок `copyMessage` до паузы кампании (`PAUSED_TRANSPORT`) |
| `TELEGRAM_TRANSPORT_PROBE_*` | Включение probe, интервал, max backoff, задержка первого probe, окно доверия для preflight |
| `BROADCAST_PAUSED_AUTO_RESUME_*`, `BROADCAST_PAUSED_TRANSPORT_SWEEP_MS` | Cooldown авто-resume и период фонового sweep |

### Профили throughput (ориентиры, не «магия»)

Ограничители по убыванию типичного влияния:

1. **`BROADCAST_GLOBAL_MESSAGES_PER_SEC`** + **`BROADCAST_DELIVERY_INTERVAL_MS`** — глобальный token bucket: суммарная частота попыток `copyMessage`.
2. **`BROADCAST_PER_CHAT_MIN_INTERVAL_MS`** — пауза между отправками в один и тот же chat id (защита от flood/лимитов на чат).
3. **`BROADCAST_WORKER_CONCURRENCY`** — сколько получателей обрабатывается параллельно внутри волны (выше — больше одновременных запросов к Bot API и нагрузка на прокси).
4. **`BROADCAST_DELIVERY_WAVE_BATCH_SIZE`** — размер волны (крупнее — реже метаданные волны, но дольше «кусок» без перерыва).
5. **`BROADCAST_RETRY_WAVE_POLL_MS`** — как часто воркер просыпается, чтобы забрать `RETRY_WAIT` между волнами (влияет на хвост очереди с ретраями).
6. **`BROADCAST_MAX_COPY_ATTEMPTS`** — сколько попыток на получателя до terminal fail.

| Профиль | Аудитория | Идея |
|---------|-----------|------|
| **small** | до ~2k | Консервативно: меньше concurrency, умеренный global rate — меньше шанс 429 и таймаутов прокси. |
| **medium** | 2k–20k | Значения близкие к дефолтам в `deploy/env.example`. |
| **large** | 20k+ | Выше **`BROADCAST_GLOBAL_MESSAGES_PER_SEC`** и/или concurrency только если стабильны прокси и нет 429; опасно резать **`BROADCAST_PER_CHAT_MIN_INTERVAL_MS`** (риск лимитов Telegram на чат). Ретраи и **`RETRY_WAVE`** увеличивают wall-clock время — это нормально. |

**Опасно без понимания нагрузки:** резко поднимать `BROADCAST_WORKER_CONCURRENCY`, `BROADCAST_GLOBAL_MESSAGES_PER_SEC` или опускать `BROADCAST_PER_CHAT_MIN_INTERVAL_MS` — 429, таймауты, срабатывание transport breaker.

**Относительно безопасно:** подстраивать `BROADCAST_RETRY_WAVE_POLL_MS` (хвост ретраев), `BROADCAST_DELIVERY_WAVE_BATCH_SIZE` (гранулярность волн), при стабильном транспорте — умеренно `BROADCAST_GLOBAL_MESSAGES_PER_SEC`.

## Health: `/api/health/ops`

Полезные поля:

- **`flags.BROADCAST_*`**, `flags.BROADCAST_TOPIC_TEST_MODE` — эффективные значения после чтения env.
- **`threadsConfigured.broadcast`** — `true`, если `TELEGRAM_BROADCAST_TOPIC_THREAD_ID > 0`.
- **`broadcastWorker`** — снимок воркера: `running`, `campaignId`, `audienceSize`, `processed`, `phase`, `queueRemaining`, `waveBatchIndex`, `metrics`, `rateLimiter`, при необходимости **`recoveryRun`**, **`resumeFromDb`**, **`lastWaveProgressAtIso`** (после последней завершённой волны).
- **`broadcastDeliveryMetrics`** — накопители последней волны: `broadcast_sent_ok`, `broadcast_blocked`, `broadcast_failed_permanent`, `broadcast_failed_temporary`, `broadcast_retry_scheduled`, `broadcast_rate_limited_429`, `retry_after_seconds`, `queue_remaining`, `slow_reason`.
- **`telegramBotApiTransportHealth`** / **`telegramTransportHealth`** (одинаковый снимок): `outboundEnabled`, `httpClientPresent`, `proxyConfigured`, `transportMode`, `lastOutboundSuccessAt`, `lastOutboundErrorAt`, `lastOutboundErrorCode`, `lastOutboundErrorMethod`, `lastOutboundSuccessMethod`, `consecutiveTransportErrors`, `totalOutboundResultsObserved`, `degraded`, `degradedReason`.
- **`transportProbe`**: `enabled`, `method`, `intervalMs`, `backoffMaxMs`, `preflightTrustMs`, `lastProbeAt`, `lastProbeOkAt`, `lastProbeErrorAt`, `lastProbeErrorCode`, `consecutiveProbeFailures`, `nextProbeDueAt`, `probeState`, `probeReason`, `lastProbeSkipReason`.
- **`broadcastOps`** — без PII: как ранее, плюс **`pausedTransportCampaignCount`**, **`lastAutoResumeAt`**, **`lastAutoResumeCampaignId`**, **`lastAutoResumeResult`**, **`nextPausedTransportSweepAt`**, тюнинг **`probePreflightTrustMs`**, **`pausedTransportAutoResumeMinIntervalMs`**, **`pausedTransportPerCampaignCooldownMs`**, **`pausedTransportSweepMs`**, **`lastBroadcastTriggerOutcome`** — последний результат **`startCampaignFromTopicMessage`** в **памяти процесса** (триггер из темы): `ok`, `error` (`FORBIDDEN`, `BROADCASTS_DISABLED`, `TRANSPORT_PREFLIGHT_FAILED`, `CAMPAIGN_CREATE_FAILED`, …), при блоке preflight — **`transportPreflightReason`**, при успехе — **`campaignId`**, **`scheduledAsync`**, **`jobNotScheduledReason`**, **`recipientsTargeted`**, **`duplicate`**, **`testModeSkipped`**. Пока job не отработал, **`broadcastLastRun`** может не отражать эту попытку — смотрите сюда и лог `[BroadcastFlow] topic trigger handled`.
- **`broadcastOps.lastPersistedTriggerOutcome`** — последняя строка из **`broadcast_trigger_audit`** (устойчиво после рестарта), те же поля, что в health-форме audit: `id`, `createdAt`, `resultCode`, `campaignId`, `topicTestMode`, `sourceThreadId`, `sourceMessageId`, причины preflight/job, `audienceEstimate`.
- **`broadcastOps.recentTriggerOutcomes`** — до **5** последних записей audit (новые сверху), урезанный набор полей, без `actor`.
- **`broadcastOps.recentTriggerOutcomeCount`** — число строк в **`broadcast_trigger_audit`** (для оценки объёма trail).
- **`broadcastOps.broadcastTriggerAuditError`** — если запрос audit к БД упал (редко); иначе `null`.
- **`broadcastOps.lastPersistedCampaignEvent`** — последняя строка **`broadcast_campaign_events`** (глобально по id): `eventCode`, `campaignId`, `createdAt`, `topicTestMode`, `details` (без PII).
- **`broadcastOps.recentCampaignEvents`** — до **5** последних lifecycle-событий (все кампании).
- **`broadcastOps.campaignLifecycleEventCount`** — `COUNT(*)` по **`broadcast_campaign_events`**.
- **`broadcastOps.broadcastCampaignEventError`** — ошибка чтения lifecycle-таблицы; иначе `null`.
- **`broadcastOps.broadcastTransportGate`** — fail-closed для доставки: `deliveryWouldHaltNow` (preflight или probe DEGRADED), `haltReason`, `haltSource` (`probe` | `preflight`), `workerPhase`, `workersHaltedByGate`, `workerPhaseIsTransportGateHalt` (воркер остановлен по gate в текущем job). См. также **`lastDeliveryGateHalt`**, **`lastStartupRecoveryTransportGate`** (агрегат по кампаниям, пропущенным recovery при мёртвом transport).
- **`broadcastOps.lastPersistedTransportGateEvent`** / **`recentTransportGateEvents`** / **`transportGateEventCount`** / **`deliveryTransportGateHaltCount`** / **`startupRecoveryTransportGateSkipCount`** / **`lastTransportGateReasonCode`** / **`lastTransportGateDecisionSource`** — устойчивый срез по SQLite по кодам **`TRANSPORT_GATE_HALTED_DELIVERY`** и **`TRANSPORT_GATE_STARTUP_RECOVERY_SKIP`** (после рестарта процесса in-memory агрегаты обнуляются, эти поля — нет). Детали событий без PII: `reasonCode`, `decisionSource`, `phase` (`pre_delivery` — до enqueue/волн; `delivery_loop` — в цикле волн; `startup_recovery`), `dbCounts`, `queueRemaining`, `workerRunning`, `activeCampaignDeliveryJobs`, `transportSnapshot` (degraded, probe, consecutive counters).
- **`broadcastLifecycle.lastStartupRecovery`** — при старте процесса может содержать **`startupTransportGateSkips`**: сколько кампаний переведены в `PAUSED_TRANSPORT` вместо планирования job из-за transport gate.
- **`broadcastLastRun`** — последняя завершённая/пропущенная попытка: `campaignId`, `jobRan`, `jobHadException`, **`jobHadTransportPause`**, **`jobHadTransportGateHalt`** (пауза по transport gate, не breaker), `audienceSize`, `deliveriesInserted`, `summaryPosted`, `incompleteFinalization`, `campaignMarkedDone`, `topicTestMode`, **`lastPersistedLifecycleEventCode`**, **`lastPersistedLifecycleEventAt`** (последнее событие в **`broadcast_campaign_events`** для этого **`campaignId`**), **`recoveryRun` / `resumeFromDb`**, **`transportResumeBlocked`** / **`transportResumeBlockedReason`**, **`transportLayerErrorsSuspected`**, `dbCounts`, `metricsTotals` (в т.ч. **`delivery_error_tally`**, **`broadcast_internal_exceptions`**), `outcomeInterpretation` (в т.ч. **`PAUSED_BY_TRANSPORT_GATE`**), `workerPhase`.
- **`broadcastLifecycle`** (ответ **async**): помимо **`lastStartupRecovery`** и **`activeCampaignDeliveryJobs`**: **`pausedTransportAutoResume`** (сводка последнего авто-resume / следующий sweep); **`runningCampaign`** — последняя кампания в статусе **`RUNNING`** или **`PAUSED_TRANSPORT`**: таймстампы прогресса из БД, **`dbCounts`**, **`funnel`**; **`stall`** — **`progressState`** (в т.ч. **`TRANSPORT_PAUSED`** при `PAUSED_TRANSPORT`), **`stallReason`**, **`lastProgressAgeMs`**, **`transportLikelyFromLastRun`**; **`doneCampaignsWithOpenDeliveryRows`** — аномалия «`DONE`, но есть PENDING/RETRY»; **`workerSnapshotBrief`**.
- **`broadcastZeroDeliveryHints`** — эвристики: отключён ли outbound, выключены ли рассылки, настроена ли тема, test mode и число id в env, напоминание что copyMessage требует outbound.

### `outcomeInterpretation.primary` (после job или skip)

| Значение | Смысл |
|----------|--------|
| `SKIPPED_TEST_RECIPIENT_LIST_EMPTY` | Test mode, пустой `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`, доставка не запускалась |
| `ZERO_AUDIENCE` | `audienceSize === 0` после выбора получателей |
| `QUEUE_INCOMPLETE` | В БД остались PENDING/RETRY_WAIT при снятии снимка (аномалия / гонка) |
| `DELIVERIES_OK` | Есть доставленные |
| `ZERO_DELIVERIES_DOMINATED_BY_BLOCKED` | 0 доставок, преобладают блокировки |
| `ZERO_DELIVERIES_WITH_FAILURES` | 0 доставок, есть ошибки |
| `ZERO_DELIVERIES_NO_SUCCESSFUL_COPY` | Ни одного успешного copy при ненулевой аудитории |
| `ZERO_DELIVERIES_FINISHED` | Итог 0 доставок; при неоднозначности в `tags` может быть `ZERO_DELIVERIES_UNKNOWN_MIX` |
| `ENQUEUE_FAILED_OR_ABORTED` | Аудитория > 0, но в очередь не попала ни одна строка (`deliveriesInserted === 0`) — обычно сбой/откат вставки до JOB_EXCEPTION |
| `JOB_EXCEPTION` | Исключение в теле job до нормального завершения |
| `PAUSED_BY_TRANSPORT_BREAKER` | Воркер остановил волны из‑за streak transport-like ошибок (`jobHadTransportPause`) |
| `TRANSPORT_RESUME_BLOCKED` | Попытка продолжить `PAUSED_TRANSPORT` при всё ещё деградировавшем транспорте (job не стартовал) |

### Исход триггера (ещё до `broadcastLastRun`)

| Поле в `broadcastOps.lastBroadcastTriggerOutcome` | Смысл |
|---------------------------------------------------|--------|
| `error: FORBIDDEN` | Пользователь не в allowlist `TELEGRAM_ADMIN_IDS` (при непустом списке) |
| `error: BROADCASTS_DISABLED` | Флаг рассылки выключен в `broadcast-service` при вызове триггера (защитный путь; при `BROADCASTS_ENABLED=0` webhook обычно не вызывает рассылку — смотрите `flags.BROADCASTS_ENABLED` и `[TelegramUpdate] forum routing`, `branch !== 'broadcast'`) |
| `error: TRANSPORT_PREFLIGHT_FAILED` | Preflight заблокировал старт; см. **`transportPreflightReason`**, также **`lastPreflightBlock`** |
| `error: CAMPAIGN_CREATE_FAILED` | Не удалось создать/прочитать кампанию (в т.ч. `createThrew: true` при исключении из БД) |
| `duplicate: true` | Повторное сообщение с тем же `source` — job не планируется |
| `testModeSkipped: true` | Test mode, пустой список тестовых id — кампания закрыта, см. **`broadcastLastRun`** с `SKIPPED_TEST_RECIPIENT_LIST_EMPTY` |
| `scheduledAsync: false` + **`jobNotScheduledReason`** | Очередь job не приняла задачу (например уже активен job на этот `campaign_id`) — смотрите причину |

### `result_code` в `broadcast_trigger_audit` (durable)

| `result_code` | Когда |
|---------------|--------|
| `OK_JOB_SCHEDULED` | Job доставки поставлен в очередь (`scheduled: true`) |
| `JOB_ALREADY_ACTIVE` | Отклонено: уже выполняется job для этого `campaign_id` |
| `JOB_NOT_SCHEDULED` | Иная причина непланирования (см. `job_not_scheduled_reason`, напр. `BAD_CAMPAIGN_ID`) |
| `TRANSPORT_PREFLIGHT_FAILED` | Preflight до создания кампании |
| `DUPLICATE_TRIGGER` | Повтор того же `source_chat_id` + `source_message_id` |
| `TEST_MODE_EMPTY_RECIPIENTS` | Test mode, пустой список тестовых id (кампания может быть закрыта без job) |
| `CAMPAIGN_CREATE_FAILED` | Нет строки кампании или исключение при создании |
| `FORBIDDEN` / `BROADCASTS_DISABLED` | Не админ или рассылки выключены в сервисе |

Пока **`broadcastWorker.running === true`**, доставка может быть ещё в процессе — смотрите `phase`, `processed`, `queueRemaining`.

## Логи (grep-friendly)

| Тег / префикс | Когда |
|----------------|--------|
| `[BroadcastFlow] ZERO_AUDIENCE` | Аудитория 0: production — проверьте пользователей без `broadcast_suppressed_reason`; test mode — см. hints в JSON |
| `[BroadcastFlow] SKIP_TEST_MODE_EMPTY_RECIPIENTS` | Test mode, пустой `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` |
| `[BroadcastFlow] delivery job started` | Старт доставки, `audienceSize` |
| `[BroadcastDelivery] wave batch` | Волна и очередь |
| `[BroadcastMetrics]` | Агрегаты метрик по волне |
| `[BroadcastDelivery] 429 rate limit` | Лимит Telegram, локальный RETRY_WAIT |
| `[BroadcastDelivery] transient error — retry_wait` | Временная ошибка, отложенный retry |
| `[BroadcastDelivery] terminal blocked` | BOT_BLOCKED, пользователь в suppress |
| `[BroadcastDelivery] terminal permanent` | Постоянная ошибка доставки |
| `[BroadcastSummary]` | Итог по кампании |
| `[BroadcastSummary] ZERO_SUCCESS_WITH_TARGETED_AUDIENCE` | Очередь обработана, но при ненулевом охвате нет ни одной DELIVERED (не путать с неполным итогом) |
| `[BroadcastSummary] INCOMPLETE_FINALIZATION` | Остались PENDING/RETRY_WAIT или исключение в воркере — кампания не переведена в DONE |
| `[BroadcastDiagnostics] snapshot` | Запись сводки last-run для health (без PII) |
| `[BroadcastTriggerAudit] recorded` | Строка audit триггера записана в `broadcast_trigger_audit` |
| `[BroadcastTriggerAudit] record_failed` | Ошибка INSERT audit (сервис рассылки продолжает работу) |
| `[BroadcastCampaignEvent] recorded` | Событие lifecycle кампании записано в `broadcast_campaign_events` |
| `[BroadcastCampaignEvent] record_failed` | Ошибка INSERT lifecycle-события |
| `[BroadcastRecovery] startup sweep completed` | Завершён обход RUNNING-кампаний при старте процесса |
| `[BroadcastRecovery] abandoned_stalled_campaign_no_deliveries` | RUNNING без строк доставок после таймаута — кампания закрыта как `DONE` (нет данных для resume) |
| `[BroadcastFlow] campaign_job_already_active` | Второй старт job для того же `campaign_id` отклонён |
| `[BroadcastPreflight] blocked_by_transport` | Триггер отклонён до создания кампании (preflight) |
| `[BroadcastFlow] paused_by_transport_breaker` | Кампания переведена в `PAUSED_TRANSPORT` |
| `[BroadcastFlow] resumed_after_transport_recovery` | Пауза снята, доставка продолжается с БД |
| `[BroadcastDiagnostics] transport_snapshot` | Снимок streak/threshold при срабатывании breaker |
| `[TelegramTransport] health_update` | Исходящий вызов Bot API зафиксирован в transport health (см. `telegram-client`) |
| `[TelegramTransportProbe] scheduled` / `success` / `failed` | Тик активного probe |
| `[TelegramTransport] recovered_by_probe` | После успешного `getMe` при ранее деградировавшем snapshot |
| `[BroadcastRecovery] paused_transport_resume_*` | Кандидаты, scheduled, skipped, blocked (авто-resume) |
| `[BroadcastDelivery] recipient_handler_exception_isolated` | Исключение в обработчике одного получателя; волна продолжается |

Примеры:

```bash
journalctl -u cvet21.service -g 'BroadcastFlow\\|BroadcastDelivery\\|BroadcastMetrics' --since '1 hour ago'
```

## «Две попытки рассылки, 0 доставок» — разбор причин

1. **Пустая аудитория (production)**  
   - Лог: `[BroadcastFlow] ZERO_AUDIENCE`, `topicTestMode: false`.  
   - Проверка: пользователи в БД, `broadcast_suppressed_reason IS NULL`, `telegram_id` заполнен.

2. **Test mode**  
   - `BROADCAST_TOPIC_TEST_MODE=1`, получатели только из `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`.  
   - Если список пуст — см. `SKIP_TEST_MODE_EMPTY_RECIPIENTS`.  
   - Health: `broadcastOps.topicTestMode`, `topicTestRecipientCount`.

3. **Outbound выключен**  
   - `TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=false` → `broadcastZeroDeliveryHints.outboundBotHttpDisabled: true`.  
   - Копии сообщений не уйдут.

4. **Неверная тема / нет матча webhook**  
   - `threadsConfigured.broadcast: false` или сообщения не в той теме → кампания не создаётся.  
   - Сверить `topicRouting` в health с реальной темой в Telegram.

5. **Блокировки пользователей**  
   - Метрика `broadcast_blocked`, лог `terminal blocked`, поле `users.broadcast_suppressed_reason`.

6. **Permanent vs transient**  
   - `broadcast_failed_permanent` vs `broadcast_failed_temporary` / `broadcast_retry_scheduled`.  
   - Постоянные коды — см. `isPermanentBroadcastDeliveryError` в `backend/reliability-utils.js`.

7. **Rate limit 429**  
   - `broadcast_rate_limited_429`, `retry_after_seconds`, логи с `429 rate limit`.

8. **Прокси / таймаут**  
   - Ошибки сети в `[TelegramClient]`; проверить `TELEGRAM_PROXY_URL` и доступность SOCKS/сети.

## См. также

- `deploy/env.example` — блок broadcast tuning  
- `deploy/PRODUCTION-RUNBOOK-ru.md` — общий pipeline  
- `deploy/systemd/broadcast-tuning.conf.example` — вынос тюнинга в drop-in  
