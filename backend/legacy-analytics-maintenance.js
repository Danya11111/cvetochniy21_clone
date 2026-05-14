'use strict';

/**
 * Идемпотентные SQL-операции для ручного восстановления аналитики после импорта legacy SQLite.
 * Не импортирует ./db — принимает sqlite3.Database снаружи (скрипт maintenance).
 */

async function run(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

async function get(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function all(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

async function tableExists(database, name) {
    const row = await get(database, "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [String(name)]);
    return !!row;
}

async function pragmaCols(database, table) {
    return all(database, `PRAGMA table_info(${table})`, []);
}

async function columnExists(database, table, column) {
    const cols = await pragmaCols(database, table);
    return (cols || []).some((c) => String(c.name) === String(column));
}

/**
 * Находит доминирующий «подозрительный» first_seen_at (массовая одинаковая метка, типично после ошибочного backfill).
 */
async function detectDominantFirstSeenCluster(database) {
    const row = await get(
        database,
        `
        SELECT first_seen_at AS ts, COUNT(*) AS c
        FROM users
        WHERE first_seen_at IS NOT NULL AND TRIM(COALESCE(first_seen_at, '')) <> ''
        GROUP BY first_seen_at
        ORDER BY c DESC
        LIMIT 1
        `
    );
    const totalNonEmpty = Math.round(
        Number((await get(database, `SELECT COUNT(*) AS c FROM users WHERE first_seen_at IS NOT NULL AND TRIM(COALESCE(first_seen_at,'')) <> ''`))?.c || 0)
    );
    const c = Math.round(Number(row?.c || 0));
    const ts = row && row.ts ? String(row.ts) : '';
    const dominant = totalNonEmpty > 0 && c >= 50 && c / totalNonEmpty >= 0.35 && ts;
    return { dominantTs: dominant ? ts : '', dominantCount: c, totalNonEmpty };
}

async function countUsersForFirstSeenHeal(database, suspiciousTs) {
    const ts = String(suspiciousTs || '').trim();
    if (!ts) {
        const row = await get(
            database,
            `
            SELECT COUNT(*) AS c FROM users
            WHERE first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = ''
            `
        );
        return Math.round(Number(row?.c || 0));
    }
    const row = await get(
        database,
        `
        SELECT COUNT(*) AS c FROM users
        WHERE (first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = '')
           OR TRIM(COALESCE(first_seen_at, '')) = TRIM(?)
        `,
        [ts]
    );
    return Math.round(Number(row?.c || 0));
}

async function applyUsersFirstSeenHistoricalBackfill(database) {
    const steps = [
        `
            UPDATE users SET first_seen_at = created_at
            WHERE (first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = '')
              AND created_at IS NOT NULL AND TRIM(COALESCE(created_at, '')) <> ''
        `,
        `
            UPDATE users SET first_seen_at = (
                SELECT o.created_at FROM orders o
                WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND o.created_at IS NOT NULL AND TRIM(COALESCE(o.created_at, '')) <> ''
                ORDER BY o.id ASC LIMIT 1
            )
            WHERE (first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = '')
              AND EXISTS (
                SELECT 1 FROM orders o2
                WHERE TRIM(CAST(o2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND o2.created_at IS NOT NULL AND TRIM(COALESCE(o2.created_at, '')) <> ''
              )
        `,
        `
            UPDATE users SET first_seen_at = (
                SELECT sm.created_at FROM support_messages sm
                INNER JOIN support_threads st ON st.id = sm.thread_id
                WHERE TRIM(CAST(st.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND sm.created_at IS NOT NULL AND TRIM(COALESCE(sm.created_at, '')) <> ''
                ORDER BY sm.id ASC LIMIT 1
            )
            WHERE (first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = '')
              AND EXISTS (
                SELECT 1 FROM support_messages sm2
                INNER JOIN support_threads st2 ON st2.id = sm2.thread_id
                WHERE TRIM(CAST(st2.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND sm2.created_at IS NOT NULL AND TRIM(COALESCE(sm2.created_at, '')) <> ''
              )
        `,
        `
            UPDATE users SET first_seen_at = (
                SELECT st.created_at FROM support_threads st
                WHERE TRIM(CAST(st.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND st.created_at IS NOT NULL AND TRIM(COALESCE(st.created_at, '')) <> ''
                ORDER BY st.id ASC LIMIT 1
            )
            WHERE (first_seen_at IS NULL OR TRIM(COALESCE(first_seen_at, '')) = '')
              AND EXISTS (
                SELECT 1 FROM support_threads st2
                WHERE TRIM(CAST(st2.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
                  AND st2.created_at IS NOT NULL AND TRIM(COALESCE(st2.created_at, '')) <> ''
              )
        `
    ];
    for (const sql of steps) {
        await run(database, sql);
    }
}

/**
 * Пересчитывает «ядовитые» first_seen_at в доминирующем кластере и пустые значения.
 * Не трогает строки с осмысленным first_seen_at вне кластера.
 */
async function healSuspiciousFirstSeenCluster(database, suspiciousTs) {
    const ts = String(suspiciousTs || '').trim();
    if (!ts) {
        await applyUsersFirstSeenHistoricalBackfill(database);
        return;
    }

    await run(
        database,
        `
        UPDATE users SET first_seen_at = created_at
        WHERE TRIM(COALESCE(first_seen_at, '')) = TRIM(?)
          AND created_at IS NOT NULL AND TRIM(COALESCE(created_at, '')) <> ''
          AND (julianday(created_at)) IS NOT NULL AND (julianday(first_seen_at)) IS NOT NULL
          AND julianday(created_at) < julianday(first_seen_at)
        `,
        [ts]
    );

    await applyUsersFirstSeenHistoricalBackfill(database);

    await run(
        database,
        `
        UPDATE users SET first_seen_at = (
            SELECT o.created_at FROM orders o
            WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o.created_at IS NOT NULL AND TRIM(COALESCE(o.created_at, '')) <> ''
            ORDER BY o.id ASC LIMIT 1
        )
        WHERE TRIM(COALESCE(first_seen_at, '')) = TRIM(?)
          AND EXISTS (
            SELECT 1 FROM orders o2
            WHERE TRIM(CAST(o2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o2.created_at IS NOT NULL AND TRIM(COALESCE(o2.created_at, '')) <> ''
          )
        `,
        [ts]
    );

    await run(
        database,
        `
        UPDATE users SET first_seen_at = (
            SELECT sm.created_at FROM support_messages sm
            INNER JOIN support_threads st ON st.id = sm.thread_id
            WHERE TRIM(CAST(st.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND sm.created_at IS NOT NULL AND TRIM(COALESCE(sm.created_at, '')) <> ''
            ORDER BY sm.id ASC LIMIT 1
        )
        WHERE TRIM(COALESCE(first_seen_at, '')) = TRIM(?)
          AND EXISTS (
            SELECT 1 FROM support_messages sm2
            INNER JOIN support_threads st2 ON st2.id = sm2.thread_id
            WHERE TRIM(CAST(st2.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND sm2.created_at IS NOT NULL AND TRIM(COALESCE(sm2.created_at, '')) <> ''
          )
        `,
        [ts]
    );

    await run(
        database,
        `
        UPDATE users SET first_seen_at = (
            SELECT st.created_at FROM support_threads st
            WHERE TRIM(CAST(st.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND st.created_at IS NOT NULL AND TRIM(COALESCE(st.created_at, '')) <> ''
            ORDER BY st.id ASC LIMIT 1
        )
        WHERE TRIM(COALESCE(first_seen_at, '')) = TRIM(?)
          AND EXISTS (
            SELECT 1 FROM support_threads st2
            WHERE TRIM(CAST(st2.telegram_user_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND st2.created_at IS NOT NULL AND TRIM(COALESCE(st2.created_at, '')) <> ''
          )
        `,
        [ts]
    );

    await run(database, `UPDATE users SET first_seen_at = NULL WHERE TRIM(COALESCE(first_seen_at, '')) = TRIM(?)`, [ts]);
    await applyUsersFirstSeenHistoricalBackfill(database);
}

async function applyUserSourcesBackfillFromOrders(database) {
    const hasUsers = await tableExists(database, 'users');
    const hasOrders = await tableExists(database, 'orders');
    if (!hasUsers || !hasOrders) return;

    await run(
        database,
        `
        UPDATE users SET first_source_code = (
            SELECT TRIM(o.source_code) FROM orders o
            WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o.source_code IS NOT NULL AND TRIM(COALESCE(o.source_code, '')) <> ''
            ORDER BY o.id ASC LIMIT 1
        )
        WHERE (first_source_code IS NULL OR TRIM(COALESCE(first_source_code, '')) = '')
          AND EXISTS (
            SELECT 1 FROM orders o2
            WHERE TRIM(CAST(o2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o2.source_code IS NOT NULL AND TRIM(COALESCE(o2.source_code, '')) <> ''
          )
        `
    );

    await run(
        database,
        `
        UPDATE users SET last_source_code = (
            SELECT TRIM(o.source_code) FROM orders o
            WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o.source_code IS NOT NULL AND TRIM(COALESCE(o.source_code, '')) <> ''
            ORDER BY o.id DESC LIMIT 1
        )
        WHERE (last_source_code IS NULL OR TRIM(COALESCE(last_source_code, '')) = '')
          AND EXISTS (
            SELECT 1 FROM orders o2
            WHERE TRIM(CAST(o2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND o2.source_code IS NOT NULL AND TRIM(COALESCE(o2.source_code, '')) <> ''
          )
        `
    );
}

async function applyUserSourcesBackfillFromPromotionClicks(database) {
    const hasUsers = await tableExists(database, 'users');
    const hasClicks = await tableExists(database, 'promotion_source_clicks');
    if (!hasUsers || !hasClicks) return;

    await run(
        database,
        `
        UPDATE users SET first_source_code = (
            SELECT TRIM(ps.source_code) FROM promotion_source_clicks ps
            WHERE TRIM(CAST(ps.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND ps.source_code IS NOT NULL AND TRIM(COALESCE(ps.source_code, '')) <> ''
            ORDER BY ps.id ASC LIMIT 1
        )
        WHERE (first_source_code IS NULL OR TRIM(COALESCE(first_source_code, '')) = '')
          AND EXISTS (
            SELECT 1 FROM promotion_source_clicks ps2
            WHERE TRIM(CAST(ps2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND ps2.source_code IS NOT NULL AND TRIM(COALESCE(ps2.source_code, '')) <> ''
          )
        `
    );

    await run(
        database,
        `
        UPDATE users SET last_source_code = (
            SELECT TRIM(ps.source_code) FROM promotion_source_clicks ps
            WHERE TRIM(CAST(ps.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND ps.source_code IS NOT NULL AND TRIM(COALESCE(ps.source_code, '')) <> ''
            ORDER BY ps.id DESC LIMIT 1
        )
        WHERE (last_source_code IS NULL OR TRIM(COALESCE(last_source_code, '')) = '')
          AND EXISTS (
            SELECT 1 FROM promotion_source_clicks ps2
            WHERE TRIM(CAST(ps2.telegram_id AS TEXT)) = TRIM(CAST(users.telegram_id AS TEXT))
              AND ps2.source_code IS NOT NULL AND TRIM(COALESCE(ps2.source_code, '')) <> ''
          )
        `
    );
}

async function countSupportThreads(database) {
    if (!(await tableExists(database, 'support_threads'))) return 0;
    const row = await get(database, `SELECT COUNT(*) AS c FROM support_threads`, []);
    return Math.round(Number(row?.c || 0));
}

module.exports = {
    columnExists,
    detectDominantFirstSeenCluster,
    countUsersForFirstSeenHeal,
    countSupportThreads,
    applyUsersFirstSeenHistoricalBackfill,
    healSuspiciousFirstSeenCluster,
    applyUserSourcesBackfillFromOrders,
    applyUserSourcesBackfillFromPromotionClicks
};
