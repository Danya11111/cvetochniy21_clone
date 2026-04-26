# SAMBOT_REMOVAL_REPORT_RU

## 1) Что было найдено перед удалением

### Runtime-код

- `backend/event-publisher.js`
  - Sambot target-ветки;
  - импорт `publishers/sambot-publisher`.
- `backend/publishers/sambot-publisher.js`
  - HTTP GET доставка в Sambot URL.
- `backend/tbank.js`
  - Sambot-specific идемпотентность через `paid_sambot_sent`;
  - Sambot-oriented логика `onPaid`.
- `backend/config.js`
  - `SAMBOT_URL_PAID`
  - `SAMBOT_URL_CHECKOUT`
  - `PUBLISH_TO_SAMBOT`
  - `SAMBOT_ENABLED`
- `backend/runtime-flags-service.js`
  - `SAMBOT_ENABLED` в `managedKeys`.
- `backend/db.js`
  - runtime ensureColumn для `orders.paid_sambot_sent`.

### Документация

Были упоминания о Sambot как fallback в:
- `README.md`
- `docs/README.md`
- `docs/architecture.md`
- `docs/payment-flow.md`
- `docs/operations.md`
- `docs/changelog-migration.md`
- `docs/sambot.md`

## 2) Что удалено

- Полностью удалён файл:
  - `backend/publishers/sambot-publisher.js`
- Полностью удалены Sambot env/config ключи:
  - `SAMBOT_URL_PAID`
  - `SAMBOT_URL_CHECKOUT`
  - `PUBLISH_TO_SAMBOT`
  - `SAMBOT_ENABLED`
- Удалён runtime-учёт `SAMBOT_ENABLED` из `runtime-flags-service`.
- Удалены Sambot-specific ветки и логи из `event-publisher.js` и `tbank.js`.

## 3) Что переписано

### `backend/event-publisher.js`
- Убран multi-target путь с Sambot provider.
- Сохранён внутренний event-слой с controlled no-op и outbox enqueue.

### `backend/tbank.js`
- Убрана Sambot-specific идемпотентность и rollback-флаг.
- `onPaid` теперь публикуется в внутренний event-контур, где дедуп делается через outbox `dedupe_key`.

### `backend/db.js`
- Удалено runtime-добавление колонки `paid_sambot_sent`.

## 4) Что сделано с `paid_sambot_sent`

- Зависимость runtime-кода от `paid_sambot_sent` полностью убрана.
- В существующих инсталляциях колонка может физически остаться в SQLite как legacy residue.
- Колонка не используется ни в одном runtime-пути.

## 5) Изменённые runtime-пути

- Checkout event:
  - больше не имеет внешнего Sambot-target.
  - работает через внутренний publisher/outbox контур.
- Paid event:
  - больше не завязан на Sambot-гейт.
  - публикуется в event-контур с generic дедупом.

## 6) Итоговая зависимость после удаления

### Runtime dependency на Sambot
**Отсутствует.**

### Допустимые исторические следы
- В документации Sambot упоминается только как уже удалённый контур.
- В БД может оставаться неиспользуемая legacy-колонка `paid_sambot_sent` в старых файлах SQLite.

