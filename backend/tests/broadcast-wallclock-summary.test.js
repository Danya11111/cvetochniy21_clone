'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = path.join(os.tmpdir(), `f21-wallclock-${Date.now()}.sqlite`);
try {
    fs.unlinkSync(tmp);
} catch (_) {
    /* ok */
}
process.env.F21_SQLITE_PATH = tmp;

const {
    createBroadcastService,
    BROADCAST_CAMPAIGN_EVENT_CODES,
    BROADCAST_CAMPAIGN_MAX_WALL_MS,
    isCampaignPastWallClockDeadline
} = require('../broadcast-service');

function waitForDb() {
    const db = require('../db');
    return db.awaitMigrations;
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
    await waitForDb();

    await run('isCampaignPastWallClockDeadline respects 4h', async () => {
        const old = new Date(Date.now() - BROADCAST_CAMPAIGN_MAX_WALL_MS - 60_000).toISOString();
        assert.strictEqual(isCampaignPastWallClockDeadline({ created_at: old }), true);
        const young = new Date(Date.now() - 60_000).toISOString();
        assert.strictEqual(isCampaignPastWallClockDeadline({ created_at: young }), false);
    });

    await run('enforceCampaignWallClockTimeouts sets ABORTED_TIMEOUT and sends one terminal event', async () => {
        const svc = createBroadcastService({
            telegramClient: {
                sendMessage: async () => ({ ok: true, data: { message_id: 999 } })
            },
            broadcastTopicChatId: '-100',
            broadcastTopicThreadId: 2,
            adminIds: ['1'],
            topicTestModeEnabled: false,
            topicTestTelegramIds: [],
            getTransportPreflightContext: () => ({
                outboundEnabled: true,
                httpClientPresent: true,
                proxyConfigured: false,
                transportMode: 'test'
            }),
            broadcastsEnabled: true,
            logger: console
        });
        const oldIso = new Date(Date.now() - BROADCAST_CAMPAIGN_MAX_WALL_MS - 120_000).toISOString();
        await dbRun(
            `
            INSERT INTO broadcast_campaigns (
                source_chat_id, source_message_id, source_thread_id, initiated_by_telegram_id,
                status, topic_test_mode, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'RUNNING', 0, ?, ?)
        `,
            ['-100', 1, 2, '99', oldIso, oldIso]
        );
        await dbRun(
            `
            INSERT INTO broadcast_deliveries (campaign_id, recipient_telegram_id, status, created_at, updated_at)
            VALUES (1, '111', 'PENDING', datetime('now'), datetime('now'))
        `
        );
        const r = await svc.enforceCampaignWallClockTimeouts('test');
        assert.ok(r.count >= 1);
        const camp = await dbGet(`SELECT status, broadcast_terminal_notice_kind FROM broadcast_campaigns WHERE id = 1`);
        assert.strictEqual(String(camp.status).toUpperCase(), 'ABORTED_TIMEOUT');
        assert.strictEqual(camp.broadcast_terminal_notice_kind, 'ABORTED_TIMEOUT');
        const ev = await dbAll(
            `SELECT event_code FROM broadcast_campaign_events WHERE campaign_id = 1 ORDER BY id DESC`
        );
        assert.ok(ev.some((e) => e.event_code === BROADCAST_CAMPAIGN_EVENT_CODES.CAMPAIGN_ABORTED_TIMEOUT));
    });

    await run('second enforce does not duplicate timeout processing', async () => {
        const svc = createBroadcastService({
            telegramClient: {
                sendMessage: async () => ({ ok: true, data: { message_id: 1001 } })
            },
            broadcastTopicChatId: '-100',
            broadcastTopicThreadId: 2,
            adminIds: ['1'],
            topicTestModeEnabled: false,
            topicTestTelegramIds: [],
            getTransportPreflightContext: () => ({
                outboundEnabled: true,
                httpClientPresent: true,
                proxyConfigured: false,
                transportMode: 'test'
            }),
            broadcastsEnabled: true,
            logger: console
        });
        const n1 = (await dbAll(`SELECT id FROM broadcast_campaign_events WHERE campaign_id = 1`)).length;
        const r = await svc.enforceCampaignWallClockTimeouts('test_repeat');
        assert.strictEqual(r.count, 0);
        const n2 = (await dbAll(`SELECT id FROM broadcast_campaign_events WHERE campaign_id = 1`)).length;
        assert.strictEqual(n2, n1);
    });

    try {
        fs.unlinkSync(tmp);
    } catch (_) {
        /* ok */
    }
    process.exit(typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 0);
})();
