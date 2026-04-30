'use strict';

const assert = require('assert');
const { buildManagerHelpReplyMarkup, MANAGER_HELP_CALLBACK_DATA } = require('../manager-help-constants');
const { createTelegramUpdateHandler } = require('../telegram-update-handler');
const { resetManagerHelpOpsForTests } = require('../manager-help-ops');

resetManagerHelpOpsForTests();

const markup = buildManagerHelpReplyMarkup();
const btn = markup.inline_keyboard[0][0];
assert.strictEqual(btn.callback_data, MANAGER_HELP_CALLBACK_DATA);
assert.strictEqual('url' in btn, false);
assert.strictEqual('web_app' in btn, false);
assert.ok(String(btn.text || '').includes('менеджера'));

const calls = [];
const telegramClient = {
    async answerCallbackQuery(p) {
        calls.push({ type: 'answerCallbackQuery', ...p });
        return { ok: true };
    },
    async sendMessage() {
        calls.push({ type: 'sendMessage' });
        return { ok: true };
    }
};

const supportService = {
    async handleManagerHelpRequest(ctx) {
        calls.push({ type: 'handleManagerHelpRequest', chatId: ctx.chatId });
        return { ok: true };
    }
};

const broadcastService = {
    isBroadcastTopicMessage: () => false,
    getBroadcastTopicRoutingDebug: () => ({ expectedChatId: '', expectedThreadId: 0 }),
    deleteCampaignMessages: async () => ({ ok: true }),
    startCampaignFromTopicMessage: async () => ({})
};

const telegramAdminDashboard = {
    async handleAdminCallbackQuery() {
        /* только adm:*; этот тест шлёт manager_help_request */
    },
    async handleAdminCommandMessage() {}
};

const { handleUpdate } = createTelegramUpdateHandler({
    supportService,
    broadcastService,
    telegramClient,
    telegramAdminDashboard,
    config: {
        BROADCASTS_ENABLED: false,
        BROADCAST_DELETE_ENABLED: false,
        SUPPORT_RELAY_ENABLED: true,
        CLIENT_TOPIC_REPLY_ENABLED: true,
        TELEGRAM_SUPPORT_NOTIFY_CHAT_ID: '',
        TELEGRAM_SUPPORT_NOTIFY_THREAD_ID: 0,
        TELEGRAM_FORUM_GROUP_ID: '-100'
    },
    logger: console
});

async function main() {
    await handleUpdate({
        update_id: 42,
        callback_query: {
            id: 'cq-mh-1',
            from: { id: 777001, first_name: 'T', is_bot: false },
            message: { chat: { id: 777001, type: 'private' } },
            data: MANAGER_HELP_CALLBACK_DATA
        }
    });

    assert.strictEqual(calls[0]?.type, 'answerCallbackQuery', 'answerCallbackQuery must be first (fast ack)');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls[1]?.type, 'handleManagerHelpRequest', 'heavy work after setImmediate');
    assert.strictEqual(calls[1].chatId, 777001);

    process.stdout.write('PASS manager-help callback markup and handler ordering\n');
}

main().catch((e) => {
    process.stderr.write(`FAIL manager-help-callback: ${e.stack || e}\n`);
    process.exitCode = 1;
});
