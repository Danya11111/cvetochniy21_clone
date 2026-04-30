'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();
const { createPromotionService } = require('../promotion-service');

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
    await run(
        db,
        `CREATE TABLE promotion_broadcast_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            broadcast_id INTEGER NOT NULL,
            storage_path TEXT NOT NULL,
            original_name TEXT,
            mime_type TEXT,
            size_bytes INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
        )`
    );

    const promo = createPromotionService({
        db,
        config: { TELEGRAM_BOT_USERNAME: 'testbot' }
    });

    const created = await get(db, 'SELECT datetime("now") AS ts', []);
    const now = created && created.ts ? String(created.ts) : new Date().toISOString();

    /** Список и get скрывают soft-deleted */
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at,
            placement_status, placed_at, deleted_at
        ) VALUES (NULL, 'gone', 'lily', 'active', ?, 'placed', ?, NULL)`,
        [now, now]
    );

    await run(
        db,
        `UPDATE promotion_broadcasts SET deleted_at = ? WHERE id = 1`,
        [now]
    );

    const listed = await promo.listBroadcasts(30);
    assert.strictEqual(listed.length, 0);
    assert.strictEqual(await promo.getBroadcast(1), null);

    /** Idempotent soft delete уже помеченной строки по id — по-прежнему success */
    const again = await promo.softDeleteBroadcast(1);
    assert.strictEqual(again.already_deleted, true);
    assert.strictEqual(again.id, 1);

    /** Простое совпадение по ключевому слову не считает удалённую карточку */
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, ' alive ', 'розы ', 'active', ?, 'placed', ?)`,
        [now, now]
    );

    await run(
        db,
        `UPDATE promotion_broadcasts SET deleted_at = ? WHERE id = 2`,
        [now]
    );

    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 'keep', 'розы ', 'active', ?, 'placed', ?)`,
        [now, now]
    );

    const h = promo.handleKeywordReply;
    const ok = await h(null, baseMsg({ text: 'Розы', fromId: '2001' }), console);
    assert.strictEqual(ok, true);
    const rOk = await get(db, `SELECT broadcast_id FROM promotion_broadcast_responses WHERE telegram_id = '2001'`, []);
    assert.strictEqual(Number(rOk.broadcast_id), 3);

    /** Две активные карточки с тем же ключом: после удаления новейшей матчится более старая */
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 'old_kw', 'тюльпан ', 'active', ?, 'placed', ?)`,
        [now, '2020-01-01 12:00:00']
    );
    await run(
        db,
        `INSERT INTO promotion_broadcasts (
            title, body_text, keyword, status, created_at, placement_status, placed_at
        ) VALUES (NULL, 'new_kw', 'тюльпан ', 'active', ?, 'placed', ?)`,
        [now, '2022-06-01 12:00:00']
    );
    /** id 4 и 5: свежее placed_at побеждает, пока строка не soft-deleted */
    const pickNew = await h(null, baseMsg({ text: 'Тюльпан', fromId: '3001' }), console);
    assert.strictEqual(pickNew, true);
    const bwNew = await get(db, `SELECT broadcast_id FROM promotion_broadcast_responses WHERE telegram_id = '3001'`, []);
    assert.strictEqual(Number(bwNew.broadcast_id), 5);

    await promo.softDeleteBroadcast(5);
    const pickOld = await h(null, baseMsg({ text: 'Тюльпан', fromId: '3002' }), console);
    assert.strictEqual(pickOld, true);
    const bwOld = await get(db, `SELECT broadcast_id FROM promotion_broadcast_responses WHERE telegram_id = '3002'`, []);
    assert.strictEqual(Number(bwOld.broadcast_id), 4);

    /** Отклики не удаляются при soft-delete карточки */
    const respCount = await get(db, 'SELECT COUNT(*) AS c FROM promotion_broadcast_responses', []);
    assert.strictEqual(Number(respCount.c), 3);
    /** Удалённые строки в promotion_broadcasts остаются и держат отклики */
    const orphaned = await get(
        db,
        'SELECT COUNT(*) AS c FROM promotion_broadcast_responses WHERE broadcast_id IN (5)',
        []
    );
    assert.strictEqual(Number(orphaned.c), 1);

    process.stdout.write('PASS promotion broadcast soft-delete (list, keyword, responses)\n');
    db.close();
}

main().catch((e) => {
    process.stderr.write(`FAIL promotion-broadcast-soft-delete: ${e.stack || e}\n`);
    process.exitCode = 1;
});
