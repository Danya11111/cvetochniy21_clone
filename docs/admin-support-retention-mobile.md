# Экран "Поддержка" как retention-инструмент (mobile)

## Цель

Экран `Поддержка` реализован как сервисный слой удержания клиентов:
- показывает риск потери из-за задержек ответа;
- выделяет VIP/новых/ценных клиентов в поддержке;
- помогает быстро открыть критичные диалоги и связанные действия.

## Структура экрана

Реализация:
- `frontend/admin/app.js`
- `frontend/admin/styles.css`

Экран состоит из:
1. Hero summary (`Сервисный пульс`): активные, ждут ответа, критичные, VIP, скорость реакции.
2. Кликабельный summary strip:
   - активные,
   - ждут ответа,
   - критичные,
   - VIP,
   - новые.
3. Быстрые фильтры:
   - Все, Ждут ответа, Критичные, VIP, Новые, Повторные,
   - Активные, Закрытые, С заказами, Требуют внимания.
4. Блок `Что важно по поддержке`.
5. Блок `Риск потери клиента` (top risk dialogs).
6. Карточки диалогов с urgency, сегментом клиента и быстрыми действиями.

## Summary metrics

Новый endpoint:
- `GET /api/admin/support/summary`

Возвращает:
- `totals`:
  - `total`, `active`, `waiting`, `critical`,
  - `vip`, `newClients`,
  - `avgFirstResponseMinutes`, `avgWaitingMinutes`.
- `segments`:
  - `repeat`, `withOrders`, `attention`, `closed`, `waitingRisk`.
- `lossRisk`:
  - `waitingTooLong`, `vipWaiting`, `newWaiting`,
  - `topRiskDialogs[]`.
- `highlights[]` с CTA и action-переходами.

## Derived support fields

Список диалогов (`GET /api/admin/support/threads`) enriched полями:
- `waiting_minutes`
- `is_waiting_response`
- `is_critical`
- `is_vip_client`
- `is_new_client`
- `is_repeat_client`
- `is_sleeping_client`
- `client_total_revenue`
- `client_orders_count`
- `has_recent_order`
- `latest_order_id`
- `support_attention_level`
- `support_attention_reason`
- `support_subtitle`
- `support_priority_score`
- `topic_link`

## Как определяется critical / waiting / VIP-risk

Rules-based логика (без ML):

- `waiting`:
  - диалог в статусе `OPEN/PENDING`;
  - есть ожидание ответа поддержки.

- `critical`:
  - VIP-клиент ждет ответа;
  - новый клиент долго ждет;
  - клиент с недавним заказом долго без реакции;
  - очень длинное ожидание.

- `important`:
  - ожидание выше порога;
  - повторный клиент без ответа.

- `VIP-risk`:
  - VIP-клиенты в статусе ожидания;
  - агрегируется в summary и блоке риска.

## Блок риска потери клиента

Показывает:
- сколько клиентов ждут слишком долго (`waitingTooLong`);
- сколько VIP в ожидании (`vipWaiting`);
- сколько новых в ожидании (`newWaiting`);
- топ приоритетных диалогов (`topRiskDialogs`) по `support_priority_score`.

Это rules-based и честная эвристика для управленческого приоритета.

## Карточка диалога и действия

Карточка показывает:
- имя клиента;
- subtitle по смыслу риска;
- ожидание в минутах;
- статус и бейджи (VIP/новый/повторный/недавний заказ);
- revenue/orders контекст клиента;
- причину внимания.

Доступные действия:
- `Тема` (если есть link);
- `Клиент` (переход в `client_detail`);
- `Заказы` (scope по клиенту);
- `Открыть` (detail диалога).

## Связь с Главной, Клиентами и Заказами

Поддержаны deep-link/filter-state:
- `waiting`
- `critical`
- `vip`
- `new`
- `repeat`
- `attention`
- `active`
- `with_orders`

Из клиентской карточки и блоков внимания можно перейти в scoped поддержку (`supportClientTelegramId`).

## Ограничения текущего этапа

Не реализованы на этом шаге:
- enterprise helpdesk workflow;
- SLA-конструктор;
- авто-назначения операторов;
- workforce планирование.

Фокус: мобильный retention-control экран поддержки для собственника и управляющего.
