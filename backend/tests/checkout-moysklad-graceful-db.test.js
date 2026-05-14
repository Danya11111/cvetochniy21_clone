'use strict';

/**
 * Проверка «graceful degradation»: сбой МойСклад не переводит заказ в cancelled,
 * в БД сохраняются moysklad_sync_status/moysklad_sync_error (как на реальном checkout после нефатальной ветки).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(
    os.tmpdir(),
    `f21-checkout-ms-grace-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
);

process.env.F21_SQLITE_PATH = tmpDb;

const { syncOrderToMoySkladOnCheckout } = require('../checkout-moysklad-order');

async function dbRun(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function dbGet(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function main() {
    const db = require('../db');
    await db.awaitMigrations;

    const nowIso = new Date().toISOString();
    const ins = await dbRun(
        db,
        `
        INSERT INTO orders (
            telegram_id, full_name, phone, address,
            total, status, items_json, created_at,
            delivery_date, delivery_time,
            total_before_bonus, bonuses_used, total_paid,
            bonus_earned, bonus_processed,
            checkout_hash, ms_sync_hash,
            receiver_mode, recipient_full_name, recipient_phone,
            florist_comment, card_text,
            email, delivery_option, delivery_fee_rub,
            source_code
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
            'tg-ms-grace',
            'Test User',
            '+79990001122',
            'Addr',
            100,
            'PENDING_PAYMENT',
            JSON.stringify([{ msId: 'ms-product-1', name: 'Rose', price: 100, quantity: 1 }]),
            nowIso,
            '2026-05-15',
            '10:00 - 12:00',
            10000,
            0,
            10000,
            0,
            0,
            'checkout-hash-new',
            'old-sync-hash',
            'self',
            'Test User',
            '+79990001122',
            '',
            '',
            'u@test.ru',
            'city400',
            0,
            null
        ]
    );

    const orderId = ins.lastID;
    assert.ok(Number(orderId) > 0);

    const order = {
        id: orderId,
        telegramId: 'tg-ms-grace',
        fullName: 'Test User',
        phone: '+79990001122',
        address: 'Addr',
        items: [{ msId: 'ms-product-1', name: 'Rose', price: 100, quantity: 1 }],
        deliveryMethod: 'delivery',
        deliveryDate: '2026-05-15',
        deliveryTime: '10:00 - 12:00',
        totalPaidK: 10000,
        totalBeforeK: 10000,
        bonusesUsedK: 0,
        receiverMode: 'self',
        recipientFullName: 'Test User',
        recipientPhone: '+79990001122',
        floristComment: '',
        cardText: '',
        deliveryFeeRub: 0,
        email: 'u@test.ru',
        deliveryOption: 'city400'
    };

    const msSyncResult = await syncOrderToMoySkladOnCheckout({
        needMsSync: true,
        order,
        checkoutHash: 'checkout-hash-new',
        sendOrderToMoySklad: async () => {
            throw new Error('MOYSKLAD_HTTP_503_SIM');
        }
    });

    assert.strictEqual(msSyncResult.ok, false);
    assert.strictEqual(msSyncResult.error, 'checkout_failed_moysklad_sync');

    const failReason =
        (msSyncResult.cause && msSyncResult.cause.message) ||
        String(msSyncResult.cause || 'MoySklad sync failed');

    await dbRun(db, `UPDATE orders SET moysklad_sync_status = ?, moysklad_sync_error = ? WHERE id = ?`, [
        'moysklad_failed',
        String(failReason).slice(0, 900),
        orderId
    ]);

    const row = await dbGet(
        db,
        `SELECT status, moysklad_sync_status, moysklad_sync_error FROM orders WHERE id = ?`,
        [orderId]
    );

    assert.strictEqual(row.status, 'PENDING_PAYMENT');
    assert.strictEqual(row.moysklad_sync_status, 'moysklad_failed');
    assert.ok(String(row.moysklad_sync_error || '').includes('MOYSKLAD_HTTP_503_SIM'));

    process.stdout.write('PASS checkout moysklad graceful DB persistence\n');
}

main()
    .catch((e) => {
        process.stderr.write(`FAIL checkout-moysklad-graceful-db: ${e.stack || e}\n`);
        process.exitCode = 1;
    })
    .finally(() => {
        delete process.env.F21_SQLITE_PATH;
        try {
            fs.unlinkSync(tmpDb);
        } catch (_) {}
    });
