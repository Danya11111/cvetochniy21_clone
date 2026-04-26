# Эксплуатация: rollout / rollback / incidents

## Rollout (рекомендуемый порядок)

1. Baseline: checkout/payment без новых контуров.
2. Topics registry.
3. Outbox + order topic notifications (shadow/контролируемо).
4. Support relay.
5. Broadcasts + delete-for-all.
6. Подтвердить стабильность post-Sambot контуров (без внешнего fallback).

## Что мониторить

- Успешность checkout и `CONFIRMED` webhook.
- Outbox: `NEW`, `RETRYING`, `FAILED`.
- Broadcast delivery counters: delivered/blocked/failed.
- Support relay ошибки.
- `/api/admin/health` (включая orphan counters).
- `GET /api/health/ops` — компактно: флаги операционных контуров и факт настройки thread id (без секретов); см. `docs/production-runtime-audit-fixes-ru.md`.

## Быстрый rollback

1. Выключить Stage2 operational flags.
2. Остановить outbox-процессинг (`OUTBOX_WORKER_ENABLED=false`, `EVENT_OUTBOX_ENABLED=false`).
3. Перезапустить backend.
4. Проверить baseline checkout/payment/MoySklad.

## Incident runbook (кратко)

- **Failed broadcast**: проверить кампанию, причины ошибок, повторить безопасно.
- **Blocked bot spike**: фиксировать как пользовательское состояние, не ретраить агрессивно.
- **Rate limit**: избегать массовых запусков, ждать retry.
- **Support relay failure**: проверить thread/messages и причину недоставки.
- **Order topic notify failure**: reprocess outbox через admin API/UI.

## Pre-release дисциплина

Перед релизом обязательно пройти чеклисты из `testing.md`, в первую очередь payment и admin access.

