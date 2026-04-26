# Цветочный 21

Telegram WebApp + Node.js backend для оформления и оплаты заказов цветов, синхронизации с МойСклад и операционной работы через Telegram Topics (заказы, рассылки, поддержка) с административной панелью.

## Что внутри проекта

- `backend/` — API, платежи, интеграции, Telegram Bot API, outbox/worker, admin API.
- `frontend/` — Telegram WebApp (клиентский интерфейс) и `frontend/admin/` (admin mini-SPA).
- `docs/` — актуальная проектная документация (single source of truth).
- `backend/database.sqlite` — локальная SQLite база (создаётся/расширяется runtime-миграциями из `backend/db.js`).

## Ключевые интеграции

- Telegram WebApp (`window.Telegram.WebApp`).
- Telegram Bot API (topics, messages, callbacks, support relay, broadcasts).
- T-Bank (инициализация платежа и webhook-обработка статусов).
- МойСклад (каталог, заказы, статусы, связанные операции).
- Sambot удалён из runtime проекта.

## Где искать документацию

- Архитектура: `docs/architecture.md`
- Потоки данных: `docs/data-flow.md`
- Telegram topics / broadcasts / support / orders: `docs/telegram-topics.md`
- Платежный контур и проверка регрессий: `docs/payment-flow.md`
- Админ-панель: `docs/admin-panel.md`
- Доступ в админку: `docs/admin-access.md`
- Отчёт по удалению Sambot: `docs/sambot.md`, `docs/SAMBOT_REMOVAL_REPORT_RU.md`
- Эксплуатация (rollout/rollback/runbook): `docs/operations.md`
- Тестовые и pre-release проверки: `docs/testing.md`
- Русификация: `docs/localization.md`
- История этапов миграции: `docs/changelog-migration.md`
- Навигатор по документации: `docs/README.md`

## Быстрый старт для нового разработчика

1. Прочитать этот `README.md`.
2. Прочитать `docs/architecture.md`.
3. Прочитать `docs/payment-flow.md` (критичный контур).
4. Прочитать `docs/telegram-topics.md`.
5. Прочитать `docs/admin-access.md` и `docs/admin-panel.md`.
6. Перед релизом использовать `docs/operations.md` + `docs/testing.md`.

## Текущий статус (кратко)

- Stage 1/2 реализованы: EventPublisher, topics/outbox, broadcasts/support/orders, admin panel.
- Доступ в админку основан на Telegram identity (`initData` + allowlist по `telegram_id`).
- Основной admin allowlist по умолчанию: `67460775`.
- Telegram Topics и часть новых контуров включаются флагами.
- Sambot полностью исключён из runtime.

