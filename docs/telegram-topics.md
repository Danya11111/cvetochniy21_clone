# Telegram Topics и operational-контур

## Назначение

Telegram Topics используются как основной операционный слой для:
- уведомлений по заказам,
- рассылок,
- поддержки.

## Основные компоненты

- `telegram_topics` — реестр тем и маршрутизации.
- `telegram-routing-service.js` — bridge между legacy `users.topic_id` и новой моделью.
- `event_outbox` + `outbox-worker` — надежная асинхронная доставка.
- `telegram-update-handler.js` — обработка webhook updates/callbacks.

## Рассылки

Сценарий:
1. Trusted admin публикует сообщение в тему рассылок.
2. Создаётся кампания и список доставок.
3. Бот копирует сообщение получателям (`copyMessage`).
4. В тему рассылок отправляется summary.
5. Кнопка `Удалить рассылку у всех` запускает массовое удаление и итог удаления.

Контроль:
- дедуп запуска кампании;
- устойчивость к повторным callback;
- учёт `BLOCKED` / `FAILED` / `DELETED`.

## Поддержка

Сценарий:
1. Клиент пишет в бот.
2. Сообщение отражается в личной теме клиента.
3. В notify-тему поддержки уходит компактное уведомление.
4. Менеджер отвечает из темы клиента.
5. Ответ релеится клиенту в DM.

Контроль:
- self-loop защита для bot-origin сообщений;
- дедуп relay;
- понятные системные ошибки при недоставке.

## Уведомления по заказам

Сценарий:
- новый заказ/событие оплаты публикуется:
  - в операционную тему заказов,
  - в личную тему клиента.

Важно:
- это operational-слой, не источник истины платежа;
- падение topic-доставки не должно ломать фиксацию оплаты.

## Feature flags (критичные)

- `TELEGRAM_TOPICS_ENABLED`
- `EVENT_OUTBOX_ENABLED`
- `OUTBOX_WORKER_ENABLED`
- `BROADCASTS_ENABLED`
- `BROADCAST_DELETE_ENABLED`
- `SUPPORT_RELAY_ENABLED`
- `ORDERS_TOPIC_NOTIFICATIONS_ENABLED`
- `CLIENT_TOPIC_REPLY_ENABLED`

