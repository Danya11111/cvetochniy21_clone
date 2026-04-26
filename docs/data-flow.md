# Потоки данных

## Хранилища и источники

- Локальная БД: `backend/database.sqlite` (SQLite).
- Telegram WebApp user context (`initData`/`initDataUnsafe`).
- Telegram Bot API (сообщения, callbacks, topics).
- T-Bank (payment init + webhook notify).
- МойСклад (каталог и заказный контур).

## Ключевые сущности БД

- `users` — пользователь Telegram, профиль, бонусы, legacy topic binding.
- `orders` — заказ, статус, суммы, служебные флаги идемпотентности.
- `payments` — платежные статусы/идентификаторы.
- `telegram_topics` — нормализованный реестр тем.
- `event_outbox` — очередь событий доставки.
- `broadcast_campaigns`, `broadcast_deliveries`.
- `support_threads`, `support_messages`.
- `runtime_flags`, `admin_action_logs`.
- `telegram_processed_updates` — дедуп входящих updates.

## Основной путь заказа/оплаты

1. Клиент создаёт checkout в WebApp.
2. Backend создаёт/обновляет локальный `orders`.
3. Инициируется T-Bank платеж (`paymentUrl` в ответ).
4. T-Bank webhook обновляет `payments` и `orders`.
5. На `CONFIRMED` выполняются post-paid side effects:
   - уведомление пользователю,
   - интеграционные действия,
   - event-публикация в operational контур.

## Operational-потоки Telegram

### Заказы
- Order events попадают в outbox.
- Worker доставляет уведомление в операционную тему заказов и в тему клиента.

### Поддержка
- Сообщение клиента в ЛС -> запись в support лог -> копия в личную тему клиента.
- Уведомление в support notify topic.
- Ответ менеджера из темы клиента -> relay в DM клиенту.

### Рассылки
- Сообщение админа в designated тему = старт кампании.
- Доставка по получателям через `copyMessage`.
- Summary и callback удаления у всех.
- Результаты удаления сохраняются в delivery/campaign состоянии.

## Дедуп и целостность

- Дедуп webhook updates: `telegram_processed_updates(update_id)`.
- Дедуп support relay: уникальный индекс по `(thread_id, direction, source_chat_id, source_message_id)`.
- Outbox dedupe: `dedupe_key` + статусы (`NEW`, `RETRYING`, `SENT`, `FAILED`).

