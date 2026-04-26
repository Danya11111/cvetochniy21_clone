const db = require('./db');

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function toBool(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function createRuntimeFlagsService({ config }) {
    const managedKeys = [
        'TELEGRAM_TOPICS_ENABLED',
        'EVENT_OUTBOX_ENABLED',
        'OUTBOX_WORKER_ENABLED',
        'BROADCASTS_ENABLED',
        'BROADCAST_DELETE_ENABLED',
        'SUPPORT_RELAY_ENABLED',
        'ORDERS_TOPIC_NOTIFICATIONS_ENABLED',
        'CLIENT_TOPIC_REPLY_ENABLED'
    ];

    function defaults() {
        const out = {};
        for (const key of managedKeys) out[key] = !!config[key];
        return out;
    }

    async function getAll() {
        const rows = await all('SELECT key, value, updated_by, updated_at FROM runtime_flags', []);
        const d = defaults();
        for (const r of rows) {
            if (!managedKeys.includes(r.key)) continue;
            d[r.key] = toBool(r.value);
        }
        return d;
    }

    async function patch(partial, updatedBy) {
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(partial || {})) {
            if (!managedKeys.includes(k)) continue;
            await run(
                `
                INSERT INTO runtime_flags (key, value, updated_by, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_by = excluded.updated_by,
                    updated_at = excluded.updated_at
                `,
                [k, v ? 'true' : 'false', String(updatedBy || ''), now]
            );
        }
        return getAll();
    }

    return {
        managedKeys,
        defaults,
        getAll,
        patch
    };
}

module.exports = {
    createRuntimeFlagsService
};

