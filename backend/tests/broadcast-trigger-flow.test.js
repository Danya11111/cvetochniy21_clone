'use strict';

/**
 * Интеграция trigger path + SQLite (отдельный temp-файл через F21_SQLITE_PATH).
 * Запускается в отдельном процессе npm test — кэш require чистый.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `f21-broadcast-flow-${Date.now()}.sqlite`);
try {
    fs.unlinkSync(tmp);
} catch (_) {
    /* ok */
}
process.env.F21_SQLITE_PATH = tmp;

const { createBroadcastService, BROADCAST_TRIGGER_RESULT_CODES } = require('../broadcast-service');
const { fetchBroadcastTriggerAuditDiagnostics } = require('../broadcast-trigger-audit');

function waitForDbMigrationsReady() {
    const db = require('../db');
    return db.awaitMigrations.then(
        () =>
            new Promise((resolve, reject) => {
                const deadline = Date.now() + 12000;
                function tick() {
                    db.all('PRAGMA table_info(broadcast_campaigns)', (err1, colsBc) => {
                        if (err1) return reject(err1);
                        db.all('PRAGMA table_info(broadcast_deliveries)', (err2, colsBd) => {
                            if (err2) return reject(err2);
                            db.all('PRAGMA table_info(broadcast_campaign_events)', (err3, colsEv) => {
                                if (err3) return reject(err3);
                                const okBc = (colsBc || []).some((c) => c.name === 'topic_test_mode');
                                const okBd = (colsBd || []).some((c) => c.name === 'next_retry_at');
                                const okEv = (colsEv || []).some((c) => c.name === 'event_code');
                                if (okBc && okBd && okEv) return resolve();
                                if (Date.now() > deadline) {
                                    return reject(new Error('migration timeout: broadcast schema'));
                                }
                                setTimeout(tick, 40);
                            });
                        });
                    });
                }
                tick();
            })
    );
}

function baseMsg(over = {}) {
    return {
        chat: { id: '-100' },
        message_thread_id: 2,
        message_id: 100,
        from: { id: 99 },
        ...over
    };
}

function makeService(over = {}) {
    return createBroadcastService({
        telegramClient: {
            sendMessage: async () => ({ ok: true }),
            copyMessage: async () => ({ ok: true, data: { message_id: 1 } })
        },
        broadcastTopicChatId: '-100',
        broadcastTopicThreadId: 2,
        adminIds: ['99'],
        topicTestModeEnabled: false,
        topicTestTelegramIds: [],
        getTransportPreflightContext:
            over.getTransportPreflightContext ||
            (() => ({
                outboundEnabled: true,
                httpClientPresent: true,
                proxyConfigured: false,
                transportMode: 'test'
            })),
        broadcastsEnabled: true,
        ...over
    });
}

