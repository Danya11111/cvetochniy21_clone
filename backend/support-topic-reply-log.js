/**
 * Диагностика пути «ответ менеджера в теме → личка клиента» (без секретов).
 * @see https://core.telegram.org/bots/api#message
 */

/** Часто встречающийся from.id для анонимного администратора в супергруппах (не is_bot). */
const TELEGRAM_ANONYMOUS_ADMIN_USER_ID = 1087968824;

function normalizeTelegramChatIdForCompare(id) {
    return String(id ?? '').trim();
}

/**
 * Поля входящего сообщения для логов (и для проверки веток).
 * @param {Record<string, unknown>} message
 */
function buildSupportTopicIncomingFields(message) {
    const m = message || {};
    const chat = m.chat || {};
    const from = m.from || {};
    const sc = m.sender_chat || null;
    const rt = m.reply_to_message || null;
    return {
        chatId: String(chat.id ?? ''),
        messageThreadId: Number(m.message_thread_id || 0),
        messageId: Number(m.message_id || 0),
        fromId: from.id != null ? Number(from.id) : null,
        fromIsBot: from.is_bot === true,
        hasSenderChat: !!(sc && Object.keys(sc).length),
        senderChatId: sc?.id != null ? String(sc.id) : null,
        senderChatType: sc?.type ? String(sc.type) : null,
        isAutomaticForward: m.is_automatic_forward === true,
        hasReplyTo: !!rt,
        replyToMessageId: rt?.message_id != null ? Number(rt.message_id) : null,
        replyToThreadId: rt?.message_thread_id != null ? Number(rt.message_thread_id) : null
    };
}

/**
 * Анонимный админ / пост от имени чата: нельзя отфильтровать как «обычный бот» по from.is_bot без проверки sender_chat.
 * @param {Record<string, unknown>} message
 */
function shouldAllowGroupMessageDespiteFromBot(message) {
    const m = message || {};
    if (m.sender_chat && Object.keys(m.sender_chat).length) return true;
    if (Number(m.from?.id) === TELEGRAM_ANONYMOUS_ADMIN_USER_ID) return true;
    return false;
}

/**
 * Сообщение в теме «уведомлений поддержки», а не в персональной теме клиента.
 */
function isMessageInSupportNotifyTopic({
    chatId,
    messageThreadId,
    supportNotifyChatId,
    supportNotifyThreadId
}) {
    const notifyChat = normalizeTelegramChatIdForCompare(supportNotifyChatId || '');
    const tid = Number(supportNotifyThreadId || 0);
    if (!(tid > 0) || !notifyChat) return false;
    return (
        normalizeTelegramChatIdForCompare(chatId) === notifyChat && Number(messageThreadId || 0) === tid
    );
}

module.exports = {
    TELEGRAM_ANONYMOUS_ADMIN_USER_ID,
    buildSupportTopicIncomingFields,
    shouldAllowGroupMessageDespiteFromBot,
    isMessageInSupportNotifyTopic,
    normalizeTelegramChatIdForCompare
};
