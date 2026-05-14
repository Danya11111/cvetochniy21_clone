'use strict';

/**
 * Интеграция: transport fail-closed gate + SQLite + delivery job (отдельный temp DB).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `f21-transport-gate-${Date.now()}.sqlite`);
try {
    fs.unlinkSync(tmp);
} catch (_) {
    /* ok */
}
process.env.F21_SQLITE_PATH = tmp;

const { createBroadcastService, BROADCAST_CAMPAIGN_EVENT_CODES } = require('../broadcast-service');
const {
    resetTelegramTransportHealthRuntimeForTests,
    recordTransportProbeResult
} = require('../telegram-transport-health');

function waitForDbMigrationsReady() {
    const db = require('../db');
    return db.awaitMigrations.then(
        () =>
            new Promise((resolve, reject) => {
                const deadline = Date.now() + 12000;
                function tick() {
                    db.all('PRAGMA table_info(broadcast_campaign_events)', (err3, colsEv) => {
                        if (err3) return reject(err3);
                        const okEv = (colsEv || []).some((c) => c.name === 'event_code');
                        if (okEv) return resolve();
                        if (Date.now() > deadline) {
                            return reject(new Error('migration timeout: broadcast_campaign_events'));
                        }
                        setTimeout(tick, 40);
                    });
                }
                tick();
            })
    );
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

function dbRun(sql, params = []) {
    const db = require('../db');
    return new Promise((res, rej) => {
        db.run(sql, params, function onRun(err) {
            if (err) return rej(err);
            res({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    const db = require('../db');
    return new Promise((res, rej) => {
        db.get(sql, params, (err, row) => (err ? rej(err) : res(row)));
    });
}

function dbAll(sql, params = []) {
    const db = require('../db');
    return new Promise((res, rej) => {
        db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows || [])));
    });
}

/**
 * Дождаться завершения delivery job после transport gate / summary.
 * Нельзя полагаться только на «сначала увидели worker running, потом idle»:
 * на быстрых CI runner job может полностью проскочить между poll (15–20 ms), и sawRunning останется false.
 * Устойчивые маркеры: CAMPAIGN_DONE_INCOMPLETE (await в sendSummary) и lastRun с PAUSED_BY_TRANSPORT_GATE.
 */
async function waitForDeliveryIdle(svc, campaignId, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    while (Date.now() < deadline) {
        const w = svc.getWorkerSnapshot();
        if (w.running && Number(w.campaignId) === Number(campaignId)) {
            sawRunning = true;
        }
        if (!w.running) {
            const doneIncomplete = await dbGet(
                `SELECT 1 AS ok FROM broadcast_campaign_events WHERE campaign_id = ? AND event_code = ? LIMIT 1`,
                [campaignId, BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_DONE_INCOMPLETE]
            );
            if (doneIncomplete) {
                return;
            }
            let last = null;
            try {
                last = await svc.getBroadcastLastRunDiagnostics();
            } catch (_) {
                last = null;
            }
            if (
                last &&
                Number(last.campaignId) === Number(campaignId) &&
                last.jobRan &&
                last.jobHadTransportGateHalt &&
                last.outcomeInterpretation &&
                last.outcomeInterpretation.primary === 'PAUSED_BY_TRANSPORT_GATE'
            ) {
                return;
            }
            if (sawRunning) {
                return;
            }
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting for delivery job');
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

(async () => {
    await waitForDbMigrationsReady();

    await run('blocked transport halts worker before retry storm (pre_wave gate)', async () => {
        resetTelegramTransportHealthRuntimeForTests();
        recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });

        const svc = makeService();
        const rIns = await dbRun(
            `
            INSERT INTO broadcast_campaigns (
                source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id,
                status, topic_test_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'RUNNING', 0, datetime('now'), datetime('now'))
        `,
            ['-100', 501, 2, '99']
        );
        const campaignId = rIns.lastID;
        const n = 120;
        for (let i = 0; i < n; i += 1) {
            await dbRun(
                `
                INSERT INTO broadcast_deliveries (
                    campaign_id, recipient_telegram_id, status, created_at, updated_at
                ) VALUES (?, ?, 'PENDING', datetime('now'), datetime('now'))
            `,
                [campaignId, String(10000 + i)]
            );
        }

        const beforePending = await dbGet(
            `SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ? AND status = 'PENDING'`,
            [campaignId]
        );
        assert.strictEqual(Number(beforePending.c), n);

        svc.scheduleCampaignDeliveryJob({
            campaignId,
            sourceChatId: '-100',
            sourceMessageId: 501,
            recipients: [],
            mode: { resumeFromDb: true, recoveryRun: false, isTopicTestMode: false }
        });

        await waitForDeliveryIdle(svc, campaignId);

        const camp = await dbGet(`SELECT status, completed_at FROM broadcast_campaigns WHERE id = ?`, [campaignId]);
        assert.strictEqual(String(camp.status).toUpperCase(), 'PAUSED_TRANSPORT');
        assert.ok(!camp.completed_at);

        const afterPending = await dbGet(
            `SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ? AND status = 'PENDING'`,
            [campaignId]
        );
        const retryWait = await dbGet(
            `SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ? AND status = 'RETRY_WAIT'`,
            [campaignId]
        );
        assert.ok(Number(afterPending.c) >= n * 0.85, 'most rows should stay PENDING');
        assert.ok(Number(retryWait.c) < 15, 'no mass RETRY_WAIT churn');

        const ev = await dbAll(
            `SELECT event_code, details_json FROM broadcast_campaign_events WHERE campaign_id = ? ORDER BY id DESC`,
            [campaignId]
        );
        const gateEv = ev.find((e) => e.event_code === BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_HALTED_DELIVERY);
        assert.ok(gateEv, 'TRANSPORT_GATE_HALTED_DELIVERY persisted');
        const det = JSON.parse(String(gateEv.details_json || '{}'));
        assert.strictEqual(det.phase, 'pre_delivery');
        assert.ok(det.reasonCode);
        assert.ok(det.decisionSource === 'probe' || det.decisionSource === 'preflight');
        assert.ok(det.transportSnapshot && typeof det.transportSnapshot.probeState === 'string');

        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.ok(ops.transportGateEventCount >= 1);
        assert.ok(ops.deliveryTransportGateHaltCount >= 1);
        assert.ok(ops.lastPersistedTransportGateEvent);
        assert.ok(ops.lastTransportGateReasonCode);

        const lastRun = await svc.getBroadcastLastRunDiagnostics();
        assert.ok(lastRun && lastRun.jobHadTransportGateHalt);
        assert.strictEqual(lastRun.outcomeInterpretation.primary, 'PAUSED_BY_TRANSPORT_GATE');
    });

    await run('resumeFromDb does not duplicate delivery rows when halted by transport gate', async () => {
        resetTelegramTransportHealthRuntimeForTests();
        recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });

        const svc = makeService();
        const rIns = await dbRun(
            `
            INSERT INTO broadcast_campaigns (
                source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id,
                status, topic_test_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'RUNNING', 0, datetime('now'), datetime('now'))
        `,
            ['-100', 502, 2, '99']
        );
        const campaignId = rIns.lastID;
        const initial = 8;
        for (let i = 0; i < initial; i += 1) {
            await dbRun(
                `
                INSERT INTO broadcast_deliveries (
                    campaign_id, recipient_telegram_id, status, created_at, updated_at
                ) VALUES (?, ?, 'PENDING', datetime('now'), datetime('now'))
            `,
                [campaignId, String(20000 + i)]
            );
        }
        const rowsBefore = await dbGet(`SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`, [
            campaignId
        ]);
        assert.strictEqual(Number(rowsBefore.c), initial);

        svc.scheduleCampaignDeliveryJob({
            campaignId,
            sourceChatId: '-100',
            sourceMessageId: 502,
            recipients: [],
            mode: { resumeFromDb: true, recoveryRun: false, isTopicTestMode: false }
        });
        await waitForDeliveryIdle(svc, campaignId);

        const rowsAfter = await dbGet(`SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE campaign_id = ?`, [
            campaignId
        ]);
        assert.strictEqual(Number(rowsAfter.c), initial);
    });

    await run('startup recovery pauses multiple RUNNING campaigns without scheduling jobs (transport gate)', async () => {
        resetTelegramTransportHealthRuntimeForTests();
        recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });

        await dbRun(`DELETE FROM broadcast_campaign_events`);
        await dbRun(`DELETE FROM broadcast_deliveries`);
        await dbRun(`DELETE FROM broadcast_campaigns`);

        const svc = makeService();
        const ids = [];
        for (let k = 0; k < 4; k += 1) {
            const rIns = await dbRun(
                `
                INSERT INTO broadcast_campaigns (
                    source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id,
                    status, topic_test_mode, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'RUNNING', 0, datetime('now'), datetime('now'))
            `,
                ['-100', 600 + k, 2, '99']
            );
            const cid = rIns.lastID;
            ids.push(cid);
            await dbRun(
                `
                INSERT INTO broadcast_deliveries (
                    campaign_id, recipient_telegram_id, status, created_at, updated_at
                ) VALUES (?, ?, 'PENDING', datetime('now'), datetime('now'))
            `,
                [cid, String(30000 + k)]
            );
        }

        const snap = await svc.runStartupBroadcastRecovery();
        assert.strictEqual(snap.startupTransportGateSkips, 4);
        assert.ok(Array.isArray(snap.outcomes));
        assert.strictEqual(snap.outcomes.filter((o) => o.action === 'skipped_transport_gate').length, 4);

        const life = await svc.getBroadcastLifecycleDiagnostics();
        assert.strictEqual(life.activeCampaignDeliveryJobs, 0);

        for (const cid of ids) {
            const row = await dbGet(`SELECT status FROM broadcast_campaigns WHERE id = ?`, [cid]);
            assert.strictEqual(String(row.status).toUpperCase(), 'PAUSED_TRANSPORT');
        }

        const skipCount = await dbGet(
            `SELECT COUNT(*) AS c FROM broadcast_campaign_events WHERE event_code = ?`,
            [BROADCAST_CAMPAIGN_EVENT_CODES.TRANSPORT_GATE_STARTUP_RECOVERY_SKIP]
        );
        assert.strictEqual(Number(skipCount.c), 4);

        const ops = await svc.getBroadcastOpsDiagnostics();
        assert.strictEqual(ops.startupRecoveryTransportGateSkipCount, 4);
        assert.ok(ops.lastPersistedTransportGateEvent);
        const d = ops.lastPersistedTransportGateEvent.details || {};
        assert.strictEqual(d.phase, 'startup_recovery');
        assert.ok(d.recoveryAction);
    });

    try {
        fs.unlinkSync(tmp);
    } catch (_) {
        /* ok */
    }
    process.exit(typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 0);
})();
