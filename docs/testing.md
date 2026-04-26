# Тестирование и чеклисты

## Базовый smoke (минимум)

1. Backend стартует при целевой комбинации флагов.
2. Checkout создаёт заказ и возвращает `paymentUrl`.
3. `CONFIRMED` webhook корректно фиксирует оплату.
4. Повторный webhook не создаёт дубли критичных side-effects.

## Telegram operational проверки

### Orders
- Уведомление приходит в тему заказов и в тему клиента.

### Support relay
- Клиент -> тема клиента.
- Менеджер из темы клиента -> DM клиенту.
- Нет self-loop и дублей.

### Broadcasts
- Кампания стартует только в нужной теме и от trusted admin.
- Summary корректен.
- delete-for-all работает и повторный callback не ломает состояние.

## Admin проверки

- Кнопка `Админка` видна только allowlisted admin.
- `/admin` и `/api/admin/*` deny для неadmin.
- Разделы админки открываются и отображают данные.
- Reprocess outbox работает.

## Pre-release checklist (минимум)

Перед релизом выполнить:
1. Payment smoke (checkout -> paid -> webhook retry без дублей).
2. Admin access smoke (allowlisted admin / неadmin direct deny).
3. Topics smoke (orders/support/broadcast при целевых флагах).

## Post-Sambot checklist

После удаления Sambot использовать:
- `POST_SAMBOT_REGRESSION_CHECKLIST_RU.md`

## Что тестировать при изменениях auth/безопасности

1. Валидацию Telegram `initData` (валидный/битый/просроченный).
2. Ограничение доступа по `telegram_id` allowlist.
3. Fail-closed поведение при отсутствии Telegram контекста.

