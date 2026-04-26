/**
 * Утилиты нормализации @username бота (legacy / тесты).
 * Кнопка «Позвать менеджера» в welcome теперь использует callback_data, не t.me URL.
 */

function normalizeTelegramBotUsername(raw) {
    const s = String(raw || '')
        .trim()
        .replace(/^@+/, '');
    if (!s) return '';
    if (!/^[a-zA-Z0-9_]{5,32}$/.test(s)) return '';
    return s;
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} opts.telegramClient
 * @param {{ username?: string | null }} [opts.runtimeBotProfile]
 * @param {Console} [opts.logger]
 * @param {number|string} opts.chatId
 * @returns {Promise<{ source: 'env' | 'getMe' | 'fallback_none', username: string, url: string, buttonIncluded: boolean }>}
 */
async function resolveManagerHelpButtonContext({ config, telegramClient, runtimeBotProfile = {}, logger = console, chatId }) {
    const chatIdStr = String(chatId);
    let source = /** @type {'env' | 'getMe' | 'fallback_none'} */ ('fallback_none');
    let username = '';

    const envU = normalizeTelegramBotUsername(config.TELEGRAM_BOT_USERNAME);
    if (envU) {
        source = 'env';
        username = envU;
    } else {
        const runU = normalizeTelegramBotUsername(runtimeBotProfile?.username);
        if (runU) {
            source = 'getMe';
            username = runU;
        } else if (config.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
            try {
                const r = await telegramClient.getMe();
                if (r?.ok && r.data?.username) {
                    const u = normalizeTelegramBotUsername(r.data.username);
                    if (u) {
                        source = 'getMe';
                        username = u;
                    }
                }
            } catch (e) {
                logger.warn('[TelegramCommand] manager_help_getme_failed', {
                    chatId: chatIdStr,
                    message: String(e?.message || e)
                });
            }
        }
    }

    const url = username ? `https://t.me/${username}` : '';
    const buttonIncluded = !!url;

    return { source, username, url, buttonIncluded };
}

module.exports = {
    normalizeTelegramBotUsername,
    resolveManagerHelpButtonContext
};
