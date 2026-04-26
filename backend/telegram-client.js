const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { classifyTelegramDescription } = require('./reliability-utils');
const { isLikelyProxyOrTunnelError } = require('./telegram-axios-client');
const transportHealth = require('./telegram-transport-health');

function recordOutboundApi(method, result) {
    try {
        transportHealth.recordTelegramOutboundResult({
            ok: !!(result && result.ok),
            errorCode: result && result.errorCode,
            method: String(method || '')
        });
    } catch (_) {
        /* ignore */
    }
}

/**
 * @typedef {{ok:boolean, errorCode?:string, message?:string, retryAfterSec?:number, data?:any}} TgResult
 */

/**
 * Для форумов: в Bot API передаём только конечный положительный integer.
 * Не используем truthiness — иначе теряются валидные edge-кейсы и проскакивают строки "0".
 * @param {unknown} v
 * @returns {number|undefined}
 */
function normalizeMessageThreadId(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.trunc(n);
}

function normalizeTelegramError(error) {
    const data = error?.response?.data || {};
    const description = String(data?.description || error.message || 'UNKNOWN_TG_ERROR');
    const errorCode = classifyTelegramDescription(description);

    const retryAfterSec = Number(data?.parameters?.retry_after || 0) || undefined;
    return {
        ok: false,
        errorCode,
        message: description,
        retryAfterSec
    };
}

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {boolean} [opts.outboundHttpEnabled]
 * @param {import('axios').AxiosInstance} [opts.http] — обязателен при outboundHttpEnabled: инстанс из createTelegramBotApiAxios
 * @param {'proxied'|'direct'|'unknown'} [opts.transportMode]
 * @param {string|null} [opts.proxyEndpointForLogs] — без учётных данных (см. describeProxyUrlForLogs)
 * @param {Console} [opts.logger]
 */
