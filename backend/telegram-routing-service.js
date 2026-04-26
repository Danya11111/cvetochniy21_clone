const db = require('./db');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function normalizeClientTopicKey(telegramUserId) {
    return `client:${String(telegramUserId)}`;
}

function buildTopicLink(chatId, messageThreadId) {
    const s = String(chatId || '');
    if (!s.startsWith('-100')) return '';
    const internal = s.slice(4);
    return `https://t.me/c/${internal}/${Number(messageThreadId || 0)}`;
}

function createTelegramRoutingService({ telegramClient, forumGroupId, logger = console }) {
    async function getTopicByKey(topicKey) {
        return get(
            'SELECT * FROM telegram_topics WHERE topic_key = ? AND is_active = 1',
            [String(topicKey)]
        );
    }

    async function upsertTopic({
        topicKey,
        telegramUserId = null,
        chatId,
        messageThreadId,
        rootMessageId = null,
        title = null
    }) {
        const now = new Date().toISOString();
        await run(
            `
            INSERT INTO telegram_topics (
                topic_key, telegram_user_id, chat_id, message_thread_id, root_message_id, title, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(topic_key) DO UPDATE SET
                telegram_user_id = excluded.telegram_user_id,
                chat_id = excluded.chat_id,
                message_thread_id = excluded.message_thread_id,
                root_message_id = COALESCE(excluded.root_message_id, telegram_topics.root_message_id),
                title = COALESCE(excluded.title, telegram_topics.title),
                is_active = 1,
                updated_at = excluded.updated_at
            `,
            [
                String(topicKey),
                telegramUserId ? String(telegramUserId) : null,
                String(chatId),
                Number(messageThreadId),
                rootMessageId ? Number(rootMessageId) : null,
                title,
                now,
                now
            ]
        );
        return getTopicByKey(topicKey);
    }

    async function ensureUserExists({ telegramUserId, firstName, lastName, username }) {
        const existing = await get('SELECT telegram_id FROM users WHERE telegram_id = ?', [String(telegramUserId)]);
        if (existing) return;
        await run(
            `
            INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, bonus_balance, topic_id)
            VALUES (?, ?, ?, ?, '', 0, NULL)
            `,
            [String(telegramUserId), firstName || '', lastName || '', username || '']
        );
    }

    async function ensureClientTopic({
        telegramUserId,
        firstName = '',
        lastName = '',
        username = ''
    }) {
        const userId = String(telegramUserId);
        const topicKey = normalizeClientTopicKey(userId);

        const existing = await getTopicByKey(topicKey);
        if (existing) return existing;

        await ensureUserExists({ telegramUserId: userId, firstName, lastName, username });

        const userRow = await get(
            'SELECT topic_id, first_name, last_name FROM users WHERE telegram_id = ?',
            [userId]
        );

        const legacyTopicId = Number(userRow?.topic_id || 0);
        if (legacyTopicId > 0) {
            return upsertTopic({
                topicKey,
                telegramUserId: userId,
                chatId: forumGroupId,
                messageThreadId: legacyTopicId,
                title: `${firstName || userRow?.first_name || ''} ${lastName || userRow?.last_name || ''}`.trim() || `Client #${userId}`
            });
        }

        const titleBase = `${String(firstName || userRow?.first_name || '').trim()} ${String(lastName || userRow?.last_name || '').trim()}`.trim() || 'Клиент';
        const title = `${titleBase} (#${userId})`.slice(0, 128);
        const created = await telegramClient.createForumTopic({
            chatId: forumGroupId,
            name: title
        });
        if (!created.ok) {
            logger.error('[TopicRouting] createForumTopic failed', {
                telegramUserId: userId,
                errorCode: created.errorCode,
                message: created.message
            });
            return null;
        }

        const newTopicId = Number(created.data?.message_thread_id || 0);
        if (!(newTopicId > 0)) {
            logger.error('[TopicRouting] createForumTopic has empty message_thread_id', {
                telegramUserId: userId
            });
            return null;
        }

        await run('UPDATE users SET topic_id = ? WHERE telegram_id = ?', [newTopicId, userId]);
        return upsertTopic({
            topicKey,
            telegramUserId: userId,
            chatId: forumGroupId,
            messageThreadId: newTopicId,
            rootMessageId: created.data?.message_id || null,
            title
        });
    }

    async function findClientByTopic({ chatId, messageThreadId }) {
        return get(
            `
            SELECT * FROM telegram_topics
            WHERE chat_id = ? AND message_thread_id = ? AND is_active = 1
            LIMIT 1
            `,
            [String(chatId), Number(messageThreadId)]
        );
    }

    return {
        buildTopicLink,
        normalizeClientTopicKey,
        getTopicByKey,
        upsertTopic,
        ensureClientTopic,
        findClientByTopic
    };
}

module.exports = {
    createTelegramRoutingService
};

