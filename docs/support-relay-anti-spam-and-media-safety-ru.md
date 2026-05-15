# Поддержка в Telegram: антиспам alert-ов и безопасность media relay

Цель: **сообщения клиента всегда доставляются в персональную тему поддержки** через `copyMessage`, а **отдельный alert в тему уведомлений менеджеров** отправляется только по политике cooldown. Дополнительно зафиксированы правила против подмены медиа при пересылке.

## 1. Как работает cooldown для alert-ов

Переменная окружения (опционально):

- `SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES` — по умолчанию **120**.
- Некорректное или пустое значение → откат на **120 минут**.

Модуль политики: `backend/support-client-notification-policy.js`.

Alert в тему поддержки (общий «колокольчик») для **обычных сообщений клиента** отправляется, если:

1. Это **первое успешно доставленное** relay `CLIENT_TO_TOPIC` в треде, **или**
2. С момента записи `support_threads.last_client_notification_at` прошло **не меньше** указанного интервала.

Внутри окна cooldown второе/третье сообщение подряд у клиента:

- **relay** в тему выполняется;
- **alert** не дублируется;
- `last_client_notification_at` **не обновляется** (при suppression).

Кнопка **«Позвать менеджера»**:

- шлёт свой отдельный alert (даже когда client-message alert в cooldown у того же треда);
- обновляет `last_client_notification_at` после успеха;
- имеет **отдельный in-memory** антидубль на быстрые повторные нажатия через `manager-help-ops` (`MANAGER_HELP_COOLDOWN_MS` из env / `config.js`).

Важно не путать:

- **relay** (копирование сообщения клиента в тему);
- **alert** (отдельное `sendMessage` в `TELEGRAM_SUPPORT_NOTIFY_*` с кнопкой-ссылкой на тему клиента).

## 2. Почему сообщения клиента всё равно видны в теме

Всегда выполняется Bot API `copyMessage` из **приватного чата клиента** (`from_chat_id = chat.id клиента`, `message_id = входящего update.message.message_id`) в **тему клиента** форума (`message_thread_id` из `telegram_topics`).

Ограничение касается только **дополнительного** уведомления в операционной теме «уведомлений поддержки».

## 3. Как защищаемся от подмены фото

Правила реализации (`backend/support-service.js`, `backend/support-relay-utils.js`):

- **Нельзя** использовать `reply_to_message.message_id` как основной `copyMessage` для клиентского relay: ответ текстом на фото копируется как **текущий** `message_id`.
- **Нельзя** брать `copied_message_id` из предыдущих сообщений как источник копии.
- Payload в `support_messages.payload_json` сохраняется как **сжатый объект** (`schema: support_relay_payload_v2`): `content_kind`, `file_unique_id`, `reply_to`, `forward_origin`, но **без** необходимости переотправки по старому `file_id`.

Для media / reply / forward после успешного `copyMessage` в тему клиента может отправляться короткая служебная строка вида:

- `Сообщение клиента · <тип> · ID: <source_message_id>`
- плюс строки про пересылку / reply (см. `buildSupportRelayManagerHintLines`).

В логах: `[SupportRelay] relay_copy_ok` с `source_message_id`, `copied_message_id`, `photo_file_unique_id` (без сырого текста и без полного `chat_id`).

Возможная причина прошлого инцидента (гипотеза): **вводящий в заблуждение reply-превью** в Telegram у цепочки ответов или путаница менеджера между **цитатой** и **основным медиа-сообщением**. Явные строки с `ID: source_message_id` и строгая привязка `copyMessage` к текущему `message_id` адресуют это операционно.

## 4. Как разобрать конкретный инцидент в SQLite

Подключитесь к боевой базе **только через админский доступ** и **не** экспортируйте ПДн без необходимости.

1. Найти тред по `telegram_user_id`:

```sql
SELECT id, telegram_user_id, chat_id, message_thread_id,
       waiting_for_staff, last_client_message_at,
       last_staff_reply_at, last_client_notification_at,
       last_message_direction
FROM support_threads
WHERE telegram_user_id = '<id>';
```

2. Сообщения relay:

```sql
SELECT id, direction, source_message_id, copied_message_id, status, created_at,
       substr(payload_json,1,400) AS payload_head
FROM support_messages
WHERE thread_id = <id>
ORDER BY id DESC
LIMIT 40;
```

В `payload_summary` (через скрипт ниже) смотрите `content_kind`, `photo_file_unique_id`, `forward_origin_type`, `reply_to_private_message_id`.

3. Скрипт (без текстов из БД, только technical summary):

```bash
npm run maintenance:inspect-support-message -- --thread-id=12
# или
npm run maintenance:inspect-support-message -- --source-message-id=955
```

## 5. Логи на сервере (идея поиска)

- `journalctl -u <servicename>` с фильтром по `[SupportRelay]` / `[SupportNotifyTopic]` / `[ManagerHelp]`.
- Отдельные метки: `[SupportRelay] relay_copy_ok`, `[SupportNotifyTopic] notify_suppressed`.

## 6. Связанные файлы

- `backend/support-service.js` — relay + alert.
- `backend/support-relay-utils.js` — payload без ПДн и подсказки менеджеру.
- `backend/support-client-notification-policy.js` — решение об alert для client messages.
- `backend/telegram-update-handler.js` — передаёт `updateId` в relay.
- Тесты: `backend/tests/support-service-notify-cooldown.test.js`, `support-service-relay-media-contract.test.js`, `support-client-notification-policy.test.js`.
