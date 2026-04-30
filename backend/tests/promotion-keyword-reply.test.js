'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { createPromotionService, MAX_PROMOTION_KEYWORD_LEN } = require('../promotion-service');

function openMemoryDb() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => (err ? reject(err) : resolve()));
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function baseMsg({ text, fromId = '1001' }) {
    return {
        chat: { type: 'private', id: Number(fromId) },
        from: { id: Number(fromId), first_name: 'T', is_bot: false },
        message_id: Math.floor(Math.random() * 1e9),
        text
    };
}

async function main() {
    assert.strictEqual(MAX_PROMOTION_KEYWORD_LEN, 64);

    const db = await openMemoryDb();
    await run(
        db,
        `CREATE TABLE promotion_broadcasts (
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
            place_error TEXT,
            deleted_at TEXT
        )`
    );
    await run(
        db,
        `CREATE TABLE promotion_broadcast_responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broadcast_id INTEGER NOT NULL,
            keyword TEXT NOT NULL,
            telegram_id TEXT NOT NULL,
            username TEXT,
            full_name TEXT,
            message_text TEXT,
            responded_at TEXT,
            UNIQUE(broadcast_id, telegram_id)
        )`
    );

    const now = new Date().toISOString();
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 't1', 'розы', 'active', ?, 'placed', ?)`,
        [now, now]
    );

    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 't2', 'розы', 'active', ?, 'draft', NULL)`,
        [now]
    );

    const promo = createPromotionService({
        db,
        config: { TELEGRAM_BOT_USERNAME: 'testbot' }
    });

    const h = promo.handleKeywordReply;
    const log = { lines: [] };
    const logger = {
        log(...a) {
            log.lines.push(a);
        },
        warn(...a) {
            log.lines.push(a);
        }
    };

    const ok1 = await h(null, baseMsg({ text: '  Розы  ' }), logger);
    assert.strictEqual(ok1, true);
    const row1 = await get(db, 'SELECT COUNT(*) AS c FROM promotion_broadcast_responses', []);
    assert.strictEqual(row1.c, 1);

    const okDup = await h(null, baseMsg({ text: 'розы', fromId: '1001' }), logger);
    assert.strictEqual(okDup, true);

    const okLong = await h(null, baseMsg({ text: 'розы и мне нужна доставка завтра', fromId: '1002' }), logger);
    assert.strictEqual(okLong, false);

    const kw64 = 'a'.repeat(MAX_PROMOTION_KEYWORD_LEN);
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 'long', ?, 'active', ?, 'placed', ?)`,
        [kw64, now, now]
    );

    const almost = await h(null, baseMsg({ text: `${kw64}x`, fromId: '1003' }), logger);
    assert.strictEqual(almost, false, 'prefix+extra must not match 64-char keyword via truncation');

    const exact64 = await h(null, baseMsg({ text: kw64, fromId: '1003' }), logger);
    assert.strictEqual(exact64, true);

    const draftOnly = await h(null, baseMsg({ text: 'draftonly', fromId: '1004' }), logger);
    assert.strictEqual(draftOnly, false);

    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 'td', 'solo_draft_kw', 'active', ?, 'draft', NULL)`,
        [now]
    );
    const noPlace = await h(null, baseMsg({ text: 'solo_draft_kw', fromId: '1005' }), logger);
    assert.strictEqual(noPlace, false, 'draft-only broadcast must not capture keyword');

    process.stdout.write('PASS promotion keyword reply (length guard, exact match, placed-only)\n');
    db.close();
}

main().catch((e) => {
    process.stderr.write(`FAIL promotion-keyword-reply: ${e.stack || e}\n`);
    process.exitCode = 1;
});
