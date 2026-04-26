'use strict';

/**
 * Изолированная SQLite + мок Bot API: первый запрос шлёт ровно одно уведомление в support topic,
 * второй в пределах cooldown — dedupe без второго notify.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `f21-manager-help-int-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
process.env.F21_SQLITE_PATH = tmpDb;

const { createTelegramRoutingService } = require('../telegram-routing-service');
const { createSupportService } = require('../support-service');
const { resetManagerHelpOpsForTests } = require('../manager-help-ops');

async function main() {
    const db = require('../db');
    await db.awaitMigrations;
    resetManagerHelpOpsForTests();

    const outbound = [];
    const telegramClient = {
        async createForumTopic({ chatId, name }) {
            outbound.push({ kind: 'createForumTopic', chatId, name });
            return { ok: true, data: { message_thread_id: 501, message_id: 9001 } };
        },
        async sendMessage(payload) {
            outbound.push({ kind: 'sendMessage', ...payload });
            const n = outbound.filter((x) => x.kind === 'sendMessage').length;
            return { ok: true, data: { message_id: n } };
        }
    };

    const forumId = '-1008000000001';
    const routingService = createTelegramRoutingService({
        telegramClient,
        forumGroupId: forumId,
        logger: console
    });

    const supportService = createSupportService({
        telegramClient,
        routingService,
        supportNotifyChatId: forumId,
        supportNotifyThreadId: 7,
        logger: console,
        managerHelpCooldownMs: 600_000,
        telegramOutboundBotHttpEnabled: true
    });

    const chatUserId = 51515151;
    const cq = {
        id: 'cbq-int-1',
        from: {
            id: chatUserId,
            first_name: 'Иван',
            last_name: 'Тест',
            username: 'ivan_t',
            is_bot: false
        },
        message: { chat: { id: chatUserId, type: 'private' } },
        data: 'manager_help_request'
    };

    const r1 = await supportService.handleManagerHelpRequest({ callbackQuery: cq, chatId: chatUserId });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.duplicateSuppressed, false);

    const notifySends = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === 7 && String(x.chatId) === forumId
    );
    assert.strictEqual(notifySends.length, 1);
    assert.ok(String(notifySends[0].text || '').includes('Запрос менеджера'));

    const r2 = await supportService.handleManagerHelpRequest({ callbackQuery: cq, chatId: chatUserId });
    assert.strictEqual(r2.duplicateSuppressed, true);
    assert.strictEqual(r2.reason, 'cooldown');

    const notifySends2 = outbound.filter(
        (x) => x.kind === 'sendMessage' && Number(x.messageThreadId || 0) === 7 && String(x.chatId) === forumId
    );
    assert.strictEqual(notifySends2.length, 1);

    const userTexts = outbound
        .filter((x) => x.kind === 'sendMessage' && String(x.chatId) === String(chatUserId) && !x.messageThreadId)
        .map((x) => String(x.text || ''));
    assert.ok(userTexts.some((t) => t.includes('Менеджер уже получил')));
    assert.ok(userTexts.some((t) => t.includes('Запрос уже передан')));

    const r3 = await supportService.handleManagerHelpRequest({
        callbackQuery: { ...cq, id: 'cbq-int-2' },
        chatId: chatUserId
    });
    assert.strictEqual(r3.duplicateSuppressed, true);
    assert.strictEqual(notifySends2.length, 1);

    process.stdout.write('PASS manager-help integration (notify + cooldown dedupe)\n');
}

main()
    .catch((e) => {
        process.stderr.write(`FAIL manager-help-integration: ${e.stack || e}\n`);
        process.exitCode = 1;
    })
    .finally(() => {
        delete process.env.F21_SQLITE_PATH;
        try {
            fs.unlinkSync(tmpDb);
        } catch (_) {}
    });
