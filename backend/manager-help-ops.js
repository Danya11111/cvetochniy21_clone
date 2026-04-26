'use strict';

const lastSuccessfulNotifyAtByUser = new Map();
const inFlightUserIds = new Set();

const metrics = {
    lastManagerHelpRequestAt: null,
    lastManagerHelpNotifyAt: null,
    managerHelpDuplicateSuppressCount: 0,
    managerHelpLastError: null
};

function resetManagerHelpOpsForTests() {
    lastSuccessfulNotifyAtByUser.clear();
    inFlightUserIds.clear();
    metrics.lastManagerHelpRequestAt = null;
    metrics.lastManagerHelpNotifyAt = null;
    metrics.managerHelpDuplicateSuppressCount = 0;
    clearManagerHelpLastError();
}

function recordManagerHelpRequestInbound() {
    metrics.lastManagerHelpRequestAt = new Date().toISOString();
}

function recordManagerHelpNotifySuccess() {
    metrics.lastManagerHelpNotifyAt = new Date().toISOString();
}

function bumpDuplicateSuppress() {
    metrics.managerHelpDuplicateSuppressCount += 1;
}

function recordManagerHelpLastError(code, message) {
    metrics.managerHelpLastError = {
        at: new Date().toISOString(),
        code: String(code || 'UNKNOWN'),
        message: String(message || '').slice(0, 240)
    };
}

function clearManagerHelpLastError() {
    metrics.managerHelpLastError = null;
}

function getManagerHelpOpsSnapshot() {
    return {
        lastManagerHelpRequestAt: metrics.lastManagerHelpRequestAt,
        lastManagerHelpNotifyAt: metrics.lastManagerHelpNotifyAt,
        managerHelpDuplicateSuppressCount: metrics.managerHelpDuplicateSuppressCount,
        managerHelpLastError: metrics.managerHelpLastError
            ? { ...metrics.managerHelpLastError }
            : null
    };
}

function isCooldownActive(telegramUserId, cooldownMs, now = Date.now()) {
    const t = lastSuccessfulNotifyAtByUser.get(String(telegramUserId));
    if (!t) return false;
    return now - t < cooldownMs;
}

function markNotifyCooldown(telegramUserId, now = Date.now()) {
    lastSuccessfulNotifyAtByUser.set(String(telegramUserId), now);
}

function tryBeginManagerHelpInFlight(telegramUserId) {
    const id = String(telegramUserId);
    if (inFlightUserIds.has(id)) return false;
    inFlightUserIds.add(id);
    return true;
}

function endManagerHelpInFlight(telegramUserId) {
    inFlightUserIds.delete(String(telegramUserId));
}

module.exports = {
    resetManagerHelpOpsForTests,
    recordManagerHelpRequestInbound,
    recordManagerHelpNotifySuccess,
    bumpDuplicateSuppress,
    recordManagerHelpLastError,
    clearManagerHelpLastError,
    getManagerHelpOpsSnapshot,
    isCooldownActive,
    markNotifyCooldown,
    tryBeginManagerHelpInFlight,
    endManagerHelpInFlight
};
