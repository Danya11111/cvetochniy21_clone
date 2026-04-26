# Документация проекта

Этот каталог — единый источник актуальной документации по проекту «Цветочный 21».

## Содержание

- `architecture.md` — архитектура, модули, зависимости, интеграции, риски.
- `data-flow.md` — потоки данных, сущности, ключевые таблицы и связи.
- `telegram-topics.md` — operational-контур: topics, рассылки, поддержка, уведомления заказов.
- `payment-flow.md` — платежный контур (checkout/init/notify/paid), регрессионные проверки.
- `admin-panel.md` — устройство admin mini-SPA и backend admin API.
- `admin-access.md` — модель доступа в админку на основе Telegram identity.
- `sambot.md` — финальный статус Sambot после полного удаления.
- `SAMBOT_REMOVAL_REPORT_RU.md` — детальный отчёт по удалению Sambot.
- `POST_SAMBOT_REGRESSION_CHECKLIST_RU.md` — smoke-проверки после удаления Sambot.
- `operations.md` — rollout, rollback, runbook и preprod-подход.
- `testing.md` — smoke/e2e/idempotency чеклисты и pre-release проверки.
- `localization.md` — статус русификации и правила поддержки текстов.
- `changelog-migration.md` — краткая хронология этапов миграции.
- `DOCUMENTATION_STRUCTURE_REPORT_RU.md` — отчёт по реорганизации документации.

## Что читать по ролям

### Backend-разработчик
1. `architecture.md`
2. `payment-flow.md`
3. `telegram-topics.md`
4. `admin-access.md`

### Release/оператор
1. `operations.md`
2. `testing.md`
3. `sambot.md`

### Перед релизом
1. `operations.md`
2. `testing.md`
3. `payment-flow.md`

### При проблемах с оплатой
1. `payment-flow.md`
2. `operations.md`

### При проблемах с Telegram topics / broadcasts / support
1. `telegram-topics.md`
2. `operations.md`
3. `testing.md`

