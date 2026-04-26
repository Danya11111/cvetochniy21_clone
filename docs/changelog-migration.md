# Журнал миграции (кратко)

## Этап 1 — EventPublisher

- Введён единый publisher-слой.
- Прямые Sambot-вызовы убраны из endpoint-логики.
- Сохранена обратимость через feature flags.

## Этап 2 — Telegram Topics operational layer

- Добавлены topics registry, outbox, worker.
- Реализованы broadcasts/support relay/order topic notifications.
- Добавлены соответствующие таблицы и индексы.

## Этап 3 — Admin panel

- Добавлен admin mini-SPA.
- Добавлены admin API, permissions, runtime flags, audit logs.

## Этап 4 — Production hardening

- Усилены идемпотентность, retry/recovery, классификация Telegram ошибок.
- Добавлены health/reprocess механизмы.
- Выполнен pre-production pass и локализация операторского слоя.

## Этап 5 — Полное удаление Sambot

- Удалён Sambot provider и все Sambot runtime-вызовы.
- Удалены Sambot env/flags из конфигурации.
- Sambot-specific идемпотентность убрана из runtime-логики.
- Документация обновлена под post-Sambot состояние.

## Текущий статус

- Проект готов к контролируемому rollout по флагам.
- Sambot полностью исключён из runtime-проекта.

