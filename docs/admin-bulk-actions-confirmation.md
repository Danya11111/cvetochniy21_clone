# Единый confirmation layer для bulk/high-impact действий

## Задача этапа

Добавлен единый mobile-first слой подтверждения для действий, где есть риск:
- массового эффекта,
- необратимого изменения коммуникации,
- случайного запуска из-за двойного тапа на телефоне.

Цель: безопасно подтверждать важные действия без лишней бюрократии.

## Аудит действий: что найдено

### 1) Массовые / коммуникационные
- `playbook repeat_strong_campaign` (campaign reuse flow)
- `playbook lost_reach_reduction` (работа с проблемными кампаниями)
- (future) отправка рассылки из админки — пока в текущем UI нет отдельного send-form, но слой подтверждения готов к подключению.

### 2) Деструктивные
- `broadcast-delete` → `POST /api/admin/broadcasts/:id/delete-for-all`

### 3) High-impact operational
- `save-flags` → `PATCH /api/admin/feature-flags`
- `outbox-reprocess` → `POST /api/admin/outbox/:id/reprocess`

Безопасная навигация, фильтры, переходы по спискам и открытие карточек подтверждением не перегружаются.

## Reusable confirmation pattern

Внедрён единый reusable компонент:
- **mobile confirmation bottom sheet** (`confirm-overlay` + `confirm-sheet`)
- поддержка полей:
  - `title`
  - `message`
  - `impact_summary`
  - `severity` (`normal` / `high` / `destructive`)
  - `confirm_label`
  - `cancel_label`
  - `secondary_note`
  - `count_summary` (опционально)
  - `irreversible_warning` (опционально)
  - `loading`/disabled состояние

UX:
- крупные кнопки;
- safe-area friendly;
- визуальное разделение destructive CTA;
- без browser `confirm()`.

## Где добавлены подтверждения

### Destructive confirm
- `Удалить у всех` в рассылках и карточке рассылки:
  - явно объясняется, что система попытается удалить уже доставленные сообщения;
  - есть предупреждение о потенциальной необратимости.

### High-impact confirm
- запуск playbook-сценариев:
  - `repeat_strong_campaign`
  - `lost_reach_reduction`
- сохранение runtime flags (`save-flags`)

### Normal confirm
- `outbox-reprocess` (повторная обработка события)

## Как защищён broadcast send flow

В текущем admin UI нет отдельной формы фактической отправки рассылки (send action не реализован как отдельный экран/кнопка).
Для всех текущих communication-sensitive entry points добавлен high-impact confirm через единый sheet.

Когда send-flow будет добавлен, он должен использовать тот же pattern с заголовком:
- `Подтвердите отправку рассылки`
и summary:
- аудитория,
- масштаб,
- наличие медиа,
- confirm CTA `Подтвердить отправку`.

## Как защищён delete-for-all

`broadcast-delete` теперь:
- не использует `window.confirm`;
- запускается только через destructive bottom sheet;
- имеет ясный consequence-text;
- имеет отдельный destructive CTA.

## Защита от double submit

Добавлен in-flight guard:
- `runGuardedAction(actionKey, handler)`
- повторный запуск того же actionKey блокируется, пока действие выполняется.

Покрыто для:
- `broadcast-delete-{id}`
- `save-flags`
- `outbox-reprocess-{id}`

Также на этапе подтверждения:
- confirm-кнопка уходит в loading;
- кнопки блокируются до завершения операции.

## Что может потребовать подтверждения в будущем

- реальный send-flow рассылки (обязательный high-impact confirm);
- любые новые bulk-команды по сегментам клиентов;
- массовые статусы/изменения заказов;
- новые коммуникационные playbook действия с фактическим запуском отправки.

## Файлы изменений

- `frontend/admin/app.js`
- `frontend/admin/styles.css`
- `docs/admin-bulk-actions-confirmation.md`