async function run(name, fn) {
    try {
        await fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

function dbRun(sql, params = []) {
    const db = require('../db');
    return new Promise((res, rej) => {
        db.run(sql, params, function onRun(err) {
            if (err) return rej(err);
            res({ lastID: this.lastID });
        });
    });
}

(async () => {
    await waitForDbMigrationsReady();

    await run('preflight blocked persists TRANSPORT_PREFLIGHT_FAILED', async () => {
        const svc = makeService({
            getTransportPreflightContext: () => ({
                outboundEnabled: false,
                httpClientPresent: true,
                proxyConfigured: false,
                transportMode: 'test'
            })
        });
        const r = await svc.startCampaignFromTopicMessage(baseMsg({ message_id: 201 }));
        assert.strictEqual(r.ok, false);
        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(ops.lastPersistedTriggerOutcome.resultCode, BROADCAST_TRIGGER_RESULT_CODES.TRANSPORT_PREFLIGHT_FAILED);
        assert.ok(ops.lastPersistedTriggerOutcome.transportPreflightReason);
    });

    await run('duplicate trigger persists DUPLICATE_TRIGGER', async () => {
        await dbRun(
            `
            INSERT INTO broadcast_campaigns (
                source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id,
                status, topic_test_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'RUNNING', 0, datetime('now'), datetime('now'))
        `,
            ['-100', 202, 2, '99']
        );
        const svc = makeService();
        const r = await svc.startCampaignFromTopicMessage(baseMsg({ message_id: 202 }));
        assert.strictEqual(r.duplicate, true);
        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(ops.lastPersistedTriggerOutcome.resultCode, BROADCAST_TRIGGER_RESULT_CODES.DUPLICATE_TRIGGER);
        assert.ok(ops.lastPersistedTriggerOutcome.campaignId > 0);
    });

    await run('successful schedule persists OK_JOB_SCHEDULED', async () => {
        const svc = makeService();
        const r = await svc.startCampaignFromTopicMessage(baseMsg({ message_id: 203 }));
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.scheduledAsync, true);
        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(ops.lastPersistedTriggerOutcome.resultCode, BROADCAST_TRIGGER_RESULT_CODES.OK_JOB_SCHEDULED);
        // Production: recipients load in background job — audit has no estimate at trigger time.
        assert.strictEqual(ops.lastPersistedTriggerOutcome.audienceEstimate, null);
        assert.ok(ops.recentTriggerOutcomeCount >= 1);
    });

    await run('createCampaign insert failure persists CAMPAIGN_CREATE_FAILED', async () => {
        const svc = makeService({ debugForceCampaignInsertError: true });
        const r = await svc.startCampaignFromTopicMessage(baseMsg({ message_id: 204 }));
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'CAMPAIGN_CREATE_FAILED');
        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(ops.lastPersistedTriggerOutcome.resultCode, BROADCAST_TRIGGER_RESULT_CODES.CAMPAIGN_CREATE_FAILED);
    });

    await run('campaign lifecycle events in broadcastOps and broadcastLastRun', async () => {
        const svc = makeService();
        const r = await svc.startCampaignFromTopicMessage(baseMsg({ message_id: 305 }));
        assert.strictEqual(r.ok, true);
        assert.ok(r.campaignId);
        const wantId = r.campaignId;
        const deadline = Date.now() + 15000;
        let ops;
        let lastRun;
        while (Date.now() < deadline) {
            ops = await svc.getBroadcastOpsDiagnostics();
            lastRun = await svc.getBroadcastLastRunDiagnostics();
            const codesForCampaign = (ops.recentCampaignEvents || [])
                .filter((e) => e.campaignId === wantId)
                .map((e) => e.eventCode);
            const doneForCampaign =
                codesForCampaign.includes('CAMPAIGN_DONE') || codesForCampaign.includes('CAMPAIGN_DONE_INCOMPLETE');
            if (
                doneForCampaign &&
                lastRun &&
                lastRun.campaignId === wantId &&
                lastRun.lastPersistedLifecycleEventCode
            ) {
                break;
            }
            await new Promise((res) => setTimeout(res, 80));
        }
        assert.ok(ops.campaignLifecycleEventCount >= 1);
        assert.ok(ops.lastPersistedCampaignEvent && ops.lastPersistedCampaignEvent.eventCode);
        const codesForCampaign = (ops.recentCampaignEvents || [])
            .filter((e) => e.campaignId === wantId)
            .map((e) => e.eventCode);
        assert.ok(codesForCampaign.includes('CAMPAIGN_CREATED'), `expected CAMPAIGN_CREATED for campaign ${wantId}`);
        assert.ok(lastRun);
        assert.strictEqual(lastRun.campaignId, wantId);
        assert.ok(lastRun.lastPersistedLifecycleEventCode);
        assert.ok(lastRun.lastPersistedLifecycleEventAt);
    });

    await run('fetchBroadcastTriggerAuditDiagnostics matches getBroadcastOpsDiagnostics', async () => {
        const dbMod = require('../db');
        const get = (sql, params = []) =>
            new Promise((res, rej) => {
                dbMod.get(sql, params, (err, row) => (err ? rej(err) : res(row)));
            });
        const all = (sql, params = []) =>
            new Promise((res, rej) => {
                dbMod.all(sql, params, (err, rows) => (err ? rej(err) : res(rows || [])));
            });
        const d = await fetchBroadcastTriggerAuditDiagnostics({ get, all }, { recentLimit: 5 });
        const svc = makeService();
        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(
            d.lastPersistedTriggerOutcome && d.lastPersistedTriggerOutcome.resultCode,
            ops.lastPersistedTriggerOutcome && ops.lastPersistedTriggerOutcome.resultCode
        );
        assert.strictEqual(d.recentTriggerOutcomeCount, ops.recentTriggerOutcomeCount);
    });

    try {
        fs.unlinkSync(tmp);
    } catch (_) {
        /* ok */
    }
    process.exit(typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 0);
})();
