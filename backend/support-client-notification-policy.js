'use strict';

/** @typedef {'manager_help_button'|'first_client_message'|'cooldown_elapsed'|'cooldown_active'|'no_notify_needed'} SupportClientNotifyReason */

const DEFAULT_COOLDOWN_MINUTES = 120;

/**
 * @param {string|undefined|null} raw
 * @returns {number} миллисекунды охлаждения, минимум 1 мин при невалидном значении
 */
function resolveSupportClientNotificationCooldownMs(raw = process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES) {
    const n = Number(String(raw ?? '').trim());
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_COOLDOWN_MINUTES * 60 * 1000;
    const capped = Math.min(Math.floor(n), 72 * 60); /* защита от опечаток типа 999999 */
    return Math.max(1, capped) * 60 * 1000;
}

function parseIsoMs(iso, nowMs = Date.now()) {
    if (iso === undefined || iso === null) return { ms: NaN, empty: true };
    const s = String(iso).trim();
    if (!s) return { ms: NaN, empty: true };
    const ms = Date.parse(s);
    return { ms, empty: false };
}

/**
 * Решает, слать ли отдельный alert менеджерам в теме уведомлений (не путать с relay сообщения клиента в тему).
 *
 * Политика (для сообщений клиента в личке):
 * — первое доставленное relay клиента → всегда уведомить;
 * — иначе, если есть last_client_notification_at и интервал короче cooldown → suppression;
 * — иначе (прошёл cooldown или невалидная дата прошлого уведомления) → уведомить.
 *
 * Причины manager_help обрабатываются в другом код-пути и всегда требуют отдельного правила антидубля (см. support-service handleManagerHelpRequest).
 *
 * @param {{ last_client_notification_at?: string|null }} threadRow строка из support_threads (можно только это поле)
 * @param {{ isFirstRelayedClientMessage: boolean }} params
 * @param {{ cooldownMs?: number, nowMs?: number }} [opts]
 * @returns {{ shouldNotify: boolean, reason: SupportClientNotifyReason }}
 */
function shouldNotifySupportAboutClientMessage(threadRow, params, opts = {}) {
    const nowMs = Number(opts.nowMs ?? Date.now());
    const cooldownMs = Number(opts.cooldownMs ?? resolveSupportClientNotificationCooldownMs());

    const { isFirstRelayedClientMessage } = params || {};

    const lastIso = threadRow?.last_client_notification_at;
    const { ms: lastMs, empty } = parseIsoMs(lastIso, nowMs);

    /* Первое зафиксированное сообщение клиента в тред (после успешной доставки relay) должно давать один alert независимо от содержания last_* */
    if (isFirstRelayedClientMessage === true) {
        return { shouldNotify: true, reason: 'first_client_message' };
    }

    if (empty || !Number.isFinite(lastMs)) {
        /* Нет засеченного интервала: это не должно случаться после успешной первой нотификации, трактуем как «давно не уведомляли». */
        return { shouldNotify: true, reason: 'cooldown_elapsed' };
    }

    const elapsed = nowMs - lastMs;
    if (!Number.isFinite(elapsed)) {
        return { shouldNotify: true, reason: 'cooldown_elapsed' };
    }

    if (elapsed >= cooldownMs) {
        return { shouldNotify: true, reason: 'cooldown_elapsed' };
    }

    /* Внутри cooldown и это не первый relay */
    return { shouldNotify: false, reason: 'cooldown_active' };
}

module.exports = {
    DEFAULT_COOLDOWN_MINUTES,
    resolveSupportClientNotificationCooldownMs,
    shouldNotifySupportAboutClientMessage,
    parseIsoMsForTests: parseIsoMs
};
