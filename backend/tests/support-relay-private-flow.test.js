'use strict';

const assert = require('assert');
const { createTelegramUpdateHandler } = require('../telegram-update-handler');

const telegramClient = { async answerCallbackQuery() {}, async sendMessage() {} };
const broadcastService = {
    isBroadcastTopicMessage: () => false,
    getBroadcastTopicRoutingDebug: () => ({ expectedChatId: '', expectedThreadId: 0 }),
    deleteCampaignMessages: async () => ({ ok: true }),
    startCampaignFromTopicMessage: async () => ({})
};
const telegramAdminDashboard = {
    async handleAdminCallbackQuery() {},
    async handleAdminCommandMessage() {}
};

function baseCfg(overrides = {}) {
    return {
        BROADCASTS_ENABLED: false,
        BROADCAST_DELETE_ENABLED: false,
        SUPPORT_RELAY_ENABLED: true,
        CLIENT_TOPIC_REPLY_ENABLED: true,
        TELEGRAM_SUPPORT_NOTIFY_CHAT_ID: '',
        TELEGRAM_SUPPORT_NOTIFY_THREAD_ID: 0,
        TELEGRAM_FORUM_GROUP_ID: '-100',
        ...overrides
    };
}

async function main() {
    let clientCalls = [];
    const supportService = {
        async handleClientMessage(msg) {
            clientCalls.push({ type: 'handleClientMessage', message_id: msg.message_id, text: msg.text });
            return { ok: true };
        },
        async handleManagerHelpRequest() {
            return { ok: true };
        }
    };

    const promotionAlwaysKeyword = {
        async handleKeywordReply() {
            return true;
        }
    };

    const { handleUpdate: hKeyword } = createTelegramUpdateHandler({
        supportService,
        broadcastService,
        telegramClient,
        telegramAdminDashboard,
        promotionService: promotionAlwaysKeyword,
        runtimeFlagsService: { async getAll() {
            return { SUPPORT_RELAY_ENABLED: true };
        } },
        config: baseCfg(),
        logger: console
    });

    await hKeyword({
        update_id: 9001,
        message: {
            message_id: 11,
            chat: { id: 4242, type: 'private' },
            from: { id: 4242, is_bot: false, first_name: 'U' },
            text: 'любой короткий текст'
        }
    });
    assert.strictEqual(clientCalls.length, 1, 'keyword matched/recorded must still call handleClientMessage');
    assert.strictEqual(clientCalls[0].message_id, 11);

    clientCalls = [];
    const promotionThrows = {
        async handleKeywordReply() {
            throw new Error('boom_keyword');
        }
    };
    const { handleUpdate: hThrow } = createTelegramUpdateHandler({
        supportService,
        broadcastService,
        telegramClient,
        telegramAdminDashboard,
        promotionService: promotionThrows,
        runtimeFlagsService: {
            async getAll() {
                return { SUPPORT_RELAY_ENABLED: true };
            }
        },
        config: baseCfg(),
        logger: console
    });
    await hThrow({
        update_id: 9005,
        message: {
            message_id: 55,
            chat: { id: 9191, type: 'private' },
            from: { id: 9191, is_bot: false },
            text: 'hi'
        }
    });
    assert.strictEqual(
        clientCalls.length,
        1,
        'handleKeywordReply failure must still call handleClientMessage'
    );

    const promotionNoKeyword = {
        async handleKeywordReply() {
            return false;
        }
    };

    clientCalls = [];
    const runtimeOff = {
        async getAll() {
            return { SUPPORT_RELAY_ENABLED: false };
        }
    };

    const { handleUpdate: hRelayOff } = createTelegramUpdateHandler({
        supportService,
        broadcastService,
        telegramClient,
        telegramAdminDashboard,
        promotionService: promotionNoKeyword,
        runtimeFlagsService: runtimeOff,
        config: baseCfg({ SUPPORT_RELAY_ENABLED: true }),
        logger: console
    });

    await hRelayOff({
        update_id: 9002,
        message: {
            message_id: 22,
            chat: { id: 5252, type: 'private' },
            from: { id: 5252, is_bot: false, first_name: 'V' },
            text: 'здравствуйте'
        }
    });
    assert.strictEqual(
        clientCalls.length,
        0,
        'runtime SUPPORT_RELAY_ENABLED=false must suppress handleClientMessage even if env true'
    );

    clientCalls = [];
    const { handleUpdate: hOk } = createTelegramUpdateHandler({
        supportService,
        broadcastService,
        telegramClient,
        telegramAdminDashboard,
        promotionService: promotionNoKeyword,
        runtimeFlagsService: {
            async getAll() {
                return { SUPPORT_RELAY_ENABLED: true };
            }
        },
        config: baseCfg({ SUPPORT_RELAY_ENABLED: true }),
        logger: console
    });

    await hOk({
        update_id: 9003,
        message: {
            message_id: 33,
            chat: { id: 6262, type: 'private' },
            from: { id: 6262, is_bot: false, first_name: 'W' },
            text: 'нужна доставка завтра до 18:00, спасибо'
        }
    });
    assert.strictEqual(clientCalls.length, 1, 'long plain text must reach handleClientMessage');
    assert.strictEqual(clientCalls[0].type, 'handleClientMessage');

    clientCalls = [];
    const { handleUpdate: hNoRuntime } = createTelegramUpdateHandler({
        supportService,
        broadcastService,
        telegramClient,
        telegramAdminDashboard,
        promotionService: promotionNoKeyword,
        config: baseCfg({ SUPPORT_RELAY_ENABLED: true }),
        logger: console
    });
    await hNoRuntime({
        update_id: 9004,
        message: {
            message_id: 44,
            chat: { id: 7272, type: 'private' },
            from: { id: 7272, is_bot: false },
            text: 'ok'
        }
    });
    assert.strictEqual(clientCalls.length, 1, 'without runtimeFlagsService, env SUPPORT_RELAY_ENABLED must relay');

    process.stdout.write('PASS support relay private flow (keyword + support, runtime flag, errors)\n');
}

main().catch((e) => {
    process.stderr.write(`FAIL support-relay-private-flow: ${e.stack || e}\n`);
    process.exitCode = 1;
});
