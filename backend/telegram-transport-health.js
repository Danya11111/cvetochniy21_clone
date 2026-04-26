/**
 * Лёгкий runtime-снимок здоровья outbound Bot API (без PII).
 * Обновляется из telegram-client на каждом outbound вызове.
 */

/** @type {{ at: string, reason: string } | null} */
let lastBroadcastPreflightBlock = null;

/** @type {{ campaignId: number, at: string, reason: string } | null} */
let lastWorkerTransportPause = null;

/** @type {{ campaignId: number, at: string } | null} */
let lastTransportResume = null;

/** Последний fail-closed halt доставки рассылки (без PII). */
/** @type {{ at: string, reason: string, source: string, campaignId?: number } | null} */
let lastBroadcastDeliveryGateHalt = null;

/** Стартап recovery: transport gate заблокировал планирование job (агрегат). */
/** @type {{ at: string, reason: string, source: string, campaignsAffected: number[] } | null} */
let lastStartupRecoveryTransportGate = null;

const runtime = {
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    lastErrorCode: null,
    lastErrorMethod: null,
    lastSuccessMethod: null,
    consecutiveTransportErrors: 0,
    totalOutboundResults: 0
};

/** Состояние активного probe (getMe); без PII. */
const probeRuntime = {
    lastProbeAtMs: null,
    lastProbeOkAtMs: null,
    lastProbeErrorAtMs: null,
    lastProbeErrorCode: null,
    lastProbeMethod: 'getMe',
    consecutiveProbeFailures: 0,
    nextProbeDueAtMs: null,
    probeState: 'IDLE',
    probeReason: null,
    lastProbeSkipReason: null
};

const DEFAULT_PROBE_PREFLIGHT_TRUST_MS = 120_000;

const TRANSPORT_LAYER_CODES = new Set([
    'TIMEOUT',
    'NETWORK',
    'TG_REQUEST_FAILED',
    'RATE_LIMIT',
    'OUTBOUND_DISABLED',
    'NO_HTTP_CLIENT'
]);

/**
 * Коды, которые считаются «transport-like» для streak (не user-level permanent).
 */
function isTransportLayerErrorCode(code) {
    return TRANSPORT_LAYER_CODES.has(String(code || ''));
}

/**
 * Для broadcast breaker: ошибки copyMessage, указывающие на transport/API pressure, не на «плохого пользователя».
 */
function isBreakerTransportCopyCode(code) {
    return isTransportLayerErrorCode(code);
}

/**
 * User/recipient-scoped терминальные — сбрасывают streak глобального transport breaker по копиям.
 */
function isUserScopedCopyTerminalCode(code) {
    const c = String(code || '');
    return (
        c === 'BOT_BLOCKED' ||
        c === 'CHAT_NOT_FOUND' ||
        c === 'USER_DEACTIVATED' ||
        c === 'FORBIDDEN' ||
        c === 'MESSAGE_NOT_FOUND' ||
        c === 'ATTEMPTS_EXHAUSTED'
    );
}

/**
 * @param {{ ok: boolean, errorCode?: string, method?: string }} p
 */
function recordTelegramOutboundResult(p) {
    const ok = Boolean(p && p.ok);
    const method = String(p && p.method ? p.method : '');
    const code = String(p && p.errorCode ? p.errorCode : '');
    runtime.totalOutboundResults += 1;
    const now = Date.now();
    if (ok) {
        runtime.lastSuccessAtMs = now;
        runtime.lastSuccessMethod = method;
        runtime.consecutiveTransportErrors = 0;
        return;
    }
    runtime.lastErrorAtMs = now;
    runtime.lastErrorCode = code;
    runtime.lastErrorMethod = method;
    if (isTransportLayerErrorCode(code)) {
        runtime.consecutiveTransportErrors += 1;
    }
    // Бизнес-ошибки Telegram API не удлиняют transport streak (но и не обнуляют last success)
}

function recordBroadcastPreflightBlocked(reason) {
    lastBroadcastPreflightBlock = {
        at: new Date().toISOString(),
        reason: String(reason || 'UNKNOWN')
    };
}

function recordBroadcastWorkerTransportPause(campaignId, reason) {
    lastWorkerTransportPause = {
        campaignId: Number(campaignId),
        at: new Date().toISOString(),
        reason: String(reason || 'UNKNOWN')
    };
}

function recordBroadcastTransportResume(campaignId) {
    lastTransportResume = {
        campaignId: Number(campaignId),
        at: new Date().toISOString()
    };
}

