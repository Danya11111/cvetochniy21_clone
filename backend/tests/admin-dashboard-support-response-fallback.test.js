'use strict';

/**
 * Fallback метрики «скорость ответа» из исторических support_messages, если support_response_windows пуст.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tmpSqlitePath() {
    return path.join(os.tmpdir(), `f21-dash-supp-fb-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
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
        `INSERT INTO support_threads (telegram_user_id, status, created_at, updated_at)
         VALUES ('777', 'OPEN', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`
    );

    await dbRun(
        db,
        `INSERT INTO support_messages (thread_id, direction, status, created_at)
         VALUES (1, 'CLIENT_TO_TOPIC', 'SENT', '2026-03-10T10:00:00.000Z')`
    );
    await dbRun(
        db,
        `INSERT INTO support_messages (thread_id, direction, status, created_at)
         VALUES (1, 'TOPIC_TO_CLIENT', 'SENT', '2026-03-10T10:10:00.000Z')`
    );

    const day = svc.getCustomDashboardPeriodRange('2026-03-10', '2026-03-10');
    const m = await svc.fetchDashboardMetricsForRange(day);
    assert.strictEqual(m.avgResponseInsufficientData, false);
    assert.strictEqual(typeof m.avgResponseMinutes, 'number');
    assert.ok(Number.isFinite(m.avgResponseMinutes));

    await new Promise((resolve, reject) => db.close((e) => (e ? reject(e) : resolve())));
    process.stdout.write('PASS admin-dashboard support response fallback integration\n');
})().catch((e) => {
    process.stderr.write(`FAIL admin-dashboard support response fallback integration: ${e.message}\n`);
    process.exit(1);
});
