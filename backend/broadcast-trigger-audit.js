'use strict';

/**
 * Устойчивый audit trail для триггера рассылки из темы форума (без текста сообщения).
 * actor_telegram_id хранится в БД для разборов через SQL; в health API не отдаётся.
 */

const TRIGGER_KIND_FORUM_TOPIC = 'forum_topic_message';

const BROADCAST_TRIGGER_RESULT_CODES = Object.freeze({
    OK_JOB_SCHEDULED: 'OK_JOB_SCHEDULED',
    BROADCASTS_DISABLED: 'BROADCASTS_DISABLED',
    FORBIDDEN: 'FORBIDDEN',
    TRANSPORT_PREFLIGHT_FAILED: 'TRANSPORT_PREFLIGHT_FAILED',
    DUPLICATE_TRIGGER: 'DUPLICATE_TRIGGER',
    TEST_MODE_EMPTY_RECIPIENTS: 'TEST_MODE_EMPTY_RECIPIENTS',
    CAMPAIGN_CREATE_FAILED: 'CAMPAIGN_CREATE_FAILED',
    JOB_ALREADY_ACTIVE: 'JOB_ALREADY_ACTIVE',
    JOB_NOT_SCHEDULED: 'JOB_NOT_SCHEDULED'
});

const MAX_REASON = 500;

function clip(s, max = MAX_REASON) {
    if (s == null || s === undefined) return null;
    const t = String(s);
    return t.length > max ? t.slice(0, max) : t;
}

function safeActorId(updateMessage) {
    const u = String(updateMessage?.from?.id ?? '').trim();
    return /^\d{1,32}$/.test(u) ? u : null;
}

/**
 * @param {object} updateMessage
 * @param {boolean} topicTestEnabled
 */
function buildTopicMessageAuditBase(updateMessage, topicTestEnabled) {
    return {
        trigger_kind: TRIGGER_KIND_FORUM_TOPIC,
        source_chat_id: updateMessage?.chat?.id != null ? String(updateMessage.chat.id) : null,
        source_thread_id: Number.isFinite(Number(updateMessage?.message_thread_id))
            ? Number(updateMessage.message_thread_id)
            : null,
        source_message_id: Number.isFinite(Number(updateMessage?.message_id)) ? Number(updateMessage.message_id) : null,
        topic_test_mode: topicTestEnabled ? 1 : 0,
        actor_telegram_id: safeActorId(updateMessage)
    };
}

/**
 * @param {{ scheduled: boolean, reason?: string|null }} sch
 */
function mapScheduleResultToAuditFields(sch) {
    if (sch && sch.scheduled) {
        return {
            result_code: BROADCAST_TRIGGER_RESULT_CODES.OK_JOB_SCHEDULED,
            job_not_scheduled_reason: null
        };
    }
    const r = sch && sch.reason != null ? String(sch.reason) : null;
    if (r === 'ALREADY_ACTIVE') {
        return {
            result_code: BROADCAST_TRIGGER_RESULT_CODES.JOB_ALREADY_ACTIVE,
            job_not_scheduled_reason: 'ALREADY_ACTIVE'
        };
    }
    return {
        result_code: BROADCAST_TRIGGER_RESULT_CODES.JOB_NOT_SCHEDULED,
        job_not_scheduled_reason: r ? clip(r, 120) : null
    };
}

/**
 * @param {object} row — строка из broadcast_trigger_audit
 */
function shapeAuditRowForHealthOps(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        createdAt: row.created_at || null,
        resultCode: row.result_code || null,
        campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
        topicTestMode: Number(row.topic_test_mode) === 1,
        sourceThreadId: row.source_thread_id != null ? Number(row.source_thread_id) : null,
        sourceMessageId: row.source_message_id != null ? Number(row.source_message_id) : null,
        transportPreflightReason: row.transport_preflight_reason || null,
        jobNotScheduledReason: row.job_not_scheduled_reason || null,
        audienceEstimate: row.audience_estimate != null ? Number(row.audience_estimate) : null
    };
}