function setTransportProbeNextDueAtMs(ms) {
    probeRuntime.nextProbeDueAtMs = ms != null && Number.isFinite(Number(ms)) ? Number(ms) : null;
}

function getTransportProbeInternalState() {
    return { ...probeRuntime };
}

/**
 * @param {{ ok: boolean, errorCode?: string, method?: string }} p
 */
function recordTransportProbeResult(p) {
    const ok = Boolean(p && p.ok);
    const method = String((p && p.method) || 'getMe');
    const code = String((p && p.errorCode) || '');
    const now = Date.now();
    probeRuntime.lastProbeAtMs = now;
    probeRuntime.lastProbeMethod = method;
    probeRuntime.lastProbeSkipReason = null;
    if (ok) {
        probeRuntime.lastProbeOkAtMs = now;
        probeRuntime.consecutiveProbeFailures = 0;
        probeRuntime.lastProbeErrorCode = null;
        probeRuntime.probeState = 'HEALTHY';
        probeRuntime.probeReason = null;
        return;
    }
    probeRuntime.lastProbeErrorAtMs = now;
    probeRuntime.lastProbeErrorCode = code || 'UNKNOWN';
    probeRuntime.consecutiveProbeFailures += 1;
    probeRuntime.probeState = 'DEGRADED';
    probeRuntime.probeReason = code || 'PROBE_FAILED';
}

function recordTransportProbeSkipped(reason) {
    probeRuntime.lastProbeSkipReason = String(reason || 'UNKNOWN');
    probeRuntime.probeState = 'DISABLED';
    probeRuntime.probeReason = probeRuntime.lastProbeSkipReason;
}

/**
 * @param {object} ctx
 * @param {boolean} ctx.outboundEnabled
 * @param {boolean} ctx.httpClientPresent
 * @param {boolean} ctx.proxyConfigured
 * @param {string} ctx.transportMode
 */
function getTelegramTransportHealthSnapshot(ctx) {
    const outboundEnabled = Boolean(ctx && ctx.outboundEnabled);
    const httpClientPresent = Boolean(ctx && ctx.httpClientPresent);
    const proxyConfigured = Boolean(ctx && ctx.proxyConfigured);
    const transportMode = String((ctx && ctx.transportMode) || 'unknown');

    let degraded = false;
    let degradedReason = null;

    if (!outboundEnabled) {
        degraded = true;
        degradedReason = 'OUTBOUND_DISABLED';
    } else if (!httpClientPresent) {
        degraded = true;
        degradedReason = 'NO_HTTP_CLIENT';
    } else if (runtime.consecutiveTransportErrors >= 4) {
        degraded = true;
        degradedReason = 'CONSECUTIVE_OUTBOUND_TRANSPORT_ERRORS';
    } else if (
        runtime.lastSuccessAtMs &&
        runtime.lastErrorAtMs &&
        runtime.lastErrorAtMs > runtime.lastSuccessAtMs &&
        runtime.consecutiveTransportErrors >= 2 &&
        Date.now() - runtime.lastSuccessAtMs > 90_000
    ) {
        degraded = true;
        degradedReason = 'TRANSPORT_ERRORS_AFTER_STALE_SUCCESS';
    }

    return {
        outboundEnabled,
        httpClientPresent,
        proxyConfigured,
        transportMode,
        lastOutboundSuccessAt:
            runtime.lastSuccessAtMs != null ? new Date(runtime.lastSuccessAtMs).toISOString() : null,
        lastOutboundErrorAt:
            runtime.lastErrorAtMs != null ? new Date(runtime.lastErrorAtMs).toISOString() : null,
        lastOutboundErrorCode: runtime.lastErrorCode,
        lastOutboundErrorMethod: runtime.lastErrorMethod,
        lastOutboundSuccessMethod: runtime.lastSuccessMethod,
        consecutiveTransportErrors: runtime.consecutiveTransportErrors,
        totalOutboundResultsObserved: runtime.totalOutboundResults,
        degraded,
        degradedReason
    };
}

/**
 * Блокировать новый broadcast trigger (preflight), если транспорт явно неверен.
 * @param {object} ctx — как у getTelegramTransportHealthSnapshot
 * @param {{ probePreflightTrustMs?: number }} [options]
 */
