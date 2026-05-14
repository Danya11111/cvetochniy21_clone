# Telegram: супергруппа‑форум и служебные темы

В production один и тот же `chat_id` супергруппы‑форума задаётся как `TELEGRAM_SUPERGROUP_ID` (или `TELEGRAM_FORUM_GROUP_ID`; см. приоритеты в `backend/config.js`). В коде отправки поддерживаются три «операционные» темы внутри этой группы:

1. **Заказы** — `TELEGRAM_TOPIC_ORDERS_ID` (legacy fallback: `TELEGRAM_ORDERS_NOTIFY_THREAD_ID`, `TELEGRAM_ORDERS_THREAD_ID`).
2. **Поддержка** — `TELEGRAM_TOPIC_SUPPORT_ID` (legacy: `TELEGRAM_SUPPORT_NOTIFY_THREAD_ID`, `TELEGRAM_SUPPORT_THREAD_ID`).
3. **Рассылки** — `TELEGRAM_TOPIC_BROADCASTS_ID` (legacy: `TELEGRAM_BROADCAST_TOPIC_THREAD_ID`, `TELEGRAM_BROADCASTS_THREAD_ID`).

Отдельной служебной темы **«Брошенные корзины» не требуется и не нужна**:

- Сервер продолжает хранить снимки корзин в SQLite (`abandoned_carts`) и показывает их в админ‑Mini App даже без форумной темы.
- Уведомления в Telegram включены **только** если задан ненулевой `TELEGRAM_TOPIC_ABANDONED_CARTS_ID` и не выставлен принудительный выключатель `ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED=false`.

Пользовательские/личные сценарии (например, welcome / «Позвать менеджера») не должны опираться на отдельный abandoned‑topic форума: для клиента используются **личные сообщения бота** и существующий поток поддержки.

Отдельные служебные ошибки (если появится явная отправка) могут использовать `TELEGRAM_TOPIC_ERRORS_ID`; если он пустой, маршрутизация ошибок может совпасть с темой поддержки (см. `TELEGRAM_ERRORS_NOTIFY_THREAD_ID` в `backend/config.js`).
