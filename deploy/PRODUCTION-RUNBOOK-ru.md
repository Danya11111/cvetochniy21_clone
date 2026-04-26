# Production runbook (источник правды — git)

Единый канон по маршрутизации, systemd и запрету drift: **`deploy/PRODUCTION-SOURCE-OF-TRUTH-ru.md`**.

## Каноническая схема

`git` → деплой (обновление рабочей копии, `npm install` при необходимости) → **systemd** (`cvet21.service` + drop-ins + `/etc/cvetochny21.env`) → **nginx** (reverse proxy на Node) → **Node** (`backend/server.js`).

Ручные правки конфигов **только на сервере** без отражения в репозитории запрещены как долгосрочная практика: они создают drift; восстановление — через приведение сервера к файлам из git и шаблонам в `deploy/`.

### SQLite: `support_threads` (денорм для админки / SLA)

Колонки **`waiting_for_staff`**, **`last_client_message_at`**, **`last_staff_reply_at`**, **`last_message_direction`** создаются и догоняются **кодом** при старте (`backend/support-threads-schema.js`, `db.awaitMigrations`). Ручной `ALTER TABLE` на проде не нужен: достаточно обычного **pull + restart** после обновления репозитория. Логи миграции: grep по **`[DBMigration] support_threads`**.

## Где источник правды

| Область | Источник в репозитории |
|--------|-------------------------|
| HTML / build id | `backend/server.js` + `backend/frontend-build-id.js`, шаблоны `frontend/**/*.html` — см. `deploy/BUILD-DELIVERY-RUNBOOK-ru.md` |
| Переменные окружения | `deploy/env.example` → на сервере `/etc/cvetochny21.env` (один файл + опционально drop-ins) |
| systemd | `deploy/systemd/cvet21.service.example`, `deploy/systemd/*.conf.example` |
| nginx | `deploy/nginx/tgtsvetochnii21.ru.example.conf` |
| Операции / рассылка | `deploy/PRODUCTION-RUNBOOK-ru.md`, `docs/broadcast-ops-ru.md` |

## Что не править «вживую» на сервере

- Не редактировать `frontend/index.html` и `frontend/admin/index.html` в обход деплоя.
- Не держать «эталонные» копии unit-файлов только в `/etc` без соответствия git.
- Не оставлять `.bak` и дублирующие `server {}` в nginx без выноса в документацию/шаблон.

## Effective environment (systemd)

```bash
sudo systemctl show cvet21.service -p Environment -p EnvironmentFiles --no-pager
sudo systemctl cat cvet21.service
```

Переменные из drop-in **перекрывают** одноимённые из `EnvironmentFile`, если заданы позже (см. комментарии в `deploy/systemd/*.conf.example`).

## Прокси до api.telegram.org

1. В `/api/health/ops` смотрите `telegramBotApiProxy`, `telegramTransport` (режим, не секреты), **`telegramBotApiTransportHealth`** / **`telegramTransportHealth`** (единый снимок: `degraded`, `consecutiveTransportErrors`, последние success/error по outbound).
2. Убедитесь, что `TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=true`, иначе исходящие запросы к Bot API отключены.
3. Рассылка: **`broadcastOps.lastPreflightBlock`**, **`transportProbe`** (активный `getMe`, `nextProbeDueAt`, `probeState`), **`pausedTransportCampaignCount`**, **`lastAutoResumeAt`** / **`nextPausedTransportSweep`**, **`broadcastOps.lastWorkerTransportPause`**, **`activeCampaignPausedByTransport`**, флаги **`BROADCAST_*`** / **`TELEGRAM_TRANSPORT_PROBE_*`**, устойчивый trail триггера **`broadcastOps.lastPersistedTriggerOutcome`** / **`recentTriggerOutcomes`** (таблица `broadcast_trigger_audit`), lifecycle кампании **`broadcastOps.lastPersistedCampaignEvent`** / **`recentCampaignEvents`** (таблица `broadcast_campaign_events`), в **`broadcastLastRun`** — **`lastPersistedLifecycleEventCode`** — см. `docs/broadcast-ops-ru.md`.
4. Логи при сетевых ошибках: grep по `[TelegramClient]`, `[TelegramTransport] health_update`, `[BroadcastPreflight]`, `[BroadcastFlow] paused_by_transport_breaker` (см. `backend/telegram-client.js`, `backend/broadcast-service.js`).

## Webhook

- URL должен совпадать с `setWebhook`; секрет — `TELEGRAM_WEBHOOK_SECRET`.
- Проверка: POST на `/api/telegram/webhook` с валидным телом (в проде только от Telegram); при неверном секрете — отказ.
- Health: `GET /api/health/ops` → JSON, не HTML (если HTML — см. `docs/runtime-routing-and-ops-fixes-ru.md`).

## Inline callback (callback_query)

- Смотрите логи обработчика обновлений и маршруты в `backend/telegram-update-handler.js`.
- Grep: `callback_query`, `[TelegramUpdate]`.

## Admin access

- Список админов: `ADMIN_TELEGRAM_IDS` (+ union с дефолтами), см. `backend/config.js`.
- Вход в админку: `POST /admin-launch` → `GET /admin-embed?h=...`.
- Логи: `[AdminAccess]`, `[AdminLaunch]`, `[AdminEmbed]`.

## Быстрый чеклист артефактов

См. `deploy/README.md` и `npm run verify:manifest`.

## Health `/api/health/ops` (кратко)

JSON включает **`telegramBotApiTransportHealth`**, `broadcastLastRun`, `broadcastLifecycle` (в т.ч. последняя **`RUNNING` / `PAUSED_TRANSPORT`**), `broadcastWorker`, `broadcastDeliveryMetrics`, расширенный **`broadcastOps`** (transport ops + активная пауза + **persisted trigger audit**), `broadcastZeroDeliveryHints` — подробно в `docs/broadcast-ops-ru.md`.