/**
 * @param {{ run: Function, logger: { log: Function, error: Function } }} deps
 * @param {object} row
 */
async function insertBroadcastTriggerAudit(deps, row) {
    const { run, logger } = deps;
    const now = new Date().toISOString();
    const sql = `
        INSERT INTO broadcast_trigger_audit (
            created_at, trigger_kind, source_chat_id, source_thread_id, source_message_id,
            topic_test_mode, actor_telegram_id, result_code, job_not_scheduled_reason,
            transport_preflight_reason, campaign_id, audience_estimate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
        now,
        clip(row.trigger_kind, 64) || TRIGGER_KIND_FORUM_TOPIC,
        row.source_chat_id != null ? clip(row.source_chat_id, 32) : null,
        row.source_thread_id != null ? Number(row.source_thread_id) : null,
        row.source_message_id != null ? Number(row.source_message_id) : null,
        Number(row.topic_test_mode) === 1 ? 1 : 0,
        row.actor_telegram_id != null ? clip(row.actor_telegram_id, 32) : null,
        clip(row.result_code, 80),
        row.job_not_scheduled_reason != null ? clip(row.job_not_scheduled_reason, MAX_REASON) : null,
        row.transport_preflight_reason != null ? clip(row.transport_preflight_reason, MAX_REASON) : null,
        row.campaign_id != null ? Number(row.campaign_id) : null,
        row.audience_estimate != null ? Number(row.audience_estimate) : null
    ];
    try {
        const r = await run(sql, params);
        const id = r && r.lastID != null ? Number(r.lastID) : null;
        logger.log('[BroadcastTriggerAudit] recorded', {
            id,
            resultCode: params[7],
            campaignId: params[10] != null ? Number(params[10]) : null,
            tag: 'BROADCAST_TRIGGER_AUDIT_OK'
        });
        return { ok: true, id };
    } catch (e) {
        logger.error('[BroadcastTriggerAudit] record_failed', {
            message: e.message || String(e),
            resultCode: row.result_code,
            tag: 'BROADCAST_TRIGGER_AUDIT_FAIL'
        });
        return { ok: false, error: e.message || String(e) };
    }
}

/**
 * @param {{ get: Function, all: Function }} deps
 * @param {{ recentLimit?: number }} options
 */
async function fetchBroadcastTriggerAuditDiagnostics(deps, options = {}) {
    const { get, all } = deps;
    const recentLimit = Math.max(1, Math.min(10, Number(options.recentLimit) || 5));
    let total = 0;
    let lastRow = null;
    let recentRows = [];
    try {
        const cRow = await get(`SELECT COUNT(*) AS c FROM broadcast_trigger_audit`);
        total = Number(cRow?.c || 0);
        lastRow = await get(`SELECT * FROM broadcast_trigger_audit ORDER BY id DESC LIMIT 1`);
        recentRows = await all(
            `SELECT * FROM broadcast_trigger_audit ORDER BY id DESC LIMIT ?`,
            [recentLimit]
        );
    } catch (e) {
        return {
            lastPersistedTriggerOutcome: null,
            recentTriggerOutcomes: [],
            recentTriggerOutcomeCount: 0,
            broadcastTriggerAuditError: String(e.message || e)
        };
    }
    return {
        lastPersistedTriggerOutcome: shapeAuditRowForHealthOps(lastRow),
        recentTriggerOutcomes: (recentRows || []).map((r) => shapeAuditRowForHealthOps(r)).filter(Boolean),
        recentTriggerOutcomeCount: total
    };
}

module.exports = {
    TRIGGER_KIND_FORUM_TOPIC,
    BROADCAST_TRIGGER_RESULT_CODES,
    buildTopicMessageAuditBase,
    mapScheduleResultToAuditFields,
    insertBroadcastTriggerAudit,
    fetchBroadcastTriggerAuditDiagnostics,
    shapeAuditRowForHealthOps
};
