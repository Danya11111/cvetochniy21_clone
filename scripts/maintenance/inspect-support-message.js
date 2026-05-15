#!/usr/bin/env node
'use strict';

/**
 * Диагностика support relay: без текстов сообщений клиента/ФИО, только технические ключи payload.
 *
 *   node scripts/maintenance/inspect-support-message.js --thread-id=12 [--limit=40] [--db=...]
 *   node scripts/maintenance/inspect-support-message.js --source-message-id=955 [--db=...]
 */

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function argvDbPath() {
    const raw = process.argv.slice(2).find((a) => a.startsWith('--db='));
    if (raw) return String(raw.slice('--db='.length)).trim();
    const env = process.env.F21_SQLITE_PATH && String(process.env.F21_SQLITE_PATH).trim();
    if (env) return env;
    return path.join(__dirname, '..', '..', 'backend', 'database.sqlite');
}

function argvNum(prefix) {
    const raw = process.argv.slice(2).find((a) => a.startsWith(prefix));
    if (!raw) return NaN;
    const n = Number(String(raw.slice(prefix.length)).trim());
    return Number.isFinite(n) ? n : NaN;
}

function argvLimit() {
    const n = argvNum('--limit=');
    if (!Number.isFinite(n) || n <= 0) return 40;
    return Math.min(500, Math.floor(n));
}

function openDb(filePath) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filePath, (err) => (err ? reject(err) : resolve(database)));
    });
}

function closeDb(database) {
    return new Promise((resolve, reject) => {
        database.close((err) => (err ? reject(err) : resolve()));
    });
}

function dbGet(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function safeJsonParse(raw) {
    try {
        return JSON.parse(String(raw || '{}'));
    } catch (_) {
        return { parse_error: true };
    }
}

function summarizePayload(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const media = p.media || {};
    return {
        schema: p.schema || null,
        content_kind: p.content_kind ?? null,
        message_id_in_private: p.message_id_in_private ?? null,
        reply_to_private_message_id: p.reply_to && p.reply_to.message_id != null ? p.reply_to.message_id : null,
        forward_origin_type: p.forward_origin && p.forward_origin.type ? String(p.forward_origin.type) : null,
        photo_file_unique_id:
            typeof media.photo_largest_file_unique_id === 'string' ? media.photo_largest_file_unique_id : null,
        document_file_unique_id:
            typeof media.document_file_unique_id === 'string' ? media.document_file_unique_id : null,
        sticker_file_unique_id:
            typeof media.sticker_file_unique_id === 'string' ? media.sticker_file_unique_id : null,
        copy_rule:
            typeof p.copy_rule === 'string' ? p.copy_rule : null,
        note: typeof p.note === 'string' ? String(p.note).slice(0, 120) : null
    };
}

(async function main() {
    const threadId = argvNum('--thread-id=');
    const sourceMessageId = argvNum('--source-message-id=');
    const hasThread = Number.isFinite(threadId) && threadId > 0;
    const hasSrc = Number.isFinite(sourceMessageId) && sourceMessageId > 0;

    if ((hasThread && hasSrc) || (!hasThread && !hasSrc)) {
        console.error(
            'Укажите ровно один фильтр: --thread-id=<id_support_threads> или --source-message-id=<incoming_message_id в исходном чате>.'
        );
        process.exitCode = 2;
        return;
    }

    const dbPath = argvDbPath();
    const database = await openDb(dbPath);

    if (hasThread) {
        const thread = await dbGet(
            database,
            `
            SELECT id, telegram_user_id, chat_id,
                   message_thread_id, status,
                   waiting_for_staff, last_client_message_at,
                   last_staff_reply_at, last_client_notification_at, last_message_direction
            FROM support_threads WHERE id = ?
            `,
            [threadId]
        );
        console.log(JSON.stringify({ thread_preview: thread || null, db_path: dbPath }, null, 2));

        const limit = argvLimit();
        const rows = await dbAll(
            database,
            `
            SELECT id, thread_id, direction, source_chat_id, source_message_id, copied_message_id,
                   status, error_message,
                   substr(COALESCE(payload_json,''), 1, 800) AS payload_json_trunc,
                   created_at
            FROM support_messages
            WHERE thread_id = ?
            ORDER BY id DESC
            LIMIT ?
            `,
            [threadId, limit]
        );
        const decorated = rows.map((r) => ({
            ...r,
            source_chat_digits: `${String(r.source_chat_id || '').slice(0, 6)}…`,
            payload_json: undefined,
            payload_summary: summarizePayload(safeJsonParse(r.payload_json_trunc))
        }));
        console.log(JSON.stringify({ support_messages_recent: decorated }, null, 2));
    } else if (hasSrc) {
        const rows = await dbAll(
            database,
            `
            SELECT sm.id, sm.thread_id, sm.direction,
                   substr(CAST(sm.source_chat_id AS TEXT), 1, 6) AS source_chat_digits,
                   sm.source_message_id, sm.copied_message_id,
                   sm.status, sm.created_at,
                   substr(COALESCE(sm.payload_json,''), 1, 800) AS payload_json_trunc
            FROM support_messages sm
            WHERE sm.source_message_id = ?
               OR sm.copied_message_id = ?
            ORDER BY sm.id DESC
            LIMIT 50
            `,
            [sourceMessageId, sourceMessageId]
        );
        console.log(JSON.stringify({ db_path: dbPath }, null, 2));
        console.log(JSON.stringify(rows.map(r => ({
            ...r,
            payload_summary: summarizePayload(safeJsonParse(r.payload_json_trunc))
        })), null, 2));
    }

    await closeDb(database);
})().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
});
