const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { ensureSupportThreadsDenormSchema } = require('./support-threads-schema');

const dbPathRaw = process.env.F21_SQLITE_PATH && String(process.env.F21_SQLITE_PATH).trim();
const dbPath = dbPathRaw || path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

/** Разрешается после DDL + всех миграций колонок (см. db.run SELECT 1 gate). */
let settleDbMigrations;
db.awaitMigrations = new Promise((resolve, reject) => {
    settleDbMigrations = { resolve, reject };
});

function ensureColumn(table, column, definition) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (err, cols) => {
            if (err) return reject(err);

            const exists = (cols || []).some(c => c.name === column);
            if (exists) return resolve(false);

            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (e) => {
                if (e) return reject(e);
                resolve(true);
            });
        });
    });
}

db.serialize(() => {
    // users
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
                                             telegram_id TEXT PRIMARY KEY,
                                             first_name TEXT,
                                             last_name TEXT,
                                             username TEXT,
                                             photo_url TEXT
        )
    `);

    // addresses
    db.run(`
        CREATE TABLE IF NOT EXISTS addresses (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 telegram_id TEXT,
                                                 label TEXT,
                                                 address TEXT
        )
    `);

    // orders (базовые поля)
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                              telegram_id TEXT,
                                              full_name TEXT,
                                              phone TEXT,
                                              address TEXT,
                                              total REAL,
                                              status TEXT,
                                              items_json TEXT,
                                              created_at TEXT,
                                              delivery_date TEXT,
                                              delivery_time TEXT,
                                              ms_id TEXT
        )
    `);

    // products (базовые поля)
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
                                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                ms_id TEXT,
                                                name TEXT,
                                                price REAL,
                                                images_json TEXT,
                                                stock INTEGER DEFAULT 10
        )
    `);

    // payments
    db.run(`
        CREATE TABLE IF NOT EXISTS payments (
                                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                order_id INTEGER,
                                                payment_id TEXT,
                                                amount INTEGER,
                                                status TEXT,
                                                raw_json TEXT,
                                                created_at TEXT
        )
    `);

    // telegram_topics: нормализованный routing-реестр тем
    db.run(`
        CREATE TABLE IF NOT EXISTS telegram_topics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            topic_key TEXT UNIQUE,
            telegram_user_id TEXT,
            chat_id TEXT NOT NULL,
            message_thread_id INTEGER NOT NULL,
            root_message_id INTEGER,
            title TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        )
    `);

    // event_outbox: надежная доставка событий
    db.run(`
        CREATE TABLE IF NOT EXISTS event_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            entity_type TEXT,
            entity_id TEXT,
            payload_json TEXT NOT NULL,
            routing_key TEXT,
            dedupe_key TEXT UNIQUE,
            status TEXT DEFAULT 'NEW',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            next_retry_at TEXT,
            created_at TEXT,
            sent_at TEXT
        )
    `);

    // broadcasts
    db.run(`
        CREATE TABLE IF NOT EXISTS broadcast_campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_chat_id TEXT NOT NULL,
            source_message_id INTEGER NOT NULL,
            source_thread_id INTEGER,
            initiated_by_telegram_id TEXT,
            status TEXT DEFAULT 'PENDING',
            summary_message_id INTEGER,
            delete_summary_message_id INTEGER,
            completed_at TEXT,
            deleted_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            UNIQUE(source_chat_id, source_message_id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS broadcast_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER NOT NULL,
            recipient_telegram_id TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            delivered_message_id INTEGER,
            error_code TEXT,
            error_message TEXT,
            deleted_at TEXT,
            delete_status TEXT,
            delete_error TEXT,
            created_at TEXT,
            updated_at TEXT,
            UNIQUE(campaign_id, recipient_telegram_id)
        )
    `);

    /** Audit триггеров рассылки из темы (без текста сообщения; actor в БД для SQL-разборов, не в health JSON). */
    db.run(`
        CREATE TABLE IF NOT EXISTS broadcast_trigger_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            source_chat_id TEXT,
            source_thread_id INTEGER,
            source_message_id INTEGER,
            topic_test_mode INTEGER DEFAULT 0,
            actor_telegram_id TEXT,
            result_code TEXT NOT NULL,
            job_not_scheduled_reason TEXT,
            transport_preflight_reason TEXT,
            campaign_id INTEGER,
            audience_estimate INTEGER
        )
    `);

    /** Append-only lifecycle события кампании рассылки (без PII). */
    db.run(`
        CREATE TABLE IF NOT EXISTS broadcast_campaign_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            campaign_id INTEGER NOT NULL,
            event_code TEXT NOT NULL,
            event_category TEXT,
            trigger_kind TEXT,
            topic_test_mode INTEGER DEFAULT 0,
            details_json TEXT
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_broadcast_campaign_events_campaign ON broadcast_campaign_events(campaign_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_broadcast_campaign_events_created ON broadcast_campaign_events(created_at)');

    // support relay (denorm-колонки в CREATE — для новых БД; старые догоняются ensureSupportThreadsDenormSchema)
    db.run(`
        CREATE TABLE IF NOT EXISTS support_threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_user_id TEXT UNIQUE NOT NULL,
            topic_key TEXT,
            chat_id TEXT,
            message_thread_id INTEGER,
            status TEXT DEFAULT 'OPEN',
            first_response_at TEXT,
            closed_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            waiting_for_staff INTEGER DEFAULT 0,
            last_client_message_at TEXT,
            last_staff_reply_at TEXT,
            last_message_direction TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS support_messages (
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

    db.run(`
        CREATE TABLE IF NOT EXISTS runtime_flags (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_by TEXT,
            updated_at TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS admin_action_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id TEXT,
            details_json TEXT,
            created_at TEXT
        )
    `);

    /** Mini App «Продвижение»: UTM-подобные источники (deep link src_*) и отклики по кодовому слову. */
    db.run(`
        CREATE TABLE IF NOT EXISTS promotion_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            created_at TEXT,
            created_by_telegram_id TEXT,
            is_active INTEGER DEFAULT 1
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS promotion_source_clicks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL,
            source_code TEXT NOT NULL,
            telegram_id TEXT NOT NULL,
            username TEXT,
            full_name TEXT,
            clicked_at TEXT,
            raw_payload TEXT
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS promotion_broadcasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            body_text TEXT NOT NULL,
            image_url TEXT,
            image_storage_path TEXT,
            keyword TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            created_at TEXT,
            created_by_telegram_id TEXT
        )
    `);
    db.run(
        'CREATE INDEX IF NOT EXISTS idx_promotion_broadcasts_keyword ON promotion_broadcasts(keyword)'
    );
    db.run(`
        CREATE TABLE IF NOT EXISTS promotion_broadcast_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broadcast_id INTEGER NOT NULL,
            storage_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            size_bytes INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )
    `);
    db.run(
        'CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_images_bc ON promotion_broadcast_images(broadcast_id)'
    );
    db.run(
        'CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_images_sort ON promotion_broadcast_images(broadcast_id, sort_order)'
    );
    db.run(`
        CREATE TABLE IF NOT EXISTS promotion_broadcast_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broadcast_id INTEGER NOT NULL,
            keyword TEXT NOT NULL,
            telegram_id TEXT NOT NULL,
            username TEXT,
            full_name TEXT,
            message_text TEXT,
            responded_at TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS telegram_processed_updates (
            update_id INTEGER PRIMARY KEY,
            processed_at TEXT
        )
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_telegram_topics_user ON telegram_topics(telegram_user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_event_outbox_status_next ON event_outbox(status, next_retry_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_event_outbox_event_entity ON event_outbox(event_type, entity_type, entity_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_campaign ON broadcast_deliveries(campaign_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_status ON broadcast_deliveries(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id)');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_dedupe ON support_messages(thread_id, direction, source_chat_id, source_message_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_admin_action_logs_created_at ON admin_action_logs(created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_clicks_source_code ON promotion_source_clicks(source_code)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_clicks_telegram_id ON promotion_source_clicks(telegram_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_responses_broadcast ON promotion_broadcast_responses(broadcast_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_responses_tid ON promotion_broadcast_responses(telegram_id)');
    db.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS ux_promotion_broadcast_resp_user ON promotion_broadcast_responses(broadcast_id, telegram_id)'
    );

    // После всего DDL: миграции колонок (не запускать до завершения CREATE выше — иначе гонка с async IIFE).
    db.run('SELECT 1', (gateErr) => {
        if (gateErr) {
            console.error('[DBMigration] schema_gate_failed', gateErr);
            settleDbMigrations.reject(gateErr);
            return;
        }
        runAllMigrationsAsync();
    });
});

