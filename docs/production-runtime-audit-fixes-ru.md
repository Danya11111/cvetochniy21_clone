# Production runtime audit — симптомы, причины, исправления

Документ фиксирует результат production-oriented аудита (bootstrap, Mini App admin, webhook, topic broadcast, orders/support). Операторский язык — русский; идентификаторы кода и env — как в репозитории.

---

## Симптомы (как было)

1. **Админка в Mini App** — ожидался встроенный режим, по факту: внешний браузер и/или белый экран, админка не работала как задумано.
2. **Topic-triggered broadcast (test mode)** — сообщение в теме рассылки не приводило к предсказуемой тестовой рассылке.
3. **Темы заказов и поддержки** — уведомления в соответствующие темы не приходили.
4. **Ощущение «бот не перезапустился»** — поведение не совпадало с ожиданиями после деплоя.

---

## FACT vs HYPOTHESIS vs FIX vs VERIFIED

### 1. Встроенная админка (iframe)

| Тип | Содержание |
|-----|------------|
| **FACT** | Клиент формировал URL `/admin-embed?...&tgWebAppData=<очень длинная строка>`. Сервер отдавал `index.html` без передачи initData в HTML; клиентский `resolveInitData()` опирался на query или `Telegram.WebApp.initData`. |
| **FACT** | В WebView Telegram длинные query часто обрезаются или ведут себя нестабильно → падение проверки подписи initData, пустая страница, ощущение «белого экрана». |
| **FACT** | Статика админки подключена как `/admin-assets/*`; пути в `admin/index.html` корректны — отдельной поломки путей не выявлено. |
| **HYPOTHESIS (отклонена как единственная причина)** | Только CSP/X-Frame-Options: для same-origin iframe достаточно корректной раздачи; основной риск — **длина URL и отсутствие initData в контексте iframe**. |
| **FIX** | Короткий **handoff**: `POST /api/admin/handoff` с заголовком `x-telegram-init-data` → одноразовый token → `GET /admin-embed?h=...`. После успешной авторизации в HTML инжектируется `window.__F21_EMBEDDED_INIT_DATA` (JSON-string), админское `app.js` читает его первым. Fallback: прежний длинный query. |
| **VERIFIED** | После деплоя: открыть Mini App → Профиль → **Админка** → контент админки загружается в iframe без внешнего браузера; в логах сервера — `[AdminHandoff] выдан token`. |

### 2. Topic broadcast и test mode

| Тип | Содержание |
|-----|------------|
| **FACT** | В `telegram-update-handler` рассылка из темы вызывается только если `BROADCASTS_ENABLED && broadcastService.isBroadcastTopicMessage(message)`. |
| **FACT** | В `broadcast-service.js` совпадение темы: `chatId === String(broadcastTopicChatId)` и `threadId === Number(broadcastTopicThreadId)`. При **`TELEGRAM_BROADCAST_TOPIC_THREAD_ID=0`** (дефолт в env) реальное сообщение из темы **никогда** не совпадёт с условием. |
| **FACT** | В `config.js` ранее флаги `BROADCASTS_ENABLED`, `TELEGRAM_TOPICS_ENABLED`, outbox и др. по умолчанию были **false** — при отсутствии переменных в systemd весь контур был выключен. |
| **FACT** | Test mode: при `BROADCAST_TOPIC_TEST_MODE=true` получатели берутся из `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`; пустой список → рассылка не стартует, в тему уходит пояснение (см. `broadcast-service.js`). |
| **FIX** | Дефолты для операционных флагов выставлены в **true** (отключение явным `false`/`0` в env). При старте сервера — предупреждение, если `BROADCASTS_ENABLED` и thread id рассылки = 0. |
| **VERIFIED** | `GET /api/health/ops` — `BROADCASTS_ENABLED`, `threadsConfigured.broadcast`; в логах при старте нет предупреждения о thread=0; тестовое сообщение в **назначенной** теме рассылки запускает цепочку (см. чеклист ниже). |

### 3. Уведомления в темы заказов и поддержки

| Тип | Содержание |
|-----|------------|
| **FACT** | Заказы: `event-publisher` кладёт события в outbox только если одновременно `TELEGRAM_TOPICS_ENABLED && EVENT_OUTBOX_ENABLED && ORDERS_TOPIC_NOTIFICATIONS_ENABLED` и тип события checkout/paid. |
| **FACT** | `outbox-worker` должен быть включён (`OUTBOX_WORKER_ENABLED`), иначе очередь не обрабатывается. |
| **FACT** | `order-topic-notification-service`: сообщение в **тему заказов** отправляется только если `ordersNotifyThreadId > 0`. При 0 уведомление в форумную тему заказов не уходит (клиентская тема может обрабатываться отдельно). |
| **FACT** | Поддержка: при `SUPPORT_RELAY_ENABLED` ЛС клиента копируются в тему клиента; уведомление в тему «поддержка» — при `supportNotifyThreadId > 0`. |
| **FIX** | Те же дефолты флагов + startup warnings при включённом функционале и `*_THREAD_ID=0`. |
| **VERIFIED** | `/api/health/ops`, логи `[EventPublisher]`, `[OutboxWorker]`; тестовый заказ и ЛС в поддержку (чеклист). |

### 4. Webhook и «бот не обновился»

