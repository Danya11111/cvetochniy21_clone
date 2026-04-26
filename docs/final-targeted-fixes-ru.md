# Целевые production-исправления (embedded admin, broadcast, notify topics)

Документ фиксирует **root cause**, **исправления в коде** и **ручную верификацию** после точечной диагностики (без общего аудита).

---

## 1. Встроенная админка: iframe показывал storefront (двойной Mini App)

### Root cause

- Маршруты **`GET /admin-embed`** и раздача **`/admin-assets`** были завязаны только на **`ADMIN_UI_ENABLED`**.
- **`POST /api/admin/handoff`** и **`/api/admin/*`** при этом оставались доступны.
- При **`ADMIN_UI_ENABLED=false`** запрос к **`/admin-embed`** не находил хендлер и попадал в **`app.get('*')` → `frontend/index.html`** (клиентский SPA) — в iframe загружался тот же storefront.

### Fix

- Введён флаг **`ADMIN_MINIAPP_EMBED_ENABLED`** (по умолчанию **`true`**), который управляет **`/admin-embed`** и **`/admin-assets`** независимо от **`ADMIN_UI_ENABLED`**.
- **`GET /admin`** (открытие админки в браузере по прямой ссылке) по-прежнему только при **`ADMIN_UI_ENABLED=true`**.
- В **`sendAdminIndexHtml`** добавлен явный лог **`[AdminUI] sendAdminIndexHtml: отдаём frontend/admin/index.html`** (подтверждение, что ответ не SPA fallback).
- В **`logStartupWiring`** предупреждение, если оба флага админки выключены и iframe гарантированно упрётся в storefront.

### Проверка

1. `curl -sS https://<host>/api/health/ops` → в **`flags`** есть **`ADMIN_MINIAPP_EMBED_ENABLED: true`**.
2. Mini App → Профиль → **Админка** → в логах сервера строка **`[AdminUI] sendAdminIndexHtml`** и **нет** повторной загрузки корневого бандла как единственного HTML для iframe.

### Дополнение: `[AdminHandoff]` есть, `[AdminUI] sendAdminIndexHtml` нет

**Симптом:** handoff выдаётся, но до рендера admin HTML дело не доходит.

**Root cause:** запрос **`GET /admin-embed?h=…`** из iframe в Telegram WebView часто **теряет или режет query** (`h` не доходит до Node). Тогда **`resolveAdminFromRequest`** не видит ни `h`, ни cookie → **403** на **`ensureAdminUiAccess`** → **`sendAdminIndexHtml` не вызывается**.

**Fix:**

- **`POST /api/admin/handoff/attach`** — в теле **`{ "token": "<handoff>" }`**, ответ выставляет **`f21_admin_tg_init`** (HttpOnly), токен одноразово потребляется как при `?h=`.
- Клиент после успешного handoff вызывает **attach** с **`credentials: 'same-origin'`**, затем **`iframe.src = /admin-embed?...&_cb=…`** **без `h`** (авторизация по cookie).
- Fallback: если attach не удался — прежний URL с **`&h=`** в query.
- Логи: **`[AdminHandoffAttach]`**, **`[AdminEmbedHit]`**, **`[AdminUIAccess] отказ`**, **`[F21AdminEmbed]`** (консоль WebView).

---

## 2. Рассылка из темы форума не триггерилась

### Root cause

- Сравнение **`chat_id` / `message_thread_id`** в **`isBroadcastTopicMessage`** зависело от корректных env; при несовпадении **`thread_id`** ветка broadcast не выбиралась.
- Нужна была **наблюдаемость**: реальный **`message_thread_id`** из update vs ожидаемый **`TELEGRAM_BROADCAST_TOPIC_THREAD_ID`**.

### Fix

- Нормализация строк (**`trim`**) для **`chat_id`** и явное требование **`expectedThreadId > 0`** в матче.
- Экспорт **`getBroadcastTopicRoutingDebug()`** из **`broadcast-service`** (ожидаемые chat/thread без секретов).
- В **`telegram-update-handler`** структурированный лог **`[TelegramUpdate] forum routing`** (chat_id, message_thread_id, ветка, **`expectedBroadcastChatId` / `expectedBroadcastThreadId`**).
- Если сообщение в **том же чате**, но **другой теме** — лог **`[TelegramUpdate] сообщение в другой теме того же чата`**.

### Проверка

1. Отправить текст в тему рассылки → в логах **`branch: "broadcast"`**, **`broadcastMatch: true`**, затем **`[TelegramUpdate] broadcast trigger`**.
2. Если **`broadcastMatch: false`**, сравнить **`messageThreadId`** с **`expectedBroadcastThreadId`** и поправить **`TELEGRAM_BROADCAST_TOPIC_THREAD_ID`** в env процесса.

