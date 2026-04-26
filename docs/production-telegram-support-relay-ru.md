# Production: relay поддержки (клиент ↔ тема) и требования к боту

## FACT

- Код relay **менеджер → тема → клиент** обрабатывает входящие `message` / `edited_message` в супергруппе с `message_thread_id > 0`, сопоставляет `(chat_id, message_thread_id)` с записью `telegram_topics` и вызывает `copyMessage` в личку клиента.
- **Тема уведомлений поддержки** (`TELEGRAM_SUPPORT_NOTIFY_THREAD_ID`) — это отдельная ветка форума для карточек «новый запрос» и кнопки «Перейти в тему клиента». **Ответ клиенту нужно писать в персональной теме клиента**, а не в теме уведомлений: в БД нет `telegram_topics` для пары (chat, support_notify_thread), relay туда намеренно не маппится.
- Telegram **не присылает** боту в webhook обычные сообщения из групп, если у бота включён **Group Privacy** (privacy mode): бот видит только команды `/...`, ответы на свои сообщения и часть служебных событий.
- В объекте `getMe` поле **`can_read_all_group_messages`**: при значении **`false`** privacy считается включённым — это сильный сигнал, что сообщения менеджеров из супергруппы/тем **могут не доходить** до backend вообще.

## HYPOTHESIS

- Если в логах есть **private** inbound и **support notify**, но **нет** `[TelegramUpdate] inbound group message (raw)` при ответе менеджера в теме, причина с высокой вероятностью **операционная** (privacy / права), а не ошибка маппинга в БД.
- Если **raw** есть, а затем `[SupportTopicReply] skipped` с `reason: support_notify_topic`, менеджер пишет **не в тему клиента**, а в тему уведомлений — это **операционная** ошибка процесса, не баг кода.

## OPERATIONAL REQUIREMENTS (обязательно для topic → client)

1. **@BotFather → Bot Settings → Group Privacy — Turn off**  
   (чтобы бот получал обычные сообщения в группах и мог ретранслировать ответы менеджера.)

2. **Бот — администратор** супергруппы с возможностью работы с **темами** (forum topics), если используется форум.

3. **Тест manager reply:** открыть **личную тему клиента** (по ссылке из уведомления в теме поддержки или из списка тем), написать там текст. Не отвечать в теме «Поддержка: новый клиентский запрос» — туда уходит только уведомление.

4. После смены privacy проверьте **`GET /api/health/ops` → `telegramBotCapabilities.canReadAllGroupMessages: true`**.

## Anonymous admin / sender_chat

- **FACT:** Сообщения с заполненным `sender_chat` или с `from.id = 1087968824` (частый id заглушки анонимного админа) **не отбрасываются** правилом `from.is_bot` так же, как обычные боты: иначе часть ответов могла бы тихо отфильтроваться.
- **FACT:** При `sender_chat` / автопересылке пишется лог `[SupportTopicReply] anonymous admin / sender_chat detected`.
- **HYPOTHESIS:** Редкие варианты анонимности Telegram могут отличаться от документации; тогда смотрите поля в `[SupportTopicReply] incoming` и пришлите безопасный фрагмент лога.

## FIX (код)

- Схема **`support_threads`**: денорм-колонки (`waiting_for_staff`, `last_client_message_at`, …) добавляются при старте БД автоматически (`backend/support-threads-schema.js`, `db.awaitMigrations`); ручной SQL на сервере не требуется.
- Единый префикс логов **`[SupportTopicReply]`** и поля входа: `chatId`, `messageThreadId`, `fromId`, `fromIsBot`, `senderChat*`, `isAutomaticForward`, `reply_to_*`.
- Явный **skip** с подсказкой, если сообщение в **теме support notify**, а не в теме клиента.
- Модуль `backend/support-topic-reply-log.js` — сравнение id чатов и сбор полей без секретов.
- При старте **getMe**; при `can_read_all_group_messages === false` — warning; **`/api/health/ops` → `telegramBotCapabilities`**.

## Логи при успешном ответе менеджера из темы клиента

1. `[TelegramUpdate] inbound group message (raw)` — с `messageThreadId` > 0, `fromIsBot` false (или обход для sender_chat / анонимного id).
2. `[TelegramUpdate] forum routing` — `branch: client_topic_reply`.
3. `[SupportTopicReply] incoming` — полный набор полей.
4. **Нет** `[SupportTopicReply] skipped` с `support_notify_topic`.
5. `[SupportTopicReply] topic mapping found` — есть `topicKey`, `clientTelegramUserId`.
6. `[SupportTopicReply] relay to client attempted` → `[SupportTopicReply] relay result` с `ok: true`.

## VERIFIED

- После отключения Group Privacy и ответа **в теме клиента**: цепочка логов выше; клиент получает копию сообщения в личке.

## Ограничения (не баг кода)

- Сообщения от **другого бота** (`from.is_bot` без `sender_chat` и без id анонимного админа) игнорируются — это ожидаемо.
- Сообщения **без** `message_thread_id` в форуме не попадают в ветку `client_topic_reply` — в логах `reason: no_message_thread_id`.
