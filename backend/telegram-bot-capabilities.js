/**
 * Снимок публичных полей getMe для диагностики (без токена).
 * @param {{ ok: boolean, data?: any, errorCode?: string, message?: string }} getMeResult
 */
function buildTelegramBotCapabilitiesSnapshot(getMeResult) {
    const fetchedAt = new Date().toISOString();
    if (!getMeResult || !getMeResult.ok || !getMeResult.data) {
        return {
            ok: false,
            fetchedAt,
            errorCode: getMeResult?.errorCode || 'GETME_FAILED',
            message: getMeResult?.message || null,
            canReadAllGroupMessages: null,
            botUserId: null,
            username: null
        };
    }
    const u = getMeResult.data;
    return {
        ok: true,
        fetchedAt,
        errorCode: null,
        message: null,
        botUserId: Number(u.id) || null,
        username: u.username ? String(u.username) : null,
        isBot: u.is_bot === true,
        /** true = privacy mode выключен у бота; false = обычные сообщения в группах могут не приходить в webhook */
        canReadAllGroupMessages: u.can_read_all_group_messages === true,
        canJoinGroups: u.can_join_groups === true,
        supportsInlineQueries: u.supports_inline_queries === true
    };
}

module.exports = {
    buildTelegramBotCapabilitiesSnapshot
};