| Тип | Содержание |
|-----|------------|
| **FACT** | Вход: `POST /api/telegram/webhook`; при заданном `TELEGRAM_WEBHOOK_SECRET` заголовок `x-telegram-bot-api-secret-token` должен совпадать, иначе **403** и updates не обрабатываются. |
| **FIX** | Лог при несовпадении secret; лог успешной обработки update (без тел чувствительных данных). |
| **VERIFIED** | В логах нет повторяющихся `403` от webhook; `setWebhook` у Bot API указывает на HTTPS URL приложения и тот же secret. |

---

## Что оказалось ложным следом (кратко)

- **«Только не перезапустили бота»** — без перезапуска процесса Node изменения не подхватятся, но основная причина сбоев — **конфигурация флагов/thread id и доставка initData в админку**, а не только рестарт.
- **Единственный виновник iframe — заголовки** — для same-origin вторично; критичны **длина URL с initData** и **выключенные флаги**.

---

## Обязательные env (критичные для прод-операций)

| Переменная | Назначение |
|------------|------------|
| `TELEGRAM_BOT_TOKEN` | Бот, webhook, отправка сообщений |
| `TELEGRAM_FORUM_GROUP_ID` | ID супергруппы-форума |
| `TELEGRAM_BROADCAST_TOPIC_CHAT_ID` / `TELEGRAM_BROADCAST_TOPIC_THREAD_ID` | Тема рассылки (thread **> 0**) |
| `TELEGRAM_ORDERS_NOTIFY_CHAT_ID` / `TELEGRAM_ORDERS_NOTIFY_THREAD_ID` | Тема уведомлений о заказах (thread **> 0** для поста в тему) |
| `TELEGRAM_SUPPORT_NOTIFY_CHAT_ID` / `TELEGRAM_SUPPORT_NOTIFY_THREAD_ID` | Тема уведомлений поддержки |
| `TELEGRAM_WEBHOOK_SECRET` | Должен совпадать с `secret_token` в `setWebhook` |
| `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` | CSV Telegram user id для тестового режима рассылки |
| `ADMIN_TELEGRAM_IDS` / `TELEGRAM_ADMIN_IDS` | Кто может триггерить рассылку и заходить в админку |

Переменные читаются из `process.env` процесса Node (systemd `Environment` / `EnvironmentFile`). Файлы `.env` на сервере сами по себе не подхватываются, если не используется dotenv в коде (в проекте не добавлялся).

---

## Ручная проверка после деплоя

### Админка в Mini App

1. Открыть приложение в Telegram → Профиль → **Админка**.
2. Убедиться, что UI админки виден внутри приложения (не внешний браузер).
3. В логах: `[AdminHandoff] выдан token`, без 403 на `/admin-embed`.

### Topic broadcast (test mode)

1. Убедиться, что `BROADCAST_TOPIC_TEST_MODE=true` и в `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` указаны ваши id.
2. Отправить сообщение-триггер в **назначенную** тему рассылки от аккаунта из admin ids.
3. Проверить лог `[TelegramUpdate] broadcast trigger` и доставку тестовым id.

### Заказы (тема)

1. `GET https://<BASE_URL>/api/health/ops` — флаги и `threadsConfigured.orders: true`.
2. Оформить тестовый checkout; смотреть `[EventPublisher:OUTBOX] queued` и `[OutboxWorker] sent`.

### Поддержка

1. Написать боту в ЛС; проверить копирование в тему клиента и уведомление в тему поддержки (при настроенных id).

### Webhook

1. `curl` или логи Telegram: запросы доходят до `POST /api/telegram/webhook` без 403.
2. При 403 — сверить `TELEGRAM_WEBHOOK_SECRET` и `secret_token` в `getWebhookInfo`.

---

## Что проверить перед финальным go-live

- [ ] Все thread id > 0 для реально используемых тем.
- [ ] Webhook URL и secret согласованы с прод-доменом.
- [ ] systemd (или аналог) задаёт все нужные env; после `systemctl daemon-reload && systemctl restart <service>` в логах есть `[Startup] F21 wiring`.
- [ ] Мониторинг логов `[TelegramWebhook] 403` — должно быть ноль в штате.

---

## Изменённые и добавленные файлы (код)

- `backend/config.js` — дефолты операционных флагов.
- `backend/server.js` — handoff, инъекция initData в HTML, `/api/health/ops`, startup warnings, логи webhook.
- `backend/admin-auth.js` — поддержка `h` + peek/consume handoff.
- `backend/admin-handoff-store.js` — **новый** store токенов.
- `backend/telegram-update-handler.js` — диагностика `CLIENT_TOPIC_NOT_MAPPED`.
- `frontend/app.js` — `openAdminEmbedded` через handoff + fallback.
- `frontend/admin/app.js` — приоритет `window.__F21_EMBEDDED_INIT_DATA`.

---

## Executive summary

Раньше цепочки форумных операций были **выключены дефолтами конфига** при отсутствии env; рассылка из темы **не распознавалась** при `TELEGRAM_BROADCAST_TOPIC_THREAD_ID=0`; уведомления о заказах **не выходили** без включённого outbox/worker и ненулевого thread id. Админка во встроенном режиме ломалась из‑за **передачи огромного `tgWebAppData` в query**. Исправления: **handoff + инъекция initData**, **включение операционных дефолтов**, **явные предупреждения при thread=0**, **диагностические логи и `/api/health/ops`**.
