# Финальные правки: рассылки, embedded admin, наблюдаемость

Документ фиксирует **FACT / HYPOTHESIS / FIX / VERIFIED** по результатам аудита кода и типичного поведения Telegram Bot API.

---

## 1. Executive Summary

- **Рассылки:** доставка больше не блокирует ответ webhook на время всей кампании; добавлены интервал между `copyMessage`, ретраи при `RATE_LIMIT` и исчерпываемых сетевых ошибках, исключение из аудитории пользователей с `BOT_BLOCKED` (поле в `users`), сброс подавления при следующем `/api/user/init`.
- **Админка во iframe:** усилены заголовки кэширования для HTML админки, лог ветки `sendAdminIndexHtml`, логи `/admin-embed` и выдачи `/admin-assets`, в `frontend/admin/index.html` подключён `telegram-web-app.js` для корректного `Telegram.WebApp` во встроенном режиме.
- **Наблюдаемость:** префиксы `[BroadcastFlow]`, `[BroadcastDelivery]`, `[BroadcastSummary]`, расширение `GET /api/health/ops` (`broadcastWorker`, флаги `BROADCAST_*`).

---

## 2. Рассылки — задержка старта (latency)

| | |
|---|---|
| **FACT** | Раньше `startCampaignFromTopicMessage` выполнял все `copyMessage` в том же async-потоке, что и `POST /api/telegram/webhook`, и ответ `200` отправлялся только после завершения всей цепочки. |
| **FACT** | Telegram накладывает лимиты на частоту запросов к Bot API; при большой аудитории последовательная отправка даёт задержку порядка минут и всплески `429 Too Many Requests`. |
| **HYPOTHESIS** | Наблюдаемая задержка «до ~10 минут» до итогового сообщения в теме совпадает с длительностью полного прохода по базе при отсутствии быстрого ACK и при отсутствии бэкоффа по `retry_after`. |
| **FIX** | Webhook завершает обработку сразу после планирования фоновой задачи; первая реальная отправка начинается в фоне; между сообщениями — `BROADCAST_DELIVERY_INTERVAL_MS` (по умолчанию 55 ms); при `RATE_LIMIT` — ожидание `retry_after` и повтор до `BROADCAST_MAX_COPY_ATTEMPTS`. |
| **VERIFIED** | По коду: `telegram-update-handler` ждёт только `startCampaignFromTopicMessage`, который возвращает после `runCampaignDeliveryJob(...).catch(...)` без await на сам job. Локально: `node --check backend/broadcast-service.js`. Прод: смотреть логи `[BroadcastFlow] topic trigger handled` с `scheduledAsync: true` и ранний `[TelegramWebhook] update обработан`. |

---

## 3. Рассылки — рост ошибок по кампаниям

| | |
|---|---|
| **FACT** | Раньше получатели с `BOT_BLOCKED` и прочими ошибками оставались в общем `SELECT` из `users` и участвовали в каждой новой кампании. |
| **FACT** | Ошибки `429` без ожидания `retry_after` часто попадали в `FAILED`, ухудшая метрики без реальной «терминальной» причины для адреса. |
| **HYPOTHESIS** | «Ползущие» ошибки и падение delivered объясняются накоплением заблокировавших бота и агрессивной классификацией временных сбоев как финальных без ретраев. |
| **FIX** | Колонки `users.broadcast_suppressed_reason` / `broadcast_suppressed_at`: при `BOT_BLOCKED` пользователь исключается из продакшен-аудитории; при успешном `/api/user/init` подавление сбрасывается (пользователь снова активен в приложении). Ретраи для `RATE_LIMIT` и retryable-кодов перед финальным `FAILED`. |
| **VERIFIED** | Логика в `backend/broadcast-service.js` (`getRecipientsForProduction`, `copyMessageWithBackoff`, `markBroadcastSuppressedForUser`). Регресс: `delete-for-all` по-прежнему только `status = 'DELIVERED'` с `delivered_message_id`. |

---

## 4. Embedded admin — «storefront вместо админки»

