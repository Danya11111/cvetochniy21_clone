# Ручное исправление заказа, ошибочно помеченного как оплаченный

Исторически при оформлении в колонку `orders.total_paid` попадала **сумма к оплате** (до webhook Т-Банка). Админка и SQL считали `total_paid > 0` признаком оплаты, из‑за чего неоплаченные заказы могли отображаться как «Оплачен» и попадать в выручку.

В актуальном коде:

- до подтверждения оплаты `total_paid = 0`;
- после `CONFIRMED` webhook выставляются `status = PAID` и `total_paid` = сумма из `payments.amount`.

## Диагностика (production, без вывода ПДн)

Снимок по заказу (подставьте id и путь к БД на сервере):

```bash
F21_SQLITE_PATH=/abs/path/f21.sqlite node scripts/maintenance/inspect-order-payment.js --id=196
```

Общий аудит подозрительных строк:

```bash
F21_SQLITE_PATH=/abs/path/f21.sqlite node scripts/maintenance/audit-payment-revenue.js
```

## Пример: тестовый заказ не оплачен в Т-Банке, но в админке «Оплачен»

Перед правкой убедитесь, что в `payments` **нет** строки со `status = 'CONFIRMED'` для этого `order_id`. Если была только инициализация (`NEW` / `FORM_SHOWED` и т.п.) — заказ не считаем оплаченным.

**Безопасный откат только для ошибочно помеченного неоплаченного заказа** (замените `:id`):

```sql
BEGIN;
SELECT id, status, total, total_paid FROM orders WHERE id = :id;
SELECT id, payment_id, amount, status FROM payments WHERE order_id = :id ORDER BY id DESC;

UPDATE orders
SET status = 'PENDING_PAYMENT',
    total_paid = 0
WHERE id = :id
  AND UPPER(TRIM(COALESCE(status,''))) IN ('PAID','COMPLETED','DELIVERED')
  AND NOT EXISTS (
    SELECT 1 FROM payments p
    WHERE p.order_id = orders.id AND UPPER(TRIM(COALESCE(p.status,''))) = 'CONFIRMED'
  );

COMMIT;
```

Если оплата заведомо не будет завершена, можно заменить статус на `PAYMENT_FAILED` вместо `PENDING_PAYMENT` по бизнес-решению.

Не изменяйте строки, где webhook уже зафиксировал `CONFIRMED`, без ручной сверки с личным кабинетом Т-Банка.
