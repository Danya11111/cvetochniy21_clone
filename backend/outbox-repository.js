const db = require('./db');
const { computeNextRetryAt } = require('./reliability-utils');

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

function createOutboxRepository({ logger = console }) {
    async function enqueue({
        eventType,
        entityType = null,
        entityId = null,
        payload,
        routingKey = null,
        dedupeKey
    }) {
        const now = new Date().toISOString();
        try {
            const r = await run(
                `
                INSERT INTO event_outbox (
                    event_type, entity_type, entity_id, payload_json, routing_key, dedupe_key, status, attempts, next_retry_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'NEW', 0, ?, ?)
                `,
                [
                    String(eventType),
                    entityType,
                    entityId ? String(entityId) : null,
                    JSON.stringify(payload || {}),
                    routingKey,
                    String(dedupeKey),
                    now,
                    now
                ]
            );
            return { ok: true, id: r.lastID, duplicate: false };
        } catch (e) {
            if (String(e.message || '').toLowerCase().includes('unique constraint failed')) {
                logger.log('[Outbox] duplicate dedupe_key ignored', { eventType, dedupeKey });
                return { ok: true, duplicate: true };
            }
            throw e;
        }
    }

    async function pullBatch(limit = 50) {
        const now = new Date().toISOString();
        const rows = await all(
            `
            SELECT * FROM event_outbox
            WHERE status IN ('NEW', 'RETRYING')
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY id ASC
            LIMIT ?
            `,
            [now, Number(limit)]
        );
        return rows;
    }

    async function markSent(id) {
        await run(
            `
            UPDATE event_outbox
            SET status = 'SENT', sent_at = ?, attempts = attempts + 1
            WHERE id = ?
            `,
            [new Date().toISOString(), Number(id)]
        );
    }

    async function markRetry(id, { attempts, errorMessage, retryAfterSec }) {
        const nextRetryAt = computeNextRetryAt(Number(attempts || 0), retryAfterSec);
        await run(
            `
            UPDATE event_outbox
            SET status = 'RETRYING',
                attempts = attempts + 1,
                last_error = ?,
                next_retry_at = ?
            WHERE id = ?
            `,
            [String(errorMessage || 'UNKNOWN_ERROR').slice(0, 1000), nextRetryAt, Number(id)]
        );
    }

    async function markFailed(id, errorMessage) {
        await run(
            `
            UPDATE event_outbox
            SET status = 'FAILED',
                attempts = attempts + 1,
                last_error = ?
            WHERE id = ?
            `,
            [String(errorMessage || 'FAILED').slice(0, 1000), Number(id)]
        );
    }

    async function getByDedupeKey(dedupeKey) {
        return get('SELECT * FROM event_outbox WHERE dedupe_key = ?', [String(dedupeKey)]);
    }

    return {
        enqueue,
        pullBatch,
        markSent,
        markRetry,
        markFailed,
        getByDedupeKey,
        run,
        get,
        all
    };
}

module.exports = {
    createOutboxRepository
};

