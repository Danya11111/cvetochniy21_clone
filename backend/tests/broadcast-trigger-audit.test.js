'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const {
    insertBroadcastTriggerAudit,
    fetchBroadcastTriggerAuditDiagnostics,
    mapScheduleResultToAuditFields,
    buildTopicMessageAuditBase,
    shapeAuditRowForHealthOps,
    BROADCAST_TRIGGER_RESULT_CODES
} = require('../broadcast-trigger-audit');

function promRun(db, sql, params = []) {
    return new Promise((res, rej) => {
        db.run(sql, params, function onRun(err) {
            if (err) return rej(err);
            res({ lastID: this.lastID, changes: this.changes });
        });
    });
}

(async function runAll() {
    let failed = false;
    function sub(name, fn) {
        try {
            fn();
            process.stdout.write(`PASS ${name}\n`);
        } catch (e) {
            process.stderr.write(`FAIL ${name}: ${e.message}\n`);
            failed = true;
        }
    }

    sub('mapScheduleResultToAuditFields: scheduled', () => {
        const m = mapScheduleResultToAuditFields({ scheduled: true });
        assert.strictEqual(m.result_code, BROADCAST_TRIGGER_RESULT_CODES.OK_JOB_SCHEDULED);
        assert.strictEqual(m.job_not_scheduled_reason, null);
    });

    sub('mapScheduleResultToAuditFields: ALREADY_ACTIVE', () => {
        const m = mapScheduleResultToAuditFields({ scheduled: false, reason: 'ALREADY_ACTIVE' });
        assert.strictEqual(m.result_code, BROADCAST_TRIGGER_RESULT_CODES.JOB_ALREADY_ACTIVE);
        assert.strictEqual(m.job_not_scheduled_reason, 'ALREADY_ACTIVE');
    });

    sub('mapScheduleResultToAuditFields: other reason', () => {
        const m = mapScheduleResultToAuditFields({ scheduled: false, reason: 'BAD_CAMPAIGN_ID' });
        assert.strictEqual(m.result_code, BROADCAST_TRIGGER_RESULT_CODES.JOB_NOT_SCHEDULED);
        assert.strictEqual(m.job_not_scheduled_reason, 'BAD_CAMPAIGN_ID');
    });

    sub('shapeAuditRowForHealthOps: no actor field', () => {
        const shaped = shapeAuditRowForHealthOps({
            id: 1,
            created_at: '2020-01-01T00:00:00.000Z',
            result_code: 'X',
            campaign_id: 5,
            topic_test_mode: 1,
            source_thread_id: 3,
            source_message_id: 9,
            transport_preflight_reason: null,
            job_not_scheduled_reason: null,
            audience_estimate: 10
        });
        assert.strictEqual(shaped.actorTelegramId, undefined);
        assert.strictEqual(buildTopicMessageAuditBase({ chat: { id: '-100' }, message_thread_id: 3, message_id: 9, from: { id: 777 } }, true).topic_test_mode, 1);
    });

    const db = new sqlite3.Database(':memory:');
    try {
        await promRun(
            db,
            `
            CREATE TABLE broadcast_trigger_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                trigger_kind TEXT NOT NULL,
                source_chat_id TEXT,
                source_thread_id INTEGER,
                source_message_id INTEGER,
                topic_test_mode INTEGER DEFAULT 0,
                actor_telegram_id TEXT,
                result_code TEXT NOT NULL,
                job_not_scheduled_reason TEXT,
                transport_preflight_reason TEXT,
                campaign_id INTEGER,
                audience_estimate INTEGER
            )
        `
        );

        const logger = { log() {}, error() {} };
        const get = (sql, params = []) =>
            new Promise((res, rej) => {
                db.get(sql, params, (err, row) => (err ? rej(err) : res(row)));
            });
        const all = (sql, params = []) =>
            new Promise((res, rej) => {
                db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows || [])));
            });

        await insertBroadcastTriggerAudit(
            { run: (sql, p) => promRun(db, sql, p), logger },
            {
                trigger_kind: 'forum_topic_message',
                source_chat_id: '-1',
                source_thread_id: 1,
                source_message_id: 2,
                topic_test_mode: 0,
                actor_telegram_id: '99',
                result_code: BROADCAST_TRIGGER_RESULT_CODES.TRANSPORT_PREFLIGHT_FAILED,
                transport_preflight_reason: 'OUTBOUND_DISABLED',
                campaign_id: null,
                audience_estimate: null
            }
        );

        const diag = await fetchBroadcastTriggerAuditDiagnostics({ get, all }, { recentLimit: 5 });
        assert.strictEqual(diag.recentTriggerOutcomeCount, 1);
        assert.strictEqual(diag.lastPersistedTriggerOutcome.resultCode, BROADCAST_TRIGGER_RESULT_CODES.TRANSPORT_PREFLIGHT_FAILED);
        assert.strictEqual(diag.lastPersistedTriggerOutcome.transportPreflightReason, 'OUTBOUND_DISABLED');
        assert.strictEqual(diag.recentTriggerOutcomes.length, 1);
        process.stdout.write('PASS insert + fetchBroadcastTriggerAuditDiagnostics (memory db)\n');
    } catch (e) {
        process.stderr.write(`FAIL insert + fetchBroadcastTriggerAuditDiagnostics: ${e.message}\n`);
        failed = true;
    } finally {
        db.close();
    }

    process.exit(failed ? 1 : 0);
})();
