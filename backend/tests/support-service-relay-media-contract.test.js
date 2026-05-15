'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `f21-support-media-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.F21_SQLITE_PATH = tmpDb;
process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES = '120';

const { createTelegramRoutingService } = require('../telegram-routing-service');
const { createSupportService } = require('../support-service');

function runGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function main() {
    const db = require('../db');
    await db.awaitMigrations;

    const outbound = [];
    let seqThread = 500;
    const telegramClient = {
        async createForumTopic({ chatId, name }) {
            seqThread += 1;
            outbound.push({ kind: 'createForumTopic', chatId, name });
            return { ok: true, data: { message_thread_id: seqThread, message_id: 9000 + seqThread } };
        },
        async copyMessage(payload) {
            outbound.push({ kind: 'copyMessage', ...payload });
            return { ok: true, data: { message_id: 9100 + outbound.filter((x) => x.kind === 'copyMessage').length } };
        },
        async sendMessage(payload) {
            outbound.push({ kind: 'sendMessage', ...payload });
            return { ok: true, data: { message_id: 1 } };
        }
    };

    const forumId = '-1008000000999';
    const routingService = createTelegramRoutingService({
        telegramClient,
        forumGroupId: forumId,
        logger: console
    });

    const supportService = createSupportService({
        telegramClient,
        routingService,
        supportNotifyChatId: forumId,
        supportNotifyThreadId: 31,
        logger: console,
        telegramOutboundBotHttpEnabled: true
    });

    const uidA = 601;
    const uidB = 602;

    const photoMsgA = {
        message_id: 5001,
        date: 1,
        chat: { id: uidA, type: 'private' },
        from: { id: uidA, first_name: 'A', is_bot: false },
        photo: [
            { file_id: 'small', file_unique_id: 'uniqA-small', width: 10, height: 10 },
            { file_id: 'big', file_unique_id: 'uniqA-big', width: 900, height: 900 }
        ],
        caption: 'букет A'
    };

    const photoMsgB = {
        message_id: 6001,
        date: 2,
        chat: { id: uidB, type: 'private' },
        from: { id: uidB, first_name: 'B', is_bot: false },
        photo: [{ file_id: 'only', file_unique_id: 'uniqB', width: 200, height: 200 }]
    };

    await supportService.handleClientMessage(photoMsgA, { updateId: 7001 });
    await supportService.handleClientMessage(photoMsgB, { updateId: 7002 });

    const copies = outbound.filter((x) => x.kind === 'copyMessage');
    assert.strictEqual(copies.length, 2);
    assert.strictEqual(String(copies[0].fromChatId), String(uidA));
    assert.strictEqual(Number(copies[0].messageId), 5001);
    assert.strictEqual(String(copies[1].fromChatId), String(uidB));
    assert.strictEqual(Number(copies[1].messageId), 6001);

    const rowA = await runGet(
        db,
        `
        SELECT sm.payload_json
        FROM support_messages sm
        INNER JOIN support_threads st ON st.id = sm.thread_id
        WHERE st.telegram_user_id = ?
        ORDER BY sm.id DESC
        LIMIT 1
        `,
        [String(uidA)]
    );
    const payloadA = JSON.parse(String(rowA.payload_json || '{}'));
    assert.strictEqual(payloadA.content_kind, 'photo');
    assert.strictEqual(payloadA.media?.photo_largest_file_unique_id, 'uniqA-big');
    assert.strictEqual(payloadA.message_id_in_private, 5001);

    const textReplyToPhoto = {
        message_id: 5002,
        date: 3,
        chat: { id: uidA, type: 'private' },
        from: { id: uidA, first_name: 'A', is_bot: false },
        text: 'да, это тот букет',
        reply_to_message: {
            message_id: 5001,
            chat: { id: uidA, type: 'private' },
            photo: [{ file_id: 'big', file_unique_id: 'uniqA-big', width: 900, height: 900 }]
        }
    };
    await supportService.handleClientMessage(textReplyToPhoto, { updateId: 7003 });
    const lastCopy = outbound.filter((x) => x.kind === 'copyMessage').pop();
    assert.strictEqual(Number(lastCopy.messageId), 5002, 'reply на фото: копируем текстовый message_id, не reply_to');

    const rowText = await runGet(
        db,
        `
        SELECT sm.payload_json
        FROM support_messages sm
        INNER JOIN support_threads st ON st.id = sm.thread_id
        WHERE st.telegram_user_id = ? AND sm.source_message_id = 5002
        LIMIT 1
        `,
        [String(uidA)]
    );
    const payloadText = JSON.parse(String(rowText.payload_json || '{}'));
    assert.strictEqual(payloadText.content_kind, 'text');
    assert.strictEqual(payloadText.reply_to?.message_id, 5001);
    assert.strictEqual(payloadText.reply_to?.reply_to_photo_file_unique_id, 'uniqA-big');

    const fwdPhoto = {
        message_id: 7007,
        date: 4,
        chat: { id: uidA, type: 'private' },
        from: { id: uidA, first_name: 'A', is_bot: false },
        forward_origin: { type: 'user', sender_user: { id: 999, is_bot: false } },
        photo: [{ file_id: 'fwd', file_unique_id: 'uniqFwd', width: 50, height: 50 }]
    };
    await supportService.handleClientMessage(fwdPhoto, { updateId: 8008 });
    const fwdCopy = outbound.filter((x) => x.kind === 'copyMessage').pop();
    assert.strictEqual(Number(fwdCopy.messageId), 7007);

    const rowFwd = await runGet(
        db,
        `
        SELECT sm.payload_json
        FROM support_messages sm
        INNER JOIN support_threads st ON st.id = sm.thread_id
        WHERE st.telegram_user_id = ? AND sm.source_message_id = 7007
        LIMIT 1
        `,
        [String(uidA)]
    );
    const payloadFwd = JSON.parse(String(rowFwd.payload_json || '{}'));
    assert.strictEqual(payloadFwd.forward_origin?.type, 'user');
    assert.strictEqual(payloadFwd.media?.photo_largest_file_unique_id, 'uniqFwd');

    /* Менеджер → клиент: копируется сообщение из темы клиента (forum) в private user id. */
    const topicA = await runGet(
        db,
        `SELECT chat_id, message_thread_id FROM telegram_topics WHERE telegram_user_id = ? AND is_active = 1 LIMIT 1`,
        [String(uidA)]
    );
    assert.ok(topicA && topicA.message_thread_id, 'telegram_topics row for A');
    await supportService.handleManagerMessage({
        message_id: 12001,
        message_thread_id: Number(topicA.message_thread_id),
        chat: { id: String(topicA.chat_id), type: 'supergroup' },
        from: { id: 77001, first_name: 'Mgr', is_bot: false },
        text: 'Здравствуйте, мы на связи.',
        date: 9
    });
    const staffCopy = outbound.filter((x) => x.kind === 'copyMessage').pop();
    assert.strictEqual(String(staffCopy.fromChatId), String(topicA.chat_id));
    assert.strictEqual(Number(staffCopy.messageId), 12001);
    assert.strictEqual(Number(staffCopy.chatId), uidA, 'доставка оператору должна идти в private user id клиента A');

    await supportService.handleManagerMessage({
        message_id: 12002,
        message_thread_id: Number(topicA.message_thread_id),
        chat: { id: String(topicA.chat_id), type: 'supergroup' },
        from: { id: 77002, first_name: 'Mgr2', is_bot: false },
        text: 'ответ в reply-цепочке',
        date: 10,
        reply_to_message: {
            message_id: 9000,
            chat: { id: String(topicA.chat_id), type: 'supergroup' },
            message_thread_id: Number(topicA.message_thread_id),
            text: 'старое'
        }
    });
    const staffCopy2 = outbound.filter((x) => x.kind === 'copyMessage').pop();
    assert.strictEqual(Number(staffCopy2.messageId), 12002, 'не брать reply_to_message.message_id как «основное»');

    process.stdout.write('PASS support relay media contract (copy ids + payload_json)\n');
}

main()
    .catch((e) => {
        process.stderr.write(`FAIL support-service-relay-media-contract: ${e.stack || e}\n`);
        process.exitCode = 1;
    })
    .finally(() => {
        delete process.env.F21_SQLITE_PATH;
        delete process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES;
        try {
            fs.unlinkSync(tmpDb);
        } catch (_) {
            /* ignore */
        }
    });