function shouldBlockBroadcastTrigger(ctx, options = {}) {
    const snap = getTelegramTransportHealthSnapshot(ctx);
    if (!snap.outboundEnabled) return { block: true, reason: 'OUTBOUND_DISABLED' };
    if (!snap.httpClientPresent) return { block: true, reason: 'NO_HTTP_CLIENT' };
    const trustMs =
        options.probePreflightTrustMs != null && Number.isFinite(Number(options.probePreflightTrustMs))
            ? Math.max(5_000, Number(options.probePreflightTrustMs))
            : DEFAULT_PROBE_PREFLIGHT_TRUST_MS;

    if (snap.degraded && snap.degradedReason) {
        const now = Date.now();
        if (
            probeRuntime.lastProbeOkAtMs != null &&
            now - probeRuntime.lastProbeOkAtMs <= trustMs &&
            probeRuntime.consecutiveProbeFailures === 0
        ) {
            return { block: false, reason: null, allowedByActiveProbe: true };
        }
        return { block: true, reason: snap.degradedReason };
    }
    return { block: false, reason: null };
}

/**
 * Fail-closed gate для активной доставки рассылки: probe TIMEOUT / passive degraded / preflight.
 * Шире, чем только shouldBlockBroadcastTrigger: учитывает DEGRADED probe даже до passive consecutive errors.
 * @param {object} ctx — как getTelegramTransportHealthSnapshot
 * @param {{ probePreflightTrustMs?: number }} [options]
 * @returns {{ halt: boolean, reason: string | null, source: 'probe' | 'preflight' | null }}
 */
function shouldHaltBroadcastDelivery(ctx, options = {}) {
    const pr = getTransportProbeInternalState();
    if (pr.probeState === 'DEGRADED' && pr.consecutiveProbeFailures >= 1) {
        return {
            halt: true,
            reason: String(pr.probeReason || pr.lastProbeErrorCode || 'PROBE_FAILED').slice(0, 120),
            source: 'probe'
        };
    }
    const pre = shouldBlockBroadcastTrigger(ctx, options);
    if (pre.block) {
        return { halt: true, reason: String(pre.reason || 'TRANSPORT_BLOCK').slice(0, 120), source: 'preflight' };
    }
    return { halt: false, reason: null, source: null };
}

function recordBroadcastDeliveryGateHalt(payload) {
    lastBroadcastDeliveryGateHalt = {
        at: new Date().toISOString(),
        reason: String(payload && payload.reason ? payload.reason : 'UNKNOWN').slice(0, 200),
        source: String(payload && payload.source ? payload.source : 'unknown').slice(0, 32),
        campaignId: payload && payload.campaignId != null ? Number(payload.campaignId) : undefined
    };
}

function recordStartupRecoveryTransportGate(payload) {
    lastStartupRecoveryTransportGate = {
        at: new Date().toISOString(),
        reason: String(payload && payload.reason ? payload.reason : 'UNKNOWN').slice(0, 200),
        source: String(payload && payload.source ? payload.source : 'unknown').slice(0, 32),
        campaignsAffected: Array.isArray(payload && payload.campaignsAffected)
            ? payload.campaignsAffected.map((x) => Number(x)).filter((n) => Number.isFinite(n))
            : []
    };
}

function getBroadcastTransportGateDiagnostics() {
    return {
        lastDeliveryGateHalt: lastBroadcastDeliveryGateHalt ? { ...lastBroadcastDeliveryGateHalt } : null,
        lastStartupRecoveryTransportGate: lastStartupRecoveryTransportGate
            ? { ...lastStartupRecoveryTransportGate, campaignsAffected: [...lastStartupRecoveryTransportGate.campaignsAffected] }
            : null
    };
}

/**
 * @param {object} probeConfig — enabled, method, intervalMs, backoffMaxMs, preflightTrustMs из config/server
 */
function getTransportProbeSnapshot(probeConfig = {}) {
    const enabled = Boolean(probeConfig.enabled);
    const method = String(probeConfig.method || 'getMe');
    const intervalMs = Math.max(5_000, Number(probeConfig.intervalMs) || 60_000);
    const backoffMaxMs = Math.max(intervalMs, Number(probeConfig.backoffMaxMs) || 300_000);
    const preflightTrustMs =
        probeConfig.preflightTrustMs != null && Number.isFinite(Number(probeConfig.preflightTrustMs))
            ? Number(probeConfig.preflightTrustMs)
            : DEFAULT_PROBE_PREFLIGHT_TRUST_MS;

    return {
        enabled,
        method,
        intervalMs,
        backoffMaxMs,
        preflightTrustMs,
        lastProbeAt: probeRuntime.lastProbeAtMs != null ? new Date(probeRuntime.lastProbeAtMs).toISOString() : null,
        lastProbeOkAt: probeRuntime.lastProbeOkAtMs != null ? new Date(probeRuntime.lastProbeOkAtMs).toISOString() : null,
        lastProbeErrorAt: probeRuntime.lastProbeErrorAtMs != null ? new Date(probeRuntime.lastProbeErrorAtMs).toISOString() : null,
        lastProbeErrorCode: probeRuntime.lastProbeErrorCode,
        consecutiveProbeFailures: probeRuntime.consecutiveProbeFailures,
        nextProbeDueAt:
            probeRuntime.nextProbeDueAtMs != null ? new Date(probeRuntime.nextProbeDueAtMs).toISOString() : null,
        probeState: probeRuntime.probeState,
        probeReason: probeRuntime.probeReason,
        lastProbeSkipReason: probeRuntime.lastProbeSkipReason
    };
}

