'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(
    os.tmpdir(),
    `f21-support-notify-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
);
process.env.F21_SQLITE_PATH = tmpDb;
process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES = '1';

const { createTelegramRoutingService } = require('../telegram-routing-service');
const { createSupportService } = require('../support-service');
const { resetManagerHelpOpsForTests } = require('../manager-help-ops');
const { MANAGER_HELP_CALLBACK_DATA } = require('../manager-help-constants');

function runGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function main() {
    const db = require('../db');
    await db.awaitMigrations;

    const outbound = [];
    const telegramClient = {
        async createForumTopic({ chatId, name }) {
            outbound.push({ kind: 'createForumTopic', chatId, name });
            return { ok: true, data: { message_thread_id: 501, message_id: 9001 } };
        },
        async copyMessage(payload) {
            outbound.push({ kind: 'copyMessage', ...payload });
            const idx = outbound.filter((x) => x.kind === 'copyMessage').length;
            return { ok: true, data: { message_id: 8000 + idx } };
        },
        async sendMessage(payload) {
            outbound.push({ kind: 'sendMessage', ...payload });
            const idx = outbound.filter((x) => x.kind === 'sendMessage').length;
            return { ok: true, data: { message_id: idx } };
        }
    };

    const forumId = '-1008000000777';
    const routingService = createTelegramRoutingService({
        telegramClient,
        forumGroupId: forumId,
        logger: console
    });

    const supportNotifyThreadId = 21;
    const supportService = createSupportService({
        telegramClient,
        routingService,
        supportNotifyChatId: forumId,
        supportNotifyThreadId,
        logger: console,
        managerHelpCooldownMs: 600_000,
        telegramOutboundBotHttpEnabled: true
    });

    const telegramUserId = 42424424;
    const privateChatId = telegramUserId;

    const msgPlain = {
        message_id: 111,
        date: Math.floor(Date.now() / 1000),
        chat: { id: privateChatId, type: 'private' },
        from: { id: telegramUserId, first_name: 'T', username: 't', is_bot: false },
        text: 'привет поддержка — короткая серия сообщений без alert'
    };

    await supportService.handleClientMessage(msgPlain, { updateId: 100001 });
    const notifyAfter1 = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === supportNotifyThreadId
    );
    assert.strictEqual(notifyAfter1.length, 1, 'первое сообщение → alert в тему уведомлений');

    const threads1 = await runGet(db, `SELECT id, last_client_notification_at FROM support_threads WHERE telegram_user_id = ?`, [
        String(telegramUserId)
    ]);
    assert.ok(threads1 && threads1.id, 'thread row created');
    assert.ok(threads1.last_client_notification_at, 'last_client_notification_at должен быть проставлен после alert');

    await supportService.handleClientMessage(
        { ...msgPlain, message_id: 112, text: 'второе сообщение', date: Math.floor(Date.now() / 1000) },
        { updateId: 100002 }
    );
    const notifyAfter2 = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === supportNotifyThreadId
    );
    assert.strictEqual(notifyAfter2.length, 1, 'внутри cooldown не шлём новый alert');

    const stamp2 = await runGet(db, `SELECT last_client_notification_at FROM support_threads WHERE id = ?`, [
        Number(threads1.id)
    ]);
    assert.strictEqual(
        String(stamp2.last_client_notification_at || ''),
        String(threads1.last_client_notification_at || ''),
        'при suppressed alert таймстамп notify не должен меняться'
    );

    const oldStamp = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await new Promise((resolve, reject) => {
        db.run(
            `UPDATE support_threads SET last_client_notification_at = ? WHERE id = ?`,
            [oldStamp, Number(threads1.id)],
            (err) => (err ? reject(err) : resolve())
        );
    });

    await supportService.handleClientMessage(
        { ...msgPlain, message_id: 113, text: 'третье после охлаждения', date: Math.floor(Date.now() / 1000) },
        { updateId: 100003 }
    );
    const notifyAfter3 = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === supportNotifyThreadId
    );
    assert.strictEqual(notifyAfter3.length, 2, 'после cooldown → новый alert');

    /* Кнопка «Позвать менеджера» должна давать отдельный alert даже когда client alert в cooldown. */
    resetManagerHelpOpsForTests();
    outbound.length = 0;
    await supportService.handleClientMessage(
        { ...msgPlain, message_id: 201, text: 'перед кнопкой', date: Math.floor(Date.now() / 1000) },
        { updateId: 200201 }
    );
    await supportService.handleClientMessage(
        { ...msgPlain, message_id: 202, text: 'ещё одно в cooldown', date: Math.floor(Date.now() / 1000) },
        { updateId: 200202 }
    );
    const notifiesMid = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === supportNotifyThreadId
    );
    assert.strictEqual(notifiesMid.length, 0, 'два подряд сообщения в минутном окне → без alert');

    await supportService.handleManagerHelpRequest({
        callbackQuery: {
            id: 'cbq-force-1',
            from: { id: telegramUserId, first_name: 'T', username: 't', is_bot: false },
            message: { chat: { id: telegramUserId, type: 'private' } },
            data: MANAGER_HELP_CALLBACK_DATA
        },
        chatId: telegramUserId
    });

    const notifiesHelp = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === supportNotifyThreadId
    );
    assert.strictEqual(notifiesHelp.length, 1);
    assert.ok(String(notifiesHelp[0].text || '').includes('Запрос менеджера'));

    process.stdout.write('PASS support-service notify cooldown (relay always, alert gated)\n');
}

main()
    .catch((e) => {
        process.stderr.write(`FAIL support-service-notify-cooldown: ${e.stack || e}\n`);
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
