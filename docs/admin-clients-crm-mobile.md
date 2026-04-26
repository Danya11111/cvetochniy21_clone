# Экран "Клиенты" как CRM прибыли (mobile)

## Цель

Экран `Клиенты` реализован как CRM-слой прибыли, а не как справочник контактов:
- показывает ценность клиента в деньгах и повторных продажах;
- выделяет ключевые сегменты для роста выручки и возврата;
- даёт быстрые действия с телефона: открыть клиента, перейти в тему, в его заказы и поддержку.

## Структура экрана

Файл реализации: `frontend/admin/app.js` + стили `frontend/admin/styles.css`.

Экран состоит из 5 уровней:
1. Поиск по клиентам (имя, username, Telegram ID).
2. Верхний summary-strip (кликабельные KPI-сегменты):
   - всего клиентов;
   - новые;
   - повторные;
   - VIP;
   - спящие;
   - стоит вернуть.
3. Быстрые сегментные chips:
   - Все, Новые, Повторные, VIP, Спящие;
   - Высокий чек, Недавно активные, Требуют внимания;
   - С поддержкой, С темой.
4. Блок "Что важно по клиентам":
   - агрегаты по sleeping / VIP / attention / new-without-repeat / returnable.
5. CRM-карточки клиентов:
   - выручка, заказы, средний чек, последний заказ;
   - статусные бейджи и subtitle;
   - быстрые действия: `Открыть`, `Тема`, `Заказы`, `Поддержка` (если есть).

## Сегменты и rules-based логика

Сегментация рассчитывается на backend в `backend/admin-repository.js` (функция `enrichClientRow`).

### Derived fields клиента

В DTO клиента добавлены/нормализованы:
- `total_orders`
- `total_revenue`
- `avg_order_value`
- `last_order_at`
- `days_since_last_order`
- `is_new_client`
- `is_repeat_client`
- `is_vip_client`
- `is_sleeping_client`
- `is_high_value_client`
- `is_recently_active`
- `has_support_activity`
- `has_recent_broadcast_activity`
- `has_topic`
- `is_recover_candidate`
- `client_segment`
- `attention_level`
- `attention_reason`
- `customer_subtitle`

### Логика сегментов

- **Новый**: `total_orders === 1` и клиент достаточно свежий.
- **Повторный**: `total_orders >= 2`.
- **VIP**: высокий `total_revenue`, либо высокая частота, либо высокий чек на повторе.
- **Спящий**: есть заказы, но `days_since_last_order >= 30`.
- **Высокий чек**: высокий `avg_order_value` или сильный `total_revenue`.
- **Требует внимания**: например:
  - VIP + sleeping,
  - новый без второго заказа,
  - активный support-контур.
- **Активный**: недавняя покупка, нет флага sleeping.

### "Стоит вернуть"

Флаг `is_recover_candidate` ставится rules-based:
- повторный + спящий;
- VIP с заметной паузой;
- новый клиент без повтора после порогового срока.

Это используется и в summary, и в фильтре `return`.

## Summary endpoint

Добавлен endpoint:
- `GET /api/admin/clients/summary`

Реализация:
- роут: `backend/admin-routes.js`
- сборка: `adminRepository.getClientsSummary()`

Возвращает:
- `totals` (all/new/repeat/vip/sleeping/returnable);
- `segments` (highValue/recent/attention/support/topic/vipSleeping/newWithoutRepeat/active);
- `highlights` для блока "Что важно по клиентам" с action-переходами.

## Переходы и deep-link/filter-state

Экран поддерживает фильтры и action-переходы:
- `sleeping`
- `vip`
- `repeat`
- `high-value`
- `attention`
- `recent`
- + `new`, `support`, `topic`, `return`

Рабочие переходы из карточки:
- `Открыть` -> `/api/admin/clients/:telegramId` (детали в текущем этапе);
- `Тема` -> ссылка Telegram topic;
- `Заказы` -> экран `Заказы` с client-scope (`orderClientTelegramId`);
- `Поддержка` -> экран `Поддержка` с client-scope (`supportClientTelegramId`).

## Связь с Главной и Заказами

- Экран `Главная` уже использует action-переходы в `Клиенты` (в т.ч. sleeping).
- `Клиенты` теперь могут отправлять пользователя в scoped `Заказы` и scoped `Поддержку`.
- `Заказы` и `Поддержка` получили clear-действия для сброса client-scope.

## Состояния UI

Добавлены спокойные mobile-состояния:
- база клиентов пуста;
- сегмент пуст;
- поиск без результатов;
- ошибка загрузки (базовый reusable error state).

## Ограничения текущего этапа

На этом этапе не реализована глубокая полноценная карточка клиента с отдельным экраном CRM-истории и playbook-автоматизацией.
Сделан фокус на сильный мобильный CRM-слой списка клиентов, сегментации и прибыльных действий.
