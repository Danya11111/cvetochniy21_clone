# Карточка клиента: LTV и удержание (mobile-first)

## Что реализовано

Карточка клиента переведена в отдельный owner/CRM detail-screen (`client_detail`) и теперь показывает:
- ценность клиента в деньгах;
- стадию удержания и риск потери;
- историю взаимодействия (заказы, поддержка, события);
- рекомендации "что делать дальше" с CTA.

Реализация:
- frontend: `frontend/admin/app.js`, `frontend/admin/styles.css`;
- backend DTO: `backend/admin-repository.js` (endpoint `GET /api/admin/clients/:telegramId`).

## Структура detail-screen

1. **Hero секция**
   - имя/username;
   - выручка от клиента;
   - story subtitle;
   - сегмент/стадия/приоритет;
   - заказы + средний чек.

2. **Секция "Ценность клиента"**
   - принес выручки;
   - всего заказов;
   - средний чек;
   - первый заказ;
   - последний заказ;
   - дней с последнего заказа.

3. **Секция "На что обратить внимание"**
   - причина внимания;
   - retention stage;
   - value tier;
   - support touch и recent broadcast touch.

4. **Секция "Что делать с этим клиентом"**
   - rules-based рекомендации;
   - приоритет;
   - CTA/next action.

5. **Timeline блок (табы)**
   - `Заказы` (последние заказы);
   - `Поддержка` (последние thread события);
   - `Активность` (компактный mixed timeline order/support/broadcast).

6. **Sticky actions**
   - назад в сегмент;
   - открыть тему (если есть);
   - перейти в поддержку клиента.

## Derived fields в detail DTO

`GET /api/admin/clients/:telegramId` возвращает:
- `profile`:
  - `total_revenue`, `total_orders`, `avg_order_value`;
  - `first_order_at`, `last_order_at`, `days_since_last_order`;
  - `is_new_client`, `is_repeat_client`, `is_vip_client`, `is_sleeping_client`, `is_high_value_client`;
  - `is_recover_candidate`, `has_support_activity`, `has_topic`;
  - `value_tier`, `retention_stage`, `action_priority`;
  - `client_story_subtitle`.
- `recommended_actions[]`
- `last_orders[]`
- `support_summary`
- `recent_events[]`
- `support_threads[]`, `support_messages[]` (light payload для detail).

## Как считаются retention_stage / value_tier / action_priority

Логика rules-based, прозрачная:

- `value_tier`
  - `vip`: если клиент в VIP-сегменте;
  - `high`: если high-value, но не VIP;
  - `standard`: остальные.

- `retention_stage`
  - `new`: новый клиент;
  - `at_risk`: VIP + спящий;
  - `sleeping`: давно не покупал;
  - `loyal`: повторный и недавно активный;
  - `active`: остальные активные.

- `action_priority`
  - `critical`: VIP-спящий или активная поддержка;
  - `important`: recover candidate / выраженный attention;
  - `normal`: без острых рисков.

## Как формируются recommended_actions

Рекомендации собираются rules-based из состояния клиента:
- возврат VIP (critical);
- довести нового до второго заказа (important);
- усилить repeat/upsell (normal);
- закрыть активную поддержку (critical);
- использовать готовый канал контакта (topic);
- маркетинговый touch через сегмент/рассылки.

Каждая рекомендация содержит:
- `title`
- `message`
- `priority`
- `ctaLabel`
- `action` (screen + filters для существующей навигации).

## Как устроен timeline

`recent_events[]` — объединенная лента по времени:
- события заказов;
- события поддержки;
- события рассылок.

Показываются только свежие и полезные элементы (короткий mobile-first срез, без "простыни").

## Как карточка повышает LTV и повторные продажи

Карточка делает ценность клиента управляемой:
- сразу видны деньги, стадия удержания и риск;
- понятны причины внимания и приоритет действий;
- есть короткий playbook (что делать прямо сейчас);
- есть быстрые переходы к операционным действиям (заказы/поддержка/тема/маркетинг).

Итог: карточка работает как управленческий CRM-профиль, а не как анкета клиента.
