# Денежная модель (cvetochny21_tg)

## Канон

- **Внутренние расчёты и админ-метрики:** целые **копейки** (integer).
- **Отображение «N ₽»:** фронт админки — `formatKopecksAsRub` (`frontend/admin/app.js`); бэкенд (строки, Telegram) — `formatKopecksRu` / `kopecksToWholeRub` в `backend/money.js`.
- **Витрина (mini app):** цены и `orders.total` в ответах пользователю — **рубли**, как раньше.

## Таблица полей SQLite

| Место | Поле | Единицы | Примечание |
|-------|------|---------|------------|
| orders | total | рубли | При новом checkout = total_paid/100 |
| orders | total_paid | копейки | Сумма к оплате/оплачено |
| orders | total_before_bonus | копейки | До списания бонусов |
| orders | bonuses_used | копейки | Списано бонусами |
| orders | bonus_earned | копейки | 5% от оплаты до конвертации в рубли бонусов |
| payments | amount | копейки | T-Bank |
| users | bonus_balance | рубли | Целые рубли на счёте бонусов |

## Связь со статусами заказа

См. `backend/ORDER_STATUS_MODEL.md` и `backend/order-status.js` (платёжный `status` vs `ms_state_name`).

## Код

- Общие функции: `backend/money.js`.
- Нормализация строк заказа для админки: `admin-repository.js` + `orderAmountKopecksFromRow` / SQL `sqlOrderPaidRevenueKopecks`.

## Админ API (JSON)

Числовые денежные поля в ответах `/api/admin/*` — **целые копейки**, если не оговорено иначе:

- `order.amount_kopecks` (канон для суммы строки заказа), `highlights[].amount` для денежных карточек заказов
- `total_revenue`, `avg_order_value` у клиента, `client_lifetime_value_stub`, `client_total_revenue`
- `hero.revenueToday`, `money.revenue7d`, `money.revenue30d`, `frozenRevenue`, `totalFrozenRevenue`, ряды графиков `revenue` / `avgCheck`
- `last_orders[].amount` в карточке клиента

Объекты потерь на главной: при `money_minor: true` поле `amount` — копейки (см. `losses.items` в mobile-summary).

Сырые поля БД `orders.total` (рубли) и `orders.total_paid` (копейки) могут приходить в JSON из‑за `...row` в enrich; **для UI админки использовать только нормализованные поля выше**, не смешивать с отображением.
