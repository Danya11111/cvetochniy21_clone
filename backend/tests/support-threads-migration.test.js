'use strict';

/**
 * Миграции support_threads denorm: fresh DB, legacy schema, повторный запуск, smoke admin-SQL.
 * Отдельный процесс npm test — кэш require чистый до первого require('../db').
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const { ensureSupportThreadsDenormSchema, SUPPORT_THREAD_DENORM_COLUMNS } = require('../support-threads-schema');

function makeEnsureColumn(db) {
    return function ensureColumn(table, column, definition) {
        return new Promise((resolve, reject) => {
            db.all(`PRAGMA table_info(${table})`, (err, cols) => {
                if (err) return reject(err);
                const exists = (cols || []).some((c) => c.name === column);
                if (exists) return resolve(false);
                db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (e) => {
                    if (e) return reject(e);
                    resolve(true);
                });
            });
        });
    };
}

function pragmaColumns(db, table) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function loadDbModule(tmpSqlitePath) {
    process.env.F21_SQLITE_PATH = tmpSqlitePath;
    delete require.cache[require.resolve('../db')];
    return require('../db');
}

function run(name, fn) {
    return fn().then(
        () => process.stdout.write(`PASS ${name}\n`),
        (e) => {
            process.stderr.write(`FAIL ${name}: ${e && e.message ? e.message : e}\n`);
            process.exitCode = 1;
        }
    );
}

(async function main() {
    await run('fresh DB: support_threads has all denorm columns after awaitMigrations', async () => {
        const tmp = path.join(os.tmpdir(), `f21-st-fresh-${Date.now()}.sqlite`);
        try {
            fs.unlinkSync(tmp);
        } catch (_) {
            /* ok */
        }
        const db = loadDbModule(tmp);
        await db.awaitMigrations;
        const cols = await pragmaColumns(db, 'support_threads');
        const names = new Set(cols.map((c) => c.name));
        for (const [col] of SUPPORT_THREAD_DENORM_COLUMNS) {
            assert.ok(names.has(col), `missing column ${col}`);
        }
    });

    await run('legacy DB: missing denorm columns are added and backfill runs', async () => {
        const tmp = path.join(os.tmpdir(), `f21-st-legacy-${Date.now()}.sqlite`);
        try {
            fs.unlinkSync(tmp);
        } catch (_) {
            /* ok */
        }
        const raw = new sqlite3.Database(tmp);
        const run = (sql) =>
            new Promise((res, rej) => {
                raw.run(sql, (e) => (e ? rej(e) : res()));
            });
        await run(`
            CREATE TABLE support_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_user_id TEXT UNIQUE NOT NULL,
                topic_key TEXT,
                chat_id TEXT,
                message_thread_id INTEGER,
                status TEXT DEFAULT 'OPEN',
                first_response_at TEXT,
                closed_at TEXT,
                created_at TEXT,
                updated_at TEXT
            )
        `);
        await run(`
            CREATE TABLE support_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL,
                direction TEXT NOT NULL,
                source_chat_id TEXT,
                source_message_id INTEGER,
                copied_message_id INTEGER,
                payload_json TEXT,
                status TEXT DEFAULT 'SENT',
                error_message TEXT,
                created_at TEXT
            )
        `);
        await run(
            `INSERT INTO support_threads (telegram_user_id, status, created_at, updated_at)
             VALUES ('777', 'OPEN', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
        );
        await run(
            `INSERT INTO support_messages (thread_id, direction, status, created_at)
             VALUES (1, 'CLIENT_TO_TOPIC', 'SENT', '2020-01-02T00:00:00.000Z')`
        );
        await new Promise((res, rej) => raw.close((e) => (e ? rej(e) : res())));

        const db = loadDbModule(tmp);
        await db.awaitMigrations;

        const cols = await pragmaColumns(db, 'support_threads');
        const names = new Set(cols.map((c) => c.name));
        for (const [col] of SUPPORT_THREAD_DENORM_COLUMNS) {
            assert.ok(names.has(col), `legacy missing ${col}`);
        }

        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT waiting_for_staff, last_message_direction, last_client_message_at
                 FROM support_threads WHERE id = 1`,
                (err, r) => (err ? reject(err) : resolve(r))
            );
        });
        assert.strictEqual(row.last_message_direction, 'CLIENT_TO_TOPIC');
        assert.strictEqual(row.last_client_message_at, '2020-01-02T00:00:00.000Z');
        assert.strictEqual(Number(row.waiting_for_staff), 1);
    });

    await run('ensureSupportThreadsDenormSchema twice: idempotent', async () => {
        const db = new sqlite3.Database(':memory:');
        await new Promise((res, rej) => {
            db.run(
                `
                CREATE TABLE support_threads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_user_id TEXT UNIQUE NOT NULL,
                    status TEXT DEFAULT 'OPEN',
                    created_at TEXT,
                    updated_at TEXT
                )
            `,
                (e) => (e ? rej(e) : res())
            );
        });
        await new Promise((res, rej) => {
            db.run(
                `CREATE TABLE support_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id INTEGER NOT NULL,
                    direction TEXT NOT NULL,
                    status TEXT DEFAULT 'SENT',
                    created_at TEXT
                )`,
                (e) => (e ? rej(e) : res())
            );
        });
        const noopLogger = { log() {}, error() {} };
        const ensureColumn = makeEnsureColumn(db);
        const r1 = await ensureSupportThreadsDenormSchema(db, ensureColumn, noopLogger);
        assert.strictEqual(r1.addedColumns.length, SUPPORT_THREAD_DENORM_COLUMNS.length);
        const r2 = await ensureSupportThreadsDenormSchema(db, ensureColumn, noopLogger);
        assert.deepStrictEqual(r2.addedColumns, []);
        assert.strictEqual(r2.backfilled, false);
        db.close();
    });

    await run('admin-style SELECT on denorm columns after migration does not error', async () => {
        const tmp = path.join(os.tmpdir(), `f21-st-admin-${Date.now()}.sqlite`);
        try {
            fs.unlinkSync(tmp);
        } catch (_) {
            /* ok */
        }
        const db = loadDbModule(tmp);
        await db.awaitMigrations;
        await new Promise((res, rej) => {
            db.run(
                `INSERT INTO support_threads (telegram_user_id, status, created_at, updated_at, waiting_for_staff)
                 VALUES ('888', 'OPEN', datetime('now'), datetime('now'), 0)`,
                (e) => (e ? rej(e) : res())
            );
        });
        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT st.last_client_message_at, st.last_staff_reply_at, st.last_message_direction, st.waiting_for_staff
                 FROM support_threads st WHERE st.telegram_user_id = '888'`,
                (err, r) => (err ? reject(err) : resolve(r))
            );
        });
        assert.ok(row);
        assert.ok('waiting_for_staff' in row);
        assert.ok('last_client_message_at' in row);
    });

    process.exit(typeof process.exitCode === 'number' && process.exitCode !== 0 ? process.exitCode : 0);
})();
