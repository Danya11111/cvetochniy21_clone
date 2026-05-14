'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { createAbandonedCartService, fetchAbandonedCartDashboardSnapshot } = require('../abandoned-cart-service');

const CART_KEY = 'f2111111-1111-4111-8111-111111111111';

function runSql(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function getRow(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function createSchema(db) {
    await runSql(
        db,
        `CREATE TABLE abandoned_carts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cart_key TEXT UNIQUE NOT NULL,
            tg_user_id TEXT NULL,
            customer_name TEXT NULL,
            customer_phone TEXT NULL,
            customer_address TEXT NULL,
            items_json TEXT NOT NULL DEFAULT '[]',
            total_amount INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'RUB',
            status TEXT NOT NULL DEFAULT 'active',
            order_id INTEGER NULL,
            source TEXT NULL,
            user_agent TEXT NULL,
            last_seen_at TEXT NOT NULL,
            checkout_started_at TEXT NULL,
            recovered_at TEXT NULL,
            cleared_at TEXT NULL,
            first_notified_at TEXT NULL,
            last_notified_at TEXT NULL,
            notification_count INTEGER DEFAULT 0,
            next_notification_at TEXT NULL,
            last_error TEXT NULL,
            metadata_json TEXT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`
    );
}

function makeService(db, overrides = {}) {
    const cfg = {
        ABANDONED_CARTS_ENABLED: true,
        ABANDONED_CART_AFTER_MINUTES: 1,
        ABANDONED_CART_NOTIFY_AFTER_MINUTES: 0,
        ABANDONED_CART_REPEAT_NOTIFY_HOURS: 24,
        ABANDONED_CART_MAX_NOTIFICATIONS: 2,
        ABANDONED_CART_EXPIRE_DAYS: 30,
        TELEGRAM_FORUM_GROUP_ID: '-1001',
        TELEGRAM_TOPIC_ABANDONED_CARTS_ID: 9,
        ...overrides
    };
    const telegramClient = {
        async sendMessage() {
            return { ok: true, data: { message_id: 1 } };
        }
    };
    return createAbandonedCartService({ db, config: cfg, telegramClient, logger: console });
}

(async function main() {
    const db = new sqlite3.Database(':memory:');
    try {
        await createSchema(db);
        const svc = makeService(db);

        await svc.sync({ cart_key: CART_KEY, items: [{ name: 'Роза', quantity: 1, price: 100 }], total_kopecks: 10000 });
        let row = await getRow(db, `SELECT * FROM abandoned_carts WHERE cart_key = ?`, [CART_KEY]);
        assert.ok(row);
        assert.strictEqual(row.status, 'active');
        assert.ok(Number(row.total_amount) > 0);

        await svc.sync({ cart_key: CART_KEY, items: [{ name: 'Роза', quantity: 2, price: 100 }], total_kopecks: 20000 });
        row = await getRow(db, `SELECT notification_count FROM abandoned_carts WHERE cart_key = ?`, [CART_KEY]);
        assert.strictEqual(Number(row.notification_count || 0), 0);

        await svc.sync({ cart_key: CART_KEY, items: [], total_kopecks: 0 });
        row = await getRow(db, `SELECT status FROM abandoned_carts WHERE cart_key = ?`, [CART_KEY]);
        assert.strictEqual(row.status, 'cleared');

        await svc.sync({
            cart_key: CART_KEY,
            items: [{ name: 'Тюльпан', quantity: 1, price: 50 }],
            total_kopecks: 5000
        });
        await svc.checkoutStarted({
            cart_key: CART_KEY,
            customer_name: 'Иван',
            customer_phone: '+79990001122',
            customer_address: 'Чебоксары'
        });
        row = await getRow(
            db,
            `SELECT status, customer_name, customer_phone, customer_address FROM abandoned_carts WHERE cart_key = ?`,
            [CART_KEY]
        );
        assert.strictEqual(row.status, 'checkout_started');
        assert.strictEqual(row.customer_name, 'Иван');

        await svc.markRecovered({ cart_key: CART_KEY, order_id: 42 });
        row = await getRow(db, `SELECT status, order_id FROM abandoned_carts WHERE cart_key = ?`, [CART_KEY]);
        assert.strictEqual(row.status, 'recovered');
        assert.strictEqual(Number(row.order_id), 42);

        const snap = await fetchAbandonedCartDashboardSnapshot(db);
        assert.ok(snap && typeof snap.recovered === 'number');

        const db2 = new sqlite3.Database(':memory:');
        await createSchema(db2);
        const svcIdle = makeService(db2);
        await svcIdle.sync({
            cart_key: 'c3011111-1111-4111-8111-111111111111',
            items: [{ name: 'A', quantity: 1, price: 10 }],
            total_kopecks: 1000
        });
        await runSql(db2, `UPDATE abandoned_carts SET last_seen_at = ? WHERE cart_key = ?`, [
            new Date(Date.now() - 120_000).toISOString(),
            'c3011111-1111-4111-8111-111111111111'
        ]);
        const scan1 = await svcIdle.scanAndProcess(new Date());
        assert.ok(scan1.abandonedN >= 1);

        /** Не отправлять уведомления для финальных статусов */
        const db3 = new sqlite3.Database(':memory:');
        await createSchema(db3);
        const svcLim = makeService(db3, { ABANDONED_CART_MAX_NOTIFICATIONS: 0 });
        await svcLim.sync({
            cart_key: 'd4011111-1111-4111-8111-111111111111',
            items: [{ name: 'X', quantity: 1, price: 1 }],
            total_kopecks: 100
        });
        await runSql(db3, `UPDATE abandoned_carts SET status='recovered', last_seen_at = ? WHERE cart_key = ?`, [
            new Date(Date.now() - 120_000).toISOString(),
            'd4011111-1111-4111-8111-111111111111'
        ]);
        const scan2 = await svcLim.scanAndProcess(new Date());
        assert.strictEqual(scan2.notifiedN, 0);

        try {
            await svc.sync({ cart_key: 'bad', items: [] });
            assert.fail('expected BAD_REQUEST');
        } catch (e) {
            assert.strictEqual(e.code, 'BAD_REQUEST');
        }

        try {
            await svc.sync({ cart_key: CART_KEY, items: {} });
            assert.fail('expected BAD_ITEMS');
        } catch (e) {
            assert.strictEqual(e.message, 'BAD_ITEMS');
            assert.strictEqual(e.code, 'BAD_REQUEST');
        }

        /** Два раза подряд нельзя, если уже достигнут лимит уведомлений */
        const db5 = new sqlite3.Database(':memory:');
        await createSchema(db5);
        const svcLimNotify = makeService(db5, { ABANDONED_CART_MAX_NOTIFICATIONS: 1 });
        const keyN = 'a6011111-1111-4111-8111-111111111111';
        await svcLimNotify.sync({
            cart_key: keyN,
            items: [{ name: 'Y', quantity: 1, price: 1 }],
            total_kopecks: 100
        });
        const rowN = await getRow(db5, `SELECT id FROM abandoned_carts WHERE cart_key = ?`, [keyN]);
        const n1 = await svcLimNotify.notifyNowAdmin(Number(rowN.id), '1');
        const n2 = await svcLimNotify.notifyNowAdmin(Number(rowN.id), '1');
        assert.ok(n1 && n1.ok);
        assert.strictEqual(n2 && n2.ok, false);
        assert.strictEqual(String(n2 && n2.error || ''), 'NOTIFY_LIMIT');

        console.log('[abandoned-cart-service.test] PASS');
    } finally {
        try {
            db.close();
        } catch (_) {
            /**/
        }
    }
})().catch((e) => {
    console.error('[abandoned-cart-service.test] FAIL', e);
    process.exit(1);
});
