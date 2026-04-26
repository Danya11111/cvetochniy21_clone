function classifyTelegramDescription(description = '') {
    const lower = String(description || '').toLowerCase();
    if (lower.includes('bot was blocked by the user')) return 'BOT_BLOCKED';
    if (lower.includes('user is deactivated')) return 'USER_DEACTIVATED';
    if (lower.includes('chat not found')) return 'CHAT_NOT_FOUND';
    if (lower.includes('forbidden')) return 'FORBIDDEN';
    if (lower.includes('message to delete not found')) return 'MESSAGE_NOT_FOUND';
    if (lower.includes('retry after') || lower.includes('too many requests')) return 'RATE_LIMIT';
    if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) return 'TIMEOUT';
    if (lower.includes('econnreset') || lower.includes('enotfound') || lower.includes('network')) return 'NETWORK';
    return 'TG_REQUEST_FAILED';
}

function isRetryableTelegramError(errorCode) {
    return ['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'TG_REQUEST_FAILED', 'INTERNAL_EXCEPTION'].includes(
        String(errorCode || '')
    );
}

/**
 * Ошибки доставки рассылки (copyMessage), после которых повтор бессмысленен.
 */
function isPermanentBroadcastDeliveryError(errorCode) {
    const c = String(errorCode || '');
    return [
        'BOT_BLOCKED',
        'CHAT_NOT_FOUND',
        'USER_DEACTIVATED',
        'FORBIDDEN',
        'MESSAGE_NOT_FOUND',
        'OUTBOUND_DISABLED',
        'NO_HTTP_CLIENT'
    ].includes(c);
}

function computeNextRetryAt(attempts = 0, retryAfterSec) {
    if (retryAfterSec && retryAfterSec > 0) {
        return new Date(Date.now() + retryAfterSec * 1000).toISOString();
    }
    const stepMs = [30_000, 120_000, 300_000, 900_000, 1800_000];
    const idx = Math.max(0, Math.min(stepMs.length - 1, Number(attempts || 0)));
    return new Date(Date.now() + stepMs[idx]).toISOString();
}

module.exports = {
    classifyTelegramDescription,
    isRetryableTelegramError,
    isPermanentBroadcastDeliveryError,
    computeNextRetryAt
};

