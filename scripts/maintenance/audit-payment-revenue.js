#!/usr/bin/env node
'use strict';

/**
 * Аудит рассогласований «оплата / выручка» в SQLite (dry-run по умолчанию).
 *
 * Не выводит ПДн: только id заказов, статусы и суммы в копейках.
 *
 * Путь к БД:
 *   --db=/abs/path.sqlite   или   F21_SQLITE_PATH
 *
 *   --apply — зарезервировано; автоматические правки не выполняются (используйте SQL из отчёта вручную).
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { sqlOrderPaidRevenueKopecks } = require('../../backend/money');

function argvDbPath() {
    const raw = process.argv.slice(2).find((a) => a.startsWith('--db='));
    if (raw) return String(raw.slice('--db='.length)).trim();
    const env = process.env.F21_SQLITE_PATH && String(process.env.F21_SQLITE_PATH).trim();
    if (env) return env;
    return path.join(__dirname, '..', '..', 'backend', 'database.sqlite');
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

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

(async function main() {
    const dbPath = argvDbPath();
    const apply = process.argv.includes('--apply');
    if (apply) {
        console.error('[audit-payment-revenue] --apply: автоматические UPDATE не поддерживаются. Исправляйте вручную по SQL из docs/payment-revenue-manual-fix-ru.md');
        process.exitCode = 2;
        return;
    }

    const db = await openDb(dbPath);
    const rev = sqlOrderPaidRevenueKopecks('o');

    const pendingButMarkedPaidK = await dbAll(
        db,
        `
        SELECT o.id, o.status, o.total_paid, o.total
        FROM orders o
        WHERE UPPER(TRIM(COALESCE(o.status,''))) IN ('PENDING_PAYMENT','AUTHORIZED')
          AND COALESCE(o.total_paid,0) > 0
        ORDER BY o.id DESC
        LIMIT 200
        `
    );

    const paidZeroRubPendingShape = await dbAll(
        db,
        `
        SELECT o.id, o.status, o.total_paid, o.total
        FROM orders o
        WHERE UPPER(TRIM(COALESCE(o.status,''))) = 'PENDING_PAYMENT'
          AND COALESCE(o.total_paid,0) = 0
          AND COALESCE(o.total_before_bonus,0) > 0
          AND COALESCE(o.total,0) <= 0
        ORDER BY o.id DESC
        LIMIT 50
        `
    );

    const revenueMismatch = await dbAll(
        db,
        `
        SELECT o.id, o.status, o.total_paid, o.total, (${rev}) AS revenue_k
        FROM orders o
        WHERE (
                (UPPER(TRIM(COALESCE(o.status,''))) IN ('PENDING_PAYMENT','AUTHORIZED','PAYMENT_FAILED') AND (${rev}) > 0)
             OR (UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED') AND (${rev}) <= 0 AND COALESCE(o.total,0) <= 0 AND COALESCE(o.total_paid,0) <= 0)
            )
        ORDER BY o.id DESC
        LIMIT 200
        `
    );

    const paidNoConfirmedPayment = await dbAll(
        db,
        `
        SELECT o.id, o.status, o.total_paid, o.total,
               MAX(CASE WHEN UPPER(TRIM(COALESCE(p.status,''))) = 'CONFIRMED' THEN 1 ELSE 0 END) AS has_confirmed
        FROM orders o
        LEFT JOIN payments p ON p.order_id = o.id
        WHERE UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED')
        GROUP BY o.id
        HAVING has_confirmed = 0
        ORDER BY o.id DESC
        LIMIT 200
        `
    );

    console.log(JSON.stringify({
        dbPath,
        counts: {
            pending_or_authorized_but_total_paid_positive: pendingButMarkedPaidK.length,
            pending_total_field_suspicious: paidZeroRubPendingShape.length,
            revenue_mismatch: revenueMismatch.length,
            paid_status_but_no_confirmed_payment_row: paidNoConfirmedPayment.length
        },
        samples: {
            pending_or_authorized_but_total_paid_positive: pendingButMarkedPaidK.slice(0, 20),
            pending_total_field_suspicious: paidZeroRubPendingShape.slice(0, 20),
            revenue_mismatch: revenueMismatch.slice(0, 20),
            paid_status_but_no_confirmed_payment_row: paidNoConfirmedPayment.slice(0, 20)
        }
    }, null, 2));

    await closeDb(db);
})().catch((e) => {
    console.error('[audit-payment-revenue] failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
});
