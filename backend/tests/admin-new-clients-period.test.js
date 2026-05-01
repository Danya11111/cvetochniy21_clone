'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const {
    getSqlNewClientsFirstOrderInRangeSubquery
} = require('../admin-dashboard-service');

function openMemDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
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
            items_json TEXT DEFAULT '[]'
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
    assert.strictEqual(Number(r1.c), 1, 'только A: первый заказ в выбранный календарный день (UTC bounds)');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('spacefmt', '2026-05-01 15:00:00')`);
    const r2 = await dbGet(db, cntSql, ['2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z']);
    assert.strictEqual(Number(r2.c), 1, 'формат с пробелом учитывается через julianday');

    await dbRun(db, 'DELETE FROM orders');
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES ('123', '2026-06-01T10:00:00.000Z')`);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at) VALUES (123, '2026-06-02T10:00:00.000Z')`);
    const r3 = await dbGet(db, cntSql, ['2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z']);
    assert.strictEqual(Number(r3.c), 1, 'INTEGER и TEXT telegram_id сливаются в одного клиента');

    db.close();
    process.stdout.write('PASS admin-new-clients period\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-new-clients period: ${e.message}\n`);
    process.exit(1);
});
