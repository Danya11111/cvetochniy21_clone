# Статусы заказа и смежные сущности

## Источники истины

| Сущность | Канон | Примечание |
|----------|--------|------------|
| Оплата (локально) | `orders.total_paid` (копейки), `payments.amount` | T-Bank Init / webhook |
| Платёжный этап заказа | `orders.status` для значений из приложения | `PENDING_PAYMENT`, `AUTHORIZED`, `PAID`, `CANCELLED` |
| Стадия в МойСклад | `orders.ms_state_name` | Только текст из MS (`state.name`), **не** перезаписывает `orders.status` |
| Поддержка | `support_threads.status`, `first_response_at` | `OPEN` / `PENDING` + отсутствие первого ответа → «ждёт ответа» в агрегатах главной |

## Правила отображения в админке

Вычисляется в `backend/order-status.js` → `deriveOrderAdminPresentation(row)`:

1. Если есть оплата (`total_paid > 0`) или статус `PAID` / `COMPLETED` / `DELIVERED` → бейдж **«Оплачен»**.
2. Иначе `PENDING_PAYMENT` → **«Ждёт оплаты»**.
3. Иначе `AUTHORIZED` → **«Оплата авторизована»**.
4. Иначе отмена/ошибка → **«Отменён / ошибка»**.
5. Иначе (в т.ч. старые строки, где в `status` попало русское имя из MS) → показываем `ms_state_name` или сырой `status` как подпись этапа, тон `info`.

Поле `status` в JSON заказа остаётся сырым из БД для отладки; UI опирается на `status_label` / `status_tone` / `status_code`.

## Синхронизация МойСклад

`syncOrderStatusesFromMoySkladForUser` обновляет только `ms_state_name`, чтобы не ломать платёжный контур и KPI.