/**
 * Урезанный снимок для durable transport-gate events (без PII, только агрегаты).
 * @param {object} ctx — как getTelegramTransportHealthSnapshot
 * @param {object} [probeConfig] — как getTransportProbeSnapshot
 */
function buildTransportGateDiagnosticSnapshot(ctx, probeConfig = {}) {
    const h = getTelegramTransportHealthSnapshot(ctx);
    const p = getTransportProbeSnapshot(probeConfig);
    return {
        degraded: h.degraded,
        degradedReason: h.degradedReason,
        consecutiveTransportErrors: h.consecutiveTransportErrors,
        consecutiveProbeFailures: p.consecutiveProbeFailures,
        probeState: p.probeState,
        transportMode: h.transportMode,
        outboundEnabled: h.outboundEnabled,
        httpClientPresent: h.httpClientPresent,
        proxyConfigured: h.proxyConfigured
    };
}

function getBroadcastTransportOpsDiagnostics() {
    return {
        lastPreflightBlock: lastBroadcastPreflightBlock ? { ...lastBroadcastPreflightBlock } : null,
        lastWorkerTransportPause: lastWorkerTransportPause ? { ...lastWorkerTransportPause } : null,
        lastTransportResume: lastTransportResume ? { ...lastTransportResume } : null,
        ...getBroadcastTransportGateDiagnostics()
    };
}

/** Только для unit-тестов — сброс in-memory runtime. */
function resetTelegramTransportHealthRuntimeForTests() {
    lastBroadcastPreflightBlock = null;
    lastWorkerTransportPause = null;
    lastTransportResume = null;
    lastBroadcastDeliveryGateHalt = null;
    lastStartupRecoveryTransportGate = null;
    runtime.lastSuccessAtMs = null;
    runtime.lastErrorAtMs = null;
    runtime.lastErrorCode = null;
    runtime.lastErrorMethod = null;
    runtime.lastSuccessMethod = null;
    runtime.consecutiveTransportErrors = 0;
    runtime.totalOutboundResults = 0;
    probeRuntime.lastProbeAtMs = null;
    probeRuntime.lastProbeOkAtMs = null;
    probeRuntime.lastProbeErrorAtMs = null;
    probeRuntime.lastProbeErrorCode = null;
    probeRuntime.lastProbeMethod = 'getMe';
    probeRuntime.consecutiveProbeFailures = 0;
    probeRuntime.nextProbeDueAtMs = null;
    probeRuntime.probeState = 'IDLE';
    probeRuntime.probeReason = null;
    probeRuntime.lastProbeSkipReason = null;
}

module.exports = {
    recordTelegramOutboundResult,
    recordBroadcastPreflightBlocked,
    recordBroadcastWorkerTransportPause,
    recordBroadcastTransportResume,
    getTelegramTransportHealthSnapshot,
    shouldBlockBroadcastTrigger,
    shouldHaltBroadcastDelivery,
    recordBroadcastDeliveryGateHalt,
    recordStartupRecoveryTransportGate,
    getBroadcastTransportGateDiagnostics,
    getBroadcastTransportOpsDiagnostics,
    isTransportLayerErrorCode,
    isBreakerTransportCopyCode,
    isUserScopedCopyTerminalCode,
    resetTelegramTransportHealthRuntimeForTests,
    recordTransportProbeResult,
    recordTransportProbeSkipped,
    setTransportProbeNextDueAtMs,
    getTransportProbeInternalState,
    getTransportProbeSnapshot,
    buildTransportGateDiagnosticSnapshot,
    DEFAULT_PROBE_PREFLIGHT_TRUST_MS
};
