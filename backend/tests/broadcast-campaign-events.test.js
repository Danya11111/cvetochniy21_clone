'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const {
    insertBroadcastCampaignEvent,
    fetchBroadcastCampaignEventDiagnostics,
    fetchBroadcastTransportGateEventDiagnostics,
    BROADCAST_CAMPAIGN_EVENT_CODES
} = require('../broadcast-campaign-events');

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

    const db = new sqlite3.Database(':memory:');
    try {
        await promRun(
            db,
            `
            CREATE TABLE broadcast_campaign_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                campaign_id INTEGER NOT NULL,
                event_code TEXT NOT NULL,
                event_category TEXT,
                trigger_kind TEXT,
                topic_test_mode INTEGER DEFAULT 0,
                details_json TEXT
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

        await insertBroadcastCampaignEvent(
            { run: (sql, p) => promRun(db, sql, p), logger },
            {
                campaign_id: 7,
                event_code: BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_PAUSED,
                event_category: 'lifecycle',
                topic_test_mode: 0,
                details: { reason: 'test' }
            }
        );

        const diag = await fetchBroadcastCampaignEventDiagnostics({ get, all }, { recentLimit: 5 });
        assert.strictEqual(diag.campaignLifecycleEventCount, 1);
        assert.strictEqual(diag.lastPersistedCampaignEvent.eventCode, BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_PAUSED);
        assert.strictEqual(diag.lastPersistedCampaignEvent.campaignId, 7);
        assert.strictEqual(diag.recentCampaignEvents.length, 1);

        await insertBroadcastCampaignEvent(
            { run: (sql, p) => promRun(db, sql, p), logger },
            {
                campaign_id: 7,
                event_code: BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY,
                event_category: 'lifecycle',
                topic_test_mode: 0,
                details: { reasonCode: 'TIMEOUT', decisionSource: 'probe', phase: 'pre_delivery' }
            }
        );
        const tg = await fetchBroadcastTransportGateEventDiagnostics({ get, all }, { recentLimit: 5 });
        assert.strictEqual(tg.transportGateEventCount, 1);
        assert.strictEqual(tg.deliveryTransportGateHaltCount, 1);
        assert.strictEqual(tg.startupRecoveryTransportGateSkipCount, 0);
        assert.strictEqual(tg.lastTransportGateReasonCode, 'TIMEOUT');
        assert.strictEqual(tg.lastTransportGateDecisionSource, 'probe');
        process.stdout.write('PASS insert + fetchBroadcastCampaignEventDiagnostics (memory db)\n');
    } catch (e) {
        process.stderr.write(`FAIL broadcast campaign events memory test: ${e.message}\n`);
        failed = true;
    } finally {
        db.close();
    }

    sub('BROADCAST_CAMPAIGN_EVENT_CODES has core keys', () => {
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_CREATED);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.ENQUEUE_COMPLETED);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.DELIVERY_JOB_STARTED);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_DONE_INCOMPLETE);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_STARTUP_RECOVERY_SKIP);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.SUMMARY_SEND_SKIPPED_DUPLICATE);
        assert.ok(BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_ABORTED_TIMEOUT);
    });

    process.exit(failed ? 1 : 0);
})();
