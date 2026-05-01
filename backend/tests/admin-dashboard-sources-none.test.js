'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { sqlOrderPaidRevenueKopecks } = require('../money');
const { mergeDashboardSourcesForApi, DASHBOARD_SYSTEM_NONE_CODE } = require('../admin-dashboard-service');

const PAID_SQL_O = `(COALESCE(o.total_paid,0) > 0 OR UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED'))`;

function openMemDb() {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(database)));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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
            status TEXT,
            total INTEGER DEFAULT 0,
            total_paid INTEGER DEFAULT 0,
            items_json TEXT DEFAULT '[]',
            source_code TEXT
        )`
    );
    await dbRun(
        db,
        `CREATE TABLE promotion_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT,
            title TEXT,
            is_active INTEGER DEFAULT 1
        )`
    );
    await dbRun(
        db,
        `CREATE TABLE promotion_source_clicks (
            source_code TEXT,
            clicked_at TEXT
        )`
    );
    await dbRun(db, `INSERT INTO promotion_sources (code, title) VALUES ('tg_bot', 'Телеграмм бот')`);

    const t0 = '2026-05-01T10:00:00.000Z';
    const t1 = '2026-05-02T12:00:00.000Z';
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at, source_code, status, total_paid) VALUES ('1', ?, NULL, 'PENDING_PAYMENT', 0)`, [t0]);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at, source_code, status, total_paid) VALUES ('2', ?, '', 'PENDING_PAYMENT', 0)`, [t0]);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at, source_code, status, total_paid) VALUES ('3', ?, 'tg_bot', 'PENDING_PAYMENT', 0)`, [t0]);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at, source_code, status, total_paid) VALUES ('4', ?, 'tg_bot', 'PAID', 10000)`, [t0]);
    await dbRun(db, `INSERT INTO orders (telegram_id, created_at, source_code, status, total_paid) VALUES ('5', ?, NULL, 'PENDING_PAYMENT', 0)`, [t1]);

    const revExpr = sqlOrderPaidRevenueKopecks('o');
    const none = DASHBOARD_SYSTEM_NONE_CODE;
    const sql = `
            SELECT
                CASE
                    WHEN o.source_code IS NULL OR TRIM(COALESCE(o.source_code, '')) = ''
                    THEN '${none}'
                    ELSE TRIM(o.source_code)
                END AS code,
                COUNT(*) AS orders_count,
                SUM(CASE WHEN (${PAID_SQL_O}) THEN 1 ELSE 0 END) AS paid_orders_count,
                COALESCE(SUM(CASE WHEN (${PAID_SQL_O}) THEN (${revExpr}) ELSE 0 END), 0) AS revenue_kopecks
            FROM orders o
            WHERE o.created_at >= ? AND o.created_at <= ?
            GROUP BY CASE
                WHEN o.source_code IS NULL OR TRIM(COALESCE(o.source_code, '')) = ''
                THEN '${none}'
                ELSE TRIM(o.source_code)
            END
        `;

    const start = '2026-05-01T00:00:00.000Z';
    const end = '2026-05-01T23:59:59.999Z';
    const orderRows = await dbAll(db, sql, [start, end]);
    assert.ok(
        orderRows.some((r) => String(r.code) === none && Number(r.orders_count) === 2),
        '__none__: два заказа NULL/пустой source в периоде'
    );

    await dbRun(db, `INSERT INTO promotion_source_clicks (source_code, clicked_at) VALUES ('tg_bot', ?), ('tg_bot', ?)`, [t0, t0]);

    const clicks = await dbAll(
        db,
        `
            SELECT TRIM(source_code) AS code, COUNT(*) AS clicks
            FROM promotion_source_clicks
            WHERE clicked_at >= ? AND clicked_at <= ?
            GROUP BY TRIM(source_code)
        `,
        [start, end]
    );
    const titles = await dbAll(db, `SELECT code, title FROM promotion_sources WHERE COALESCE(is_active, 1) = 1`, []);
    const merged = mergeDashboardSourcesForApi(clicks, orderRows, titles);
    assert.ok(merged.some((x) => x.code === none && x.isSystem === true), 'merge: строка «Без источника»');
    const noneRow = merged.find((x) => x.code === none);
    assert.strictEqual(noneRow.ordersCount, 2);
    assert.strictEqual(noneRow.clicks, 0);
    assert.ok(
        merged.some((x) => x.code === 'tg_bot' && x.clicks === 2 && x.ordersCount === 2),
        'источник с переходами и заказами'
    );

    db.close();
    process.stdout.write('PASS admin-dashboard sources __none__ SQL\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-dashboard sources __none__: ${e.message}\n`);
    process.exit(1);
});
