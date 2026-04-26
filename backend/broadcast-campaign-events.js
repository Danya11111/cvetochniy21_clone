'use strict';

/**
 * Append-only lifecycle events для кампаний рассылки (без PII, без текста сообщений).
 */

const TRIGGER_KIND_FORUM_TOPIC = 'forum_topic_message';

const BROADCAST_CAMPAIGN_EVENT_CODES = Object.freeze({
    CAMPAIGN_CREATED: 'CAMPAIGN_CREATED',
    ENQUEUE_COMPLETED: 'ENQUEUE_COMPLETED',
    DELIVERY_JOB_STARTED: 'DELIVERY_JOB_STARTED',
    DELIVERY_FIRST_ATTEMPT: 'DELIVERY_FIRST_ATTEMPT',
    DELIVERY_FIRST_SUCCESS: 'DELIVERY_FIRST_SUCCESS',
    WAVE_PROGRESS: 'WAVE_PROGRESS',
    TRANSPORT_PAUSED: 'TRANSPORT_PAUSED',
    TRANSPORT_RESUMED: 'TRANSPORT_RESUMED',
    SUMMARY_POSTED: 'SUMMARY_POSTED',
    CAMPAIGN_DONE: 'CAMPAIGN_DONE',
    CAMPAIGN_DONE_INCOMPLETE: 'CAMPAIGN_DONE_INCOMPLETE',
    RECOVERY_SCHEDULED: 'RECOVERY_SCHEDULED',
    RECOVERY_ABANDON_EMPTY: 'RECOVERY_ABANDON_EMPTY',
    AUTO_RESUME_SCHEDULED: 'AUTO_RESUME_SCHEDULED',
    JOB_EXCEPTION: 'JOB_EXCEPTION',
    /** Fail-closed: воркер остановлен по transport gate (probe/preflight), без PII */
    TRANSPORT_GATE_HALTED_DELIVERY: 'TRANSPORT_GATE_HALTED_DELIVERY',
    /** Стартап recovery не планировал job из-за мёртвого transport */
    TRANSPORT_GATE_STARTUP_RECOVERY_SKIP: 'TRANSPORT_GATE_STARTUP_RECOVERY_SKIP',
    /** Идемпотентность: такой же summary уже отправляли (durable dedupe) */
    SUMMARY_SEND_SKIPPED_DUPLICATE: 'SUMMARY_SEND_SKIPPED_DUPLICATE',
    /** Wall-clock 4h: кампания окончательно остановлена */
    CAMPAIGN_ABORTED_TIMEOUT: 'CAMPAIGN_ABORTED_TIMEOUT',
    /** Auto-resume не выполнен — кампания в timeout terminal */
    RESUME_SKIPPED_CAMPAIGN_TIMEOUT: 'RESUME_SKIPPED_CAMPAIGN_TIMEOUT',
    /** Startup recovery не планировал job — timeout */
    RECOVERY_SKIPPED_CAMPAIGN_TIMEOUT: 'RECOVERY_SKIPPED_CAMPAIGN_TIMEOUT'
});

const MAX_JSON = 4500;
const MAX_CODE = 80;

/** Коды событий transport fail-closed (SQLite slice / health). */
const BROADCAST_TRANSPORT_GATE_EVENT_CODES = Object.freeze([
    BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY,
    BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_STARTUP_RECOVERY_SKIP
]);

function clip(s, max) {
    if (s == null || s === undefined) return null;
    const t = String(s);
    return t.length > max ? t.slice(0, max) : t;
}

function sanitizeDetails(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (k.length > 64) continue;
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
        else if (v === null) out[k] = null;
        else if (typeof v === 'string') out[k] = clip(v, 500);
        else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            const nested = sanitizeDetails(v);
            if (Object.keys(nested).length) out[k] = nested;
        }
    }
    return out;
}

function shapeCampaignEventForHealth(row) {
    if (!row) return null;
    let details = null;
    if (row.details_json) {
        try {
            details = JSON.parse(String(row.details_json));
        } catch (_) {
            details = null;
        }
    }
    return {
        id: Number(row.id),
        createdAt: row.created_at || null,
        campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
        eventCode: row.event_code || null,
        eventCategory: row.event_category || null,
        triggerKind: row.trigger_kind || null,
        topicTestMode: Number(row.topic_test_mode) === 1,
        details: details && typeof details === 'object' ? details : null
    };
}

/**
 * @param {{ run: Function, logger: { log: Function, error: Function } }} deps
 * @param {object} row
 */
