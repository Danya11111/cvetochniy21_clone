# Проверка Telegram topic flows (RU)

## Scope проверки

Проверяются 4 ключевых потока:
1. Тема Заказы
2. Тема Поддержка
3. Тема Рассылки
4. Личные темы клиентов

Проверка основана на code-path ревью и expected behavior.

## 1) Тема Заказы

### Code points
- `backend/order-topic-notification-service.js`
  - `notifyOrderInTopics()`
  - `notifyOrderPaid()`
- `backend/server.js`
  - wiring `createOrderTopicNotificationService(...)`

### Expected behavior
- При новом заказе:
  - уведомление уходит в orders topic;
  - есть кнопка `Перейти в тему клиента`;
  - в личную тему клиента отправляется подробная карточка заказа.
- При оплате:
  - в личную тему клиента отправляется подтверждение оплаты.

### Успешный результат
- Сообщения в orders topic и личной теме клиента присутствуют;
- topic link валиден.

## 2) Тема Поддержка

### Code points
- `backend/support-service.js`
  - `handleClientMessage()`
  - `handleManagerMessage()`
- `backend/telegram-update-handler.js`
  - private -> `handleClientMessage`
  - group topic -> `handleManagerMessage`

### Expected behavior
- Сообщение клиента в личку бота:
  - копируется в личную тему клиента;
  - в support notify topic приходит операторское уведомление.
- Ответ менеджера в теме клиента:
  - копируется клиенту в личный чат;
  - при ошибке в тему приходит диагностическое сообщение.

### Успешный результат
- Двусторонний relay работает;
- потеря маршрута в topic mapping отсутствует.

## 3) Тема Рассылки

### Code points
- `backend/telegram-update-handler.js`
  - `broadcastService.isBroadcastTopicMessage(...)`
  - `broadcastService.startCampaignFromTopicMessage(...)`
- `backend/broadcast-service.js`
  - запуск кампании из topic message;
  - summary в ту же тему;
  - `deleteCampaignMessages(...)`

### Expected behavior
- Сообщение в designated broadcast topic запускает кампанию.
- После отправки приходит summary в этот же topic.
- Delete-for-all работает по callback-кнопке и пишет итог.

### Дополнительно (исправлено в этом pass)
- Уточнена логика duplicate/fresh campaign, чтобы новая кампания не помечалась дублем сразу после создания.

## 4) Личные темы клиентов

### Code points
- `backend/telegram-routing-service.js`
  - `ensureClientTopic()`
  - `findClientByTopic()`
  - `buildTopicLink()`
- `backend/server.js`
  - `bootstrapOperationalTopics()`

### Expected behavior
- Для клиента создаётся/находится стабильная topic mapping запись.
- Orders/Support используют единый client topic.
- Переходы по topic link из admin и notify сообщений валидны.

### Успешный результат
- Личная тема клиента остаётся единой точкой коммуникации по заказам и поддержке.

## Test mode для рассылки через тему

Проверять отдельно по документу:
- `docs/topic-broadcast-test-mode-ru.md`

Ключевые критерии:
- test mode ON -> только allowlist;
- test mode ON + пустой allowlist -> никому не отправляется;
- test mode OFF -> обычная аудитория.

## Финальный чек успешности

- Нет сломанных entry points в telegram webhook routing.
- Нет регрессии в orders/support/broadcast/client topic связности.
- Операторские сообщения понятны и не вводят в заблуждение.
