# Topic Broadcast Test Mode (RU)

## Зачем нужен режим

`Topic broadcast test mode` позволяет безопасно тестировать рассылку из темы рассылки:
- не на всю аудиторию;
- только на заранее заданный allowlist Telegram ID.

Режим минимально инвазивный и fail-closed.

## ENV-параметры

- `BROADCAST_TOPIC_TEST_MODE=false`
- `BROADCAST_TOPIC_TEST_TELEGRAM_IDS=67460775,123456789`
- `BROADCAST_TOPIC_TEST_LABEL=Тестовая рассылка`

## Поведение

### Когда `BROADCAST_TOPIC_TEST_MODE=false`

- flow работает штатно;
- получатели берутся из обычной аудитории (`users.telegram_id`);
- summary в теме без тестовой пометки.

### Когда `BROADCAST_TOPIC_TEST_MODE=true`

- flow рассылки через тему использует **только** `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`;
- обычная массовая аудитория не используется;
- summary в теме помечается как тестовый;
- в summary указывается тестовый охват.

### Fail-safe (обязательный)

Если test mode включён, но allowlist пуст:
- рассылка никому не отправляется;
- в тему отправляется понятное операторское сообщение:
  - что test mode активен,
  - но список тестовых получателей не задан.

## Как включить безопасно

1. Установить:
   - `BROADCAST_TOPIC_TEST_MODE=true`
   - `BROADCAST_TOPIC_TEST_TELEGRAM_IDS=<ваш_id>,<id_заказчика>`
2. Перезапустить backend.
3. Отправить сообщение в тему рассылки.
4. Проверить summary:
   - есть пометка тестового режима;
   - тестовый охват соответствует allowlist.

## Как выключить

1. Установить `BROADCAST_TOPIC_TEST_MODE=false`.
2. (Опционально) очистить `BROADCAST_TOPIC_TEST_TELEGRAM_IDS`.
3. Перезапустить backend.

## Пример безопасного конфига

```env
BROADCAST_TOPIC_TEST_MODE=true
BROADCAST_TOPIC_TEST_TELEGRAM_IDS=67460775,123456789
BROADCAST_TOPIC_TEST_LABEL=Тестовая рассылка
```

## Важные ограничения

- Режим применяется к **topic-triggered broadcast flow**.
- Это не staging-оркестратор и не отдельный контур доставки.
- Если в allowlist есть некорректные ID, они отфильтровываются.

## Операторские сообщения

В test mode оператор видит, что это тест:
- `Тестовая рассылка · topic test mode`
- `Тестовый охват: N получателей`
- далее стандартные метрики:
  - доставлено,
  - блокировки,
  - ошибки.