/**
 * Убираем UNIQUE по keyword у promotion_broadcasts (повтор ключевых слов в новых карточках).
 * @param {import('sqlite3').Database} db
 * @param {Console} log
 */
async function migratePromotionBroadcastsDropKeywordUnique(db, log) {
    const all = (sql, params = []) =>
        new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
    const run = (sql, params = []) =>
        new Promise((resolve, reject) => {
            db.run(sql, params, (err) => (err ? reject(err) : resolve()));
        });
    let needs = false;
    const indexes = await all(`PRAGMA index_list('promotion_broadcasts')`);
    for (const ix of indexes) {
        if (!Number(ix.unique)) continue;
        const name = String(ix.name || '');
        const parts = await all(`PRAGMA index_info("${name.replace(/"/g, '""')}")`);
        const cols = parts.map((p) => p.name).filter(Boolean);
        if (cols.length === 1 && cols[0] === 'keyword') {
            needs = true;
            break;
        }
    }
    if (!needs) return;
    log.log('[DBMigration] promotion_broadcasts_rebuild_keyword_nonunique', { phase: 'start' });
    await run('BEGIN IMMEDIATE');
    try {
        await run(`CREATE TABLE promotion_broadcasts__kwfix (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            body_text TEXT NOT NULL,
            image_url TEXT,
            image_storage_path TEXT,
            keyword TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            created_at TEXT,
            created_by_telegram_id TEXT,
            placement_status TEXT DEFAULT 'draft',
            placed_at TEXT,
            placed_message_id INTEGER,
            placed_chat_id TEXT,
            placed_thread_id INTEGER,
            placed_campaign_id INTEGER,
            place_error TEXT
        )`);
        await run(
            `INSERT INTO promotion_broadcasts__kwfix (
                id, title, body_text, image_url, image_storage_path, keyword, status, created_at, created_by_telegram_id,
                placement_status, placed_at, placed_message_id, placed_chat_id, placed_thread_id, placed_campaign_id, place_error
            ) SELECT
                id, title, body_text, image_url, image_storage_path, keyword, status, created_at, created_by_telegram_id,
                COALESCE(placement_status, 'draft'), placed_at, placed_message_id, placed_chat_id, placed_thread_id, placed_campaign_id, place_error
            FROM promotion_broadcasts`
        );
        await run('DROP TABLE promotion_broadcasts');
        await run('ALTER TABLE promotion_broadcasts__kwfix RENAME TO promotion_broadcasts');
        await run('CREATE INDEX IF NOT EXISTS idx_promotion_broadcasts_keyword ON promotion_broadcasts(keyword)');
        await run('COMMIT');
        log.log('[DBMigration] promotion_broadcasts_rebuild_keyword_nonunique', { ok: true });
    } catch (e) {
        try {
            await run('ROLLBACK');
        } catch (_) {
            /* ignore */
        }
        throw e;
    }
}

