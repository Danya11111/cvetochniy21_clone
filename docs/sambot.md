# Sambot: финальный статус

## Итог

Sambot полностью исключён из runtime-проекта.

## Что удалено

- Sambot provider из `event-publisher.js`.
- Файл `backend/publishers/sambot-publisher.js`.
- Конфигурационные ключи и флаги Sambot (`SAMBOT_*`, `PUBLISH_TO_SAMBOT`, `SAMBOT_ENABLED`).
- Sambot-specific ветки идемпотентности в `tbank.js`.
- Runtime-использование `paid_sambot_sent`.

## Что осталось как исторический след

- Возможна физическая колонка `orders.paid_sambot_sent` в уже существующих БД.
  - Колонка не используется runtime-кодом и не участвует в логике.
  - Удаление колонки в SQLite отложено как отдельная безопасная миграция данных.

## Что заменяет Sambot

- Внутренний event-контур (`event-publisher` + outbox).
- Telegram Topics operational слой:
  - order notifications,
  - support relay,
  - broadcasts + delete-for-all.
- Admin наблюдаемость и reprocess-инструменты.

## Подтверждение

После удаления в backend нет активных импортов, вызовов, флагов или URL, связанных с Sambot.

