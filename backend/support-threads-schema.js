'use strict';

/**
 * Каноническая миграция denorm-колонок support_threads (идемпотентная).
 * Раньше использовался паттерн ensureColumn(...) || ensureColumn(...) — он ломался:
 * после добавления первой колонки остальные не создавались (short-circuit).
 */

const SUPPORT_THREAD_DENORM_COLUMNS = Object.freeze([
    ['waiting_for_staff', 'INTEGER DEFAULT 0'],
    ['last_client_message_at', 'TEXT'],
    ['last_staff_reply_at', 'TEXT'],
    ['last_message_direction', 'TEXT']
]);

function logInfo(logger, event, payload = {}) {
    const fn = logger && typeof logger.log === 'function' ? logger.log.bind(logger) : console.log;
    fn(`[DBMigration] ${event}`, payload);
}

function logError(logger, event, payload = {}) {
    const fn = logger && typeof logger.error === 'function' ? logger.error.bind(logger) : console.error;
    fn(`[DBMigration] ${event}`, payload);
}

function tableExists(db, tableName) {
    return new Promise((resolve, reject) => {
        db.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            [tableName],
            (err, row) => (err ? reject(err) : resolve(!!row))
        );
    });
}

function runSql(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => (err ? reject(err) : resolve()));
    });
}

/**
 * @param {*} db — sqlite3 Database
 * @param {(table: string, column: string, definition: string) => Promise<boolean>} ensureColumn
 * @param {{ log?: Function, error?: Function }} [logger]
 * @returns {Promise<{ addedColumns: string[], backfilled: boolean }>}
 */
async function ensureSupportThreadsDenormSchema(db, ensureColumn, logger = console) {
    if (!(await tableExists(db, 'support_threads'))) {
        logInfo(logger, 'support_threads_denorm_columns_checked', { skipped: true, reason: 'no_table' });
        return { addedColumns: [], backfilled: false };
    }

    logInfo(logger, 'support_threads_denorm_columns_checked', { table: 'support_threads' });

    const addedColumns = [];
    for (const [column, definition] of SUPPORT_THREAD_DENORM_COLUMNS) {
        // Важно: каждую колонку ждём отдельно — никакого || между вызовами ensureColumn.
        const wasAdded = await ensureColumn('support_threads', column, definition);
        if (wasAdded) {
            addedColumns.push(column);
            logInfo(logger, 'support_threads_column_added', { column });
        }
    }

    if (addedColumns.length === 0) {
        return { addedColumns: [], backfilled: false };
    }

    logInfo(logger, 'support_threads_denorm_backfill_started', { addedColumns });

    try {
        await runSql(
            db,
            `
            UPDATE support_threads SET
                last_client_message_at = (
                    SELECT MAX(sm.created_at) FROM support_messages sm
                    WHERE sm.thread_id = support_threads.id AND sm.direction = 'CLIENT_TO_TOPIC'
                ),
                last_staff_reply_at = (
                    SELECT MAX(sm.created_at) FROM support_messages sm
                    WHERE sm.thread_id = support_threads.id
                      AND sm.direction = 'TOPIC_TO_CLIENT'
                      AND sm.status = 'SENT'
                ),
                last_message_direction = (
                    SELECT sm.direction FROM support_messages sm
                    WHERE sm.thread_id = support_threads.id
                    ORDER BY sm.id DESC LIMIT 1
                )
        `
        );
        await runSql(
            db,
            `
            UPDATE support_threads SET
                waiting_for_staff = CASE
                    WHEN UPPER(TRIM(COALESCE(status,''))) NOT IN ('OPEN','PENDING') THEN 0
                    WHEN IFNULL((
                        SELECT sm.direction FROM support_messages sm
                        WHERE sm.thread_id = support_threads.id
                        ORDER BY sm.id DESC LIMIT 1
                    ),'') = 'CLIENT_TO_TOPIC' THEN 1
                    ELSE 0
                END
        `
        );
        logInfo(logger, 'support_threads_denorm_backfill_done', { addedColumns });
        return { addedColumns, backfilled: true };
    } catch (e) {
        logError(logger, 'support_threads_denorm_backfill_failed', {
            message: e && e.message ? e.message : String(e)
        });
        throw e;
    }
}

module.exports = {
    SUPPORT_THREAD_DENORM_COLUMNS,
    ensureSupportThreadsDenormSchema
};
