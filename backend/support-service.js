const db = require('./db');
const {
    buildSupportTopicIncomingFields,
    isMessageInSupportNotifyTopic
} = require('./support-topic-reply-log');
const managerHelpOps = require('./manager-help-ops');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

/** Окно для метрики «скорость ответа» и антидубль уведомлений в тему поддержки. */
const SUPPORT_RESPONSE_WINDOW_MS = 2 * 60 * 60 * 1000;
const SUPPORT_NOTIFY_TOPIC_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function createSupportService({
    telegramClient,
    routingService,
    supportNotifyChatId,
    supportNotifyThreadId,
    logger = console,
    managerHelpCooldownMs = 7 * 60 * 1000,
    telegramOutboundBotHttpEnabled = true
}) {
    /**
     * Первое клиентское сообщение после 2 ч от начала предыдущего окна — новая строка окна.
     */
    async function openSupportResponseWindowIfNeeded(threadDbId, telegramUserId, clientMessageAtIso) {
        try {
            const latest = await get(
                `
                SELECT first_client_message_at
                FROM support_response_windows
                WHERE thread_id = ?
                ORDER BY first_client_message_at DESC
                LIMIT 1
                `,
                [Number(threadDbId)]
            );
            const nowMs = Date.parse(clientMessageAtIso);
            let needNew = true;
            if (latest && latest.first_client_message_at) {
                const startMs = Date.parse(String(latest.first_client_message_at));
                if (Number.isFinite(startMs) && Number.isFinite(nowMs) && nowMs - startMs < SUPPORT_RESPONSE_WINDOW_MS) {
                    needNew = false;
                }
            }
            if (!needNew) return;
            await run(
                `
                INSERT INTO support_response_windows (thread_id, telegram_user_id, first_client_message_at, created_at)
                VALUES (?, ?, ?, ?)
                `,
                [Number(threadDbId), String(telegramUserId), clientMessageAtIso, clientMessageAtIso]
            );
        } catch (e) {
            logger.warn('[SupportResponseWindow] open_failed', {
                threadId: Number(threadDbId),
                message: String(e && e.message ? e.message : e).slice(0, 200)
            });
        }
    }

    async function assignManagerFirstResponseToOldestWindow(threadDbId, managerReplyAtIso) {
        try {
            const pending = await get(
                `
                SELECT id FROM support_response_windows
                WHERE thread_id = ?
                  AND (first_manager_response_at IS NULL OR TRIM(COALESCE(first_manager_response_at,'')) = '')
                ORDER BY first_client_message_at ASC
                LIMIT 1
                `,
                [Number(threadDbId)]
            );
            if (!pending) return;
            await run(`UPDATE support_response_windows SET first_manager_response_at = ? WHERE id = ?`, [
                managerReplyAtIso,
                Number(pending.id)
            ]);
        } catch (e) {
            logger.warn('[SupportResponseWindow] manager_stamp_failed', {
                threadId: Number(threadDbId),
                message: String(e && e.message ? e.message : e).slice(0, 200)
            });
        }
    }

    async function getOrCreateThread({ telegramUserId, topic }) {
        const existing = await get('SELECT * FROM support_threads WHERE telegram_user_id = ?', [String(telegramUserId)]);
        const now = new Date().toISOString();
        if (existing) return existing;
        const inserted = await run(
            `
            INSERT INTO support_threads (telegram_user_id, topic_key, chat_id, message_thread_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'OPEN', ?, ?)
            `,
            [
                String(telegramUserId),
                topic.topic_key,
                String(topic.chat_id),
                Number(topic.message_thread_id),
                now,
                now
            ]
        );
        return get('SELECT * FROM support_threads WHERE id = ?', [inserted.lastID]);
    }

    async function logSupportMessage({
        threadId,
        direction,
        sourceChatId,
        sourceMessageId,
        copiedMessageId,
        payload,
        status = 'SENT',
        errorMessage = null
    }) {
        await run(
            `
            INSERT INTO support_messages (
                thread_id, direction, source_chat_id, source_message_id, copied_message_id, payload_json, status, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                Number(threadId),
                String(direction),
                String(sourceChatId),
                Number(sourceMessageId || 0),
                copiedMessageId ? Number(copiedMessageId) : null,
                JSON.stringify(payload || {}),
                status,
                errorMessage,
                new Date().toISOString()
            ]
        );
    }

    async function handleClientMessage(updateMessage) {
        const from = updateMessage?.from || {};
        const telegramUserId = String(from.id || '');
        if (!telegramUserId) return { ok: false, error: 'NO_USER_ID' };

        const topic = await routingService.ensureClientTopic({
            telegramUserId,
            firstName: from.first_name || '',
            lastName: from.last_name || '',
            username: from.username || ''
        });
        if (!topic) return { ok: false, error: 'TOPIC_NOT_AVAILABLE' };

        const thread = await getOrCreateThread({ telegramUserId, topic });

        const duplicate = await get(
            `
            SELECT id, status
            FROM support_messages
            WHERE thread_id = ?
              AND direction = 'CLIENT_TO_TOPIC'
              AND source_chat_id = ?
              AND source_message_id = ?
            LIMIT 1
            `,
            [Number(thread.id), String(updateMessage.chat.id), Number(updateMessage.message_id)]
        );
        if (duplicate) {
            return { ok: true, duplicate: true };
        }

        const copied = await telegramClient.copyMessage({
            fromChatId: updateMessage.chat.id,
            messageId: updateMessage.message_id,
            chatId: topic.chat_id,
            messageThreadId: topic.message_thread_id
        });

        await logSupportMessage({
            threadId: thread.id,
            direction: 'CLIENT_TO_TOPIC',
            sourceChatId: updateMessage.chat.id,
            sourceMessageId: updateMessage.message_id,
            copiedMessageId: copied.ok ? copied.data?.message_id : null,
            payload: updateMessage,
            status: copied.ok ? 'SENT' : 'FAILED',
            errorMessage: copied.ok ? null : copied.message
        });

        {
            const now = new Date().toISOString();
            await run(
                `
                UPDATE support_threads SET
                    updated_at = ?,
                    last_client_message_at = ?,
                    last_message_direction = 'CLIENT_TO_TOPIC',
                    waiting_for_staff = 1
                WHERE id = ?
                `,
                [now, now, Number(thread.id)]
            );
        }

        if (copied.ok) {
            await openSupportResponseWindowIfNeeded(thread.id, telegramUserId, new Date().toISOString());
        }

        if (supportNotifyChatId && supportNotifyThreadId > 0) {
            const topicLink = routingService.buildTopicLink(topic.chat_id, topic.message_thread_id);
            const text =
                `🆘 Поддержка: новый клиентский запрос\n` +
                `👤 ${[from.first_name, from.last_name].filter(Boolean).join(' ') || '-'}\n` +
                `🆔 ${telegramUserId}\n` +
                `@${from.username || '-'}`;

            const tRow = await get(`SELECT last_client_notification_at FROM support_threads WHERE id = ?`, [
                Number(thread.id)
            ]);
            const lastN = tRow && tRow.last_client_notification_at ? String(tRow.last_client_notification_at) : '';
            let shouldNotify = !lastN;
            if (lastN) {
                const t = Date.parse(lastN);
                shouldNotify = !Number.isFinite(t) || Date.now() - t >= SUPPORT_NOTIFY_TOPIC_COOLDOWN_MS;
            }

            if (shouldNotify) {
                const sent = await telegramClient.sendMessage({
                    chatId: supportNotifyChatId,
                    messageThreadId: Number(supportNotifyThreadId),
                    text,
                    replyMarkup: topicLink
                        ? { inline_keyboard: [[{ text: 'Перейти в тему клиента', url: topicLink }]] }
                        : undefined
                });
                logger.log('[SupportNotifyTopic] support notify topic', {
                    chatId: String(supportNotifyChatId),
                    threadId: Number(supportNotifyThreadId),
                    ok: !!sent?.ok,
                    errorCode: sent?.ok ? null : sent?.errorCode || null
                });
                if (sent?.ok) {
                    const stamp = new Date().toISOString();
                    await run(`UPDATE support_threads SET last_client_notification_at = ? WHERE id = ?`, [
                        stamp,
                        Number(thread.id)
                    ]);
                }
            } else {
                logger.log('[SupportNotifyTopic] support_notify_skipped_window', {
                    threadDbId: Number(thread.id),
                    telegramUserId,
                    last_client_notification_at: lastN || null,
                    cooldownHours: SUPPORT_NOTIFY_TOPIC_COOLDOWN_MS / 3600000
                });
            }
        } else {
            logger.log('[SupportNotifyTopic] skip (no chat/thread)', {
                hasChat: !!supportNotifyChatId,
                threadId: Number(supportNotifyThreadId || 0)
            });
        }

        return { ok: true };
    }

    async function handleManagerMessage(updateMessage) {
        const incoming = buildSupportTopicIncomingFields(updateMessage);
        const chatId = String(updateMessage?.chat?.id || '');
        const threadId = Number(updateMessage?.message_thread_id || 0);

        if (incoming.hasSenderChat || incoming.isAutomaticForward) {
            logger.log('[SupportTopicReply] anonymous admin / sender_chat detected', {
                ...incoming
            });
        }

        if (!chatId || !threadId) {
            logger.log('[SupportTopicReply] skipped', {
                reason: 'NO_TOPIC_CONTEXT',
                ...incoming
            });
            return { ok: false, error: 'NO_TOPIC_CONTEXT', errorCode: 'NO_TOPIC_CONTEXT' };
        }

        const topic = await routingService.findClientByTopic({ chatId, messageThreadId: threadId });
        if (!topic?.telegram_user_id) {
            const likelyNotify = isMessageInSupportNotifyTopic({
                chatId,
                messageThreadId: threadId,
                supportNotifyChatId,
                supportNotifyThreadId
            });
            logger.log('[SupportTopicReply] topic mapping not found', {
                ...incoming,
                likelySupportNotifyTopic: likelyNotify,
                hint: likelyNotify
                    ? 'Сообщение в теме уведомлений поддержки: ответ клиенту — в персональной теме клиента.'
                    : 'Нет строки telegram_topics для этой пары chat_id + message_thread_id (тема не клиента или не зарегистрирована).'
            });
            return { ok: false, error: 'CLIENT_TOPIC_NOT_MAPPED', errorCode: 'CLIENT_TOPIC_NOT_MAPPED' };
        }

        logger.log('[SupportTopicReply] topic mapping found', {
            ...incoming,
            topicKey: String(topic.topic_key || ''),
            clientTelegramUserId: String(topic.telegram_user_id || '')
        });

        const thread = await getOrCreateThread({
            telegramUserId: topic.telegram_user_id,
            topic
        });

        const duplicate = await get(
            `
            SELECT id, status
            FROM support_messages
            WHERE thread_id = ?
              AND direction = 'TOPIC_TO_CLIENT'
              AND source_chat_id = ?
              AND source_message_id = ?
            LIMIT 1
            `,
            [Number(thread.id), String(updateMessage.chat.id), Number(updateMessage.message_id)]
        );
        if (duplicate) {
            logger.log('[SupportTopicReply] skipped', {
                reason: 'duplicate_message_id',
                threadId: Number(thread.id),
                sourceMessageId: Number(updateMessage.message_id || 0)
            });
            return { ok: true, duplicate: true };
        }

        logger.log('[SupportTopicReply] relay to client attempted', {
            threadId: Number(thread.id),
            sourceMessageId: Number(updateMessage.message_id || 0)
        });

        const copied = await telegramClient.copyMessage({
            fromChatId: updateMessage.chat.id,
            messageId: updateMessage.message_id,
            chatId: topic.telegram_user_id
        });

        await logSupportMessage({
            threadId: thread.id,
            direction: 'TOPIC_TO_CLIENT',
            sourceChatId: updateMessage.chat.id,
            sourceMessageId: updateMessage.message_id,
            copiedMessageId: copied.ok ? copied.data?.message_id : null,
            payload: updateMessage,
            status: copied.ok ? 'SENT' : 'FAILED',
            errorMessage: copied.ok ? null : copied.message
        });

        if (copied.ok) {
            const now = new Date().toISOString();
            await run(
                `
                UPDATE support_threads SET
                    updated_at = ?,
                    last_staff_reply_at = ?,
                    last_message_direction = 'TOPIC_TO_CLIENT',
                    waiting_for_staff = 0,
                    first_response_at = COALESCE(first_response_at, ?)
                WHERE id = ?
                `,
                [now, now, now, Number(thread.id)]
            );
            await assignManagerFirstResponseToOldestWindow(thread.id, now);
        } else {
            const now = new Date().toISOString();
            await run(`UPDATE support_threads SET updated_at = ? WHERE id = ?`, [now, Number(thread.id)]);
        }

        if (copied.ok) {
            logger.log('[SupportTopicReply] relay result', {
                ok: true,
                threadId: Number(thread.id),
                copiedMessageId: copied.data?.message_id || null
            });
        } else {
            logger.warn('[SupportTopicReply] relay result', {
                ok: false,
                threadId: Number(thread.id),
                errorCode: copied.errorCode || null,
                message: copied.message ? String(copied.message).slice(0, 200) : null
            });
        }

        if (!copied.ok) {
            await telegramClient.sendMessage({
                chatId: chatId,
                messageThreadId: threadId,
                text: `⚠️ Не удалось отправить клиенту: ${copied.errorCode || copied.message || 'unknown error'}`
            });
        }
        return {
            ...copied,
            error: copied.ok ? undefined : (copied.errorCode || 'COPY_FAILED'),
            errorCode: copied.ok ? undefined : copied.errorCode
        };
    }

    const USER_MSG_OK = 'Менеджер уже получил запрос и скоро напишет вам';
    const USER_MSG_DEDUPE = 'Запрос уже передан менеджеру, пожалуйста ожидайте';
    const USER_MSG_FALLBACK =
        'Не удалось мгновенно передать запрос менеджеру, попробуйте ещё раз через минуту';

    async function sendUserText(chatId, text) {
        const r = await telegramClient.sendMessage({ chatId, text });
        if (!r?.ok) {
            logger.warn('[ManagerHelp] user_dm_failed', { chatId: String(chatId), errorCode: r?.errorCode || null });
        }
        return r;
    }

    /**
     * Кнопка «Позвать менеджера»: answerCallbackQuery уже вызван в webhook-хендлере.
     */
    async function handleManagerHelpRequest({ callbackQuery, chatId }) {
        const cq = callbackQuery || {};
        const from = cq.from || {};
        const telegramUserId = String(from.id || '');
        if (!telegramUserId) {
            logger.warn('[ManagerHelp] failed', { code: 'NO_USER_ID' });
            managerHelpOps.recordManagerHelpLastError('NO_USER_ID', 'empty from.id');
            return { ok: false, errorCode: 'NO_USER_ID' };
        }

        managerHelpOps.recordManagerHelpRequestInbound();

        if (!telegramOutboundBotHttpEnabled) {
            managerHelpOps.recordManagerHelpLastError('OUTBOUND_DISABLED', 'TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=false');
            logger.warn('[ManagerHelp] failed', { code: 'OUTBOUND_DISABLED', telegramUserId });
            return { ok: false, errorCode: 'OUTBOUND_DISABLED' };
        }

        if (!managerHelpOps.tryBeginManagerHelpInFlight(telegramUserId)) {
            managerHelpOps.bumpDuplicateSuppress();
            logger.log('[ManagerHelp] duplicate_suppressed', { reason: 'in_flight', telegramUserId });
            await sendUserText(chatId, USER_MSG_DEDUPE);
            return { ok: true, duplicateSuppressed: true, reason: 'in_flight' };
        }

        try {
            if (managerHelpOps.isCooldownActive(telegramUserId, managerHelpCooldownMs)) {
                managerHelpOps.bumpDuplicateSuppress();
                logger.log('[ManagerHelp] duplicate_suppressed', { reason: 'cooldown', telegramUserId });
                await sendUserText(chatId, USER_MSG_DEDUPE);
                return { ok: true, duplicateSuppressed: true, reason: 'cooldown' };
            }

            const topic = await routingService.ensureClientTopic({
                telegramUserId,
                firstName: from.first_name || '',
                lastName: from.last_name || '',
                username: from.username || ''
            });
            if (!topic) {
                managerHelpOps.recordManagerHelpLastError('TOPIC_NOT_AVAILABLE', 'ensureClientTopic returned null');
                logger.warn('[ManagerHelp] failed', { code: 'TOPIC_NOT_AVAILABLE', telegramUserId });
                await sendUserText(chatId, USER_MSG_FALLBACK);
                return { ok: false, errorCode: 'TOPIC_NOT_AVAILABLE' };
            }

            const threadRowBefore = await get('SELECT * FROM support_threads WHERE telegram_user_id = ?', [
                String(telegramUserId)
            ]);
            const thread = await getOrCreateThread({ telegramUserId, topic });
            const threadExisted = !!threadRowBefore;

            if (threadExisted) {
                logger.log('[ManagerHelp] request_reused_existing', { telegramUserId, threadId: Number(thread.id) });
            } else {
                logger.log('[ManagerHelp] request_created', { telegramUserId, threadId: Number(thread.id) });
            }

            const now = new Date().toISOString();
            await run(
                `
                UPDATE support_threads SET
                    updated_at = ?,
                    waiting_for_staff = 1
                WHERE id = ?
                `,
                [now, Number(thread.id)]
            );

            const notifyChat = supportNotifyChatId;
            const notifyTid = Number(supportNotifyThreadId || 0);
            if (!notifyChat || !(notifyTid > 0)) {
                managerHelpOps.recordManagerHelpLastError(
                    'SUPPORT_NOTIFY_NOT_CONFIGURED',
                    'support notify chat or thread id missing'
                );
                logger.warn('[ManagerHelp] failed', {
                    code: 'SUPPORT_NOTIFY_NOT_CONFIGURED',
                    hasChat: !!notifyChat,
                    threadId: notifyTid
                });
                await sendUserText(chatId, USER_MSG_FALLBACK);
                return { ok: false, errorCode: 'SUPPORT_NOTIFY_NOT_CONFIGURED' };
            }

            const topicLink = routingService.buildTopicLink(topic.chat_id, topic.message_thread_id);
            const notifyText =
                `🔔 Запрос менеджера (кнопка в боте)\n` +
                `👤 ${[from.first_name, from.last_name].filter(Boolean).join(' ') || '-'}\n` +
                `🆔 ${telegramUserId}\n` +
                `@${from.username || '-'}`;
            const sent = await telegramClient.sendMessage({
                chatId: notifyChat,
                messageThreadId: notifyTid,
                text: notifyText,
                replyMarkup: topicLink
                    ? { inline_keyboard: [[{ text: 'Перейти в тему клиента', url: topicLink }]] }
                    : undefined
            });

            if (!sent?.ok) {
                const errMsg = String(sent?.message || sent?.errorCode || 'SEND_FAILED');
                managerHelpOps.recordManagerHelpLastError('SUPPORT_NOTIFY_SEND_FAILED', errMsg);
                logger.warn('[ManagerHelp] failed', {
                    code: 'SUPPORT_NOTIFY_SEND_FAILED',
                    telegramUserId,
                    errorCode: sent?.errorCode || null,
                    message: errMsg.slice(0, 200)
                });
                await sendUserText(chatId, USER_MSG_FALLBACK);
                return { ok: false, errorCode: 'SUPPORT_NOTIFY_SEND_FAILED' };
            }

            managerHelpOps.markNotifyCooldown(telegramUserId);
            managerHelpOps.recordManagerHelpNotifySuccess();
            managerHelpOps.clearManagerHelpLastError();
            logger.log('[ManagerHelp] notify_topic_sent', {
                telegramUserId,
                threadId: Number(thread.id),
                notifyChatId: String(notifyChat),
                notifyThreadId: notifyTid
            });
            logger.log('[SupportNotifyTopic] support notify topic', {
                chatId: String(notifyChat),
                threadId: notifyTid,
                ok: true,
                errorCode: null,
                source: 'manager_help_request'
            });

            await sendUserText(chatId, USER_MSG_OK);
            return { ok: true, duplicateSuppressed: false, threadExisted };
        } catch (e) {
            const msg = String(e?.message || e);
            managerHelpOps.recordManagerHelpLastError('EXCEPTION', msg);
            logger.warn('[ManagerHelp] failed', { code: 'EXCEPTION', telegramUserId, message: msg.slice(0, 240) });
            await sendUserText(chatId, USER_MSG_FALLBACK);
            return { ok: false, errorCode: 'EXCEPTION' };
        } finally {
            managerHelpOps.endManagerHelpInFlight(telegramUserId);
        }
    }

    return {
        handleClientMessage,
        handleManagerMessage,
        handleManagerHelpRequest
    };
}

module.exports = {
    createSupportService
};

