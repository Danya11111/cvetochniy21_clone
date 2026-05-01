'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const {
    getSqlNewClientsFirstOrderInRangeSubquery,
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

async function countNew(db, range) {
    const sub = getSqlNewClientsFirstOrderInRangeSubquery();
    const row = await dbGet(db, `SELECT COUNT(*) AS c FROM (${sub}) nc`, [range.periodStartIso, range.periodEndIso]);
    return Number(row.c);
}

async function listNewIds(db, range) {
    const sub = getSqlNewClientsFirstOrderInRangeSubquery();
    const rows = await new Promise((resolve, reject) => {
        db.all(`SELECT telegram_id FROM (${sub}) nc ORDER BY telegram_id`, [range.periodStartIso, range.periodEndIso], (err, r) =>
            err ? reject(err) : resolve(r || [])
        );
    });
    return rows.map((r) => String(r.telegram_id));
}

(async () => {
    const db = await openMemDb();
    await dbRun(
        db,
        `CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id TEXT,
            created_at TEXT,
            total_paid INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            items_json TEXT DEFAULT '[]',
            source_code TEXT
        )`
    );

    const sub = getSqlNewClientsFirstOrderInRangeSubquery();
    const cntSql = `SELECT COUNT(*) AS c FROM (${sub}) nc`;

    const p30start = '2026-04-30T00:00:00.000Z';
    const p30end = '2026-04-30T23:59:59.999Z';

    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('A', '2026-04-30T12:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('B', '2026-04-20T10:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('B', '2026-04-30T10:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('C', '2026-05-01T10:00:00.000Z')`);

    const r1 = await dbGet(db, cntSql, [p30start, p30end]);
    assert.strictEqual(Number(r1.c), 1, '30.04 UTC window: только первый заказ A внутри окна');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('spacefmt', '2026-05-01 15:00:00')`);
    const r2 = await dbGet(db, cntSql, ['2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z']);
    assert.strictEqual(Number(r2.c), 1, 'формат с пробелом — julianday в MIN');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('123', '2026-06-01T10:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES (123, '2026-06-02T10:00:00.000Z')`);
    const r3 = await dbGet(db, cntSql, ['2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z']);
    assert.strictEqual(Number(r3.c), 1, 'INTEGER и TEXT telegram_id — один клиент, первый заказ в периоде');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('mix', '2026-04-30T12:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('mix', '2026-04-30 10:15:00')`);
    const rMix = await dbGet(db, cntSql, [p30start, p30end]);
    assert.strictEqual(Number(rMix.c), 1, 'MIN по julianday, не лексикографический MIN(created_at)');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('A', '2026-04-30 10:15:00')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('B', '2026-04-20T12:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('B', '2026-04-30T13:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('C', '2026-05-01 15:00:00')`);
    await dbRun(db, `CREATE TABLE users (telegram_id TEXT PRIMARY KEY)`);
    await dbRun(db, `INSERT INTO users (telegram_id) VALUES ('D')`);

    const r4030 = getCustomDashboardPeriodRange('2026-04-30', '2026-04-30');
    assert.strictEqual(await countNew(db, r4030), 1);
    assert.deepStrictEqual(await listNewIds(db, r4030), ['A']);

    const r2030 = getCustomDashboardPeriodRange('2026-04-20', '2026-04-30');
    assert.strictEqual(await countNew(db, r2030), 2);
    assert.deepStrictEqual(await listNewIds(db, r2030), ['A', 'B']);

    const rall = getAllTimeDashboardPeriodRange(new Date('2026-06-01T12:00:00.000Z'));
    assert.strictEqual(await countNew(db, rall), 3);
    assert.deepStrictEqual(await listNewIds(db, rall), ['A', 'B', 'C']);

    const rMay1 = getCustomDashboardPeriodRange('2026-05-01', '2026-05-01');
    assert.strictEqual(await countNew(db, rMay1), 1);
    assert.deepStrictEqual(await listNewIds(db, rMay1), ['C']);

    db.close();
    process.stdout.write('PASS admin-new-clients period\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-new-clients period: ${e.message}\n`);
    process.exit(1);
});
