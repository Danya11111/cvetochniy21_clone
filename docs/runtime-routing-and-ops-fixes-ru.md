# Runtime routing и operational wiring — диагностика и исправления

Документ описывает **фактические** причины симптомов на проде (HTML вместо JSON на `/api/health/ops`, админка, broadcast, уведомления) и внесённые исправления в `backend/server.js`.

---

## 1. Root cause: `GET /api/health/ops` возвращал HTML (Mini App `index.html`)

### FACT

- Клиентский SPA подключается через `app.get('*', …)` и `res.sendFile(…/frontend/index.html)`.
- Любой **GET**, для которого **нет** зарегистрированного обработчика раньше по цепочке, в конце попадает в этот catch-all и получает **HTML**, а не JSON.
- Симптом `curl http://127.0.0.1:3000/api/health/ops` → HTML означает одно из:
  1. **На процессе крутится старая версия** `server.js` без хендлера `GET /api/health/ops` → запрос доходит до SPA fallback.
  2. **Иной entrypoint** или другой порт/процесс, не тот репозиторий.
  3. (Реже) ошибка порядка middleware; в актуальном дереве маршрутов health должен быть объявлен **до** static + до SPA.

### FIX (в репозитории)

1. **`GET /api/health/ops` перенесён сразу после `app.use(express.json())`, до `express.static(frontendPath)`.** Так исключается любая двусмысленность с раздачей статики и гарантируется ранний матч.
2. **SPA fallback (`app.get('*', …)`) изменён:** для путей с префиксом `/api/` больше **не** отдаётся `index.html`; возвращается **JSON 404** с полем `error: 'API_NOT_FOUND'`. Неизвестный API больше не маскируется под HTML Mini App.
3. В теле ответа `/api/health/ops` добавлено поле `serverModule: 'backend/server.js'` — быстрая проверка, что отвечает нужный файл.

### VERIFIED (после деплоя)

```bash
curl -sS http://127.0.0.1:3000/api/health/ops | head -c 200
```

Ожидается JSON с `"ok":true` и `"serverModule":"backend/server.js"`. Если снова HTML — процесс не обновлён или слушает не тот код.

---

## 2. Root cause: `/admin-embed` «не тот» HTML

### FACT

- `/admin-embed` регистрируется как `app.get('/admin-embed', ensureAdminUiAccess, …)` **выше** SPA fallback, после static — для пути `/admin-embed` файл в `frontend/` обычно отсутствует, static вызывает `next()`, затем срабатывает маршрут админки.
- Если пользователь видит **клиентский** `index.html`, чаще всего сработал **`app.get('*')`** → нет зарегистрированного `GET /admin-embed` в процессе (частый случай: **`ADMIN_UI_ENABLED=false`**, при этом handoff всё ещё работал). См. **`ADMIN_MINIAPP_EMBED_ENABLED`** в `backend/config.js` и `docs/final-targeted-fixes-ru.md`.

### FIX

- Исправление порядка для `/api/health/ops` и защита catch-all для `/api/*` не ломают `/admin-embed`.
- Встроенная админка по-прежнему: handoff `POST /api/admin/handoff` + `GET /admin-embed?h=…` + `sendAdminIndexHtml` с `window.__F21_EMBEDDED_INIT_DATA`.
- Маршруты **`/admin-embed`** и **`/admin-assets`** включаются при **`ADMIN_UI_ENABLED || ADMIN_MINIAPP_EMBED_ENABLED`** (по умолчанию embedded включён).

### VERIFIED

```bash
# без авторизации ожидается 403 текст/не JSON SPA
curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin-embed
```

С валидным `h` или cookie — HTML админки (не корневой `frontend/index.html`).

---

## 3. Какие маршруты были «shadowed» / misordered

| Маршрут | Проблема | Исправление |
|---------|----------|-------------|
| `GET /api/health/ops` | При отсутствии хендлера в процессе → `app.get('*')` отдавал SPA HTML | Ранний регистр + catch-all не отдаёт HTML для `/api/*` |
| Любой неизвестный `GET /api/...` | Тот же SPA HTML | JSON 404 `API_NOT_FOUND` |
| `GET /admin-embed` | Не shadowed в актуальном коде, если процесс обновлён | Подтверждать деплой и логи |

---

## 4. Operational wiring (код не «мёртвый»)

Сервисы создаются в начале `server.js` и используются так:

- `telegramUpdateHandler` → `POST /api/telegram/webhook`
- `eventPublisher` → checkout / T-Bank notify
- `outboxWorker` → `setInterval`, если `OUTBOX_WORKER_ENABLED`
- `orderTopicNotificationService` / `supportService` / `broadcastService` → через publisher, webhook handler, broadcast flow

Если webhook не доходит (403 secret, неверный URL) или флаги/thread id нулевые — симптомы «ничего не работает» без ошибки в порядке маршрутов.

---

## 5. Env: что обязательно для прод

| Назначение | Переменные |
|------------|------------|
| Webhook | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (совпадение с `setWebhook`) |
| Broadcast test mode | `BROADCAST_TOPIC_TEST_MODE`, `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`, ненулевой `TELEGRAM_BROADCAST_TOPIC_THREAD_ID` |
| Orders/support темы | `TELEGRAM_ORDERS_NOTIFY_THREAD_ID`, `TELEGRAM_SUPPORT_NOTIFY_THREAD_ID` (>0 для поста в тему), `TELEGRAM_FORUM_GROUP_ID` |
| Outbox | `EVENT_OUTBOX_ENABLED`, `OUTBOX_WORKER_ENABLED`, `TELEGRAM_TOPICS_ENABLED`, `ORDERS_TOPIC_NOTIFICATIONS_ENABLED` |
| Admin embed (iframe) | `ADMIN_MINIAPP_EMBED_ENABLED` (по умолчанию true), `ADMIN_TELEGRAM_IDS` / `ADMIN_PRIMARY_TELEGRAM_ID` |
| Admin standalone `/admin` | `ADMIN_UI_ENABLED` |

Подхват: только `process.env` процесса Node (**systemd** `Environment=` / `EnvironmentFile=`, без «магии» `.env`, если не подключали dotenv осознанно).

---

## 6. Startup logs

После `listen` вызывается `logStartupWiring()`: эффективные флаги, thread id, предупреждения при `*_THREAD_ID=0`, строка про порядок маршрутов. Если в логах нет `[Startup] F21 operational wiring` — процесс не тот или логи режутся.

---

## 7. Ручная проверка после фикса

1. `curl -sS http://127.0.0.1:3000/api/health/ops` → JSON, `serverModule` присутствует.
2. Mini App → Админка → UI в iframe; при ошибке смотреть `[AdminHandoff]` в логах.
3. Сообщение в тему рассылки (test mode) → логи `[TelegramUpdate] broadcast trigger`.
4. Заказ / ЛС поддержки → `[EventPublisher:OUTBOX]`, `[OutboxWorker]` при включённом outbox.

---

## Изменённые файлы

- `backend/server.js` — порядок `GET /api/health/ops`, поведение SPA fallback для `/api/*`, расширение startup-лога и ответа health.

См. также: `docs/production-runtime-audit-fixes-ru.md`.
