const db = require('./db');
const {
    isRetryableTelegramError,
    isPermanentBroadcastDeliveryError,
    computeNextRetryAt
} = require('./reliability-utils');
const { formatBroadcastSendDurationLabelRu } = require('./broadcast-duration-format');
const { createBroadcastRateLimiter, sleep } = require('./broadcast-rate-limiter');
const {
    shouldBlockBroadcastTrigger,
    shouldHaltBroadcastDelivery,
    recordBroadcastPreflightBlocked,
    recordBroadcastWorkerTransportPause,
    recordBroadcastTransportResume,
    recordBroadcastDeliveryGateHalt,
    recordStartupRecoveryTransportGate,
    getBroadcastTransportOpsDiagnostics,
    buildTransportGateDiagnosticSnapshot
} = require('./telegram-transport-health');
const {
    applyTransportBreakerStreakAfterFailedCopy,
    resetTransportBreakerStreak,
    applyTransportBreakerStreakAfterWave
} = require('./broadcast-transport-breaker');
const {
    buildTopicMessageAuditBase,
    mapScheduleResultToAuditFields,
    insertBroadcastTriggerAudit,
    fetchBroadcastTriggerAuditDiagnostics,
    BROADCAST_TRIGGER_RESULT_CODES
} = require('./broadcast-trigger-audit');
const {
    insertBroadcastCampaignEvent,
    fetchBroadcastCampaignEventDiagnostics,
    fetchBroadcastTransportGateEventDiagnostics,
    fetchLastLifecycleEventForCampaign,
    BROADCAST_CAMPAIGN_EVENT_CODES,
    TRIGGER_KIND_FORUM_TOPIC: CAMPAIGN_TRIGGER_KIND_FORUM_TOPIC
} = require('./broadcast-campaign-events');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/**
 * @typedef {object} BroadcastDeliveryMetrics
 * @property {number} broadcast_sent_ok
 * @property {number} broadcast_failed_permanent
 * @property {number} broadcast_failed_temporary
 * @property {number} broadcast_retry_scheduled
 * @property {number} broadcast_rate_limited_429
 * @property {number|null} retry_after_seconds
 * @property {number|null} queue_remaining
 * @property {string|null} slow_reason
 */

/**
 * @typedef {object} BroadcastWorkerSnapshot
 * @property {boolean} running
 * @property {number|null} campaignId
 * @property {string|null} startedAtIso
 * @property {number} audienceSize
 * @property {number} processed
 * @property {string|null} phase
 * @property {BroadcastDeliveryMetrics|null} metrics
 * @property {object|null} rateLimiter
 * @property {number|null} queueRemaining
 * @property {number} waveBatchIndex
 * @property {boolean} [recoveryRun]
 * @property {boolean} [resumeFromDb]
 * @property {string|null} [lastWaveProgressAtIso]
 */

function createFreshMetrics() {
    return {
        broadcast_sent_ok: 0,
        broadcast_blocked: 0,
        broadcast_failed_permanent: 0,
        broadcast_failed_temporary: 0,
        broadcast_retry_scheduled: 0,
        broadcast_rate_limited_429: 0,
        retry_after_seconds: null,
        queue_remaining: null,
        slow_reason: null,
        /** @type {Record<string, number>} агрегаты errorCode по неуспешным попыткам (без chat id) */
        delivery_error_tally: {},
        /** Исключения в обработчике одного получателя (изолированы, волну не рвут) */
        broadcast_internal_exceptions: 0,
        /** Streak transport-like ошибок copyMessage (circuit breaker), без PII */
        transportBreakerStreak: { consecutiveTransportCopyFailures: 0 }
    };
}

async function mapWithConcurrency(items, concurrency, iterator) {
    if (!items.length) return;
    let ix = 0;
    const c = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
    async function worker() {
        while (true) {
            const my = ix++;
            if (my >= items.length) break;
            await iterator(items[my], my);
        }
    }
    const workers = [];
    for (let w = 0; w < c; w += 1) {
        workers.push(worker());
    }
    await Promise.all(workers);
}

function computeBroadcastRetryIso({ errorCode, retryAfterSec, attemptsSoFar }) {
    if (String(errorCode || '') === 'RATE_LIMIT') {
        const sec = Number(retryAfterSec);
        const s = Number.isFinite(sec) && sec > 0 ? sec : 1;
        return new Date(Date.now() + s * 1000).toISOString();
    }
    return computeNextRetryAt(Math.max(0, Number(attemptsSoFar || 0) - 1), null);
}

function parseIsoMs(iso) {
    const t = Date.parse(String(iso || ''));
    return Number.isFinite(t) ? t : null;
}

const DELIVERY_AGG_SQL = `
            SELECT
                SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN status IN ('FAILED', 'FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'RETRY_WAIT' THEN 1 ELSE 0 END) AS retry_wait
            FROM broadcast_deliveries
            WHERE campaign_id = ?
            `;

/** Wall-clock лимит жизни кампании (мс): после — ABORTED_TIMEOUT, без resume. */
const BROADCAST_CAMPAIGN_MAX_WALL_MS = 4 * 60 * 60 * 1000;

const BROADCAST_TERMINAL_NOTICE_KIND = Object.freeze({
    INCOMPLETE: 'INCOMPLETE',
    SUCCESS: 'SUCCESS',
    ABORTED_TIMEOUT: 'ABORTED_TIMEOUT'
});

function isTerminalBroadcastCampaignStatus(status) {
    const s = String(status || '').toUpperCase();
    return s === 'DONE' || s === 'DELETED' || s === 'ABORTED_TIMEOUT' || s === 'DELETING';
}

function isCampaignPastWallClockDeadline(row) {
    if (!row) return false;
    const created = Date.parse(String(row.created_at || ''));
    if (!Number.isFinite(created)) return false;
    return Date.now() - created >= BROADCAST_CAMPAIGN_MAX_WALL_MS;
}

/**
 * Агрегированная интерпретация для health (без PII): почему могло быть 0 доставок.
 * @param {object} p
 * @param {number} [p.deliveriesInserted] — сколько строк поставлено в очередь; при `audienceSize>0` и `0` — сбой/откат enqueue (см. `ENQUEUE_FAILED_OR_ABORTED`).
 */
function interpretBroadcastOutcome(p) {
    const audienceSize = Number(p.audienceSize || 0);
    const delivered = Number(p.delivered || 0);
    const blocked = Number(p.blocked || 0);
    const failed = Number(p.failed || 0);
    const pending = Number(p.pending || 0);
    const retryWait = Number(p.retry_wait || 0);
    const m = p.metrics || {};
    const topicTestMode = Boolean(p.topicTestMode);

    const tags = [];
    if (Number(m.broadcast_internal_exceptions || 0) > 0) tags.push('INTERNAL_HANDLER_EXCEPTIONS');
    if (audienceSize === 0) {
        tags.push('ZERO_AUDIENCE');
        return { primary: 'ZERO_AUDIENCE', tags, topicTestMode };
    }
    const enqueued =
        p.deliveriesInserted != null
            ? Number(p.deliveriesInserted)
            : p.deliveriesEnqueued != null
              ? Number(p.deliveriesEnqueued)
              : null;
    if (enqueued !== null && Number.isFinite(enqueued) && enqueued === 0) {
        tags.push('ZERO_ENQUEUED_ROWS');
        return { primary: 'ENQUEUE_FAILED_OR_ABORTED', tags, topicTestMode };
    }
    const queueLeft = pending + retryWait;
    if (queueLeft > 0) {
        tags.push('PENDING_OR_RETRY_WAIT_REMAINS');
        return { primary: 'QUEUE_INCOMPLETE', tags, topicTestMode };
    }
    if (delivered > 0) {
        tags.push('HAS_DELIVERIES');
        return { primary: 'DELIVERIES_OK', tags, topicTestMode };
    }
    if (Number(m.broadcast_rate_limited_429 || 0) > 0) tags.push('SEEN_429_RATE_LIMIT');
    if (Number(m.broadcast_retry_scheduled || 0) > 0) tags.push('RETRY_SCHEDULED');
    if (Number(m.broadcast_failed_temporary || 0) > 0) tags.push('TRANSIENT_FAILURES');
    if (Number(m.broadcast_failed_permanent || 0) > 0) tags.push('PERMANENT_FAILURES');
    if (Number(m.broadcast_blocked || 0) > 0) tags.push('BOT_BLOCKED_OR_SUPPRESSED');
    if (blocked > 0 && delivered === 0) tags.push('DB_COUNTS_BLOCKED');
    if (failed > 0) tags.push('DB_COUNTS_FAILED');

    let primary = 'ZERO_DELIVERIES_FINISHED';
    if (blocked > 0 && failed === 0) primary = 'ZERO_DELIVERIES_DOMINATED_BY_BLOCKED';
    else if (failed > 0) primary = 'ZERO_DELIVERIES_WITH_FAILURES';
    else if (Number(m.broadcast_sent_ok || 0) === 0 && audienceSize > 0)
        primary = 'ZERO_DELIVERIES_NO_SUCCESSFUL_COPY';

    return { primary, tags: tags.length ? tags : ['ZERO_DELIVERIES_UNKNOWN_MIX'], topicTestMode };
}

/**
 * Решение startup-recovery без PII: что делать с RUNNING-кампанией после рестарта процесса.
 * @param {{ status?: string, created_at?: string }} campaignRow
 * @param {{ totalRows: number, queueRemaining: number }} stats — queueRemaining как в countQueueRemaining (PENDING + RETRY_WAIT)
 * @param {{ nowMs?: number, abandonNoRowsAfterMs?: number }} [opts]
 * @returns {{ action: 'skip'|'resume_delivery'|'resume_finalize'|'abandon_empty', reason: string }}
 */
function computeBroadcastRecoveryAction(campaignRow, stats, opts = {}) {
    const status = String(campaignRow?.status || '').toUpperCase();
    const nowMs = opts.nowMs != null ? Number(opts.nowMs) : Date.now();
    const abandonMs =
        opts.abandonNoRowsAfterMs != null ? Number(opts.abandonNoRowsAfterMs) : 120_000;
    const totalRows = Math.max(0, Number(stats?.totalRows || 0));
    const queueRemaining = Math.max(0, Number(stats?.queueRemaining || 0));
    if (status === 'ABORTED_TIMEOUT') {
        return { action: 'skip', reason: 'ABORTED_TIMEOUT' };
    }
    if (status !== 'RUNNING' && status !== 'PAUSED_TRANSPORT') {
        return { action: 'skip', reason: 'NOT_RUNNING' };
    }
    if (queueRemaining > 0) {
        return { action: 'resume_delivery', reason: 'PENDING_OR_RETRY_IN_QUEUE' };
    }
    if (totalRows > 0) {
        return { action: 'resume_finalize', reason: 'QUEUE_DRAINED_NEEDS_SUMMARY_OR_DONE' };
    }
    const created = Date.parse(String(campaignRow?.created_at || ''));
    const ageOk = Number.isFinite(created) && nowMs - created >= abandonMs;
    if (totalRows === 0 && ageOk) {
        return { action: 'abandon_empty', reason: 'STALLED_NO_DELIVERY_ROWS' };
    }
    return { action: 'skip', reason: 'WAITING_FOR_ENQUEUE_OR_TOO_YOUNG' };
}

const STALL_NO_PROGRESS_MS = 10 * 60 * 1000;
const STALL_PRE_ENQUEUE_MS = 90 * 1000;

/**
 * Диагностика «застыла ли» RUNNING-кампания и где мы в воронке trigger→progress (без PII).
 * @param {object} campaignRow
 * @param {{ totalRows: number, queueRemaining: number, futureRetryScheduled: number, dueWorkNow?: number, nowMs?: number, workerActiveForThisCampaign: boolean, transportLikelyFromLastRun?: boolean }} ctx
 */
function deriveBroadcastStallState(campaignRow, ctx) {
    const status = String(campaignRow?.status || '').toUpperCase();
    const nowMs = ctx.nowMs != null ? Number(ctx.nowMs) : Date.now();
    const totalRows = Math.max(0, Number(ctx.totalRows || 0));
    const queueRemaining = Math.max(0, Number(ctx.queueRemaining || 0));
    const futureRetry = Math.max(0, Number(ctx.futureRetryScheduled || 0));
    const dueWork = ctx.dueWorkNow != null ? Number(ctx.dueWorkNow) : null;
    const workerOn = Boolean(ctx.workerActiveForThisCampaign);
    const transportHint = Boolean(ctx.transportLikelyFromLastRun);

    const createdMs = Date.parse(String(campaignRow?.created_at || ''));
    const enqueueMs = campaignRow?.delivery_enqueue_completed_at
        ? Date.parse(String(campaignRow.delivery_enqueue_completed_at))
        : null;
    const lastProgMs = campaignRow?.delivery_last_progress_at
        ? Date.parse(String(campaignRow.delivery_last_progress_at))
        : null;
    const firstAttemptMs = campaignRow?.delivery_first_attempt_at
        ? Date.parse(String(campaignRow.delivery_first_attempt_at))
        : null;
    const firstDelMs = campaignRow?.delivery_first_delivered_at
        ? Date.parse(String(campaignRow.delivery_first_delivered_at))
        : null;
    const waveCount = Math.max(0, Number(campaignRow?.delivery_wave_count || 0));
    const internalEx = Math.max(0, Number(campaignRow?.delivery_internal_exception_count || 0));

    const funnel = {
        campaignCreated: Number.isFinite(createdMs),
        enqueueRecorded: Number.isFinite(enqueueMs),
        firstWave: waveCount > 0,
        firstAttempt: Number.isFinite(firstAttemptMs),
        firstDelivered: Number.isFinite(firstDelMs)
    };

    const lastProgressAgeMs =
        Number.isFinite(lastProgMs) && lastProgMs <= nowMs ? nowMs - lastProgMs : null;

    if (status === 'DONE') {
        return {
            progressState: 'DONE',
            stallReason: null,
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: transportHint,
            internalExceptionCount: internalEx,
            note: 'see_done_open_queue_field_for_anomaly'
        };
    }

    if (status === 'PAUSED_TRANSPORT') {
        return {
            progressState: 'TRANSPORT_PAUSED',
            stallReason: 'BROADCAST_PAUSED_BY_TRANSPORT_BREAKER',
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: true,
            internalExceptionCount: internalEx
        };
    }

    if (status !== 'RUNNING') {
        return {
            progressState: 'NOT_RUNNING',
            stallReason: null,
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: transportHint,
            internalExceptionCount: internalEx
        };
    }

    if (!funnel.enqueueRecorded && totalRows === 0) {
        const age = Number.isFinite(createdMs) ? nowMs - createdMs : 0;
        if (age < STALL_PRE_ENQUEUE_MS) {
            return {
                progressState: 'PRE_ENQUEUE',
                stallReason: 'WAITING_ENQUEUE_OR_JOB',
                funnel,
                lastProgressAgeMs,
                transportLikelyFromLastRun: false,
                internalExceptionCount: internalEx
            };
        }
        return {
            progressState: 'STALLED',
            stallReason: 'NO_ENQUEUE_TOO_LONG',
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: false,
            internalExceptionCount: internalEx
        };
    }

    if (queueRemaining > 0 && futureRetry > 0 && (dueWork === 0 || dueWork === null)) {
        return {
            progressState: 'WAITING_SCHEDULED_RETRY',
            stallReason: null,
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: transportHint,
            internalExceptionCount: internalEx
        };
    }

    if (!workerOn && queueRemaining > 0) {
        return {
            progressState: 'STALLED',
            stallReason: 'WORKER_INACTIVE_BUT_QUEUE_OPEN',
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: transportHint,
            internalExceptionCount: internalEx
        };
    }

    if (
        workerOn &&
        queueRemaining > 0 &&
        lastProgressAgeMs != null &&
        lastProgressAgeMs > STALL_NO_PROGRESS_MS
    ) {
        return {
            progressState: 'STALLED',
            stallReason: transportHint ? 'NO_PROGRESS_TRANSPORT_SUSPECT' : 'NO_PROGRESS_LONG',
            funnel,
            lastProgressAgeMs,
            transportLikelyFromLastRun: transportHint,
            internalExceptionCount: internalEx
        };
    }

    return {
        progressState: 'ACTIVE',
        stallReason: null,
        funnel,
        lastProgressAgeMs,
        transportLikelyFromLastRun: transportHint,
        internalExceptionCount: internalEx
    };
}