async function insertBroadcastCampaignEvent(deps, row) {
    const { run, logger } = deps;
    const now = new Date().toISOString();
    const detailsObj = row.details != null && typeof row.details === 'object' ? row.details : {};
    const sanitized = sanitizeDetails(detailsObj);
    const detailsJson = Object.keys(sanitized).length ? clip(JSON.stringify(sanitized), MAX_JSON) : null;
    const sql = `
        INSERT INTO broadcast_campaign_events (
            created_at, campaign_id, event_code, event_category, trigger_kind, topic_test_mode, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        now,
        row.campaign_id != null ? Number(row.campaign_id) : null,
        clip(row.event_code, MAX_CODE),
        row.event_category != null ? clip(row.event_category, 64) : 'lifecycle',
        row.trigger_kind != null ? clip(row.trigger_kind, 64) : null,
        Number(row.topic_test_mode) === 1 ? 1 : 0,
        detailsJson
    ];
    try {
        const r = await run(sql, params);
        const id = r && r.lastID != null ? Number(r.lastID) : null;
        logger.log('[BroadcastCampaignEvent] recorded', {
            id,
            campaignId: params[1],
            eventCode: params[2],
            tag: 'BROADCAST_CAMPAIGN_EVENT_OK'
        });
        return { ok: true, id };
    } catch (e) {
        logger.error('[BroadcastCampaignEvent] record_failed', {
            message: e.message || String(e),
            campaignId: row.campaign_id,
            eventCode: row.event_code,
            tag: 'BROADCAST_CAMPAIGN_EVENT_FAIL'
        });
        return { ok: false, error: e.message || String(e) };
    }
}

/**
 * @param {{ get: Function, all: Function }} deps
 * @param {{ recentLimit?: number }} options
 */
async function fetchBroadcastCampaignEventDiagnostics(deps, options = {}) {
    const { get, all } = deps;
    const recentLimit = Math.max(1, Math.min(15, Number(options.recentLimit) || 5));
    let total = 0;
    let lastRow = null;
    let recentRows = [];
    try {
        const cRow = await get(`SELECT COUNT(*) AS c FROM broadcast_campaign_events`);
        total = Number(cRow?.c || 0);
        lastRow = await get(`SELECT * FROM broadcast_campaign_events ORDER BY id DESC LIMIT 1`);
        recentRows = await all(`SELECT * FROM broadcast_campaign_events ORDER BY id DESC LIMIT ?`, [recentLimit]);
    } catch (e) {
        return {
            lastPersistedCampaignEvent: null,
            recentCampaignEvents: [],
            campaignLifecycleEventCount: 0,
            broadcastCampaignEventError: String(e.message || e)
        };
    }
    return {
        lastPersistedCampaignEvent: shapeCampaignEventForHealth(lastRow),
        recentCampaignEvents: (recentRows || []).map((r) => shapeCampaignEventForHealth(r)).filter(Boolean),
        campaignLifecycleEventCount: total,
        broadcastCampaignEventError: null
    };
}

/**
 * Последнее событие по конкретной кампании (для обогащения broadcastLastRun).
 * @param {{ get: Function }} deps
 * @param {number} campaignId
 */
/**
 * Срез по durable transport-gate событиям (без PII).
 * @param {{ get: Function, all: Function }} deps
 * @param {{ recentLimit?: number }} options
 */
async function fetchBroadcastTransportGateEventDiagnostics(deps, options = {}) {
    const { get, all } = deps;
    const recentLimit = Math.max(1, Math.min(20, Number(options.recentLimit) || 8));
    const codes = [...BROADCAST_TRANSPORT_GATE_EVENT_CODES];
    const ph = codes.map(() => '?').join(',');
    try {
        const totalRow = await get(
            `SELECT COUNT(*) AS c FROM broadcast_campaign_events WHERE event_code IN (${ph})`,
            codes
        );
        const haltRow = await get(
            `SELECT COUNT(*) AS c FROM broadcast_campaign_events WHERE event_code = ?`,
            [BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY]
        );
        const skipRow = await get(
            `SELECT COUNT(*) AS c FROM broadcast_campaign_events WHERE event_code = ?`,
            [BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_STARTUP_RECOVERY_SKIP]
        );
        const lastRow = await get(
            `SELECT * FROM broadcast_campaign_events WHERE event_code IN (${ph}) ORDER BY id DESC LIMIT 1`,
            codes
        );
        const recentRows = await all(
            `SELECT * FROM broadcast_campaign_events WHERE event_code IN (${ph}) ORDER BY id DESC LIMIT ?`,
            [...codes, recentLimit]
        );
        const shapedLast = shapeCampaignEventForHealth(lastRow);
        let lastReason = null;
        let lastSource = null;
        if (shapedLast && shapedLast.details && typeof shapedLast.details === 'object') {
            lastReason = shapedLast.details.reasonCode || shapedLast.details.gateReason || null;
            lastSource = shapedLast.details.decisionSource || shapedLast.details.gateSource || null;
        }
        return {
            lastPersistedTransportGateEvent: shapedLast,
            recentTransportGateEvents: (recentRows || []).map((r) => shapeCampaignEventForHealth(r)).filter(Boolean),
            transportGateEventCount: Number(totalRow?.c || 0),
            deliveryTransportGateHaltCount: Number(haltRow?.c || 0),
            startupRecoveryTransportGateSkipCount: Number(skipRow?.c || 0),
            lastTransportGateReasonCode: lastReason,
            lastTransportGateDecisionSource: lastSource,
            transportGateDiagnosticsError: null
        };
    } catch (e) {
        return {
            lastPersistedTransportGateEvent: null,
            recentTransportGateEvents: [],
            transportGateEventCount: 0,
            deliveryTransportGateHaltCount: 0,
            startupRecoveryTransportGateSkipCount: 0,
            lastTransportGateReasonCode: null,
            lastTransportGateDecisionSource: null,
            transportGateDiagnosticsError: String(e.message || e)
        };
    }
}

async function fetchLastLifecycleEventForCampaign(deps, campaignId) {
    const { get } = deps;
    const cid = Number(campaignId);
    if (!Number.isFinite(cid)) return null;
    try {
        return await get(
            `
            SELECT event_code, created_at
            FROM broadcast_campaign_events
            WHERE campaign_id = ?
            ORDER BY id DESC
            LIMIT 1
            `,
            [cid]
        );
    } catch (_) {
        return null;
    }
}

module.exports = {
    TRIGGER_KIND_FORUM_TOPIC,
    BROADCAST_CAMPAIGN_EVENT_CODES,
    BROADCAST_TRANSPORT_GATE_EVENT_CODES,
    insertBroadcastCampaignEvent,
    fetchBroadcastCampaignEventDiagnostics,
    fetchBroadcastTransportGateEventDiagnostics,
    fetchLastLifecycleEventForCampaign,
    shapeCampaignEventForHealth,
    sanitizeDetails
};
