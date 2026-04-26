/**
 * Контекст чата для callback «Подтвердить» после sendDocument.
 * Telegram иногда присылает callback_query без полного message (старый апдейт) —
 * в личке с ботом chat.id совпадает с user id, можно взять cq.from.id.
 */

/**
 * @param {object} [callbackQuery]
 * @returns {{ data: string, chatId: number|string|null, chatType: string, chatResolveSource: 'message'|'from_fallback_private'|'none' }}
 */
function resolveConsentCallbackContext(callbackQuery) {
    const cq = callbackQuery || {};
    const data = String(cq.data ?? '').trim();
    const msgChat = cq.message?.chat;
    let chatId = msgChat?.id ?? null;
    let chatType = String(msgChat?.type || '');
    let chatResolveSource = /** @type {'message'|'from_fallback_private'|'none'} */ ('message');

    if (chatId == null && msgChat == null && cq.from?.id != null) {
        chatId = cq.from.id;
        chatType = 'private';
        chatResolveSource = 'from_fallback_private';
    }

    if (chatId == null) {
        chatResolveSource = 'none';
    }

    return { data, chatId, chatType, chatResolveSource };
}

module.exports = {
    resolveConsentCallbackContext
};