function createBroadcastService({
    telegramClient,
    broadcastTopicChatId,
    broadcastTopicThreadId,
    adminIds = [],
    topicTestModeEnabled = false,
    topicTestTelegramIds = [],
    topicTestLabel = '',
    deliveryIntervalMs = 55,
    globalMessagesPerSec = 18,
    workerConcurrency = 4,
    perChatMinIntervalMs = 1000,
    retryWavePollMs = 400,
    deliveryWaveBatchSize = 500,
    maxCopyAttempts = 8,
    transportBreakerCopyStreak = 12,
    /** @returns {{ outboundEnabled: boolean, httpClientPresent: boolean, proxyConfigured: boolean, transportMode: string }} */
    getTransportPreflightContext = null,
    probePreflightTrustMs = 120_000,
    pausedTransportAutoResumeMinIntervalMs = 120_000,
    pausedTransportPerCampaignCooldownMs = 180_000,
    pausedTransportSweepMs = 45_000,
    broadcastsEnabled = true,
    /** @type {null|((row: object) => Promise<unknown>)} тесты: подмена записи audit */
    broadcastTriggerAuditInsert = null,
    /** @type {null|((row: object) => Promise<unknown>)} тесты: подмена campaign lifecycle events */
    broadcastCampaignEventInsert = null,
    /** @type {boolean} только тесты: имитация сбоя INSERT кампании до audit */
    debugForceCampaignInsertError = false,
    logger = console
}) {
    const trusted = new Set((adminIds || []).map(String));
    const rawTopicTestEntries = (topicTestTelegramIds || []).map((v) => String(v || '').trim()).filter(Boolean);
    const sanitizedTopicTestIds = rawTopicTestEntries.filter((v) => /^\d+$/.test(v));
    const isTopicTestModeEnabled = Boolean(topicTestModeEnabled);

    const copyAttemptsCap = Math.max(1, Math.min(50, Number(maxCopyAttempts) || 8));
    const waveBatchSize = Math.max(10, Math.min(5000, Number(deliveryWaveBatchSize) || 500));
    const workersN = Math.max(1, Math.min(32, Number(workerConcurrency) || 4));
    const pollMs = Math.max(50, Math.min(60_000, Number(retryWavePollMs) || 400));
    const transportBreakerThreshold = Math.max(3, Math.min(500, Number(transportBreakerCopyStreak) || 12));
    const probePreflightTrustMsResolved = Math.max(5_000, Number(probePreflightTrustMs) || 120_000);
    const pausedTransportAutoResumeMinMs = Math.max(10_000, Number(pausedTransportAutoResumeMinIntervalMs) || 120_000);
    const perCampaignResumeCooldownMs = Math.max(15_000, Number(pausedTransportPerCampaignCooldownMs) || 180_000);
    const pausedTransportSweepMsResolved = Math.max(15_000, Number(pausedTransportSweepMs) || 45_000);

    async function persistTopicTriggerAuditRow(row) {
        try {
            if (typeof broadcastTriggerAuditInsert === 'function') {
                await broadcastTriggerAuditInsert(row);
            } else {
                await insertBroadcastTriggerAudit({ run, logger }, row);
            }
        } catch (e) {
            logger.error('[BroadcastTriggerAudit] record_failed', {
                message: e.message || String(e),
                resultCode: row && row.result_code,
                tag: 'BROADCAST_TRIGGER_AUDIT_EXCEPTION'
            });
        }
    }

    async function persistTopicTriggerAuditFromMessage(updateMessage, fields) {
        const base = buildTopicMessageAuditBase(updateMessage, isTopicTestModeEnabled);
        await persistTopicTriggerAuditRow({ ...base, ...fields });
    }

    async function persistCampaignEvent(campaignId, eventCode, details = {}, meta = {}) {
        let tt = meta.topicTestMode;
        if (tt === undefined) {
            try {
                const row = await get('SELECT topic_test_mode FROM broadcast_campaigns WHERE id = ?', [Number(campaignId)]);
                tt = Number(row?.topic_test_mode) === 1;
            } catch (_) {
                tt = false;
            }
        }
        const row = {
            campaign_id: Number(campaignId),
            event_code: eventCode,
            event_category: meta.eventCategory || 'lifecycle',
            trigger_kind: meta.triggerKind != null ? meta.triggerKind : null,
            topic_test_mode: tt ? 1 : 0,
            details
        };
        try {
            if (typeof broadcastCampaignEventInsert === 'function') {
                await broadcastCampaignEventInsert(row);
            } else {
                await insertBroadcastCampaignEvent({ run, logger }, row);
            }
        } catch (e) {
            logger.error('[BroadcastCampaignEvent] record_failed', {
                message: e.message || String(e),
                campaignId,
                eventCode,
                tag: 'BROADCAST_CAMPAIGN_EVENT_WRAP_FAIL'
            });
        }
    }

    /** @type {number|null} */
    let lastAutoResumeAtMs = null;
    /** @type {number|null} */
    let lastAutoResumeCampaignId = null;
    /** @type {string|null} */
    let lastAutoResumeResult = null;
    /** @type {number|null} */
    let nextPausedTransportSweepAtMs = null;
    const autoResumeAttemptByCampaign = new Map();

    function preflightBroadcastTrigger() {
        return shouldBlockBroadcastTrigger(resolveTransportPreflightContext(), {
            probePreflightTrustMs: probePreflightTrustMsResolved
        });
    }

    function getPausedTransportAutoResumeDiagnostics() {
        return {
            lastAutoResumeAt: lastAutoResumeAtMs != null ? new Date(lastAutoResumeAtMs).toISOString() : null,
            lastAutoResumeCampaignId,
            lastAutoResumeResult,
            nextPausedTransportSweepAt:
                nextPausedTransportSweepAtMs != null ? new Date(nextPausedTransportSweepAtMs).toISOString() : null
        };
    }

    /**
     * Авто-resume кампаний PAUSED_TRANSPORT после восстановления транспорта (без повторного enqueue).
     * @param {string} trigger
     */
    async function tryAutoResumePausedTransportCampaigns(trigger = 'unknown') {
        const now = Date.now();
        nextPausedTransportSweepAtMs = now + pausedTransportSweepMsResolved;

        if (!broadcastsEnabled) {
            lastAutoResumeResult = 'BROADCASTS_DISABLED';
            return { ok: false, reason: 'BROADCASTS_DISABLED' };
        }

        const pre = preflightBroadcastTrigger();
        if (pre.block) {
            logger.log('[BroadcastRecovery] paused_transport_resume_blocked_by_transport', {
                trigger,
                reason: pre.reason,
                tag: 'BROADCAST_PAUSED_RESUME_BLOCK'
            });
            lastAutoResumeResult = `BLOCKED:${pre.reason}`;
            return { ok: false, reason: 'TRANSPORT_BLOCK', transportReason: pre.reason };
        }

        if (lastAutoResumeAtMs != null && now - lastAutoResumeAtMs < pausedTransportAutoResumeMinMs) {
            logger.log('[BroadcastRecovery] paused_transport_resume_skipped', {
                trigger,
                reason: 'GLOBAL_COOLDOWN',
                tag: 'BROADCAST_PAUSED_RESUME_COOLDOWN'
            });
            lastAutoResumeResult = 'SKIPPED_GLOBAL_COOLDOWN';
            return { ok: false, reason: 'GLOBAL_COOLDOWN' };
        }

        let pausedRows = [];
        try {
            pausedRows = await all(
                `
                SELECT id, topic_test_mode, source_chat_id, source_message_id, created_at, status
                FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) = 'PAUSED_TRANSPORT'
                ORDER BY id ASC
                `
            );
        } catch (e) {
            lastAutoResumeResult = 'QUERY_FAILED';
            return { ok: false, reason: 'QUERY_FAILED' };
        }

        if (!pausedRows.length) {
            lastAutoResumeResult = 'NO_PAUSED_CAMPAIGNS';
            return { ok: false, reason: 'NO_PAUSED_CAMPAIGNS' };
        }

        logger.log('[BroadcastRecovery] paused_transport_resume_candidate', {
            trigger,
            pausedCount: pausedRows.length,
            tag: 'BROADCAST_PAUSED_RESUME_CANDIDATE'
        });

        for (const row of pausedRows) {
            const cid = Number(row.id);
            if (isCampaignPastWallClockDeadline(row)) {
                void persistCampaignEvent(cid, BROADCAST_CAMPAIGN_EVENT_CODES.RESUME_SKIPPED_CAMPAIGN_TIMEOUT, {
                    reason: 'WALL_CLOCK_EXCEEDED'
                }, { topicTestMode: Number(row.topic_test_mode) === 1 });
                logger.log('[BroadcastRecovery] paused_transport_resume_skipped', {
                    campaignId: cid,
                    reason: 'WALL_CLOCK_TIMEOUT',
                    tag: 'BROADCAST_PAUSED_RESUME_TIMEOUT'
                });
                continue;
            }
            const lastCampTry = autoResumeAttemptByCampaign.get(cid) || 0;
            if (now - lastCampTry < perCampaignResumeCooldownMs) {
                logger.log('[BroadcastRecovery] paused_transport_resume_skipped', {
                    campaignId: cid,
                    reason: 'PER_CAMPAIGN_COOLDOWN',
                    tag: 'BROADCAST_PAUSED_RESUME_SKIP'
                });
                continue;
            }
            if (activeCampaignJobs.has(cid)) {
                logger.log('[BroadcastRecovery] paused_transport_resume_skipped', {
                    campaignId: cid,
                    reason: 'ALREADY_ACTIVE',
                    tag: 'BROADCAST_PAUSED_RESUME_SKIP'
                });
                continue;
            }

            const pre2 = preflightBroadcastTrigger();
            if (pre2.block) {
                logger.log('[BroadcastRecovery] paused_transport_resume_blocked_by_transport', {
                    campaignId: cid,
                    reason: pre2.reason,
                    tag: 'BROADCAST_PAUSED_RESUME_BLOCK'
                });
                lastAutoResumeResult = `BLOCKED:${pre2.reason}`;
                return { ok: false, reason: 'TRANSPORT_BLOCK', campaignId: cid };
            }

            const totalRow = await get(`SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`, [cid]);
            const totalRows = Number(totalRow?.c || 0);
            const topicTm = Number(row.topic_test_mode) === 1;

            const sch = scheduleCampaignDeliveryJob({
                campaignId: cid,
                sourceChatId: row.source_chat_id,
                sourceMessageId: row.source_message_id,
                recipients: [],
                mode: {
                    resumeFromDb: true,
                    recoveryRun: false,
                    autoResumeFromPausedTransport: true,
                    isTopicTestMode: topicTm,
                    recipientsTargeted: totalRows
                }
            });

            autoResumeAttemptByCampaign.set(cid, now);
            lastAutoResumeAtMs = now;
            lastAutoResumeCampaignId = cid;
            lastAutoResumeResult = sch.scheduled ? 'SCHEDULED' : String(sch.reason || 'NOT_SCHEDULED');

            if (sch.scheduled) {
                logger.log('[BroadcastRecovery] paused_transport_resume_scheduled', {
                    campaignId: cid,
                    trigger,
                    tag: 'BROADCAST_PAUSED_RESUME_OK'
                });
                void persistCampaignEvent(cid, BROADCAST_CAMPAIGN_EVENT_CODES.AUTO_RESUME_SCHEDULED, {
                    trigger: String(trigger || '').slice(0, 80)
                }, { topicTestMode: topicTm });
            } else {
                logger.log('[BroadcastRecovery] paused_transport_resume_skipped', {
                    campaignId: cid,
                    reason: sch.reason || 'UNKNOWN',
                    tag: 'BROADCAST_PAUSED_RESUME_SKIP'
                });
            }

            return {
                ok: sch.scheduled,
                campaignId: cid,
                scheduleReason: sch.reason || null
            };
        }

        lastAutoResumeResult = 'NO_ELIGIBLE_AFTER_FILTERS';
        return { ok: false, reason: 'NO_ELIGIBLE' };
    }

    function resolveTransportPreflightContext() {
        if (typeof getTransportPreflightContext === 'function') {
            try {
                return getTransportPreflightContext() || {};
            } catch (e) {
                logger.warn('[BroadcastPreflight] getTransportPreflightContext_failed', {
                    message: e.message || String(e)
                });
                return {};
            }
        }
        return {};
    }

    /** @type {BroadcastWorkerSnapshot} */
    let workerSnapshot = {
        running: false,
        campaignId: null,
        startedAtIso: null,
        audienceSize: 0,
        processed: 0,
        phase: 'idle',
        metrics: null,
        rateLimiter: null,
        queueRemaining: null,
        waveBatchIndex: 0,
        recoveryRun: false,
        resumeFromDb: false,
        lastWaveProgressAtIso: null
    };

    /** @type {BroadcastDeliveryMetrics} */
    let lastDeliveryMetrics = createFreshMetrics();

    /** Последняя попытка рассылки: снимок для /api/health/ops (без PII). */
    let lastBroadcastRunDiagnostics = null;

    /** Последний результат триггера из темы (до/вместо job): для ops без grep по журналу (без PII). */
    let lastBroadcastTriggerOutcome = null;

    /** Результат последнего startup recovery (без PII). */
    let lastStartupRecoverySnapshot = null;

    /** Последний sweep wall-clock timeout (без PII). */
    let lastWallClockSweepResult = null;

    /** Защита от двух параллельных job на один campaign_id (trigger + recovery). */
    const activeCampaignJobs = new Set();

    function recordLastBroadcastRun(payload) {
        lastBroadcastRunDiagnostics = {
            recordedAtIso: new Date().toISOString(),
            ...payload
        };
        logger.log('[BroadcastDiagnostics] snapshot', {
            campaignId: payload && payload.campaignId != null ? Number(payload.campaignId) : null,
            jobRan: payload && payload.jobRan,
            primary: payload && payload.outcomeInterpretation && payload.outcomeInterpretation.primary,
            deliveriesInserted:
                payload && payload.deliveriesInserted != null ? Number(payload.deliveriesInserted) : null,
            summaryPosted: payload && payload.summaryPosted,
            incompleteFinalization: payload && payload.incompleteFinalization
        });
    }

    function recordLastBroadcastTriggerOutcome(payload) {
        lastBroadcastTriggerOutcome = {
            recordedAtIso: new Date().toISOString(),
            ...payload
        };
    }

    function getWorkerSnapshot() {
        return { ...workerSnapshot };
    }

    function getBroadcastDeliveryMetrics() {
        return { ...lastDeliveryMetrics };
    }

    function isAdmin(telegramUserId) {
        if (!trusted.size) return true;
        return trusted.has(String(telegramUserId));
    }

    async function createCampaignFromSource({ sourceChatId, sourceThreadId, sourceMessageId, initiatedBy, topicTestMode = false }) {
        if (debugForceCampaignInsertError) {
            throw new Error('debug_forced_campaign_insert_fail');
        }
        const now = new Date().toISOString();
        const tt = topicTestMode ? 1 : 0;
        try {
            const r = await run(
                `
                INSERT INTO broadcast_campaigns (
                    source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id, status, topic_test_mode, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?)
                `,
                [
                    String(sourceChatId),
                    Number(sourceMessageId),
                    Number(sourceThreadId || 0),
                    String(initiatedBy),
                    tt,
                    now,
                    now
                ]
            );
            const campaign = await get('SELECT * FROM broadcast_campaigns WHERE id = ?', [r.lastID]);
            return { campaign, created: true };
        } catch (e) {
            if (String(e.message || '').toLowerCase().includes('unique constraint failed')) {
                const campaign = await get(
                    'SELECT * FROM broadcast_campaigns WHERE source_chat_id = ? AND source_message_id = ?',
                    [String(sourceChatId), Number(sourceMessageId)]
                );
                return { campaign, created: false };
            }
            throw e;
        }
    }

    async function getRecipientsForProduction() {
        const rows = await all(
            `
            SELECT telegram_id
            FROM users
            WHERE telegram_id IS NOT NULL
              AND TRIM(telegram_id) != ''
              AND broadcast_suppressed_reason IS NULL
            `
        );
        return rows.map((r) => String(r.telegram_id)).filter(Boolean);
    }

    function getRecipientsForTopicBroadcast() {
        if (isTopicTestModeEnabled) {
            return sanitizedTopicTestIds;
        }
        return null;
    }

    async function upsertDelivery({
        campaignId,
        recipientTelegramId,
        status,
        deliveredMessageId = null,
        errorCode = null,
        errorMessage = null,
        copyAttempts = null,
        nextRetryAt = null
    }) {
        const now = new Date().toISOString();
        await run(
            `
            INSERT INTO broadcast_deliveries (
                campaign_id, recipient_telegram_id, status, delivered_message_id, error_code, error_message,
                copy_attempts, next_retry_at,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(campaign_id, recipient_telegram_id) DO UPDATE SET
                status = excluded.status,
                delivered_message_id = excluded.delivered_message_id,
                error_code = excluded.error_code,
                error_message = excluded.error_message,
                copy_attempts = COALESCE(excluded.copy_attempts, copy_attempts),
                next_retry_at = excluded.next_retry_at,
                updated_at = excluded.updated_at
            `,
            [
                Number(campaignId),
                String(recipientTelegramId),
                String(status),
                deliveredMessageId ? Number(deliveredMessageId) : null,
                errorCode,
                errorMessage ? String(errorMessage).slice(0, 500) : null,
                copyAttempts !== null && copyAttempts !== undefined ? Number(copyAttempts) : null,
                nextRetryAt,
                now,
                now
            ]
        );
    }

    async function insertPendingDeliveries(campaignId, recipientIds) {
        const ids = Array.isArray(recipientIds) ? recipientIds : [];
        if (!ids.length) return 0;
        const now = new Date().toISOString();
        await run('BEGIN IMMEDIATE');
        try {
            let inserted = 0;
            for (const recipientId of ids) {
                await run(
                    `
                INSERT INTO broadcast_deliveries (
                    campaign_id, recipient_telegram_id, status, copy_attempts, next_retry_at, created_at, updated_at
                ) VALUES (?, ?, 'PENDING', 0, NULL, ?, ?)
                ON CONFLICT(campaign_id, recipient_telegram_id) DO UPDATE SET
                    status = 'PENDING',
                    delivered_message_id = NULL,
                    error_code = NULL,
                    error_message = NULL,
                    copy_attempts = 0,
                    next_retry_at = NULL,
                    updated_at = excluded.updated_at
                `,
                    [Number(campaignId), String(recipientId), now, now]
                );
                inserted += 1;
            }
            await run('COMMIT');
            return inserted;
        } catch (e) {
            await run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async function markBroadcastSuppressedForUser(telegramId, reason = 'BOT_BLOCKED') {
        const tid = String(telegramId || '').trim();
        if (!tid) return;
        await run(
            `
            UPDATE users
            SET broadcast_suppressed_reason = ?, broadcast_suppressed_at = ?
            WHERE telegram_id = ?
            `,
            [String(reason), new Date().toISOString(), tid]
        );
    }

    async function countQueueRemaining(campaignId) {
        const row = await get(
            `
            SELECT COUNT(*) AS c
            FROM broadcast_deliveries
            WHERE campaign_id = ?
              AND status IN ('PENDING', 'RETRY_WAIT')
            `,
            [Number(campaignId)]
        );
        return Number(row?.c || 0);
    }

    /**
     * Structured details для TRANSPORT_GATE_* lifecycle events (persist + health), без PII.
     * @param {object} opts
     * @param {{ halt: boolean, reason: string|null, source: string|null }} opts.gate
     */
    async function assembleTransportGateEventDetails(opts) {
        const gate = opts.gate || { halt: false, reason: null, source: null };
        const campaignId = Number(opts.campaignId);
        const mode = opts.mode && typeof opts.mode === 'object' ? opts.mode : {};
        let statsRow = opts.statsRow;
        if (!statsRow && Number.isFinite(campaignId)) {
            try {
                statsRow = await get(DELIVERY_AGG_SQL, [campaignId]);
            } catch (_) {
                statsRow = null;
            }
        }
        const sr = statsRow || {};
        let qr = opts.queueRemaining;
        if (qr == null && Number.isFinite(campaignId)) {
            try {
                qr = await countQueueRemaining(campaignId);
            } catch (_) {
                qr = 0;
            }
        }
        const queueRemaining = Number(qr != null ? qr : 0);
        const ctx = resolveTransportPreflightContext();
        const transportSnapshot = buildTransportGateDiagnosticSnapshot(ctx, {
            enabled: true,
            method: 'getMe',
            intervalMs: 60_000,
            backoffMaxMs: 300_000,
            preflightTrustMs: probePreflightTrustMsResolved
        });
        const ws = getWorkerSnapshot();
        const workerRunning = Boolean(ws.running && Number(ws.campaignId) === campaignId);
        const phase = String(opts.phase || '').slice(0, 48);
        const out = {
            reasonCode: String(gate.reason != null ? gate.reason : 'UNKNOWN').slice(0, 120),
            decisionSource: String(gate.source != null ? gate.source : 'unknown').slice(0, 32),
            recoveryRun: Boolean(mode.recoveryRun),
            resumeFromDb: Boolean(mode.resumeFromDb),
            phase,
            dbCounts: {
                pending: Number(sr.pending || 0),
                retry_wait: Number(sr.retry_wait || 0),
                delivered: Number(sr.delivered || 0),
                failed: Number(sr.failed || 0),
                blocked: Number(sr.blocked || 0)
            },
            queueRemaining,
            workerRunning,
            activeCampaignDeliveryJobs: activeCampaignJobs.size,
            transportSnapshot
        };
        if (opts.waveIndex != null && Number.isFinite(Number(opts.waveIndex))) {
            out.waveIndex = Number(opts.waveIndex);
        }
        if (opts.recoveryAction != null) {
            out.recoveryAction = String(opts.recoveryAction).slice(0, 80);
        }
        return out;
    }

    async function markCampaignEnqueueCompleted(campaignId) {
        const now = new Date().toISOString();
        await run(
            `
            UPDATE broadcast_campaigns
            SET delivery_enqueue_completed_at = COALESCE(delivery_enqueue_completed_at, ?),
                delivery_last_progress_at = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [now, now, now, Number(campaignId)]
        );
    }

    async function markCampaignWaveProgress(campaignId) {
        const now = new Date().toISOString();
        await run(
            `
            UPDATE broadcast_campaigns
            SET delivery_last_progress_at = ?,
                delivery_wave_count = COALESCE(delivery_wave_count, 0) + 1,
                updated_at = ?
            WHERE id = ?
            `,
            [now, now, Number(campaignId)]
        );
    }

    async function markCampaignFirstAttemptEvent(campaignId) {
        const now = new Date().toISOString();
        const r = await run(
            `
            UPDATE broadcast_campaigns
            SET delivery_first_attempt_at = ?,
                delivery_last_progress_at = ?,
                updated_at = ?
            WHERE id = ? AND delivery_first_attempt_at IS NULL
            `,
            [now, now, now, Number(campaignId)]
        );
        return Boolean(r && r.changes > 0);
    }

    async function markCampaignFirstDeliveredEvent(campaignId) {
        const now = new Date().toISOString();
        await run(
            `
            UPDATE broadcast_campaigns
            SET delivery_first_delivered_at = COALESCE(delivery_first_delivered_at, ?),
                delivery_last_progress_at = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [now, now, now, Number(campaignId)]
        );
    }

    async function bumpCampaignInternalExceptionCount(campaignId) {
        const now = new Date().toISOString();
        await run(
            `
            UPDATE broadcast_campaigns
            SET delivery_internal_exception_count = COALESCE(delivery_internal_exception_count, 0) + 1,
                delivery_last_progress_at = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [now, now, Number(campaignId)]
        );
    }

    /**
     * Итог в теме рассылки + обновление broadcast_campaigns.
     * Идемпотентность: один notice на kind (INCOMPLETE / SUCCESS / ABORTED_TIMEOUT) — durable в БД.
     */
    async function sendSummary({ campaignId, mode = {} }) {
        const cid = Number(campaignId);
        const campRow = await get(`SELECT * FROM broadcast_campaigns WHERE id = ?`, [cid]);
        if (!campRow) {
            return {
                incomplete: true,
                summaryPosted: false,
                campaignMarkedDone: false,
                skippedDuplicate: false
            };
        }

        if (mode.abortedDueToTimeout) {
            if (String(campRow?.broadcast_terminal_notice_kind || '') === BROADCAST_TERMINAL_NOTICE_KIND.ABORTED_TIMEOUT) {
                void persistCampaignEvent(
                    cid,
                    BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_SEND_SKIPPED_DUPLICATE,
                    { reason: 'TIMEOUT_NOTICE_ALREADY_SENT' },
                    { topicTestMode: Boolean(mode.isTopicTestMode) }
                );
                return {
                    skippedDuplicate: true,
                    summaryPosted: false,
                    incomplete: true,
                    campaignMarkedDone: false,
                    abortedTimeout: true
                };
            }
            const statsT = await get(DELIVERY_AGG_SQL, [cid]);
            const qRem =
                Number(statsT?.pending || 0) + Number(statsT?.retry_wait || 0);
            const wallH = Math.round(BROADCAST_CAMPAIGN_MAX_WALL_MS / 3600000);
            const text =
                `⏱ Рассылка #${cid} остановлена по лимиту времени (>${wallH} ч).\n` +
                `Статус: ABORTED_TIMEOUT. Auto-resume и повторные итоги отключены.\n\n` +
                `✅ Доставлено: ${Number(statsT?.delivered || 0)}\n` +
                `⛔ Заблокировали бота: ${Number(statsT?.blocked || 0)}\n` +
                `❌ Ошибки доставки: ${Number(statsT?.failed || 0)}\n` +
                `⏳ Очередь (pending+retry): ${qRem}`;
            const sent = await telegramClient.sendMessage({
                chatId: broadcastTopicChatId,
                messageThreadId: Number(broadcastTopicThreadId),
                text,
                replyMarkup: {
                    inline_keyboard: [
                        [{ text: 'Удалить рассылку у всех', callback_data: `broadcast_delete:${cid}` }]
                    ]
                }
            });
            const nowIsoT = new Date().toISOString();
            const msgIdT = sent.ok && sent.data?.message_id ? Number(sent.data.message_id) : null;
            await run(
                `
                UPDATE broadcast_campaigns
                SET status = 'ABORTED_TIMEOUT',
                    broadcast_terminal_notice_at = ?,
                    broadcast_terminal_notice_kind = ?,
                    summary_dedupe_key = ?,
                    summary_message_id = COALESCE(?, summary_message_id),
                    updated_at = ?
                WHERE id = ?
                `,
                [
                    nowIsoT,
                    BROADCAST_TERMINAL_NOTICE_KIND.ABORTED_TIMEOUT,
                    `timeout:${cid}`,
                    msgIdT,
                    nowIsoT,
                    cid
                ]
            );
            void persistCampaignEvent(
                cid,
                BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_ABORTED_TIMEOUT,
                { wallClockMs: BROADCAST_CAMPAIGN_MAX_WALL_MS, summaryPosted: !!msgIdT },
                { topicTestMode: Boolean(mode.isTopicTestMode) }
            );
            return {
                incomplete: true,
                summaryPosted: !!msgIdT,
                campaignMarkedDone: false,
                abortedTimeout: true,
                pendingTotal: qRem
            };
        }

        if (campRow && isTerminalBroadcastCampaignStatus(campRow.status)) {
            void persistCampaignEvent(
                cid,
                BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_SEND_SKIPPED_DUPLICATE,
                { reason: 'CAMPAIGN_ALREADY_TERMINAL', status: String(campRow.status || '') },
                { topicTestMode: Boolean(mode.isTopicTestMode) }
            );
            return {
                skippedDuplicate: true,
                summaryPosted: false,
                incomplete: String(campRow.status || '').toUpperCase() !== 'DONE',
                campaignMarkedDone: String(campRow.status || '').toUpperCase() === 'DONE'
            };
        }

        const stats = await get(DELIVERY_AGG_SQL, [cid]);
        const pending = Number(stats?.pending || 0) + Number(stats?.retry_wait || 0);
        const jobHadException = Boolean(mode.jobHadException);
        const jobHadTransportPause = Boolean(mode.jobHadTransportPause);
        const jobHadTransportGateHalt = Boolean(mode.jobHadTransportGateHalt);
        const incomplete = pending > 0 || jobHadException || jobHadTransportPause;
        const intendedKind = incomplete
            ? BROADCAST_TERMINAL_NOTICE_KIND.INCOMPLETE
            : BROADCAST_TERMINAL_NOTICE_KIND.SUCCESS;
        const prevKind = String(campRow?.broadcast_terminal_notice_kind || '');
        if (prevKind === intendedKind) {
            void persistCampaignEvent(
                cid,
                BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_SEND_SKIPPED_DUPLICATE,
                { reason: 'DUPLICATE_NOTICE_KIND', intendedKind },
                { topicTestMode: Boolean(mode.isTopicTestMode) }
            );
            logger.log('[BroadcastSummary] skipped_duplicate_notice', {
                campaignId: cid,
                intendedKind,
                tag: 'BROADCAST_SUMMARY_DEDUPE_SKIP'
            });
            return {
                skippedDuplicate: true,
                summaryPosted: false,
                incomplete,
                campaignMarkedDone: false,
                pendingTotal: pending
            };
        }

        const dt = mode.deliveryTiming || {};
        const showSendDuration =
            dt.complete === true &&
            pending === 0 &&
            !jobHadException &&
            typeof dt.durationMs === 'number' &&
            Number.isFinite(dt.durationMs) &&
            dt.durationMs >= 0 &&
            String(dt.startedAtIso || '').trim() !== '' &&
            String(dt.finishedAtIso || '').trim() !== '';

        const recipientsTargeted = Number(mode.recipientsTargeted || 0);
        const topicTestMetaLine = mode.isTopicTestMode ? `Режим: topic test mode\n` : '';
        const modeLine = mode.isTopicTestMode ? `👥 Охват: ${recipientsTargeted} получателей\n` : '';
        const zeroSuccessWhileTargeted =
            !incomplete &&
            recipientsTargeted > 0 &&
            Number(stats?.delivered || 0) === 0;
        const zeroSuccessBanner = zeroSuccessWhileTargeted
            ? `⚠️ Охват ${recipientsTargeted}, успешных доставок не зафиксировано (см. блокировки и ошибки ниже; проверьте TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED и Bot API).\n\n`
            : '';
        const durationLine = showSendDuration
            ? `⏱ Время отправки: ${formatBroadcastSendDurationLabelRu(dt.durationMs)}\n`
            : '';

        const incompleteBanner = incomplete
            ? `⚠️ Рассылка #${campaignId}: итог неполный${
                  jobHadException ? ' (исключение в воркере доставки)' : ''
              }${jobHadTransportPause ? (jobHadTransportGateHalt ? ' (остановлено transport gate)' : ' (остановлено transport circuit breaker)') : ''}\n` +
              (jobHadTransportPause
                  ? `⏸ Кампания переведена в PAUSED_TRANSPORT; очередь не очищена — см. broadcastOps / логи [BroadcastFlow] paused_by_transport_breaker / delivery_halted_by_transport_gate.\n`
                  : '') +
              `⏳ В БД ещё есть PENDING/RETRY_WAIT (${pending}). Статус: ${
                  jobHadTransportPause ? 'PAUSED_TRANSPORT (ожидает восстановления транспорта)' : 'RUNNING'
              } до очистки очереди.\n\n`
            : '';
        const titleLine = incomplete
            ? `${topicTestMetaLine}${incompleteBanner}`
            : `📣 Рассылка #${campaignId} завершена\n${topicTestMetaLine}`;

        const text =
            `${titleLine}${modeLine}${zeroSuccessBanner}${durationLine}` +
            `✅ Доставлено: ${Number(stats?.delivered || 0)}\n` +
            `⛔ Заблокировали бота: ${Number(stats?.blocked || 0)}\n` +
            `❌ Ошибки доставки: ${Number(stats?.failed || 0)}`;

        if (incomplete) {
            logger.error('[BroadcastSummary] INCOMPLETE_FINALIZATION', {
                campaignId: Number(campaignId),
                pending,
                pendingBreakdown: { pending: Number(stats?.pending || 0), retry_wait: Number(stats?.retry_wait || 0) },
                jobHadException,
                tag: 'BROADCAST_SUMMARY_INCOMPLETE'
            });
        } else if (zeroSuccessWhileTargeted) {
            logger.warn('[BroadcastSummary] ZERO_SUCCESS_WITH_TARGETED_AUDIENCE', {
                campaignId: Number(campaignId),
                recipientsTargeted,
                delivered: Number(stats?.delivered || 0),
                tag: 'BROADCAST_SUMMARY_ZERO_SUCCESS'
            });
        }
        if (showSendDuration) {
            const dms = Math.round(dt.durationMs);
            logger.log('[BroadcastSummary] campaign complete', {
                campaignId: Number(campaignId),
                durationMs: dms,
                durationSec: Math.round((dms / 1000) * 10) / 10
            });
        }
        const sent = await telegramClient.sendMessage({
            chatId: broadcastTopicChatId,
            messageThreadId: Number(broadcastTopicThreadId),
            text,
            replyMarkup: {
                inline_keyboard: [
                    [{ text: 'Удалить рассылку у всех', callback_data: `broadcast_delete:${campaignId}` }]
                ]
            }
        });
        const nowIso = new Date().toISOString();
        const durMsRounded = showSendDuration ? Math.round(dt.durationMs) : null;
        const startedAt = showSendDuration ? String(dt.startedAtIso) : null;
        const finishedAt = showSendDuration ? String(dt.finishedAtIso) : null;

        const summaryPosted = !!(sent.ok && sent.data?.message_id);
        const dedupeKey = `${intendedKind}:${cid}`;

        const topicTestForSummary = Boolean(mode.isTopicTestMode);
        async function emitLifecycleSummaryEvents({ incompleteFlag, summaryPosted: sp, campaignMarkedDone: cmd }) {
            await persistCampaignEvent(cid, BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_POSTED, {
                posted: !!sp,
                incomplete: incompleteFlag
            }, { topicTestMode: topicTestForSummary });
            if (incompleteFlag) {
                await persistCampaignEvent(cid, BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_DONE_INCOMPLETE, {
                    pending,
                    jobHadException,
                    jobHadTransportPause,
                    summaryPosted: !!sp
                }, { topicTestMode: topicTestForSummary });
            } else if (cmd) {
                await persistCampaignEvent(cid, BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_DONE, {
                    summaryPosted: !!sp
                }, { topicTestMode: topicTestForSummary });
            }
        }

        if (incomplete) {
            if (summaryPosted) {
                await run(
                    `
                    UPDATE broadcast_campaigns
                    SET summary_message_id = ?,
                        broadcast_terminal_notice_at = ?,
                        broadcast_terminal_notice_kind = ?,
                        summary_dedupe_key = ?,
                        updated_at = ?
                    WHERE id = ?
                    `,
                    [
                        Number(sent.data.message_id),
                        nowIso,
                        BROADCAST_TERMINAL_NOTICE_KIND.INCOMPLETE,
                        dedupeKey,
                        nowIso,
                        cid
                    ]
                );
            } else {
                await run(
                    `
                    UPDATE broadcast_campaigns
                    SET updated_at = ?
                    WHERE id = ?
                    `,
                    [nowIso, cid]
                );
            }
            await emitLifecycleSummaryEvents({
                incompleteFlag: true,
                summaryPosted,
                campaignMarkedDone: false
            });
            return {
                incomplete: true,
                summaryPosted,
                campaignMarkedDone: false,
                pendingTotal: pending
            };
        }

        if (summaryPosted) {
            if (showSendDuration) {
                await run(
                    `
                    UPDATE broadcast_campaigns
                    SET summary_message_id = ?, status = 'DONE', completed_at = ?, updated_at = ?,
                        delivery_send_started_at = ?, delivery_send_finished_at = ?, delivery_duration_ms = ?,
                        broadcast_terminal_notice_at = ?,
                        broadcast_terminal_notice_kind = ?,
                        summary_dedupe_key = ?
                    WHERE id = ?
                    `,
                    [
                        Number(sent.data.message_id),
                        nowIso,
                        nowIso,
                        startedAt,
                        finishedAt,
                        durMsRounded,
                        nowIso,
                        BROADCAST_TERMINAL_NOTICE_KIND.SUCCESS,
                        dedupeKey,
                        cid
                    ]
                );
            } else {
                await run(
                    `
                    UPDATE broadcast_campaigns
                    SET summary_message_id = ?, status = 'DONE', completed_at = ?, updated_at = ?,
                        broadcast_terminal_notice_at = ?,
                        broadcast_terminal_notice_kind = ?,
                        summary_dedupe_key = ?
                    WHERE id = ?
                    `,
                    [
                        Number(sent.data.message_id),
                        nowIso,
                        nowIso,
                        nowIso,
                        BROADCAST_TERMINAL_NOTICE_KIND.SUCCESS,
                        dedupeKey,
                        cid
                    ]
                );
            }
        } else if (showSendDuration) {
            await run(
                `
                UPDATE broadcast_campaigns
                SET status = 'DONE', completed_at = ?, updated_at = ?,
                    delivery_send_started_at = ?, delivery_send_finished_at = ?, delivery_duration_ms = ?,
                    broadcast_terminal_notice_at = ?,
                    broadcast_terminal_notice_kind = ?,
                    summary_dedupe_key = ?
                WHERE id = ?
                `,
                [
                    nowIso,
                    nowIso,
                    startedAt,
                    finishedAt,
                    durMsRounded,
                    nowIso,
                    BROADCAST_TERMINAL_NOTICE_KIND.SUCCESS,
                    dedupeKey,
                    cid
                ]
            );
        } else {
            await run(
                `
                UPDATE broadcast_campaigns
                SET status = 'DONE', completed_at = ?, updated_at = ?,
                    broadcast_terminal_notice_at = ?,
                    broadcast_terminal_notice_kind = ?,
                    summary_dedupe_key = ?
                WHERE id = ?
                `,
                [nowIso, nowIso, nowIso, BROADCAST_TERMINAL_NOTICE_KIND.SUCCESS, dedupeKey, cid]
            );
        }

        await emitLifecycleSummaryEvents({
            incompleteFlag: false,
            summaryPosted,
            campaignMarkedDone: true
        });
        return {
            incomplete: false,
            summaryPosted,
            campaignMarkedDone: true,
            pendingTotal: 0
        };
    }

    /**
     * Периодический / startup sweep: кампании RUNNING|PAUSED старше 4ч → ABORTED_TIMEOUT + один terminal summary.
     */
    async function enforceCampaignWallClockTimeouts(trigger = 'sweep') {
        let rows = [];
        try {
            rows = await all(
                `
                SELECT * FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) IN ('RUNNING', 'PAUSED_TRANSPORT')
                ORDER BY id ASC
                `
            );
        } catch (e) {
            lastWallClockSweepResult = { at: new Date().toISOString(), error: String(e.message || e), count: 0, trigger };
            return { count: 0, error: String(e.message || e) };
        }
        let n = 0;
        for (const row of rows) {
            if (!isCampaignPastWallClockDeadline(row)) continue;
            if (isTerminalBroadcastCampaignStatus(row.status)) continue;
            await sendSummary({
                campaignId: Number(row.id),
                mode: {
                    abortedDueToTimeout: true,
                    isTopicTestMode: Number(row.topic_test_mode) === 1
                }
            });
            n += 1;
        }
        lastWallClockSweepResult = { at: new Date().toISOString(), count: n, trigger };
        if (n > 0) {
            logger.warn('[BroadcastWallClock] campaigns_aborted_timeout', {
                count: n,
                trigger,
                tag: 'BROADCAST_TIMEOUT_SWEEP'
            });
        }
        return { count: n };
    }

    async function safeDeliverOneRecipient({
        campaignId,
        sourceChatId,
        sourceMessageId,
        recipientId,
        metrics,
        rateLimiter,
        timing
    }) {
        try {
            await deliverOneRecipient({
                campaignId,
                sourceChatId,
                sourceMessageId,
                recipientId,
                metrics,
                rateLimiter,
                timing
            });
        } catch (err) {
            metrics.broadcast_internal_exceptions = (metrics.broadcast_internal_exceptions || 0) + 1;
            metrics.delivery_error_tally.INTERNAL_EXCEPTION =
                (metrics.delivery_error_tally.INTERNAL_EXCEPTION || 0) + 1;
            logger.error('[BroadcastDelivery] recipient_handler_exception_isolated', {
                campaignId: Number(campaignId),
                tag: 'BROADCAST_DELIVERY_INTERNAL_EXCEPTION',
                message: err && err.message ? String(err.message).slice(0, 240) : String(err).slice(0, 240)
            });
            await bumpCampaignInternalExceptionCount(campaignId);
            try {
                const row = await get(
                    `SELECT * FROM broadcast_deliveries WHERE campaign_id = ? AND recipient_telegram_id = ?`,
                    [Number(campaignId), String(recipientId)]
                );
                const prevAttempts = Number(row?.copy_attempts || 0);
                const attemptNum = prevAttempts + 1;
                const retryIso = new Date(Date.now() + 45_000).toISOString();
                await upsertDelivery({
                    campaignId,
                    recipientTelegramId: recipientId,
                    status: 'RETRY_WAIT',
                    errorCode: 'INTERNAL_EXCEPTION',
                    errorMessage: String(err && err.message ? err.message : err).slice(0, 500),
                    copyAttempts: attemptNum,
                    nextRetryAt: retryIso
                });
                metrics.broadcast_retry_scheduled += 1;
            } catch (e2) {
                logger.error('[BroadcastDelivery] reschedule_after_internal_exception_failed', {
                    campaignId: Number(campaignId),
                    message: e2.message || String(e2)
                });
            }
        }
    }

    async function deliverOneRecipient({
        campaignId,
        sourceChatId,
        sourceMessageId,
        recipientId,
        metrics,
        rateLimiter,
        timing
    }) {
        const row = await get(
            'SELECT * FROM broadcast_deliveries WHERE campaign_id = ? AND recipient_telegram_id = ?',
            [Number(campaignId), String(recipientId)]
        );
        if (!row) return;

        const st = String(row.status || '').toUpperCase();
        if (st !== 'PENDING' && st !== 'RETRY_WAIT') return;

        const nowIso = new Date().toISOString();
        if (st === 'RETRY_WAIT' && row.next_retry_at && row.next_retry_at > nowIso) {
            metrics.slow_reason = metrics.slow_reason || 'retry_not_due_in_batch';
            return;
        }

        const prevAttempts = Number(row.copy_attempts || 0);
        const attemptNum = prevAttempts + 1;

        if (attemptNum > copyAttemptsCap) {
            metrics.delivery_error_tally.ATTEMPTS_EXHAUSTED =
                (metrics.delivery_error_tally.ATTEMPTS_EXHAUSTED || 0) + 1;
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'FAILED',
                errorCode: 'ATTEMPTS_EXHAUSTED',
                errorMessage: String(row.error_message || '').slice(0, 500) || null,
                copyAttempts: prevAttempts,
                nextRetryAt: null
            });
            metrics.broadcast_failed_temporary += 1;
            logger.warn('[BroadcastDelivery] attempts exhausted (no HTTP)', {
                campaignId: Number(campaignId),
                recipientId: String(recipientId),
                copyAttempts: prevAttempts,
                max: copyAttemptsCap
            });
            return;
        }

        const firstAttemptRecorded = await markCampaignFirstAttemptEvent(Number(campaignId));
        if (firstAttemptRecorded) {
            void persistCampaignEvent(
                Number(campaignId),
                BROADCAST_CAMPAIGN_EVENT_CODES.DELIVERY_FIRST_ATTEMPT,
                {},
                {}
            );
        }
        await rateLimiter.acquireForChat(recipientId);

        const copied = await telegramClient.copyMessage({
            fromChatId: sourceChatId,
            messageId: sourceMessageId,
            chatId: recipientId
        });

        if (copied.ok) {
            metrics.transportBreakerStreak = resetTransportBreakerStreak();
            if (timing && !timing.firstSendAt) {
                timing.firstSendAt = new Date().toISOString();
            }
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'DELIVERED',
                deliveredMessageId: copied.data?.message_id || null,
                errorCode: null,
                errorMessage: null,
                copyAttempts: attemptNum,
                nextRetryAt: null
            });
            const isFirstSuccess = metrics.broadcast_sent_ok === 0;
            metrics.broadcast_sent_ok += 1;
            await markCampaignFirstDeliveredEvent(Number(campaignId));
            if (isFirstSuccess) {
                void persistCampaignEvent(
                    Number(campaignId),
                    BROADCAST_CAMPAIGN_EVENT_CODES.DELIVERY_FIRST_SUCCESS,
                    {},
                    {}
                );
            }
            return;
        }

        const code = String(copied.errorCode || '');
        metrics.transportBreakerStreak = applyTransportBreakerStreakAfterFailedCopy(metrics.transportBreakerStreak, code);
        const msg = copied.message || '';
        if (code) {
            metrics.delivery_error_tally[code] = (metrics.delivery_error_tally[code] || 0) + 1;
        }

        if (code === 'BOT_BLOCKED') {
            await markBroadcastSuppressedForUser(recipientId, 'BOT_BLOCKED');
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'BLOCKED',
                errorCode: code,
                errorMessage: msg,
                copyAttempts: attemptNum,
                nextRetryAt: null
            });
            metrics.broadcast_blocked += 1;
            logger.log('[BroadcastDelivery] terminal blocked', { campaignId: Number(campaignId), recipientId });
            return;
        }

        if (isPermanentBroadcastDeliveryError(code)) {
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'FAILED_PERMANENT',
                errorCode: code,
                errorMessage: msg,
                copyAttempts: attemptNum,
                nextRetryAt: null
            });
            metrics.broadcast_failed_permanent += 1;
            logger.log('[BroadcastDelivery] terminal permanent', {
                campaignId: Number(campaignId),
                recipientId,
                errorCode: code
            });
            return;
        }

        if (code === 'RATE_LIMIT') {
            if (attemptNum >= copyAttemptsCap) {
                await upsertDelivery({
                    campaignId,
                    recipientTelegramId: recipientId,
                    status: 'FAILED',
                    errorCode: code,
                    errorMessage: msg,
                    copyAttempts: attemptNum,
                    nextRetryAt: null
                });
                metrics.broadcast_failed_temporary += 1;
                logger.warn('[BroadcastDelivery] 429 but attempts exhausted', {
                    campaignId: Number(campaignId),
                    recipientId,
                    attempt: attemptNum
                });
                return;
            }
            const retryIso = computeBroadcastRetryIso({
                errorCode: code,
                retryAfterSec: copied.retryAfterSec,
                attemptsSoFar: attemptNum
            });
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'RETRY_WAIT',
                errorCode: code,
                errorMessage: msg,
                copyAttempts: attemptNum,
                nextRetryAt: retryIso
            });
            metrics.broadcast_rate_limited_429 += 1;
            metrics.broadcast_retry_scheduled += 1;
            const ra = Number(copied.retryAfterSec);
            if (Number.isFinite(ra) && ra > 0) {
                metrics.retry_after_seconds = ra;
            }
            logger.warn('[BroadcastDelivery] 429 rate limit — scheduled local retry (queue not blocked)', {
                campaignId: Number(campaignId),
                recipientId,
                retry_after_seconds: metrics.retry_after_seconds,
                next_retry_at: retryIso
            });
            return;
        }

        if (isRetryableTelegramError(code) && attemptNum < copyAttemptsCap) {
            const retryIso = computeBroadcastRetryIso({
                errorCode: code,
                retryAfterSec: copied.retryAfterSec,
                attemptsSoFar: attemptNum
            });
            await upsertDelivery({
                campaignId,
                recipientTelegramId: recipientId,
                status: 'RETRY_WAIT',
                errorCode: code,
                errorMessage: msg,
                copyAttempts: attemptNum,
                nextRetryAt: retryIso
            });
            metrics.broadcast_retry_scheduled += 1;
            logger.warn('[BroadcastDelivery] transient error — retry_wait', {
                campaignId: Number(campaignId),
                recipientId,
                errorCode: code,
                next_retry_at: retryIso,
                attempt: attemptNum
            });
            return;
        }

        await upsertDelivery({
            campaignId,
            recipientTelegramId: recipientId,
            status: 'FAILED',
            errorCode: code,
            errorMessage: msg,
            copyAttempts: attemptNum,
            nextRetryAt: null
        });
        metrics.broadcast_failed_temporary += 1;
        logger.warn('[BroadcastDelivery] failed (non-retryable or exhausted)', {
            campaignId: Number(campaignId),
            recipientId,
            errorCode: code,
            attempt: attemptNum
        });
    }

    async function pauseBroadcastCampaignTransport(campaignId, reason) {
        const iso = new Date().toISOString();
        const rid = Number(campaignId);
        const rsn = String(reason || 'UNKNOWN').slice(0, 200);
        await run(
            `
            UPDATE broadcast_campaigns
            SET status = 'PAUSED_TRANSPORT',
                delivery_transport_pause_at = ?,
                delivery_transport_pause_reason = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [iso, rsn, iso, rid]
        );
        recordBroadcastWorkerTransportPause(rid, rsn);
        logger.warn('[BroadcastFlow] paused_by_transport_breaker', {
            campaignId: rid,
            reason: rsn.slice(0, 120),
            tag: 'BROADCAST_TRANSPORT_BREAKER'
        });
        void persistCampaignEvent(rid, BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_PAUSED, {
            reason: rsn.slice(0, 120)
        }, {});
    }

    async function runCampaignDeliveryJob({ campaignId, sourceChatId, sourceMessageId, recipients, mode }) {
        const startedWall = Date.now();
        let firstSendAt = null;
        /** @type {{ complete: boolean, durationMs?: number, startedAtIso?: string, finishedAtIso?: string }} */
        let deliveryTiming = { complete: false };

        const metrics = createFreshMetrics();
        lastDeliveryMetrics = metrics;
        let jobHadTransportPause = false;

        const campRowInit = await get('SELECT * FROM broadcast_campaigns WHERE id = ?', [Number(campaignId)]);
        if (campRowInit && String(campRowInit.status || '').toUpperCase() === 'ABORTED_TIMEOUT') {
            workerSnapshot = {
                running: false,
                campaignId: null,
                startedAtIso: null,
                audienceSize: 0,
                processed: 0,
                phase: 'idle',
                metrics: null,
                rateLimiter: null,
                queueRemaining: null,
                waveBatchIndex: 0,
                recoveryRun: false,
                resumeFromDb: false,
                lastWaveProgressAtIso: null
            };
            logger.log('[BroadcastFlow] delivery job skipped — ABORTED_TIMEOUT', {
                campaignId: Number(campaignId),
                tag: 'BROADCAST_JOB_SKIP_TIMEOUT'
            });
            return;
        }
        if (
            campRowInit &&
            isCampaignPastWallClockDeadline(campRowInit) &&
            !isTerminalBroadcastCampaignStatus(campRowInit.status)
        ) {
            await sendSummary({
                campaignId: Number(campaignId),
                mode: {
                    abortedDueToTimeout: true,
                    isTopicTestMode: Number(campRowInit.topic_test_mode) === 1
                }
            });
            workerSnapshot = {
                running: false,
                campaignId: null,
                startedAtIso: null,
                audienceSize: 0,
                processed: 0,
                phase: 'idle',
                metrics: null,
                rateLimiter: null,
                queueRemaining: null,
                waveBatchIndex: 0,
                recoveryRun: false,
                resumeFromDb: false,
                lastWaveProgressAtIso: null
            };
            logger.warn('[BroadcastFlow] delivery job aborted_wall_clock', {
                campaignId: Number(campaignId),
                tag: 'BROADCAST_JOB_WALL_CLOCK'
            });
            return;
        }
        if (campRowInit && String(campRowInit.status || '').toUpperCase() === 'PAUSED_TRANSPORT') {
            const pre = preflightBroadcastTrigger();
            if (pre.block) {
                recordBroadcastPreflightBlocked(`RESUME_BLOCKED:${pre.reason}`);
                logger.warn('[BroadcastPreflight] blocked_by_transport', {
                    context: 'paused_campaign_resume',
                    campaignId: Number(campaignId),
                    reason: pre.reason,
                    tag: 'BROADCAST_RESUME_TRANSPORT'
                });
                workerSnapshot = {
                    running: false,
                    campaignId: null,
                    startedAtIso: null,
                    audienceSize: 0,
                    processed: 0,
                    phase: 'idle',
                    metrics: null,
                    rateLimiter: null,
                    queueRemaining: null,
                    waveBatchIndex: 0,
                    recoveryRun: false,
                    resumeFromDb: false,
                    lastWaveProgressAtIso: null
                };
                recordLastBroadcastRun({
                    campaignId: Number(campaignId),
                    jobRan: false,
                    audienceSize: 0,
                    topicTestMode: Boolean(mode && mode.isTopicTestMode),
                    transportResumeBlocked: true,
                    transportResumeBlockedReason: pre.reason,
                    outcomeInterpretation: {
                        primary: 'TRANSPORT_RESUME_BLOCKED',
                        tags: ['NO_DELIVERY_JOB', 'TRANSPORT_DEGRADED'],
                        topicTestMode: Boolean(mode && mode.isTopicTestMode)
                    },
                    workerPhase: 'blocked_transport_resume'
                });
                return;
            }
            const nowR = new Date().toISOString();
            await run(
                `
                UPDATE broadcast_campaigns
                SET status = 'RUNNING',
                    delivery_transport_pause_at = NULL,
                    delivery_transport_pause_reason = NULL,
                    updated_at = ?
                WHERE id = ?
                `,
                [nowR, Number(campaignId)]
            );
            recordBroadcastTransportResume(Number(campaignId));
            logger.log('[BroadcastFlow] resumed_after_transport_recovery', {
                campaignId: Number(campaignId),
                tag: 'BROADCAST_TRANSPORT_RESUME'
            });
            void persistCampaignEvent(Number(campaignId), BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_RESUMED, {
                source: 'delivery_job_clear_pause'
            }, { topicTestMode: Boolean(mode && mode.isTopicTestMode) });
        }

        const resumeFromDb = Boolean(mode && mode.resumeFromDb);
        let recipientsResolved = Array.isArray(recipients) ? recipients : [];
        if (!resumeFromDb && mode && mode.deferProductionRecipients) {
            recipientsResolved = await getRecipientsForProduction();
        }
        let audienceTotal = 0;
        if (resumeFromDb) {
            const cntRow = await get(
                `SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`,
                [Number(campaignId)]
            );
            audienceTotal = Number(cntRow?.c || 0);
        } else {
            audienceTotal = recipientsResolved.length;
        }

        if (!resumeFromDb && !recipientsResolved.length) {
            logger.warn('[BroadcastFlow] ZERO_AUDIENCE', {
                campaignId: Number(campaignId),
                topicTestMode: Boolean(mode && mode.isTopicTestMode),
                tag: 'BROADCAST_ZERO_AUDIENCE',
                hints:
                    mode && mode.isTopicTestMode
                        ? ['set BROADCAST_TOPIC_TEST_TELEGRAM_IDS', 'keep BROADCAST_TOPIC_TEST_MODE=1']
                        : [
                              'users.telegram_id populated',
                              'users.broadcast_suppressed_reason IS NULL for recipients',
                              'verify DB not empty'
                          ]
            });
        }
        if (resumeFromDb && audienceTotal === 0) {
            logger.warn('[BroadcastFlow] RECOVERY_ZERO_DELIVERY_ROWS', {
                campaignId: Number(campaignId),
                tag: 'BROADCAST_RECOVERY_EMPTY_QUEUE',
                recoveryRun: Boolean(mode && mode.recoveryRun)
            });
        }

        const rateLimiter = createBroadcastRateLimiter({
            globalMessagesPerSec,
            perChatMinIntervalMs,
            logger
        });

        const timing = { firstSendAt: null };

        workerSnapshot = {
            running: true,
            campaignId: Number(campaignId),
            startedAtIso: new Date().toISOString(),
            audienceSize: audienceTotal,
            processed: 0,
            phase: 'enqueue_pending',
            metrics,
            rateLimiter: rateLimiter.snapshot(),
            queueRemaining: audienceTotal,
            waveBatchIndex: 0,
            recoveryRun: Boolean(mode && mode.recoveryRun),
            resumeFromDb,
            lastWaveProgressAtIso: null
        };

        logger.log('[BroadcastFlow] delivery job started', {
            campaignId: Number(campaignId),
            audienceSize: audienceTotal,
            resumeFromDb,
            recoveryRun: Boolean(mode && mode.recoveryRun),
            globalMessagesPerSec,
            workerConcurrency: workersN,
            perChatMinIntervalMs,
            maxDeliveryAttempts: copyAttemptsCap,
            deliveryWaveBatchSize: waveBatchSize,
            legacyDeliveryIntervalMs: Math.max(0, Number(deliveryIntervalMs) || 0)
        });
        await persistCampaignEvent(Number(campaignId), BROADCAST_CAMPAIGN_EVENT_CODES.DELIVERY_JOB_STARTED, {
            audienceTotal,
            resumeFromDb,
            recoveryRun: Boolean(mode && mode.recoveryRun),
            autoResume: Boolean(mode && mode.autoResumeFromPausedTransport)
        }, { topicTestMode: Boolean(mode && mode.isTopicTestMode) });

        let sendStartMs = null;
        let sendEndMs = null;
        let processedTotal = 0;
        let jobHadException = false;
        let jobHadTransportGateHalt = false;

        /** Fail-closed до enqueue / первой волны: не массово churn-ить doomed copyMessage. */
        let earlySkipGate = false;
        const gateBeforeDelivery = shouldHaltBroadcastDelivery(resolveTransportPreflightContext(), {
            probePreflightTrustMs: probePreflightTrustMsResolved
        });
        if (gateBeforeDelivery.halt) {
            const statsGate0 = await get(DELIVERY_AGG_SQL, [Number(campaignId)]);
            const qrGate0 = await countQueueRemaining(campaignId);
            const detailsGate0 = await assembleTransportGateEventDetails({
                gate: gateBeforeDelivery,
                campaignId: Number(campaignId),
                statsRow: statsGate0,
                queueRemaining: qrGate0,
                mode,
                phase: 'pre_delivery',
                waveIndex: null
            });
            await pauseBroadcastCampaignTransport(
                campaignId,
                `DELIVERY_GATE:${gateBeforeDelivery.reason}`.slice(0, 200)
            );
            jobHadTransportPause = true;
            jobHadTransportGateHalt = true;
            workerSnapshot.phase = 'halted_transport_gate';
            recordBroadcastDeliveryGateHalt({
                campaignId: Number(campaignId),
                reason: gateBeforeDelivery.reason,
                source: gateBeforeDelivery.source
            });
            void persistCampaignEvent(
                Number(campaignId),
                BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY,
                detailsGate0,
                { topicTestMode: Boolean(mode && mode.isTopicTestMode) }
            );
            logger.warn('[BroadcastFlow] delivery_halted_by_transport_gate_pre_wave', {
                campaignId: Number(campaignId),
                gateSource: gateBeforeDelivery.source,
                gateReason: gateBeforeDelivery.reason,
                queueRemaining: qrGate0,
                tag: 'BROADCAST_DELIVERY_GATE_PRE_WAVE'
            });
            earlySkipGate = true;
        }

        let deliveriesInserted = 0;
        if (earlySkipGate && resumeFromDb) {
            deliveriesInserted = audienceTotal;
        }
        try {
            if (!earlySkipGate) {
            if (resumeFromDb) {
                deliveriesInserted = audienceTotal;
            } else {
                deliveriesInserted = await insertPendingDeliveries(campaignId, recipientsResolved);
            }
            logger.log('[BroadcastFlow] deliveries enqueue finished', {
                campaignId: Number(campaignId),
                deliveriesInserted,
                audienceSize: audienceTotal,
                resumeFromDb
            });
            if (audienceTotal > 0) {
                await markCampaignEnqueueCompleted(campaignId);
            }
            await persistCampaignEvent(Number(campaignId), BROADCAST_CAMPAIGN_EVENT_CODES.ENQUEUE_COMPLETED, {
                deliveriesInserted,
                audienceTotal,
                resumeFromDb
            }, { topicTestMode: Boolean(mode && mode.isTopicTestMode) });
            workerSnapshot.phase = 'delivery';

            let batchIndex = 0;

            while (true) {
                const gate = shouldHaltBroadcastDelivery(resolveTransportPreflightContext(), {
                    probePreflightTrustMs: probePreflightTrustMsResolved
                });
                if (gate.halt) {
                    const qrGate = await countQueueRemaining(campaignId);
                    const statsGateLoop = await get(DELIVERY_AGG_SQL, [Number(campaignId)]);
                    const detailsGateLoop = await assembleTransportGateEventDetails({
                        gate,
                        campaignId: Number(campaignId),
                        statsRow: statsGateLoop,
                        queueRemaining: qrGate,
                        mode,
                        phase: 'delivery_loop',
                        waveIndex: batchIndex + 1
                    });
                    await pauseBroadcastCampaignTransport(
                        campaignId,
                        `DELIVERY_GATE:${gate.reason}`.slice(0, 200)
                    );
                    jobHadTransportPause = true;
                    workerSnapshot.phase = 'halted_transport_gate';
                    recordBroadcastDeliveryGateHalt({
                        campaignId: Number(campaignId),
                        reason: gate.reason,
                        source: gate.source
                    });
                    void persistCampaignEvent(
                        Number(campaignId),
                        BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY,
                        detailsGateLoop,
                        { topicTestMode: Boolean(mode && mode.isTopicTestMode) }
                    );
                    logger.warn('[BroadcastFlow] delivery_halted_by_transport_gate', {
                        campaignId: Number(campaignId),
                        gateSource: gate.source,
                        gateReason: gate.reason,
                        waveIndex: batchIndex + 1,
                        queueRemaining: qrGate,
                        tag: 'BROADCAST_DELIVERY_GATE'
                    });
                    jobHadTransportGateHalt = true;
                    break;
                }

                const nowIso = new Date().toISOString();
                const dueRows = await all(
                    `
                    SELECT recipient_telegram_id
                    FROM broadcast_deliveries
                    WHERE campaign_id = ?
                      AND (
                        status = 'PENDING'
                        OR (status = 'RETRY_WAIT' AND (next_retry_at IS NULL OR next_retry_at <= ?))
                      )
                    ORDER BY id
                    LIMIT ?
                    `,
                    [Number(campaignId), nowIso, waveBatchSize]
                );

                const qr = await countQueueRemaining(campaignId);
                metrics.queue_remaining = qr;
                workerSnapshot.queueRemaining = qr;
                workerSnapshot.metrics = { ...metrics };
                workerSnapshot.rateLimiter = rateLimiter.snapshot();

                if (!dueRows.length) {
                    const futureRow = await get(
                        `
                        SELECT COUNT(*) AS c
                        FROM broadcast_deliveries
                        WHERE campaign_id = ?
                          AND status = 'RETRY_WAIT'
                          AND next_retry_at > ?
                        `,
                        [Number(campaignId), nowIso]
                    );
                    const future = Number(futureRow?.c || 0);
                    if (future === 0) {
                        metrics.slow_reason = null;
                        logger.log('[BroadcastFlow] delivery queue drained', {
                            campaignId: Number(campaignId),
                            queue_remaining: 0
                        });
                        break;
                    }
                    const nextIsoRow = await get(
                        `
                        SELECT MIN(next_retry_at) AS t
                        FROM broadcast_deliveries
                        WHERE campaign_id = ?
                          AND status = 'RETRY_WAIT'
                          AND next_retry_at > ?
                        `,
                        [Number(campaignId), nowIso]
                    );
                    const tMs = parseIsoMs(nextIsoRow?.t);
                    const waitMs =
                        tMs !== null ? Math.max(0, tMs - Date.now()) : pollMs;
                    const sleepMs = Math.min(60_000, Math.max(pollMs, waitMs));
                    metrics.slow_reason = 'waiting_for_scheduled_retries';
                    metrics.queue_remaining = qr;
                    logger.log('[BroadcastFlow] idle — future RETRY_WAIT', {
                        campaignId: Number(campaignId),
                        futureRetryRows: future,
                        sleepMs: Math.round(sleepMs),
                        nextRetryAt: nextIsoRow?.t || null,
                        queue_remaining: qr
                    });
                    await sleep(sleepMs);
                    continue;
                }

                batchIndex += 1;
                workerSnapshot.waveBatchIndex = batchIndex;
                const batchIds = dueRows.map((r) => String(r.recipient_telegram_id));

                logger.log('[BroadcastDelivery] wave batch', {
                    campaignId: Number(campaignId),
                    batchIndex,
                    batchSize: batchIds.length,
                    queue_remaining: qr,
                    rateLimiter: rateLimiter.snapshot()
                });

                if (sendStartMs === null && batchIds.length) {
                    sendStartMs = Date.now();
                }

                const sentOkBeforeWave = metrics.broadcast_sent_ok;
                await mapWithConcurrency(batchIds, workersN, async (recipientId) => {
                    await safeDeliverOneRecipient({
                        campaignId,
                        sourceChatId,
                        sourceMessageId,
                        recipientId,
                        metrics,
                        rateLimiter,
                        timing
                    });
                    processedTotal += 1;
                    workerSnapshot.processed = processedTotal;
                    if (timing.firstSendAt && !firstSendAt) {
                        firstSendAt = timing.firstSendAt;
                    }
                });

                metrics.transportBreakerStreak = applyTransportBreakerStreakAfterWave(
                    metrics.transportBreakerStreak,
                    metrics.broadcast_sent_ok > sentOkBeforeWave
                );
                if (metrics.transportBreakerStreak.consecutiveTransportCopyFailures >= transportBreakerThreshold) {
                    await pauseBroadcastCampaignTransport(
                        campaignId,
                        `COPY_TRANSPORT_STREAK_${metrics.transportBreakerStreak.consecutiveTransportCopyFailures}`
                    );
                    jobHadTransportPause = true;
                    workerSnapshot.phase = 'paused_transport_breaker';
                    logger.log('[BroadcastDiagnostics] transport_snapshot', {
                        campaignId: Number(campaignId),
                        consecutiveTransportCopyFailures: metrics.transportBreakerStreak.consecutiveTransportCopyFailures,
                        threshold: transportBreakerThreshold,
                        tag: 'BROADCAST_TRANSPORT_BREAKER_SNAPSHOT'
                    });
                    break;
                }

                await markCampaignWaveProgress(campaignId);
                if (batchIndex === 1 || batchIndex % 5 === 0) {
                    void persistCampaignEvent(Number(campaignId), BROADCAST_CAMPAIGN_EVENT_CODES.WAVE_PROGRESS, {
                        waveIndex: batchIndex,
                        queue_remaining: qr
                    }, { topicTestMode: Boolean(mode && mode.isTopicTestMode) });
                }
                const waveIso = new Date().toISOString();
                workerSnapshot.lastWaveProgressAtIso = waveIso;

                logger.log('[BroadcastMetrics]', {
                    campaignId: Number(campaignId),
                    batchIndex,
                    ...metrics,
                    rateLimiter: rateLimiter.snapshot(),
                    queue_remaining: metrics.queue_remaining
                });
            }

            if (audienceTotal > 0 && sendStartMs !== null) {
                sendEndMs = Date.now();
                deliveryTiming = {
                    complete: true,
                    durationMs: Math.max(0, sendEndMs - sendStartMs),
                    startedAtIso: new Date(sendStartMs).toISOString(),
                    finishedAtIso: new Date(sendEndMs).toISOString()
                };
            }

            const totalElapsedSec = (Date.now() - startedWall) / 1000;
            logger.log('[BroadcastFlow] delivery job finished', {
                campaignId: Number(campaignId),
                metrics,
                firstSendAt,
                totalElapsedSec: Math.round(totalElapsedSec * 10) / 10,
                sendDurationMs: deliveryTiming.complete ? Math.round(deliveryTiming.durationMs) : null
            });
            }
            lastDeliveryMetrics = { ...metrics };
        } catch (e) {
            jobHadException = true;
            logger.error('[BroadcastDelivery] job error (enqueue, delivery или иное)', {
                campaignId: Number(campaignId),
                error: e.message || String(e)
            });
            void persistCampaignEvent(Number(campaignId), BROADCAST_CAMPAIGN_EVENT_CODES.JOB_EXCEPTION, {
                message: String(e.message || e).slice(0, 240)
            }, { topicTestMode: Boolean(mode && mode.isTopicTestMode) });
        } finally {
            workerSnapshot.phase = 'summary';
            const summaryMeta = await sendSummary({
                campaignId,
                mode: {
                    ...mode,
                    deliveryTiming,
                    jobHadException,
                    jobHadTransportPause,
                    jobHadTransportGateHalt,
                    recipientsTargeted:
                        mode && mode.recipientsTargeted != null ? mode.recipientsTargeted : audienceTotal
                }
            });
            try {
                const statsRow = await get(DELIVERY_AGG_SQL, [Number(campaignId)]);
                const topicTestMode = Boolean(mode && mode.isTopicTestMode);
                let outcomeInterpretation = interpretBroadcastOutcome({
                    audienceSize: audienceTotal,
                    deliveriesInserted,
                    delivered: Number(statsRow?.delivered || 0),
                    blocked: Number(statsRow?.blocked || 0),
                    failed: Number(statsRow?.failed || 0),
                    pending: Number(statsRow?.pending || 0),
                    retry_wait: Number(statsRow?.retry_wait || 0),
                    metrics: lastDeliveryMetrics,
                    topicTestMode
                });
                if (jobHadException || jobHadTransportPause) {
                    const oiTags = [...(outcomeInterpretation.tags || [])];
                    if (jobHadException) oiTags.push('EXCEPTION_DURING_JOB');
                    if (jobHadTransportPause) {
                        oiTags.push(jobHadTransportGateHalt ? 'TRANSPORT_GATE_HALT' : 'TRANSPORT_BREAKER_PAUSE');
                    }
                    let primary = outcomeInterpretation.primary;
                    if (jobHadTransportPause) {
                        primary = jobHadTransportGateHalt ? 'PAUSED_BY_TRANSPORT_GATE' : 'PAUSED_BY_TRANSPORT_BREAKER';
                    } else if (jobHadException) primary = 'JOB_EXCEPTION';
                    outcomeInterpretation = { primary, tags: oiTags, topicTestMode };
                }
                const m = lastDeliveryMetrics || createFreshMetrics();
                const tally = (m && m.delivery_error_tally) || {};
                const transportLayerErrorsSuspected = ['TIMEOUT', 'NETWORK', 'TG_REQUEST_FAILED'].some(
                    (k) => Number(tally[k] || 0) > 0
                );
                recordLastBroadcastRun({
                    campaignId: Number(campaignId),
                    jobRan: true,
                    jobHadException,
                    jobHadTransportPause,
                    jobHadTransportGateHalt,
                    audienceSize: audienceTotal,
                    deliveriesInserted,
                    summaryPosted: !!(summaryMeta && summaryMeta.summaryPosted),
                    incompleteFinalization: !!(summaryMeta && summaryMeta.incomplete),
                    campaignMarkedDone: !!(summaryMeta && summaryMeta.campaignMarkedDone),
                    topicTestMode,
                    transportLayerErrorsSuspected,
                    recoveryRun: Boolean(mode && mode.recoveryRun),
                    resumeFromDb: Boolean(mode && mode.resumeFromDb),
                    dbCounts: {
                        delivered: Number(statsRow?.delivered || 0),
                        blocked: Number(statsRow?.blocked || 0),
                        failed: Number(statsRow?.failed || 0),
                        pending: Number(statsRow?.pending || 0),
                        retry_wait: Number(statsRow?.retry_wait || 0)
                    },
                    metricsTotals: {
                        broadcast_sent_ok: Number(m.broadcast_sent_ok || 0),
                        broadcast_blocked: Number(m.broadcast_blocked || 0),
                        broadcast_failed_permanent: Number(m.broadcast_failed_permanent || 0),
                        broadcast_failed_temporary: Number(m.broadcast_failed_temporary || 0),
                        broadcast_retry_scheduled: Number(m.broadcast_retry_scheduled || 0),
                        broadcast_rate_limited_429: Number(m.broadcast_rate_limited_429 || 0),
                        retry_after_seconds: m.retry_after_seconds != null ? m.retry_after_seconds : null,
                        slow_reason: m.slow_reason || null,
                        delivery_error_tally: { ...tally },
                        broadcast_internal_exceptions: Number(m.broadcast_internal_exceptions || 0)
                    },
                    outcomeInterpretation,
                    workerPhase: 'idle_after_job'
                });
            } catch (diagErr) {
                logger.warn('[BroadcastDiagnostics] record_failed', {
                    campaignId: Number(campaignId),
                    message: diagErr.message || String(diagErr)
                });
            }
            logger.log('[BroadcastSummary] finalized', {
                campaignId: Number(campaignId),
                audienceSize: audienceTotal,
                metrics: lastDeliveryMetrics
            });
            workerSnapshot = {
                running: false,
                campaignId: null,
                startedAtIso: null,
                audienceSize: 0,
                processed: 0,
                phase: 'idle',
                metrics: null,
                rateLimiter: null,
                queueRemaining: null,
                waveBatchIndex: 0,
                recoveryRun: false,
                resumeFromDb: false,
                lastWaveProgressAtIso: null
            };
        }
    }

    function scheduleCampaignDeliveryJob(args) {
        const cid = Number(args && args.campaignId);
        if (!Number.isFinite(cid)) {
            logger.warn('[BroadcastFlow] scheduleCampaignDeliveryJob: invalid campaign id');
            return { scheduled: false, reason: 'BAD_CAMPAIGN_ID' };
        }
        if (activeCampaignJobs.has(cid)) {
            logger.warn('[BroadcastFlow] campaign_job_already_active', {
                campaignId: cid,
                resumeFromDb: !!(args.mode && args.mode.resumeFromDb)
            });
            return { scheduled: false, reason: 'ALREADY_ACTIVE' };
        }
        activeCampaignJobs.add(cid);
        (async () => {
            try {
                await runCampaignDeliveryJob(args);
            } finally {
                activeCampaignJobs.delete(cid);
            }
        })().catch((e) => {
            logger.error('[BroadcastFlow] campaign job rejected', {
                campaignId: cid,
                error: e.message || String(e)
            });
        });
        return { scheduled: true };
    }

    async function runStartupBroadcastRecovery() {
        if (!broadcastsEnabled) {
            lastStartupRecoverySnapshot = {
                ranAtIso: new Date().toISOString(),
                skipped: true,
                reason: 'BROADCASTS_DISABLED'
            };
            return lastStartupRecoverySnapshot;
        }
        const nowIso = new Date().toISOString();
        const rows = await all(
            `
            SELECT * FROM broadcast_campaigns
            WHERE UPPER(TRIM(COALESCE(status, ''))) IN ('RUNNING', 'PAUSED_TRANSPORT')
            ORDER BY id ASC
            `
        );
        const outcomes = [];
        for (const c of rows) {
            if (isCampaignPastWallClockDeadline(c) && !isTerminalBroadcastCampaignStatus(c.status)) {
                await sendSummary({
                    campaignId: Number(c.id),
                    mode: { abortedDueToTimeout: true, isTopicTestMode: Number(c.topic_test_mode) === 1 }
                });
                outcomes.push({
                    campaignId: Number(c.id),
                    action: 'aborted_wall_clock',
                    reason: 'WALL_CLOCK'
                });
                continue;
            }
            const totalRow = await get(`SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`, [
                Number(c.id)
            ]);
            const totalRows = Number(totalRow?.c || 0);
            const qr = await countQueueRemaining(c.id);
            const decision = computeBroadcastRecoveryAction(
                c,
                { totalRows, queueRemaining: qr },
                { nowMs: Date.now() }
            );
            if (decision.action === 'skip') {
                outcomes.push({ campaignId: Number(c.id), action: 'skip', reason: decision.reason });
                continue;
            }
            if (decision.action === 'abandon_empty') {
                await run(
                    `UPDATE broadcast_campaigns SET status = 'DONE', completed_at = ?, updated_at = ? WHERE id = ?`,
                    [nowIso, nowIso, Number(c.id)]
                );
                logger.error('[BroadcastRecovery] abandoned_stalled_campaign_no_deliveries', {
                    campaignId: Number(c.id),
                    tag: 'BROADCAST_RECOVERY_ABANDON_EMPTY'
                });
                void persistCampaignEvent(Number(c.id), BROADCAST_CAMPAIGN_EVENT_CODES.RECOVERY_ABANDON_EMPTY, {
                    reason: String(decision.reason || '').slice(0, 200)
                }, { topicTestMode: Number(c.topic_test_mode) === 1 });
                outcomes.push({ campaignId: Number(c.id), action: 'abandoned', reason: decision.reason });
                continue;
            }

            const gate = shouldHaltBroadcastDelivery(resolveTransportPreflightContext(), {
                probePreflightTrustMs: probePreflightTrustMsResolved
            });
            if (gate.halt) {
                const cid = Number(c.id);
                const qr = await countQueueRemaining(cid);
                const statsRowSr = await get(DELIVERY_AGG_SQL, [cid]);
                const detailsSr = await assembleTransportGateEventDetails({
                    gate,
                    campaignId: cid,
                    statsRow: statsRowSr,
                    queueRemaining: qr,
                    mode: { recoveryRun: true, resumeFromDb: false },
                    phase: 'startup_recovery',
                    recoveryAction: decision.action
                });
                await pauseBroadcastCampaignTransport(cid, `GATE_STARTUP:${gate.reason}`);
                logger.warn('[BroadcastRecovery] startup_recovery_skipped_dead_transport', {
                    campaignId: cid,
                    gateReason: gate.reason,
                    gateSource: gate.source,
                    recoveryAction: decision.action,
                    queueRemaining: qr,
                    tag: 'BROADCAST_STARTUP_GATE'
                });
                void persistCampaignEvent(
                    cid,
                    BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_STARTUP_RECOVERY_SKIP,
                    detailsSr,
                    { topicTestMode: Number(c.topic_test_mode) === 1 }
                );
                outcomes.push({
                    campaignId: cid,
                    action: 'skipped_transport_gate',
                    reason: gate.reason,
                    gateSource: gate.source,
                    recoveryAction: decision.action,
                    queueRemaining: qr
                });
                continue;
            }

            const topicTm = Number(c.topic_test_mode) === 1;
            const sch = scheduleCampaignDeliveryJob({
                campaignId: c.id,
                sourceChatId: c.source_chat_id,
                sourceMessageId: c.source_message_id,
                recipients: [],
                mode: {
                    resumeFromDb: true,
                    recoveryRun: true,
                    isTopicTestMode: topicTm,
                    recipientsTargeted: totalRows
                }
            });
            outcomes.push({
                campaignId: Number(c.id),
                action: decision.action,
                scheduled: sch.scheduled,
                scheduleReason: sch.reason || null
            });
            if (sch.scheduled) {
                void persistCampaignEvent(Number(c.id), BROADCAST_CAMPAIGN_EVENT_CODES.RECOVERY_SCHEDULED, {
                    action: decision.action,
                    source: 'startup_recovery'
                }, { topicTestMode: topicTm });
            }
        }
        const gateOutcomes = outcomes.filter((o) => o.action === 'skipped_transport_gate');
        if (gateOutcomes.length) {
            recordStartupRecoveryTransportGate({
                reason: String(gateOutcomes[0].reason || 'UNKNOWN'),
                source: String(gateOutcomes[0].gateSource || 'unknown'),
                campaignsAffected: gateOutcomes.map((o) => Number(o.campaignId)).filter((n) => Number.isFinite(n))
            });
        }
        lastStartupRecoverySnapshot = {
            ranAtIso: nowIso,
            outcomes,
            startupTransportGateSkips: gateOutcomes.length
        };
        logger.log('[BroadcastRecovery] startup sweep completed', {
            runningCampaignsSeen: rows.length,
            outcomeRows: outcomes.length,
            transportGateSkips: gateOutcomes.length
        });
        return lastStartupRecoverySnapshot;
    }

    async function getBroadcastLifecycleDiagnostics() {
        const base = {
            lastStartupRecovery: lastStartupRecoverySnapshot ? { ...lastStartupRecoverySnapshot } : null,
            activeCampaignDeliveryJobs: activeCampaignJobs.size,
            pausedTransportAutoResume: getPausedTransportAutoResumeDiagnostics()
        };
        const ws = getWorkerSnapshot();
        let runningCampaignSnapshot = null;
        let stallDerived = null;
        let doneWithOpenDeliveryRows = 0;
        try {
            const doneAnom = await get(
                `
                SELECT COUNT(*) AS c
                FROM broadcast_campaigns c
                WHERE UPPER(TRIM(COALESCE(c.status, ''))) = 'DONE'
                  AND EXISTS (
                    SELECT 1 FROM broadcast_deliveries d
                    WHERE d.campaign_id = c.id
                      AND d.status IN ('PENDING', 'RETRY_WAIT')
                  )
                `
            );
            doneWithOpenDeliveryRows = Number(doneAnom?.c || 0);

            const running = await get(
                `
                SELECT * FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) IN ('RUNNING', 'PAUSED_TRANSPORT')
                ORDER BY id DESC
                LIMIT 1
                `
            );
            if (running) {
                const cid = Number(running.id);
                const agg = await get(DELIVERY_AGG_SQL, [cid]);
                const totalRow = await get(`SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`, [
                    cid
                ]);
                const totalRows = Number(totalRow?.c || 0);
                const qr = await countQueueRemaining(cid);
                const nowIso = new Date().toISOString();
                const futureRow = await get(
                    `
                    SELECT COUNT(*) AS c
                    FROM broadcast_deliveries
                    WHERE campaign_id = ?
                      AND status = 'RETRY_WAIT'
                      AND next_retry_at > ?
                    `,
                    [cid, nowIso]
                );
                const futureRetryScheduled = Number(futureRow?.c || 0);
                const dueRow = await get(
                    `
                    SELECT COUNT(*) AS c
                    FROM broadcast_deliveries
                    WHERE campaign_id = ?
                      AND (
                        status = 'PENDING'
                        OR (status = 'RETRY_WAIT' AND (next_retry_at IS NULL OR next_retry_at <= ?))
                      )
                    `,
                    [cid, nowIso]
                );
                const dueWorkNow = Number(dueRow?.c || 0);
                const workerMatches = Boolean(ws.running && Number(ws.campaignId) === cid);
                const transportHint = Boolean(
                    lastBroadcastRunDiagnostics && lastBroadcastRunDiagnostics.transportLayerErrorsSuspected
                );
                stallDerived = deriveBroadcastStallState(running, {
                    totalRows,
                    queueRemaining: qr,
                    futureRetryScheduled,
                    dueWorkNow,
                    nowMs: Date.now(),
                    workerActiveForThisCampaign: workerMatches,
                    transportLikelyFromLastRun: transportHint
                });
                runningCampaignSnapshot = {
                    campaignId: cid,
                    delivery_enqueue_completed_at: running.delivery_enqueue_completed_at || null,
                    delivery_last_progress_at: running.delivery_last_progress_at || null,
                    delivery_first_attempt_at: running.delivery_first_attempt_at || null,
                    delivery_first_delivered_at: running.delivery_first_delivered_at || null,
                    delivery_wave_count: Number(running.delivery_wave_count || 0),
                    delivery_internal_exception_count: Number(running.delivery_internal_exception_count || 0),
                    dbCounts: {
                        delivered: Number(agg?.delivered || 0),
                        blocked: Number(agg?.blocked || 0),
                        failed: Number(agg?.failed || 0),
                        pending: Number(agg?.pending || 0),
                        retry_wait: Number(agg?.retry_wait || 0)
                    },
                    funnel: stallDerived.funnel
                };
            }
        } catch (e) {
            logger.warn('[BroadcastLifecycle] diagnostics_query_failed', { message: e.message || String(e) });
        }
        return {
            ...base,
            runningCampaign: runningCampaignSnapshot,
            stall: stallDerived,
            doneCampaignsWithOpenDeliveryRows: doneWithOpenDeliveryRows,
            workerSnapshotBrief: {
                running: ws.running,
                phase: ws.phase,
                campaignId: ws.campaignId,
                lastWaveProgressAtIso: ws.lastWaveProgressAtIso || null
            }
        };
    }

    /**
     * Общий trigger рассылки из сообщения в теме форума (вебхук админа или размещение из Mini App).
     * @param {string} initiatedByTelegramId — Telegram ID актора (для прав и аудита)
     * @param {{ chat: { id: string|number }, message_thread_id?: number|null, message_id: number }} messageStub объект в форме Telegram Message
     */
    async function runBroadcastForumTopicCampaignFlow(initiatedByTelegramId, messageStub) {
        const fromUserId = String(initiatedByTelegramId || '').trim();
        const updateMessage = messageStub;

        if (!isAdmin(fromUserId)) {
            logger.warn('[Broadcast] non-admin attempt rejected', { fromUserId });
            recordLastBroadcastTriggerOutcome({ ok: false, error: 'FORBIDDEN' });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.FORBIDDEN
            });
            return { ok: false, error: 'FORBIDDEN' };
        }
        if (!broadcastsEnabled) {
            logger.warn('[BroadcastFlow] trigger rejected — broadcasts disabled');
            recordLastBroadcastTriggerOutcome({ ok: false, error: 'BROADCASTS_DISABLED' });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.BROADCASTS_DISABLED
            });
            return { ok: false, error: 'BROADCASTS_DISABLED' };
        }
        const preflight = preflightBroadcastTrigger();
        if (preflight.block) {
            recordBroadcastPreflightBlocked(preflight.reason);
            logger.warn('[BroadcastPreflight] blocked_by_transport', {
                reason: preflight.reason,
                tag: 'BROADCAST_PREFLIGHT_TRANSPORT'
            });
            recordLastBroadcastTriggerOutcome({
                ok: false,
                error: 'TRANSPORT_PREFLIGHT_FAILED',
                transportPreflightReason: preflight.reason
            });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.TRANSPORT_PREFLIGHT_FAILED,
                transport_preflight_reason: preflight.reason
            });
            return { ok: false, error: 'TRANSPORT_PREFLIGHT_FAILED', transportPreflightReason: preflight.reason };
        }
        let createdResult;
        try {
            createdResult = await createCampaignFromSource({
                sourceChatId: updateMessage.chat.id,
                sourceThreadId: updateMessage.message_thread_id,
                sourceMessageId: updateMessage.message_id,
                initiatedBy: fromUserId,
                topicTestMode: isTopicTestModeEnabled
            });
        } catch (e) {
            logger.error('[BroadcastFlow] createCampaignFromSource threw', {
                message: e.message || String(e),
                tag: 'BROADCAST_CAMPAIGN_CREATE_THROW'
            });
            recordLastBroadcastTriggerOutcome({ ok: false, error: 'CAMPAIGN_CREATE_FAILED', createThrew: true });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.CAMPAIGN_CREATE_FAILED
            });
            return { ok: false, error: 'CAMPAIGN_CREATE_FAILED' };
        }
        const campaign = createdResult && createdResult.campaign ? createdResult.campaign : null;
        const isFreshCampaign = Boolean(createdResult && createdResult.created);
        if (!campaign) {
            recordLastBroadcastTriggerOutcome({ ok: false, error: 'CAMPAIGN_CREATE_FAILED' });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.CAMPAIGN_CREATE_FAILED
            });
            return { ok: false, error: 'CAMPAIGN_CREATE_FAILED' };
        }
        if (
            !isFreshCampaign &&
            ['RUNNING', 'PAUSED_TRANSPORT', 'DONE', 'DELETING', 'DELETED', 'ABORTED_TIMEOUT'].includes(
                String(campaign.status || '').toUpperCase()
            )
        ) {
            logger.log('[BroadcastFlow] duplicate_source_message_skip', {
                campaignId: Number(campaign.id),
                status: String(campaign.status || ''),
                tag: 'BROADCAST_DUPLICATE_TRIGGER'
            });
            recordLastBroadcastTriggerOutcome({
                ok: true,
                duplicate: true,
                campaignId: Number(campaign.id),
                campaignStatus: String(campaign.status || '')
            });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.DUPLICATE_TRIGGER,
                campaign_id: Number(campaign.id)
            });
            return { ok: true, duplicate: true, campaignId: campaign.id };
        }

        if (isFreshCampaign) {
            await persistCampaignEvent(
                Number(campaign.id),
                BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_CREATED,
                { source_message_id: Number(updateMessage?.message_id) },
                { topicTestMode: isTopicTestModeEnabled, triggerKind: CAMPAIGN_TRIGGER_KIND_FORUM_TOPIC }
            );
        }

        const topicRecipients = getRecipientsForTopicBroadcast();
        if (
            isTopicTestModeEnabled &&
            rawTopicTestEntries.length > 0 &&
            sanitizedTopicTestIds.length < rawTopicTestEntries.length
        ) {
            logger.warn('[BroadcastFlow] topic_test_ids_invalid_format_dropped', {
                tag: 'BROADCAST_TEST_IDS_NON_NUMERIC_DROPPED',
                rawEntries: rawTopicTestEntries.length,
                sanitizedNumeric: sanitizedTopicTestIds.length
            });
        }
        if (isTopicTestModeEnabled && topicRecipients.length === 0) {
            logger.warn('[BroadcastFlow] SKIP_TEST_MODE_EMPTY_RECIPIENTS', {
                campaignId: Number(campaign.id),
                tag: 'BROADCAST_TEST_IDS_EMPTY',
                hint: 'BROADCAST_TOPIC_TEST_TELEGRAM_IDS'
            });
            await telegramClient.sendMessage({
                chatId: broadcastTopicChatId,
                messageThreadId: Number(broadcastTopicThreadId),
                text:
                    `Режим topic test mode включён, но список тестовых получателей пуст.\n` +
                    `Рассылка не запущена. Добавьте Telegram ID в BROADCAST_TOPIC_TEST_TELEGRAM_IDS.`
            });
            await run(
                `
                UPDATE broadcast_campaigns
                SET status = 'DONE', completed_at = ?, updated_at = ?
                WHERE id = ?
                `,
                [new Date().toISOString(), new Date().toISOString(), Number(campaign.id)]
            );
            recordLastBroadcastRun({
                campaignId: Number(campaign.id),
                jobRan: false,
                audienceSize: 0,
                topicTestMode: true,
                outcomeInterpretation: {
                    primary: 'SKIPPED_TEST_RECIPIENT_LIST_EMPTY',
                    tags: ['NO_DELIVERY_JOB', 'BROADCAST_TOPIC_TEST_MODE', 'EMPTY_BROADCAST_TOPIC_TEST_TELEGRAM_IDS'],
                    topicTestMode: true
                },
                workerPhase: 'skipped_before_enqueue'
            });
            recordLastBroadcastTriggerOutcome({
                ok: true,
                campaignId: Number(campaign.id),
                testModeSkipped: true,
                topicTestMode: true,
                scheduledAsync: false,
                recipientsTargeted: 0
            });
            await persistTopicTriggerAuditFromMessage(updateMessage, {
                result_code: BROADCAST_TRIGGER_RESULT_CODES.TEST_MODE_EMPTY_RECIPIENTS,
                campaign_id: Number(campaign.id),
                audience_estimate: 0
            });
            return { ok: true, campaignId: campaign.id, testModeSkipped: true };
        }

        const recipients = Array.isArray(topicRecipients) ? topicRecipients : [];

        logger.log('[BroadcastFlow] campaign scheduled (webhook ACK не ждёт конца доставки)', {
            campaignId: Number(campaign.id),
            audienceSize: isTopicTestModeEnabled ? recipients.length : null,
            deferProductionRecipients: !isTopicTestModeEnabled,
            topicTestMode: isTopicTestModeEnabled
        });

        const mode = {
            isTopicTestMode: isTopicTestModeEnabled,
            recipientsTargeted: isTopicTestModeEnabled ? recipients.length : null,
            deferProductionRecipients: !isTopicTestModeEnabled
        };

        const sch = scheduleCampaignDeliveryJob({
            campaignId: campaign.id,
            sourceChatId: updateMessage.chat.id,
            sourceMessageId: updateMessage.message_id,
            recipients,
            mode
        });

        recordLastBroadcastTriggerOutcome({
            ok: true,
            campaignId: Number(campaign.id),
            topicTestMode: isTopicTestModeEnabled,
            recipientsTargeted: isTopicTestModeEnabled ? recipients.length : null,
            scheduledAsync: sch.scheduled,
            jobNotScheduledReason: sch.reason || null,
            deferProductionRecipients: !isTopicTestModeEnabled
        });

        const schedFields = mapScheduleResultToAuditFields(sch);
        await persistTopicTriggerAuditFromMessage(updateMessage, {
            ...schedFields,
            campaign_id: Number(campaign.id),
            audience_estimate: isTopicTestModeEnabled ? recipients.length : null
        });

        return {
            ok: true,
            campaignId: campaign.id,
            topicTestMode: isTopicTestModeEnabled,
            recipientsTargeted: isTopicTestModeEnabled ? recipients.length : null,
            scheduledAsync: sch.scheduled,
            jobNotScheduledReason: sch.reason || null,
            deferProductionRecipients: !isTopicTestModeEnabled
        };
    }

    async function startCampaignFromTopicMessage(updateMessage) {
        return runBroadcastForumTopicCampaignFlow(String(updateMessage?.from?.id || ''), updateMessage);
    }

    /**
     * Тот же сценарий, что сообщение админа в теме рассылок, но источник — пост бота после размещения из Mini App.
     */
    async function startCampaignFromMiniAppTopicPost(initiatedByTelegramId, { chatId, threadId, messageId }) {
        const stubMsg = {
            chat: { id: chatId },
            message_thread_id: threadId,
            message_id: Number(messageId),
            from: { id: String(initiatedByTelegramId || '').trim() }
        };
        return runBroadcastForumTopicCampaignFlow(String(initiatedByTelegramId || '').trim(), stubMsg);
    }

    async function deleteCampaignMessages(campaignId, requesterTelegramId) {
        if (!isAdmin(requesterTelegramId)) {
            return { ok: false, error: 'FORBIDDEN' };
        }
        const campaign = await get('SELECT * FROM broadcast_campaigns WHERE id = ?', [Number(campaignId)]);
        if (!campaign) return { ok: false, error: 'CAMPAIGN_NOT_FOUND' };
        if (campaign.deleted_at) {
            return { ok: true, duplicate: true, deleted: 0, failed: 0 };
        }

        await run(
            `
            UPDATE broadcast_campaigns
            SET status = 'DELETING', updated_at = ?
            WHERE id = ?
            `,
            [new Date().toISOString(), Number(campaignId)]
        );

        const rows = await all(
            `
            SELECT *
            FROM broadcast_deliveries
            WHERE campaign_id = ?
              AND status = 'DELIVERED'
              AND delivered_message_id IS NOT NULL
              AND COALESCE(delete_status, '') != 'DELETED'
            `,
            [Number(campaignId)]
        );

        let deleted = 0;
        let failed = 0;
        for (const row of rows) {
            const result = await telegramClient.deleteMessage({
                chatId: row.recipient_telegram_id,
                messageId: row.delivered_message_id
            });
            if (result.ok) {
                deleted += 1;
                await run(
                    `
                    UPDATE broadcast_deliveries
                    SET delete_status = 'DELETED', deleted_at = ?, updated_at = ?
                    WHERE id = ?
                    `,
                    [new Date().toISOString(), new Date().toISOString(), Number(row.id)]
                );
            } else {
                failed += 1;
                await run(
                    `
                    UPDATE broadcast_deliveries
                    SET delete_status = 'FAILED', delete_error = ?, updated_at = ?
                    WHERE id = ?
                    `,
                    [result.errorCode || result.message || 'DELETE_FAILED', new Date().toISOString(), Number(row.id)]
                );
            }
        }

        const sent = await telegramClient.sendMessage({
            chatId: broadcastTopicChatId,
            messageThreadId: Number(broadcastTopicThreadId),
            text:
                `🧹 Удаление рассылки #${campaignId} завершено\n` +
                `✅ Удалено: ${deleted}\n` +
                `❌ Не удалено: ${failed}`
        });

        await run(
            `
            UPDATE broadcast_campaigns
            SET deleted_at = ?, delete_summary_message_id = ?, status = 'DELETED', updated_at = ?
            WHERE id = ?
            `,
            [
                new Date().toISOString(),
                sent.ok ? Number(sent.data?.message_id || 0) : null,
                new Date().toISOString(),
                Number(campaignId)
            ]
        );

        return { ok: true, deleted, failed };
    }

    function isBroadcastTopicMessage(updateMessage) {
        const chatId = String(updateMessage?.chat?.id ?? '').trim();
        const threadId = Number(updateMessage?.message_thread_id || 0);
        const wantChat = String(broadcastTopicChatId ?? '').trim();
        const wantThread = Number(broadcastTopicThreadId || 0);
        return (
            !!chatId &&
            threadId > 0 &&
            wantThread > 0 &&
            chatId === wantChat &&
            threadId === wantThread
        );
    }

    function getBroadcastTopicRoutingDebug() {
        return {
            expectedChatId: String(broadcastTopicChatId ?? '').trim(),
            expectedThreadId: Number(broadcastTopicThreadId || 0)
        };
    }

    /** Без PII: сводка для /api/health/ops и диагностики «0 доставок». */
    async function getBroadcastOpsDiagnostics() {
        const transportDiag = getBroadcastTransportOpsDiagnostics();
        let auditPersisted = {
            lastPersistedTriggerOutcome: null,
            recentTriggerOutcomes: [],
            recentTriggerOutcomeCount: 0
        };
        try {
            auditPersisted = await fetchBroadcastTriggerAuditDiagnostics({ get, all }, { recentLimit: 5 });
        } catch (e) {
            logger.warn('[BroadcastTriggerAudit] diagnostics_query_failed', { message: e.message || String(e) });
        }
        let campaignLifecyclePersisted = {
            lastPersistedCampaignEvent: null,
            recentCampaignEvents: [],
            campaignLifecycleEventCount: 0,
            broadcastCampaignEventError: null
        };
        try {
            campaignLifecyclePersisted = await fetchBroadcastCampaignEventDiagnostics({ get, all }, { recentLimit: 5 });
        } catch (e) {
            logger.warn('[BroadcastCampaignEvent] diagnostics_query_failed', { message: e.message || String(e) });
        }
        let transportGatePersisted = {
            lastPersistedTransportGateEvent: null,
            recentTransportGateEvents: [],
            transportGateEventCount: 0,
            deliveryTransportGateHaltCount: 0,
            startupRecoveryTransportGateSkipCount: 0,
            lastTransportGateReasonCode: null,
            lastTransportGateDecisionSource: null,
            transportGateDiagnosticsError: null
        };
        try {
            transportGatePersisted = await fetchBroadcastTransportGateEventDiagnostics({ get, all }, { recentLimit: 8 });
        } catch (e) {
            transportGatePersisted.transportGateDiagnosticsError = String(e.message || e);
        }
        let pausedRow = null;
        let pausedCountRow = null;
        try {
            pausedRow = await get(
                `
                SELECT id, delivery_transport_pause_reason
                FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) = 'PAUSED_TRANSPORT'
                ORDER BY id DESC
                LIMIT 1
                `
            );
            pausedCountRow = await get(
                `
                SELECT COUNT(*) AS c
                FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) = 'PAUSED_TRANSPORT'
                `
            );
        } catch (_) {
            /* ignore */
        }
        let timeoutCountRow = null;
        let dedupeSkipCountRow = null;
        let lastTimeoutCampaignRow = null;
        try {
            timeoutCountRow = await get(
                `SELECT COUNT(*) AS c FROM broadcast_campaigns WHERE UPPER(TRIM(COALESCE(status, ''))) = 'ABORTED_TIMEOUT'`
            );
            dedupeSkipCountRow = await get(
                `SELECT COUNT(*) AS c FROM broadcast_campaign_events WHERE event_code = ?`,
                [BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_SEND_SKIPPED_DUPLICATE]
            );
            lastTimeoutCampaignRow = await get(
                `
                SELECT id, created_at, broadcast_terminal_notice_at, broadcast_terminal_notice_kind
                FROM broadcast_campaigns
                WHERE UPPER(TRIM(COALESCE(status, ''))) = 'ABORTED_TIMEOUT'
                ORDER BY id DESC
                LIMIT 1
                `
            );
        } catch (_) {
            /* ignore */
        }
        return {
            broadcastCampaignWallClockMs: BROADCAST_CAMPAIGN_MAX_WALL_MS,
            lastWallClockSweep: lastWallClockSweepResult,
            abortedTimeoutCampaignCount: Number(timeoutCountRow?.c || 0),
            summaryDuplicateSuppressEventCount: Number(dedupeSkipCountRow?.c || 0),
            lastAbortedTimeoutCampaign: lastTimeoutCampaignRow
                ? {
                      campaignId: Number(lastTimeoutCampaignRow.id),
                      createdAt: lastTimeoutCampaignRow.created_at || null,
                      terminalNoticeAt: lastTimeoutCampaignRow.broadcast_terminal_notice_at || null,
                      terminalNoticeKind: lastTimeoutCampaignRow.broadcast_terminal_notice_kind || null
                  }
                : null,
            activeCampaignDeliveryJobsCount: activeCampaignJobs.size,
            topicTestMode: isTopicTestModeEnabled,
            topicTestRecipientCount: sanitizedTopicTestIds.length,
            topicTestIdSanity: {
                rawNonEmptyEntries: rawTopicTestEntries.length,
                sanitizedNumericIds: sanitizedTopicTestIds.length,
                invalidFormatDropped: Math.max(0, rawTopicTestEntries.length - sanitizedTopicTestIds.length)
            },
            topicRouting: getBroadcastTopicRoutingDebug(),
            broadcastTriggerAdmins: trusted.size === 0 ? 'any_forum_member' : `explicit_list_count_${trusted.size}`,
            transportBreakerCopyStreakThreshold: transportBreakerThreshold,
            ...transportDiag,
            activeCampaignPausedByTransport: pausedRow
                ? {
                      campaignId: Number(pausedRow.id),
                      pauseReason: pausedRow.delivery_transport_pause_reason || null
                  }
                : null,
            pausedTransportCampaignCount: Number(pausedCountRow?.c || 0),
            ...getPausedTransportAutoResumeDiagnostics(),
            probePreflightTrustMs: probePreflightTrustMsResolved,
            pausedTransportAutoResumeMinIntervalMs: pausedTransportAutoResumeMinMs,
            pausedTransportPerCampaignCooldownMs: perCampaignResumeCooldownMs,
            pausedTransportSweepMs: pausedTransportSweepMsResolved,
            lastPersistedTriggerOutcome: auditPersisted.lastPersistedTriggerOutcome,
            recentTriggerOutcomes: auditPersisted.recentTriggerOutcomes,
            recentTriggerOutcomeCount: auditPersisted.recentTriggerOutcomeCount,
            broadcastTriggerAuditError: auditPersisted.broadcastTriggerAuditError || null,
            lastPersistedCampaignEvent: campaignLifecyclePersisted.lastPersistedCampaignEvent,
            recentCampaignEvents: campaignLifecyclePersisted.recentCampaignEvents,
            campaignLifecycleEventCount: campaignLifecyclePersisted.campaignLifecycleEventCount,
            broadcastCampaignEventError: campaignLifecyclePersisted.broadcastCampaignEventError || null,
            ...transportGatePersisted,
            lastBroadcastTriggerOutcome: lastBroadcastTriggerOutcome ? { ...lastBroadcastTriggerOutcome } : null,
            broadcastTransportGate: (() => {
                const g = shouldHaltBroadcastDelivery(resolveTransportPreflightContext(), {
                    probePreflightTrustMs: probePreflightTrustMsResolved
                });
                const ws = getWorkerSnapshot();
                return {
                    deliveryWouldHaltNow: Boolean(g.halt),
                    haltReason: g.reason || null,
                    haltSource: g.source || null,
                    workerPhase: ws.phase || null,
                    workersHaltedByGate: ws.phase === 'halted_transport_gate',
                    workerPhaseIsTransportGateHalt: ws.phase === 'halted_transport_gate'
                };
            })()
        };
    }

    async function getBroadcastLastRunDiagnostics() {
        const base = lastBroadcastRunDiagnostics ? { ...lastBroadcastRunDiagnostics } : null;
        if (!base || base.campaignId == null) return base;
        try {
            const row = await fetchLastLifecycleEventForCampaign({ get }, base.campaignId);
            return {
                ...base,
                lastPersistedLifecycleEventCode: row?.event_code || null,
                lastPersistedLifecycleEventAt: row?.created_at || null
            };
        } catch (_) {
            return base;
        }
    }

    return {
        isBroadcastTopicMessage,
        getBroadcastTopicRoutingDebug,
        getBroadcastOpsDiagnostics,
        getBroadcastLastRunDiagnostics,
        getBroadcastLifecycleDiagnostics,
        startCampaignFromTopicMessage,
        startCampaignFromMiniAppTopicPost,
        deleteCampaignMessages,
        getWorkerSnapshot,
        getBroadcastDeliveryMetrics,
        runStartupBroadcastRecovery,
        tryAutoResumePausedTransportCampaigns,
        scheduleCampaignDeliveryJob,
        enforceCampaignWallClockTimeouts
    };
}

module.exports = {
    createBroadcastService,
    interpretBroadcastOutcome,
    computeBroadcastRecoveryAction,
    deriveBroadcastStallState,
    BROADCAST_TRIGGER_RESULT_CODES,
    BROADCAST_CAMPAIGN_EVENT_CODES,
    BROADCAST_CAMPAIGN_MAX_WALL_MS,
    isTerminalBroadcastCampaignStatus,
    isCampaignPastWallClockDeadline
};
