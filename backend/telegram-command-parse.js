/**
 * Извлечь команду бота из Message (Telegram Bot API: entity bot_command с offset 0).
 * @param {Record<string, unknown>} message
 * @returns {{ command: string, payload: string | null, rawPrefix: string } | null}
 */
function extractBotCommand(message) {
    const text = message?.text;
    if (text == null || String(text) === '') return null;
    const str = String(text);
    const entities = message.entities;

    if (Array.isArray(entities)) {
        const first = entities.find((e) => e && e.type === 'bot_command' && Number(e.offset) === 0);
        if (first) {
            const len = Number(first.length);
            if (!Number.isFinite(len) || len <= 0) return null;
            const rawCmd = str.substring(0, len);
            const m = rawCmd.match(/^\/([a-zA-Z0-9_]+)(@[a-zA-Z0-9_]+)?$/);
            if (!m) return null;
            const command = String(m[1]).toLowerCase();
            const payload = str.substring(len).trim();
            return {
                command,
                payload: payload.length ? payload : null,
                rawPrefix: rawCmd
            };
        }
    }

    const line = str.trim();
    const fm = line.match(/^\/([a-zA-Z0-9_]+)(@[a-zA-Z0-9_]+)?(?:\s+(.*))?$/s);
    if (!fm) return null;
    const rest = fm[3] != null ? String(fm[3]).trim() : '';
    return {
        command: String(fm[1]).toLowerCase(),
        payload: rest.length ? rest : null,
        rawPrefix: line.split(/\s/)[0] || ''
    };
}

module.exports = {
    extractBotCommand
};
