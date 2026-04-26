/**
 * Та же логика upsert, что и POST /api/user/init (без HTTP), для /start и инициализации из команд.
 */
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

/**
 * @param {Record<string, unknown>} message — private message с from
 */
async function upsertTelegramUserFromMessage(message) {
    const from = message?.from || {};
    const telegramId = String(from.id || '').trim();
    if (!telegramId) {
        return { ok: false, error: 'NO_USER_ID' };
    }
    const firstName = String(from.first_name || '');
    const lastName = String(from.last_name || '');
    const username = String(from.username || '');
    const photoUrl = '';

    const row = await get('SELECT telegram_id FROM users WHERE telegram_id = ?', [telegramId]);

    if (!row) {
        await run(
            `
            INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, bonus_balance)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [telegramId, firstName, lastName, username, photoUrl, 300]
        );
        return { ok: true, created: true, bonusBalance: 300 };
    }

    await run(
        `
        UPDATE users SET
            first_name = ?,
            last_name = ?,
            username = ?,
            photo_url = ?,
            broadcast_suppressed_reason = NULL,
            broadcast_suppressed_at = NULL
        WHERE telegram_id = ?
        `,
        [firstName, lastName, username, photoUrl, telegramId]
    );
    return { ok: true, created: false };
}

module.exports = {
    upsertTelegramUserFromMessage
};
