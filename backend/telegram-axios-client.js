const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

const DEFAULT_TIMEOUT_MS = 20000;

/** Согласовано с backend/config.js envTelegramProxyUrl — direct-режим без SOCKS. */
function isTelegramProxyDirectValue(proxyUrl) {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return true;
    const t = raw.toLowerCase();
    return t === 'direct' || t === 'none' || t === 'off' || t === 'false' || t === '0';
}

/**
 * Узнаваемые коды сетевых ошибок при недоступном SOCKS / туннеле.
 * Следующий запрос после восстановления SSH обычно проходит без «reconnect» в коде —
 * агент создаёт новое TCP-соединение на каждый HTTP-запрос.
 */
function isLikelyProxyOrTunnelError(err) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '').toLowerCase();
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH'].includes(code)) {
        return true;
    }
    if (msg.includes('socket') || msg.includes('socks') || msg.includes('proxy')) return true;
    return false;
}

/**
 * Логируемый ярлык прокси без учётных данных (только схема + хост:порт).
 */
function describeProxyUrlForLogs(proxyUrl) {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return 'direct (no proxy)';
    try {
        const u = new URL(raw.replace(/^socks5h:/i, 'socks5:'));
        const host = u.hostname || '?';
        const port = u.port || (String(u.protocol).includes('socks') ? '1080' : '');
        const scheme = raw.toLowerCase().startsWith('socks5h') ? 'socks5h' : (u.protocol || 'socks5').replace(':', '');
        return port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
    } catch (_) {
        return '[configured]';
    }
}

/**
 * Режим исходящего Bot API (для health и безопасных логов; без секретов).
 * @param {string} [proxyUrl] — как в config.TELEGRAM_PROXY_URL (уже нормализован)
 * @returns {{ mode: 'proxied' | 'direct', proxyEndpointForLogs: string }}
 */
function resolveTelegramTransportMeta(proxyUrl) {
    const direct = isTelegramProxyDirectValue(proxyUrl);
    return {
        mode: direct ? 'direct' : 'proxied',
        proxyEndpointForLogs: describeProxyUrlForLogs(direct ? '' : proxyUrl)
    };
}

/**
 * Axios-инстанс для всех HTTPS-запросов к https://api.telegram.org/bot<token>/...
 * DNS при socks5h резолвится на стороне прокси (обход локальных блокировок).
 *
 * @param {object} opts
 * @param {string} [opts.proxyUrl] — например socks5h://127.0.0.1:1080; пустая строка = без прокси
 * @param {number} [opts.timeoutMs]
 * @param {{log?:function,warn?:function,error?:function}} [opts.logger]
 * @returns {import('axios').AxiosInstance}
 */
function createTelegramBotApiAxios({ proxyUrl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
    const url = String(proxyUrl || '').trim();
    const base = {
        timeout: timeoutMs,
        // Отключаем только дефолтный axios HTTP(S)_PROXY; при TELEGRAM_PROXY_URL трафик идёт через SocksProxyAgent (ниже).
        // Это не «обход прокси»: см. createTelegramClient — без переданного http при outbound enabled будет throw.
        proxy: false,
        transitional: { clarifyTimeoutError: true }
    };

    if (!url) {
        logger.log?.('[TelegramAxios] Bot API client: direct HTTPS (TELEGRAM_PROXY_URL empty or direct)');
        return axios.create(base);
    }

    let agent;
    try {
        agent = new SocksProxyAgent(url);
    } catch (e) {
        logger.error?.('[TelegramAxios] invalid TELEGRAM_PROXY_URL', { message: e.message });
        throw e;
    }

    logger.log?.('[TelegramAxios] Bot API client via proxy', { target: describeProxyUrlForLogs(url) });

    return axios.create({
        ...base,
        httpAgent: agent,
        httpsAgent: agent
    });
}

module.exports = {
    createTelegramBotApiAxios,
    describeProxyUrlForLogs,
    resolveTelegramTransportMeta,
    isLikelyProxyOrTunnelError,
    DEFAULT_TIMEOUT_MS
};
