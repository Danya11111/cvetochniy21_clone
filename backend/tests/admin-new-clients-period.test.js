'use strict';

/**
 * Новый клиент = пользователь с first_seen_at в периоде (users), не первый заказ.
 */

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const {
    getSqlNewUsersInPeriodSubquery,
    getCustomDashboardPeriodRange,
    getAllTimeDashboardPeriodRange
} = require('../admin-dashboard-service');

function openMemDb() {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(database)));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function RunCb(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function countNewUsers(db, range) {
    const sub = getSqlNewUsersInPeriodSubquery();
    const row = await dbGet(db, `SELECT COUNT(*) AS c FROM (${sub}) nc`, [range.periodStartIso, range.periodEndIso]);
    return Number(row.c);
}

async function listNewTelegramIds(db, range) {
    const sub = getSqlNewUsersInPeriodSubquery();
    const rows = await new Promise((resolve, reject) => {
        db.all(
            `SELECT telegram_id FROM (${sub}) nc ORDER BY telegram_id`,
            [range.periodStartIso, range.periodEndIso],
            (err, r) => (err ? reject(err) : resolve(r || []))
        );
    });
    return rows.map((r) => String(r.telegram_id));
}

(async () => {
    const db = await openMemDb();
    await dbRun(
        db,
        `CREATE TABLE users (
            telegram_id TEXT PRIMARY KEY,
            first_seen_at TEXT,
            first_name TEXT,
            first_source_code TEXT,
            last_source_code TEXT
        )`
    );
    await dbRun(
        db,
        `CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT,
            created_at TEXT,
            total_paid INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            source_code TEXT
        )`
    );

    const p30start = '2026-04-30T00:00:00.000Z';
    const p30end = '2026-04-30T23:59:59.999Z';

    // A: first_seen в периоде, заказов нет → новый клиент
    await dbRun(db, `INSERT INTO users (telegram_id, first_seen_at) VALUES ('A', '2026-04-30T12:00:00.000Z')`);
    // B: first_seen до периода, заказ в периоде → не новый клиент по users
    await dbRun(db, `INSERT INTO users (telegram_id, first_seen_at) VALUES ('B', '2026-04-20T10:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('B', '2026-04-30T10:00:00.000Z')`);
    // C: first_seen в другом дне периода мая
    await dbRun(db, `INSERT INTO users (telegram_id, first_seen_at) VALUES ('C', '2026-05-01T10:00:00.000Z')`);

    const r4030 = getCustomDashboardPeriodRange('2026-04-30', '2026-04-30');
    assert.strictEqual(await countNewUsers(db, r4030), 1, 'только A');
    assert.deepStrictEqual(await listNewTelegramIds(db, r4030), ['A']);

    const sub = getSqlNewUsersInPeriodSubquery();
    const newWoRow = await dbGet(
        db,
        `
        SELECT COUNT(*) AS c
        FROM (${sub}) nu
        WHERE NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(nu.telegram_id AS TEXT))
        )
        `,
        [r4030.periodStartIso, r4030.periodEndIso]
    );
    assert.strictEqual(Number(newWoRow.c), 1, 'новый клиент без заказов (A) входит в период');

    const rMay1 = getCustomDashboardPeriodRange('2026-05-01', '2026-05-01');
    assert.strictEqual(await countNewUsers(db, rMay1), 1, 'только C');
    assert.deepStrictEqual(await listNewTelegramIds(db, rMay1), ['C']);

    await dbRun(db, `INSERT INTO users (telegram_id, first_seen_at) VALUES ('D', '2026-04-30T15:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('D', '2026-04-30T16:00:00.000Z')`);
    assert.strictEqual(await countNewUsers(db, r4030), 2, 'A и D по first_seen в периоде');

    const rall = getAllTimeDashboardPeriodRange(new Date('2026-06-01T12:00:00.000Z'));
    const allIds = await listNewTelegramIds(db, rall);
    assert.ok(allIds.includes('A') && allIds.includes('B') && allIds.includes('C') && allIds.includes('D'), 'все пользователи с датой');

    db.close();
    process.stdout.write('PASS admin-new-clients period (users first_seen_at)\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-new-clients period: ${e.message}\n`);
    process.exit(1);
});