function createTelegramClient({
    botToken,
    outboundHttpEnabled = true,
    http,
    transportMode = 'unknown',
    proxyEndpointForLogs = null,
    logger = console
}) {
    const hasToken = !!String(botToken || '').trim();
    if (outboundHttpEnabled) {
        if (!http || typeof http.post !== 'function') {
            throw new Error(
                'createTelegramClient: при включённом outbound HTTP передайте `http` — axios из createTelegramBotApiAxios(...). ' +
                    'Тихий fallback на прямой axios отключён, чтобы не обходить SOCKS/прокси.'
            );
        }
    }
    const httpClient = http;

    if (outboundHttpEnabled && http) {
        logger.log?.('[TelegramClient] transport', {
            telegramTransportMode: transportMode,
            telegramProxyEndpoint: proxyEndpointForLogs,
            client: 'createTelegramBotApiAxios'
        });
    }

    async function request(method, payload) {
        if (!hasToken) {
            const r = { ok: false, errorCode: 'NO_TOKEN', message: 'TELEGRAM_BOT_TOKEN is empty' };
            recordOutboundApi(method, r);
            return r;
        }
        if (!outboundHttpEnabled) {
            if (method === 'getMe') {
                const r = {
                    ok: false,
                    errorCode: 'OUTBOUND_DISABLED',
                    message: 'Telegram Bot API outbound HTTP is disabled (TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=0)'
                };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'createForumTopic') {
                const r = {
                    ok: false,
                    errorCode: 'OUTBOUND_DISABLED',
                    message: 'Telegram Bot API outbound HTTP is disabled (TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=0)'
                };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'sendMessage') {
                const r = { ok: true, data: { message_id: 0 } };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'sendPhoto') {
                const r = { ok: true, data: { message_id: 0 } };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'sendDocument') {
                const r = { ok: true, data: { message_id: 0 } };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'pinChatMessage') {
                const r = { ok: true, data: true };
                recordOutboundApi(method, r);
                return r;
            }
            /** Рассылка не должна получать «успешный» copyMessage без реального Bot API — иначе ложные DELIVERED в БД. */
            if (method === 'copyMessage') {
                const r = {
                    ok: false,
                    errorCode: 'OUTBOUND_DISABLED',
                    message: 'Telegram Bot API outbound HTTP is disabled (TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=0)'
                };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'deleteMessage') {
                const r = { ok: true, data: true };
                recordOutboundApi(method, r);
                return r;
            }
            if (method === 'answerCallbackQuery') {
                const r = { ok: true, data: true };
                recordOutboundApi(method, r);
                return r;
            }
            const r = { ok: true, data: null };
            recordOutboundApi(method, r);
            return r;
        }
        if (!httpClient) {
            logger.error('[TelegramClient] outbound enabled but http client missing');
            const r = {
                ok: false,
                errorCode: 'NO_HTTP_CLIENT',
                message: 'Telegram Bot API http transport is not configured'
            };
            recordOutboundApi(method, r);
            return r;
        }
        if (process.env.TELEGRAM_DEBUG_BOT_API === '1') {
            logger.log?.('[TelegramTransport] outbound request', {
                method,
                telegramTransportMode: transportMode,
                telegramProxyEndpoint: proxyEndpointForLogs
            });
        }
        const url = `https://api.telegram.org/bot${botToken}/${method}`;
        try {
            const resp = await httpClient.post(url, payload);
            if (!resp.data?.ok) {
                const description = String(resp.data?.description || 'TG_API_ERROR');
                const errorCode = classifyTelegramDescription(description);
                const r = {
                    ok: false,
                    errorCode,
                    message: description,
                    retryAfterSec: Number(resp.data?.parameters?.retry_after || 0) || undefined,
                    data: resp.data || null
                };
                recordOutboundApi(method, r);
                return r;
            }
            const result = resp.data?.result;
            if (
                result &&
                (method === 'sendMessage' ||
                    method === 'copyMessage' ||
                    method === 'sendPhoto' ||
                    method === 'sendDocument') &&
                !(Number(result.message_id) > 0)
            ) {
                logger.warn('[TelegramClient] API ok but missing/invalid message_id (проверьте TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED и реальный ответ Telegram)', {
                    method,
                    telegramTransportMode: transportMode,
                    messageId: result.message_id
                });
            }
            const okRes = { ok: true, data: result };
            recordOutboundApi(method, okRes);
            try {
                logger.log?.('[TelegramTransport] health_update', {
                    method,
                    ok: true,
                    consecutiveTransportErrors: transportHealth.getTelegramTransportHealthSnapshot({
                        outboundEnabled: true,
                        httpClientPresent: true,
                        proxyConfigured: !!proxyEndpointForLogs,
                        transportMode
                    }).consecutiveTransportErrors
                });
            } catch (_) {
                /* ignore */
            }
            return okRes;
        } catch (e) {
            const normalized = normalizeTelegramError(e);
            if (isLikelyProxyOrTunnelError(e)) {
                logger.warn('[TelegramClient] network/proxy error (проверьте SSH SOCKS / TELEGRAM_PROXY_URL)', {
                    method,
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    syscall: e.code || null
                });
            } else {
                logger.warn('[TelegramClient] request failed', {
                    method,
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    message: normalized.message
                });
            }
            recordOutboundApi(method, normalized);
            try {
                const snap = transportHealth.getTelegramTransportHealthSnapshot({
                    outboundEnabled: true,
                    httpClientPresent: true,
                    proxyConfigured: !!proxyEndpointForLogs,
                    transportMode
                });
                logger.log?.('[TelegramTransport] health_update', {
                    method,
                    ok: false,
                    errorCode: normalized.errorCode,
                    consecutiveTransportErrors: snap.consecutiveTransportErrors,
                    degraded: snap.degraded
                });
            } catch (_) {
                /* ignore */
            }
            return normalized;
        }
    }

    /** @returns {Promise<TgResult>} */
    async function sendMessage({ chatId, messageThreadId, text, replyMarkup, parseMode }) {
        const tid = normalizeMessageThreadId(messageThreadId);
        return request('sendMessage', {
            chat_id: chatId,
            ...(tid !== undefined ? { message_thread_id: tid } : {}),
            text: String(text || ''),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {})
        });
    }

    /** @param {{ chatId: number|string, photo: string, caption?: string, replyMarkup?: object, parseMode?: string }} opts — photo: file_id или HTTPS URL */
    async function sendPhoto({ chatId, photo, caption, replyMarkup, parseMode }) {
        return request('sendPhoto', {
            chat_id: chatId,
            photo: String(photo || ''),
            ...(caption ? { caption: String(caption) } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {})
        });
    }

    /** @param {{ chatId: number|string, document: string, caption?: string, replyMarkup?: object, parseMode?: string }} opts — document: file_id или HTTPS URL */
    async function sendDocument({ chatId, document, caption, replyMarkup, parseMode }) {
        return request('sendDocument', {
            chat_id: chatId,
            document: String(document || ''),
            ...(caption ? { caption: String(caption) } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {})
        });
    }

    /**
     * sendDocument через multipart: файл с диска (надёжнее, чем URL, если Telegram не может скачать публичный PDF).
     * @param {{ chatId: number|string, filePath: string, caption?: string, replyMarkup?: object, parseMode?: string }} opts
     */
    async function sendDocumentFromFile({ chatId, filePath, caption, replyMarkup, parseMode }) {
        if (!hasToken) {
            const r = { ok: false, errorCode: 'NO_TOKEN', message: 'TELEGRAM_BOT_TOKEN is empty' };
            recordOutboundApi('sendDocumentFromFile', r);
            return r;
        }
        if (!outboundHttpEnabled) {
            const r = { ok: true, data: { message_id: 0 } };
            recordOutboundApi('sendDocumentFromFile', r);
            return r;
        }
        if (!httpClient) {
            logger.error('[TelegramClient] outbound enabled but http client missing');
            const r = {
                ok: false,
                errorCode: 'NO_HTTP_CLIENT',
                message: 'Telegram Bot API http transport is not configured'
            };
            recordOutboundApi('sendDocumentFromFile', r);
            return r;
        }
        const abs = path.resolve(String(filePath || ''));
        if (!abs || !fs.existsSync(abs)) {
            const r = {
                ok: false,
                errorCode: 'FILE_NOT_FOUND',
                message: `Local document file not found: ${abs || '(empty)'}`
            };
            recordOutboundApi('sendDocumentFromFile', r);
            return r;
        }
        const apiUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('document', fs.createReadStream(abs), {
            filename: path.basename(abs) || 'document.pdf',
            contentType: 'application/pdf'
        });
        if (caption) form.append('caption', String(caption));
        if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
        if (parseMode) form.append('parse_mode', String(parseMode));
        try {
            const resp = await httpClient.post(apiUrl, form, {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            if (!resp.data?.ok) {
                const description = String(resp.data?.description || 'TG_API_ERROR');
                const errorCode = classifyTelegramDescription(description);
                const r = {
                    ok: false,
                    errorCode,
                    message: description,
                    retryAfterSec: Number(resp.data?.parameters?.retry_after || 0) || undefined,
                    data: resp.data || null
                };
                recordOutboundApi('sendDocumentFromFile', r);
                return r;
            }
            const result = resp.data?.result;
            if (
                result &&
                !(Number(result.message_id) > 0)
            ) {
                logger.warn('[TelegramClient] sendDocumentFromFile: API ok but missing/invalid message_id', {
                    telegramTransportMode: transportMode,
                    messageId: result.message_id
                });
            }
            const okRes = { ok: true, data: result };
            recordOutboundApi('sendDocumentFromFile', okRes);
            return okRes;
        } catch (e) {
            const normalized = normalizeTelegramError(e);
            if (isLikelyProxyOrTunnelError(e)) {
                logger.warn('[TelegramClient] sendDocumentFromFile network/proxy error', {
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    syscall: e.code || null
                });
            } else {
                logger.warn('[TelegramClient] sendDocumentFromFile request failed', {
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    message: normalized.message
                });
            }
            recordOutboundApi('sendDocumentFromFile', normalized);
            return normalized;
        }
    }

    function guessImageContentType(filePath) {
        const ext = path.extname(String(filePath || '')).toLowerCase();
        if (ext === '.png') return 'image/png';
        if (ext === '.webp') return 'image/webp';
        if (ext === '.gif') return 'image/gif';
        return 'image/jpeg';
    }

    /**
     * sendPhoto через multipart: файл с диска (если Telegram не может скачать публичный URL).
     * @param {{ chatId: number|string, filePath: string, caption?: string, replyMarkup?: object, parseMode?: string }} opts
     */
    async function sendPhotoFromFile({ chatId, filePath, caption, replyMarkup, parseMode }) {
        if (!hasToken) {
            const r = { ok: false, errorCode: 'NO_TOKEN', message: 'TELEGRAM_BOT_TOKEN is empty' };
            recordOutboundApi('sendPhotoFromFile', r);
            return r;
        }
        if (!outboundHttpEnabled) {
            const r = { ok: true, data: { message_id: 0 } };
            recordOutboundApi('sendPhotoFromFile', r);
            return r;
        }
        if (!httpClient) {
            logger.error('[TelegramClient] outbound enabled but http client missing');
            const r = {
                ok: false,
                errorCode: 'NO_HTTP_CLIENT',
                message: 'Telegram Bot API http transport is not configured'
            };
            recordOutboundApi('sendPhotoFromFile', r);
            return r;
        }
        const abs = path.resolve(String(filePath || ''));
        if (!abs || !fs.existsSync(abs)) {
            const r = {
                ok: false,
                errorCode: 'FILE_NOT_FOUND',
                message: `Local photo file not found: ${abs || '(empty)'}`
            };
            recordOutboundApi('sendPhotoFromFile', r);
            return r;
        }
        const apiUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        const ct = guessImageContentType(abs);
        const base = path.basename(abs) || 'photo.jpg';
        form.append('photo', fs.createReadStream(abs), {
            filename: base,
            contentType: ct
        });
        if (caption) form.append('caption', String(caption));
        if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
        if (parseMode) form.append('parse_mode', String(parseMode));
        try {
            const resp = await httpClient.post(apiUrl, form, {
                headers: form.getHeaders(),
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            if (!resp.data?.ok) {
                const description = String(resp.data?.description || 'TG_API_ERROR');
                const errorCode = classifyTelegramDescription(description);
                const r = {
                    ok: false,
                    errorCode,
                    message: description,
                    retryAfterSec: Number(resp.data?.parameters?.retry_after || 0) || undefined,
                    data: resp.data || null
                };
                recordOutboundApi('sendPhotoFromFile', r);
                return r;
            }
            const result = resp.data?.result;
            if (result && !(Number(result.message_id) > 0)) {
                logger.warn('[TelegramClient] sendPhotoFromFile: API ok but missing/invalid message_id', {
                    telegramTransportMode: transportMode,
                    messageId: result.message_id
                });
            }
            const okRes = { ok: true, data: result };
            recordOutboundApi('sendPhotoFromFile', okRes);
            return okRes;
        } catch (e) {
            const normalized = normalizeTelegramError(e);
            if (isLikelyProxyOrTunnelError(e)) {
                logger.warn('[TelegramClient] sendPhotoFromFile network/proxy error', {
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    syscall: e.code || null
                });
            } else {
                logger.warn('[TelegramClient] sendPhotoFromFile request failed', {
                    telegramTransportMode: transportMode,
                    errorCode: normalized.errorCode,
                    message: normalized.message
                });
            }
            recordOutboundApi('sendPhotoFromFile', normalized);
            return normalized;
        }
    }

    /** @returns {Promise<TgResult>} */
    async function pinChatMessage({ chatId, messageId, disableNotification = true }) {
        return request('pinChatMessage', {
            chat_id: chatId,
            message_id: Number(messageId),
            disable_notification: !!disableNotification
        });
    }

    /** @returns {Promise<TgResult>} */
    async function copyMessage({ fromChatId, messageId, chatId, messageThreadId }) {
        const tid = normalizeMessageThreadId(messageThreadId);
        return request('copyMessage', {
            from_chat_id: fromChatId,
            message_id: messageId,
            chat_id: chatId,
            ...(tid !== undefined ? { message_thread_id: tid } : {})
        });
    }

    /** @returns {Promise<TgResult>} */
    async function deleteMessage({ chatId, messageId }) {
        return request('deleteMessage', {
            chat_id: chatId,
            message_id: messageId
        });
    }

    /** @returns {Promise<TgResult>} */
    async function answerCallbackQuery({ callbackQueryId, text, showAlert = false }) {
        return request('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...(text ? { text } : {}),
            show_alert: !!showAlert
        });
    }

    /** @returns {Promise<TgResult>} */
    async function createForumTopic({ chatId, name }) {
        return request('createForumTopic', {
            chat_id: chatId,
            name: String(name || 'Client').slice(0, 128)
        });
    }

    /** @returns {Promise<TgResult>} — result.data: User (id, username, can_read_all_group_messages, …) */
    async function getMe() {
        return request('getMe', {});
    }

    return {
        sendMessage,
        sendPhoto,
        sendPhotoFromFile,
        sendDocument,
        sendDocumentFromFile,
        pinChatMessage,
        copyMessage,
        deleteMessage,
        answerCallbackQuery,
        createForumTopic,
        getMe,
        normalizeTelegramError
    };
}

module.exports = {
    createTelegramClient,
    normalizeTelegramError
};

