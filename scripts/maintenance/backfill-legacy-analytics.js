#!/usr/bin/env node
'use strict';

/**
 * Ручной maintenance/backfill для legacy SQLite после переноса.
 *
 * По умолчанию dry-run (ничего не меняет).
 * Apply требует явного подтверждения окружения:
 *   CONFIRM_BACKFILL_LEGACY_ANALYTICS=yes
 *
 * Путь к БД:
 *   --db=/abs/path.sqlite   или   F21_SQLITE_PATH=/abs/path.sqlite
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { reconcileSupportThreadsDenormFromMessages } = require('../../backend/support-threads-schema');
const maintenance = require('../../backend/legacy-analytics-maintenance');

function argvDbPath() {
    const raw = process.argv.slice(2).find((a) => a.startsWith('--db='));
    if (raw) return String(raw.slice('--db='.length)).trim();
    const env = process.env.F21_SQLITE_PATH && String(process.env.F21_SQLITE_PATH).trim();
    return env || '';
}

function argvHasApply() {
    return process.argv.includes('--apply');
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

(async function main() {
    const dbPath = argvDbPath();
    if (!dbPath) {
        process.stderr.write('FAIL: укажите путь к SQLite: --db=... или F21_SQLITE_PATH\n');
        process.exitCode = 2;
        return;
    }
    if (!fs.existsSync(dbPath)) {
        process.stderr.write(`FAIL: файл БД не найден: ${dbPath}\n`);
        process.exitCode = 2;
        return;
    }

    const apply = argvHasApply();
    const confirmed = String(process.env.CONFIRM_BACKFILL_LEGACY_ANALYTICS || '').trim() === 'yes';
    if (apply && !confirmed) {
        process.stderr.write(
            'FAIL: для --apply установите CONFIRM_BACKFILL_LEGACY_ANALYTICS=yes (защита от случайного запуска).\n'
        );
        process.exitCode = 2;
        return;
    }

    const db = await openDb(dbPath);
    try {
        const cluster = await maintenance.detectDominantFirstSeenCluster(db);
        const suspiciousTs = cluster.dominantTs || '';
        const usersTouch = await maintenance.countUsersForFirstSeenHeal(db, suspiciousTs);
        const threadsTotal = await maintenance.countSupportThreads(db);

        const summary = {
            phase: apply ? 'apply' : 'dry-run',
            dbFile: path.basename(dbPath),
            dominant_first_seen_cluster: suspiciousTs ? { ts: suspiciousTs.slice(0, 24), count: cluster.dominantCount } : null,
            users_first_seen_candidates: usersTouch,
            support_threads_rows: threadsTotal,
            actions: apply
                ? ['users_first_seen', 'users_sources_orders', 'users_sources_promo_clicks', 'support_threads_denorm']
                : ['noop']
        };

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ ok: true, summary }));

        if (!apply) {
            return;
        }

        await maintenance.healSuspiciousFirstSeenCluster(db, suspiciousTs);
        await maintenance.applyUserSourcesBackfillFromOrders(db);
        await maintenance.applyUserSourcesBackfillFromPromotionClicks(db);
        await reconcileSupportThreadsDenormFromMessages(db, console);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ ok: true, applied: true }));
    } finally {
        await closeDb(db);
    }
})().catch((e) => {
    process.stderr.write(`FAIL: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