---

## 3. Уведомления в тему заказов и тему поддержки

### Root cause

- Логика отправки уже была в **`order-topic-notification-service`** и **`support-service`**, но при **`thread_id=0`** или пропуске блока не было **явного** structured log результата **`sendMessage`**.
- Упрощает диагностику: отличить «не вызывалось» от «Telegram вернул ошибку».

### Fix

- **`[OrderTopicNotify] orders notify topic`** — chat_id, thread_id, **`ok`**, **`errorCode`** при ошибке; отдельно **`[OrderTopicNotify] skip`** если нет chat/thread.
- **`[SupportNotifyTopic] support notify topic`** / **`skip`** — аналогично для темы поддержки.

Напоминание: уведомление о заказе в тему заказов идёт через **outbox** после **`publishCheckoutStarted`** (нужны **`EVENT_OUTBOX_ENABLED`**, **`OUTBOX_WORKER_ENABLED`**, **`TELEGRAM_TOPICS_ENABLED`**, **`ORDERS_TOPIC_NOTIFICATIONS_ENABLED`**).

### Проверка

- Тестовый checkout → в логах **`[OrderTopicNotify]`** с **`ok: true`** или понятным **`errorCode`**.
- Первое сообщение клиента в **private** боту → **`[SupportNotifyTopic]`** с **`ok: true`** (при ненулевом **`TELEGRAM_SUPPORT_NOTIFY_THREAD_ID`**).

---

## 4. Systemd: `Invalid environment assignment, ignoring: рассылка`

### Root cause

Строка в unit-файле без **`KEY=value`** или значение с пробелами **без кавычек** — systemd игнорирует присваивание; в логе может остаться обрезок вроде **`рассылка`**.

### Допустимые формы

```ini
# Значение с пробелами — в кавычках:
Environment="BROADCAST_TOPIC_TEST_LABEL=Тестовая рассылка"

# Или в EnvironmentFile (одна строка на переменную):
# BROADCAST_TOPIC_TEST_LABEL=Тестовая рассылка
```

Не использовать «голый» текст **`Тестовая рассылка`** без имени переменной в директиве **`Environment=`**.

---

## Файлы изменений

| Файл | Изменение |
|------|-----------|
| `backend/config.js` | `ADMIN_MINIAPP_EMBED_ENABLED` |
| `backend/server.js` | `/admin-embed`, `/admin-assets`, **`POST /api/admin/handoff/attach`**, логи hit/access |
| `backend/admin-auth.js` | handoff token из **`req.body.token`** |
| `frontend/app.js` | attach → iframe без `h`, логи **`[F21AdminEmbed]`** |
| `backend/telegram-update-handler.js` | Логи forum routing, ветки, mismatch темы |
| `backend/broadcast-service.js` | `isBroadcastTopicMessage` нормализация, `getBroadcastTopicRoutingDebug` |
| `backend/order-topic-notification-service.js` | `[OrderTopicNotify]` |
| `backend/support-service.js` | `[SupportNotifyTopic]` |
| `deploy/systemd/cvetochny21-node.service.example` | Комментарий про кавычки и `EnvironmentFile` |
| `docs/runtime-routing-and-ops-fixes-ru.md` | Согласование с embedded-флагом |
| `docs/final-targeted-fixes-ru.md` | Этот документ |

---

## Env в systemd (ориентир)

| Переменная | Назначение |
|------------|------------|
| `ADMIN_MINIAPP_EMBED_ENABLED=true` | Встроенная админка в Mini App |
| `ADMIN_UI_ENABLED=true` | Опционально: прямой `/admin` в браузере |
| `TELEGRAM_BROADCAST_TOPIC_THREAD_ID` | ID темы рассылки (из ссылки форума) |
| `TELEGRAM_ORDERS_NOTIFY_THREAD_ID` | Тема уведомлений о заказах |
| `TELEGRAM_SUPPORT_NOTIFY_THREAD_ID` | Тема операторских уведомлений поддержки |
| `BROADCAST_TOPIC_TEST_MODE` / `BROADCAST_TOPIC_TEST_TELEGRAM_IDS` | Тестовая рассылка из темы |
| `BROADCAST_TOPIC_TEST_LABEL` | Подпись; при пробелах — см. §4 |

Все значения — в **`Environment=`** / **`EnvironmentFile=`** процесса **node**, который исполняет **`backend/server.js`**.
