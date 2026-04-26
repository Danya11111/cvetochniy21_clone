const {
    isBreakerTransportCopyCode,
    isUserScopedCopyTerminalCode
} = require('./telegram-transport-health');

/**
 * Чистая логика streak для circuit breaker рассылки (copyMessage), без гонок и без БД.
 * @param {{ consecutiveTransportCopyFailures: number }} state
 * @param {string} errorCode — код неуспешного copyMessage
 * @returns {{ consecutiveTransportCopyFailures: number }}
 */
function applyTransportBreakerStreakAfterFailedCopy(state, errorCode) {
    const s = state && typeof state === 'object' ? state : { consecutiveTransportCopyFailures: 0 };
    const n = Math.max(0, Number(s.consecutiveTransportCopyFailures || 0));
    const code = String(errorCode || '');
    if (isUserScopedCopyTerminalCode(code)) {
        return { consecutiveTransportCopyFailures: 0 };
    }
    if (isBreakerTransportCopyCode(code)) {
        return { consecutiveTransportCopyFailures: n + 1 };
    }
    return { consecutiveTransportCopyFailures: 0 };
}

function resetTransportBreakerStreak() {
    return { consecutiveTransportCopyFailures: 0 };
}

/**
 * После волны: если была хотя бы одна успешная доставка — транспорт «жив» для потока.
 * @param {{ consecutiveTransportCopyFailures: number }} state
 * @param {boolean} hadSuccessfulCopyThisWave
 */
function applyTransportBreakerStreakAfterWave(state, hadSuccessfulCopyThisWave) {
    if (hadSuccessfulCopyThisWave) {
        return { consecutiveTransportCopyFailures: 0 };
    }
    const s = state && typeof state === 'object' ? state : { consecutiveTransportCopyFailures: 0 };
    return { consecutiveTransportCopyFailures: Math.max(0, Number(s.consecutiveTransportCopyFailures || 0)) };
}

module.exports = {
    applyTransportBreakerStreakAfterFailedCopy,
    resetTransportBreakerStreak,
    applyTransportBreakerStreakAfterWave
};