/**
 * @param {import('sqlite3').Database} db
 * @param {Console} log
 */
async function ensurePromotionBroadcastImagesTableExists(db, log) {
    await new Promise((resolve, reject) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS promotion_broadcast_images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                broadcast_id INTEGER NOT NULL,
                storage_path TEXT NOT NULL,
                original_name TEXT,
                mime_type TEXT,
                size_bytes INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT
            )`,
            (err) => (err ? reject(err) : resolve())
        );
    });
    await new Promise((resolve, reject) => {
        db.run(
            'CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_images_bc ON promotion_broadcast_images(broadcast_id)',
            (err) => (err ? reject(err) : resolve())
        );
    });
    await new Promise((resolve, reject) => {
        db.run(
            'CREATE INDEX IF NOT EXISTS idx_promotion_broadcast_images_sort ON promotion_broadcast_images(broadcast_id, sort_order)',
            (err) => (err ? reject(err) : resolve())
        );
    });
    log.log('[DBMigration] promotion_broadcast_images_checked', { ok: true });
}

async function runAllMigrationsAsync() {
    try {
        // users
        await ensureColumn('users', 'bonus_balance', 'INTEGER DEFAULT 0');
        await ensureColumn('users', 'topic_id', 'INTEGER');
        await ensureColumn('users', 'broadcast_suppressed_reason', 'TEXT');
        await ensureColumn('users', 'broadcast_suppressed_at', 'TEXT');
        await ensureColumn('users', 'first_source_code', 'TEXT');
        await ensureColumn('users', 'last_source_code', 'TEXT');

        await ensureColumn('broadcast_campaigns', 'delivery_send_started_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_send_finished_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_duration_ms', 'INTEGER');
        await ensureColumn('broadcast_campaigns', 'topic_test_mode', 'INTEGER DEFAULT 0');
        await ensureColumn('broadcast_campaigns', 'delivery_enqueue_completed_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_last_progress_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_first_attempt_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_first_delivered_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_wave_count', 'INTEGER DEFAULT 0');
        await ensureColumn('broadcast_campaigns', 'delivery_internal_exception_count', 'INTEGER DEFAULT 0');
        await ensureColumn('broadcast_campaigns', 'delivery_transport_pause_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'delivery_transport_pause_reason', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'broadcast_terminal_notice_at', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'broadcast_terminal_notice_kind', 'TEXT');
        await ensureColumn('broadcast_campaigns', 'summary_dedupe_key', 'TEXT');

        await ensureColumn('broadcast_deliveries', 'copy_attempts', 'INTEGER DEFAULT 0');
        await ensureColumn('broadcast_deliveries', 'next_retry_at', 'TEXT');
        await new Promise((resolve, reject) => {
            db.run(
                'CREATE INDEX IF NOT EXISTS idx_broadcast_deliveries_campaign_retry ON broadcast_deliveries(campaign_id, status, next_retry_at)',
                (err) => (err ? reject(err) : resolve())
            );
        });

        // orders
        await ensureColumn('orders', 'phone', 'TEXT');
        await ensureColumn('orders', 'delivery_date', 'TEXT');
        await ensureColumn('orders', 'delivery_time', 'TEXT');
        await ensureColumn('orders', 'ms_id', 'TEXT');
        await ensureColumn('orders', 'ms_name', 'TEXT');
        await ensureColumn('orders', 'ms_state_name', 'TEXT');

        await ensureColumn('orders', 'total_before_bonus', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'bonuses_used', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'total_paid', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'bonus_earned', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'bonus_processed', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'ms_paymentin_created', 'INTEGER DEFAULT 0');

        await ensureColumn('orders', 'checkout_hash', 'TEXT');
        await ensureColumn('orders', 'ms_sync_hash', 'TEXT');

        await ensureColumn('orders', 'receiver_mode', 'TEXT');
        await ensureColumn('orders', 'recipient_full_name', 'TEXT');
        await ensureColumn('orders', 'recipient_phone', 'TEXT');
        await ensureColumn('orders', 'florist_comment', 'TEXT');
        await ensureColumn('orders', 'card_text', 'TEXT');

        await ensureColumn('orders', 'email', 'TEXT');
        await ensureColumn('orders', 'delivery_option', 'TEXT');
        await ensureColumn('orders', 'delivery_fee_rub', 'INTEGER DEFAULT 0');

        await ensureColumn('orders', 'paid_user_msg_sent', 'INTEGER DEFAULT 0');
        await ensureColumn('orders', 'source_code', 'TEXT');

        await ensureColumn('promotion_broadcasts', 'placement_status', "TEXT DEFAULT 'draft'");
        await ensureColumn('promotion_broadcasts', 'placed_at', 'TEXT');
        await ensureColumn('promotion_broadcasts', 'placed_message_id', 'INTEGER');
        await ensureColumn('promotion_broadcasts', 'placed_chat_id', 'TEXT');
        await ensureColumn('promotion_broadcasts', 'placed_thread_id', 'INTEGER');
        await ensureColumn('promotion_broadcasts', 'placed_campaign_id', 'INTEGER');
        await ensureColumn('promotion_broadcasts', 'place_error', 'TEXT');
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE promotion_broadcasts
                 SET placement_status = 'draft'
                 WHERE placement_status IS NULL OR TRIM(COALESCE(placement_status, '')) = ''`,
                (err) => (err ? reject(err) : resolve())
            );
        });

        await migratePromotionBroadcastsDropKeywordUnique(db, console);
        await ensurePromotionBroadcastImagesTableExists(db, console);

        // products
        await ensureColumn('products', 'category', 'TEXT');
        await ensureColumn('products', 'category_path', 'TEXT');

        await ensureSupportThreadsDenormSchema(db, ensureColumn, console);

        console.log('[DBMigration] all_migrations_completed', { ok: true });
        settleDbMigrations.resolve();
    } catch (e) {
        console.error('DB migration error:', e);
        settleDbMigrations.reject(e);
    }
}

module.exports = db;
