'use strict';

/**
 * Интеграция: legacy-пользователь без first_seen_at не считается «новым» по дате миграции,
 * если есть исторический заказ (effective-first-seen через COALESCE в SQL).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tmpSqlitePath() {
    return path.join(os.tmpdir(), `f21-dash-legacy-fs-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function RunCb(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

(async () => {
    const p = tmpSqlitePath();
    try {
        fs.unlinkSync(p);
    } catch (_) {
        /* ok */
    }

    process.env.F21_SQLITE_PATH = p;
    delete require.cache[require.resolve('../db')];
    delete require.cache[require.resolve('../admin-dashboard-service')];

    const db = require('../db');
    await db.awaitMigrations;
    const svc = require('../admin-dashboard-service');

    await dbRun(
        db,
        `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, bonus_balance, first_seen_at)
         VALUES ('LEG_NULL_FS', '', '', '', '', 0, NULL)`
    );
    await dbRun(
        db,
        `INSERT INTO orders (telegram_id, full_name, phone, address, total, status, items_json, created_at, total_paid)
         VALUES ('LEG_NULL_FS', 'Test', '', '', 100, 'PAID', '[]', '2026-03-15T10:00:00.000Z', 10000)`
    );

    const march = svc.getCustomDashboardPeriodRange('2026-03-15', '2026-03-15');
    const mMarch = await svc.fetchDashboardMetricsForRange(march);
    assert.strictEqual(mMarch.newClients, 1);

    const april = svc.getCustomDashboardPeriodRange('2026-04-30', '2026-04-30');
    const mApril = await svc.fetchDashboardMetricsForRange(april);
    assert.strictEqual(mApril.newClients, 0);

    await dbRun(
        db,
        `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, bonus_balance, first_seen_at)
         VALUES ('LEG_NEW', '', '', '', '', 0, '2026-04-30T12:00:00.000Z')`
    );

    const apr30 = svc.getCustomDashboardPeriodRange('2026-04-30', '2026-04-30');
    const mApr30 = await svc.fetchDashboardMetricsForRange(apr30);
    assert.strictEqual(mApr30.newClients, 1);

    await new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
    process.stdout.write('PASS admin-dashboard legacy effective first_seen integration\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-dashboard legacy effective first_seen integration: ${e.message}\n`);
    process.exit(1);
});
