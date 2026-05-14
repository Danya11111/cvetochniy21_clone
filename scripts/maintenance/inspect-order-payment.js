#!/usr/bin/env node
'use strict';

/**
 * Снимок заказа для диагностики платежа (без ПДн): статусы и суммы.
 *
 *   node scripts/maintenance/inspect-order-payment.js --id=196 [--db=...]
 *   F21_SQLITE_PATH=... node scripts/maintenance/inspect-order-payment.js --id=196
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function argvDbPath() {
    const raw = process.argv.slice(2).find((a) => a.startsWith('--db='));
    if (raw) return String(raw.slice('--db='.length)).trim();
    const env = process.env.F21_SQLITE_PATH && String(process.env.F21_SQLITE_PATH).trim();
    if (env) return env;
    return path.join(__dirname, '..', '..', 'backend', 'database.sqlite');
}

function argvOrderId() {
    const raw = process.argv.slice(2).find((a) => a.startsWith('--id='));
    if (!raw) return NaN;
    return Number(String(raw.slice('--id='.length)).trim());
}

function openDb(filePath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, (err) => (err ? reject(err) : resolve(db)));
    });
}

function closeDb(db) {
    return new Promise((resolve, reject) => {
        db.close((err) => (err ? reject(err) : resolve()));
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

(async function main() {
    const id = argvOrderId();
    if (!Number.isFinite(id) || id <= 0) {
        console.error('Usage: inspect-order-payment.js --id=<order_id> [--db=path.sqlite]');
        process.exitCode = 2;
        return;
    }
    const dbPath = argvDbPath();
    const db = await openDb(dbPath);
    const order = await dbGet(
        db,
        `
        SELECT id, status, total, total_paid, total_before_bonus, bonuses_used,
               bonus_earned, bonus_processed, ms_paymentin_created, created_at
        FROM orders
        WHERE id = ?
        `,
        [id]
    );
    const payments = await dbAll(
        db,
        `
        SELECT id, order_id, payment_id, amount, status,
               substr(COALESCE(raw_json,''), 1, 240) AS raw_json_preview, created_at
        FROM payments
        WHERE order_id = ?
        ORDER BY id DESC
        `,
        [id]
    );
    console.log(JSON.stringify({ dbPath, order: order || null, payments }, null, 2));
    await closeDb(db);
})().catch((e) => {
    console.error('[inspect-order-payment] failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
});
