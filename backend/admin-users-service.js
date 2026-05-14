'use strict';

const db = require('./db');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/**
 * @param {import('./config')} config
 */
function createAdminUsersService(config, { logger = console } = {}) {
    const ownerId =
        String(config.ADMIN_OWNER_TG_ID || config.ADMIN_PRIMARY_TELEGRAM_ID || '').trim() || '67460775';

    async function countRows() {
        const row = await get('SELECT COUNT(*) AS c FROM admin_users');
        return Number(row && row.c) || 0;
    }

    /**
     * Первичный seed: пустая таблица → владелец + ADMIN_INITIAL_TG_IDS + legacy CSV из env (если заданы).
     */
    async function bootstrapIfNeeded() {
        const n = await countRows();
        const envInitial = Array.isArray(config.ADMIN_INITIAL_TG_IDS_LIST) ? config.ADMIN_INITIAL_TG_IDS_LIST : [];
        const envMergedAdmins = Array.isArray(config.ADMIN_TELEGRAM_IDS) ? config.ADMIN_TELEGRAM_IDS.map(String) : [];
        const iso = new Date().toISOString();

        if (n === 0) {
            const uniq = new Set(
                [
                    ownerId,
                    ...envInitial.map((x) => String(x || '').trim()).filter(Boolean),
                    ...envMergedAdmins.map((x) => String(x || '').trim()).filter(Boolean)
                ].filter(Boolean)
            );
            for (const tid of uniq) {
                await run(
                    `INSERT OR IGNORE INTO admin_users (telegram_id, created_at, created_by_telegram_id, is_owner)
                     VALUES (?, ?, ?, ?)`,
                    [String(tid), iso, 'bootstrap', tid === ownerId ? 1 : 0]
                );
            }
            logger.log('[AdminUsers] bootstrap_seeded', { count: uniq.size, ownerId });
            return;
        }

        await run(
            `INSERT OR IGNORE INTO admin_users (telegram_id, created_at, created_by_telegram_id, is_owner)
             VALUES (?, ?, ?, 1)`,
            [ownerId, iso, 'bootstrap_owner']
        );
    }

    async function isAllowedTelegramId(telegramId) {
        const tid = String(telegramId || '').trim();
        if (!tid) return false;
        if (tid === ownerId) return true;
        const row = await get('SELECT 1 AS ok FROM admin_users WHERE telegram_id = ? LIMIT 1', [tid]);
        return !!(row && row.ok);
    }

    async function listAdmins() {
        const rows = await all(
            `SELECT telegram_id, is_owner, created_at, created_by_telegram_id
             FROM admin_users
             ORDER BY is_owner DESC, telegram_id ASC`
        );
        return rows.map((r) => ({
            telegram_id: String(r.telegram_id),
            is_owner: Number(r.is_owner) === 1,
            created_at: r.created_at || null,
            created_by_telegram_id: r.created_by_telegram_id || null
        }));
    }

    async function addAdmin(telegramId, actorTgId) {
        const tid = String(telegramId || '').trim();
        if (!/^\d+$/.test(tid)) {
            const err = new Error('BAD_TELEGRAM_ID');
            err.code = 'BAD_TELEGRAM_ID';
            throw err;
        }
        if (tid === ownerId) {
            const err = new Error('OWNER_ALREADY');
            err.code = 'OWNER_ALREADY';
            throw err;
        }
        const iso = new Date().toISOString();
        const r = await run(
            `INSERT OR IGNORE INTO admin_users (telegram_id, created_at, created_by_telegram_id, is_owner)
             VALUES (?, ?, ?, 0)`,
            [tid, iso, String(actorTgId || '').trim() || null]
        );
        if (!r.changes) {
            const err = new Error('ALREADY_ADMIN');
            err.code = 'ALREADY_ADMIN';
            throw err;
        }
    }

    async function removeAdmin(telegramId, actorTgId) {
        const tid = String(telegramId || '').trim();
        if (tid === ownerId) {
            const err = new Error('CANNOT_REMOVE_OWNER');
            err.code = 'CANNOT_REMOVE_OWNER';
            throw err;
        }
        const r = await run('DELETE FROM admin_users WHERE telegram_id = ? AND is_owner = 0', [tid]);
        if (!r.changes) {
            const err = new Error('NOT_FOUND');
            err.code = 'NOT_FOUND';
            throw err;
        }
    }

    function getOwnerTelegramId() {
        return ownerId;
    }

    function isOwnerTelegramId(telegramId) {
        return String(telegramId || '').trim() === ownerId;
    }

    return {
        bootstrapIfNeeded,
        isAllowedTelegramId,
        listAdmins,
        addAdmin,
        removeAdmin,
        getOwnerTelegramId,
        isOwnerTelegramId
    };
}

module.exports = {
    createAdminUsersService
};