| | |
|---|---|
| **FACT** | Если `GET /admin-embed` не попадает в хендлер (флаги, старый процесс), срабатывает `app.get('*')` и отдаётся `frontend/index.html` (витрина). |
| **FACT** | Ранее документировалось обрезание query `h` в WebView; цепочка handoff + cookie решает авторизацию без длинного query. |
| **HYPOTHESIS** | Смесь кэша HTML и отсутствия `Telegram.WebApp` во встроенном iframe могла давать «не тот» UX (пустой экран / неверная инициализация), при ошибке маршрута — SPA. |
| **FIX** | `Cache-Control: no-store` + `Vary: Cookie` для ответа админского HTML; явные логи `[AdminEmbed]` / `[AdminAssets]`; скрипт `telegram-web-app.js` в `frontend/admin/index.html`. |
| **VERIFIED** | После деплоя в логах должны быть `[AdminEmbed] GET /admin-embed` → `[AdminEmbed] sendAdminIndexHtml branch=admin_html` → `[AdminAssets] served branch=admin_bundle` для `app.js` / `styles.css`. Не должно одновременно отдаваться только корневой бандл без этих строк. |

---

## 5. Изменённые файлы

| Файл | Изменения |
|------|-----------|
| `backend/broadcast-service.js` | Фоновая доставка, ретраи, подавление BLOCKED, логи, `getWorkerSnapshot` |
| `backend/config.js` | `BROADCAST_DELIVERY_INTERVAL_MS`, `BROADCAST_MAX_COPY_ATTEMPTS` |
| `backend/db.js` | Миграции колонок `broadcast_suppressed_*` |
| `backend/server.js` | Параметры сервиса, health/ops, заголовки админки, логи Admin, сброс подавления в `/api/user/init`, static `admin-assets` |
| `backend/telegram-update-handler.js` | Лог `[BroadcastFlow] topic trigger handled` |
| `frontend/admin/index.html` | Подключение `telegram-web-app.js` |

---

## 6. Новые логи и метрики

- `[BroadcastFlow]` — планирование кампании, старт/конец job (без секретов, с `campaignId`, `audienceSize`).
- `[BroadcastDelivery]` — прогресс батчами, `RATE_LIMIT`, retryable backoff.
- `[BroadcastSummary]` — финализация и предупреждение оставшихся `PENDING`.
- `[AdminEmbed]` — hit на `/admin-embed`, ветка авторизации; `sendAdminIndexHtml`.
- `[AdminAssets]` — выдача `app.js` / `styles.css` из admin bundle.
- `GET /api/health/ops`: `broadcastWorker`, `BROADCAST_DELIVERY_INTERVAL_MS`, `BROADCAST_MAX_COPY_ATTEMPTS`.

---

## 7. Что проверено автоматически

- `node --check backend/broadcast-service.js`

---

## 8. Что проверить вручную после деплоя

1. Тема рассылки: сообщение-триггер → в логах сначала `[TelegramWebhook] update обработан`, затем `[BroadcastFlow]` / `[BroadcastDelivery]`; итог в теме после завершения фона.
2. Mini App → Профиль → Админка: iframe, логи `[AdminEmbed]` + `[AdminAssets]`, интерфейс админки (не витрина).
3. `curl -sS https://<BASE>/api/health/ops` — наличие `broadcastWorker`, корректные флаги.
4. «Удалить рассылку у всех» для завершённой кампании с доставками.

---

## 9. Env / systemd

Обязательно в проде:

- `TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=true`
- `TELEGRAM_WEBHOOK_SECRET` согласован с `setWebhook`
- `ADMIN_MINIAPP_EMBED_ENABLED=true` если нужна встроенная админка при `ADMIN_UI_ENABLED=false`
- Опционально: `BROADCAST_DELIVERY_INTERVAL_MS` (например 55), `BROADCAST_MAX_COPY_ATTEMPTS` (например 8)
- `NODE_ENV=production` для `secure` cookie у handoff

---

## 10. Rollback

- Откатить коммит с изменениями `broadcast-service.js` / `server.js` / `config.js` / `db.js` / `telegram-update-handler.js` / `frontend/admin/index.html`.
- Новые колонки в SQLite безопасны (NULL по умолчанию); откат кода не удаляет колонки — не мешает старому коду.
- Если фоновая доставка нежелательна временно: отключить рассылки `BROADCASTS_ENABLED=false` (операционная мера).
