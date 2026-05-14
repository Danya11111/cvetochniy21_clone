'use strict';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_CHARS = 96 * 1024;
const MAX_ITEMS = 80;
const FINAL_STATUSES = new Set(['recovered', 'cleared', 'expired']);

/** @typedef {import('sqlite3').Database} SqliteDb */

function nowIso() {
    return new Date().toISOString();
}

function run(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function safeMetaParse(raw) {
    if (!raw) return {};
    try {
        const o = JSON.parse(String(raw));
        return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch (_) {
        return {};
    }
}

function safeMetaStringify(meta) {
    try {
        return JSON.stringify(meta && typeof meta === 'object' ? meta : {});
    } catch (_) {
        return '{}';
    }
}

function validateCartKey(cartKey) {
    const k = String(cartKey || '').trim();
    if (!k || k.length > 64 || !UUID_V4_RE.test(k)) return null;
    return k;
}

/**
 * Принимаем только «лёгкий» снимок для админки; checkout по-прежнему пересчитывает суммы серверно.
 */
function sanitizeItems(payload) {
    if (!payload) return [];
    if (!Array.isArray(payload)) return null;
    if (payload.length > MAX_ITEMS) return null;
    const out = [];
    for (const it of payload) {
        if (!it || typeof it !== 'object') continue;
        const name = String(it.name || '').trim().slice(0, 240);
        const msId = it.msId != null ? String(it.msId).trim().slice(0, 64) : '';
        const qty = Math.max(0, Math.min(999, Math.round(Number(it.quantity ?? it.qty ?? 1) || 0)));
        if (qty <= 0) continue;
        const priceRub = Number(it.price ?? it.priceRub ?? 0);
        const priceK = Number.isFinite(priceRub) ? Math.round(priceRub * 100) : 0;
        out.push({
            productId: it.productId != null ? Number(it.productId) : null,
            msId,
            name: name || 'Товар',
            price: Number.isFinite(priceRub) ? priceRub : priceK / 100,
            quantity: qty,
            priceKopecksSnapshot: Math.max(0, Math.min(100_000_000, priceK)) * qty
        });
    }
    return out;
}

function totalKopecksFromSanitized(items) {
    return items.reduce((s, it) => s + (Number(it.priceKopecksSnapshot) || 0), 0);
}

function itemsJsonFromSanitized(items) {
    const slim = items.map(({ productId, msId, name, price, quantity }) => ({
        productId,
        msId,
        name,
        price,
        quantity
    }));
    return JSON.stringify(slim);
}

/**
 * @param {{ db: SqliteDb, config: object, telegramClient: object, logger?: Console }} deps
 */
function createAbandonedCartService({ db, config, telegramClient, logger = console }) {
    const enabled = !!config.ABANDONED_CARTS_ENABLED;
    const afterMin = Math.max(1, Number(config.ABANDONED_CART_AFTER_MINUTES) || 30);
    const notifyAfterMin = Math.max(0, Number(config.ABANDONED_CART_NOTIFY_AFTER_MINUTES) || 30);
    const repeatHours = Math.max(1, Number(config.ABANDONED_CART_REPEAT_NOTIFY_HOURS) || 24);
    const maxNotifications = Math.max(0, Number(config.ABANDONED_CART_MAX_NOTIFICATIONS) || 2);
    const expireDays = Math.max(1, Number(config.ABANDONED_CART_EXPIRE_DAYS) || 30);

    const forumChatId = String(config.TELEGRAM_FORUM_GROUP_ID || '').trim();
    const abandonedThreadId = Number(config.TELEGRAM_TOPIC_ABANDONED_CARTS_ID || 0);
    const telegramNotifyEnabled = !!config.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED;

    function parseIsoMs(iso) {
        const t = Date.parse(String(iso || ''));
        return Number.isFinite(t) ? t : null;
    }

    function itemsNonEmpty(itemsJson) {
        const s = String(itemsJson || '').trim();
        if (!s || s === '[]') return false;
        try {
            const a = JSON.parse(s);
            return Array.isArray(a) && a.length > 0;
        } catch (_) {
            return false;
        }
    }

    async function sync(payload) {
        if (!enabled) return { ok: true, skipped: true };
        const raw = JSON.stringify(payload || {});
        if (raw.length > MAX_JSON_CHARS) {
            const err = new Error('PAYLOAD_TOO_LARGE');
            err.code = 'BAD_REQUEST';
            throw err;
        }
        const cartKey = validateCartKey(payload && payload.cart_key);
        if (!cartKey) {
            const err = new Error('BAD_CART_KEY');
            err.code = 'BAD_REQUEST';
            throw err;
        }

        const items = sanitizeItems(payload.items);
        if (items === null) {
            const err = new Error('BAD_ITEMS');
            err.code = 'BAD_REQUEST';
            throw err;
        }

        const tgRaw = payload.telegram_id ?? payload.telegramId;
        const tgUserId =
            tgRaw !== undefined && tgRaw !== null && String(tgRaw).trim() !== ''
                ? String(tgRaw).trim().slice(0, 32)
                : null;
        const iso = nowIso();
        const totalK = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(payload.total_kopecks) || 0));
        const recomputed = totalKopecksFromSanitized(items);
        const snapshotTotal =
            recomputed > 0 ? recomputed : totalK ? Math.min(totalK, 50_000_000) : 0;

        const existing = await get(db, `SELECT id, status, order_id FROM abandoned_carts WHERE cart_key = ?`, [cartKey]);
        if (existing && existing.status === 'recovered') {
            if (items.length > 0) {
                logger.log('[AbandonedCart] sync_skip_recovered_need_new_key', { cartKey: cartKey.slice(0, 8) });
                return { ok: true, ignored: true, reason: 'recovered' };
            }
            return { ok: true };
        }

        if (items.length === 0) {
            if (!existing) return { ok: true, cleared: 'noop' };
            if (!FINAL_STATUSES.has(String(existing.status)) && Number(existing.order_id || 0) <= 0) {
                await run(
                    db,
                    `UPDATE abandoned_carts SET
                        items_json = '[]',
                        total_amount = 0,
                        status = 'cleared',
                        cleared_at = ?,
                        updated_at = ?,
                        tg_user_id = COALESCE(tg_user_id, ?),
                        metadata_json = metadata_json
                     WHERE cart_key = ?`,
                    [iso, iso, tgUserId, cartKey]
                );
            }
            return { ok: true, cleared: true };
        }

        const itemsJson = itemsJsonFromSanitized(items);
        const source = payload.source ? String(payload.source).slice(0, 64) : 'miniapp';
        const ua = payload.user_agent ? String(payload.user_agent).slice(0, 320) : null;

        if (!existing) {
            await run(
                db,
                `INSERT INTO abandoned_carts (
                    cart_key, tg_user_id, customer_name, customer_phone, customer_address,
                    items_json, total_amount, currency, status, order_id, source,
                    user_agent, last_seen_at, checkout_started_at,
                    recovered_at, cleared_at, first_notified_at, last_notified_at,
                    notification_count, next_notification_at, last_error, metadata_json,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?,
                    ?, ?, 'RUB', 'active', NULL, ?,
                    ?, ?, NULL,
                    NULL, NULL, NULL, NULL,
                    0, NULL, NULL, '{}',
                    ?, ?
                )`,
                [
                    cartKey,
                    tgUserId,
                    null,
                    null,
                    null,
                    itemsJson,
                    snapshotTotal,
                    source,
                    ua,
                    iso,
                    iso,
                    iso
                ]
            );
            return { ok: true, created: true };
        }

        await run(
            db,
            `UPDATE abandoned_carts SET
                tg_user_id = COALESCE(?, tg_user_id),
                items_json = ?,
                total_amount = ?,
                source = COALESCE(source, ?),
                user_agent = COALESCE(?, user_agent),
                status = CASE
                    WHEN status IN ('cleared','expired') THEN 'active'
                    ELSE status END,
                last_seen_at = ?,
                cleared_at = NULL,
                recovered_at = NULL,
                order_id = NULL,
                updated_at = ?,
                checkout_started_at = CASE WHEN status IN ('checkout_started','abandoned','notified') THEN checkout_started_at ELSE NULL END
             WHERE cart_key = ?
               AND status != 'recovered'`,
            [tgUserId, itemsJson, snapshotTotal, source, ua, iso, iso, cartKey]
        );
        return { ok: true, updated: true };
    }

    async function checkoutStarted(payload) {
        if (!enabled) return { ok: true, skipped: true };
        const cartKey = validateCartKey(payload && payload.cart_key);
        if (!cartKey) {
            const err = new Error('BAD_CART_KEY');
            err.code = 'BAD_REQUEST';
            throw err;
        }
        const iso = nowIso();
        const name = payload.customer_name != null ? String(payload.customer_name).trim().slice(0, 200) || null : null;
        const phone = payload.customer_phone != null ? String(payload.customer_phone).trim().slice(0, 32) || null : null;
        const address = payload.customer_address != null ? String(payload.customer_address).trim().slice(0, 500) || null : null;

        const row = await get(db, `SELECT id, status FROM abandoned_carts WHERE cart_key = ?`, [cartKey]);
        if (!row || row.status === 'recovered') return { ok: true, noop: true };

        await run(
            db,
            `UPDATE abandoned_carts SET
                status = CASE WHEN status IN ('cleared','expired') THEN status ELSE 'checkout_started' END,
                customer_name = CASE WHEN COALESCE(TRIM(customer_name),'') = '' THEN ? ELSE COALESCE(customer_name, ?) END,
                customer_phone = CASE WHEN COALESCE(TRIM(customer_phone),'') = '' THEN ? ELSE COALESCE(customer_phone, ?) END,
                customer_address = CASE WHEN COALESCE(TRIM(customer_address),'') = '' THEN ? ELSE COALESCE(customer_address, ?) END,
                checkout_started_at = COALESCE(checkout_started_at, ?),
                last_seen_at = ?,
                updated_at = ?
             WHERE cart_key = ? AND status != 'recovered'`,
            [
                name,
                name,
                phone,
                phone,
                address,
                address,
                iso,
                iso,
                iso,
                cartKey
            ]
        );
        return { ok: true };
    }

    /** Не кидает — для вызова после checkout. */
    async function persistRecoveredCart(cartKey, orderId) {
        const oid = Math.round(Number(orderId));
        if (!(oid > 0)) return;
        const iso = nowIso();
        await run(
            db,
            `UPDATE abandoned_carts SET
                    status = 'recovered',
                    order_id = ?,
                    recovered_at = ?,
                    updated_at = ?,
                    next_notification_at = NULL
                 WHERE cart_key = ?
                   AND status != 'cleared'
                   AND status != 'expired'`,
            [oid, iso, iso, cartKey]
        );
    }

    async function recoveredSafe(cartKeyRaw, orderId) {
        if (!enabled || !cartKeyRaw) return;
        const cartKey = validateCartKey(cartKeyRaw);
        const oid = Math.round(Number(orderId));
        if (!cartKey || !(oid > 0)) return;
        try {
            await persistRecoveredCart(cartKey, oid);
        } catch (e) {
            logger.warn('[AbandonedCart] recovered_safe_failed', { message: e.message || String(e), orderId: oid });
        }
    }

    async function markRecovered(payload) {
        if (!enabled) return { ok: true, skipped: true };
        const cartKey = validateCartKey(payload && payload.cart_key);
        const oid = Math.round(Number(payload && payload.order_id));
        if (!cartKey || !(oid > 0)) {
            const err = new Error('BAD_REQUEST');
            err.code = 'BAD_REQUEST';
            throw err;
        }
        try {
            await persistRecoveredCart(cartKey, oid);
        } catch (e) {
            logger.warn('[AbandonedCart] mark_recovered_failed', { message: e.message || String(e), orderId: oid });
            return { ok: false, error: 'PERSIST_FAILED' };
        }
        return { ok: true };
    }

    function formatCartLines(itemsJson) {
        let items = [];
        try {
            items = JSON.parse(String(itemsJson || '[]'));
        } catch (_) {
            return '(состав недоступен)';
        }
        if (!Array.isArray(items)) return '(состав недоступен)';
        return items
            .slice(0, 40)
            .map((it) => {
                const n = String((it && it.name) || 'Товар').trim();
                const q = Number((it && it.quantity) || 1);
                return `• ${n} × ${q}`;
            })
            .join('\n');
    }

    function formatRubFromK(k) {
        const rub = Math.round(Number(k) || 0) / 100;
        return `${rub.toLocaleString('ru-RU')} ₽`;
    }

    /** Plain text only (avoid Markdown parse failures in forum topics). */
    async function sendTelegramNotify(row) {
        if (!telegramNotifyEnabled) {
            return { ok: true, skipped: true, reason: 'TELEGRAM_DISABLED' };
        }
        if (!forumChatId || !(abandonedThreadId > 0)) {
            return { ok: true, skipped: true, reason: 'NO_TOPIC' };
        }
        const text =
            `🛒 Брошенная корзина #${row.id}\n` +
            `Ключ (cart_key): ${String(row.cart_key)}\n` +
            `Статус: ${String(row.status)}\n` +
            `Последняя активность: ${String(row.last_seen_at || '-')}\n` +
            `${row.tg_user_id ? `TG: ${row.tg_user_id}\n` : ''}` +
            `${row.customer_name ? `Имя: ${String(row.customer_name)}\n` : ''}` +
            `${row.customer_phone ? `Телефон: ${String(row.customer_phone)}\n` : ''}` +
            `${row.customer_address ? `Адрес: ${String(row.customer_address)}\n` : ''}` +
            `Сумма (снимок): ${formatRubFromK(row.total_amount)}\n` +
            `Состав:\n${formatCartLines(row.items_json)}\n\n` +
            `Админка: раздел «Брошенные корзины».`;

        try {
            const r = await telegramClient.sendMessage({
                chatId: forumChatId,
                messageThreadId: abandonedThreadId,
                text
            });
            return r;
        } catch (e) {
            logger.error('[AbandonedCart] telegram_send_throw', { message: e.message || String(e) });
            return { ok: false, errorCode: 'SEND_THROW', message: String(e.message || e).slice(0, 400) };
        }
    }

    async function markExpiredRow(id) {
        const iso = nowIso();
        await run(db, `UPDATE abandoned_carts SET status = 'expired', updated_at = ?, next_notification_at = NULL WHERE id = ?`, [
            iso,
            id
        ]);
    }

    async function bumpNotificationRow(id, patch) {
        const iso = nowIso();
        await run(
            db,
            `UPDATE abandoned_carts SET
                notification_count = ?,
                first_notified_at = COALESCE(?, first_notified_at),
                last_notified_at = ?,
                next_notification_at = ?,
                status = ?,
                last_error = ?,
                metadata_json = ?,
                updated_at = ?
             WHERE id = ?`,
            [
                patch.count,
                patch.firstAt,
                patch.lastAt,
                patch.nextAt,
                patch.status,
                patch.err,
                patch.meta || '{}',
                iso,
                id
            ]
        );
    }

    async function scanAndProcess(now = new Date()) {
        if (!enabled) return { scanned: false };
        const nowMs = now.getTime();
        const iso = now.toISOString();
        const expireMs = expireDays * 24 * 60 * 60 * 1000;
        const afterMs = afterMin * 60 * 1000;
        const notifyLagMs = notifyAfterMin * 60 * 1000;
        const repeatMs = repeatHours * 60 * 60 * 1000;

        /** @type {any[]} */
        const candidates = await all(
            db,
            `SELECT * FROM abandoned_carts
             WHERE status NOT IN ('recovered','cleared','expired')
             ORDER BY id ASC
             LIMIT 500`
        );

        let expiredN = 0;
        let abandonedN = 0;
        let notifiedN = 0;

        for (const row of candidates) {
            const createdMs = parseIsoMs(row.created_at);
            if (createdMs != null && nowMs - createdMs > expireMs) {
                await markExpiredRow(row.id);
                expiredN++;
                continue;
            }

            if (!itemsNonEmpty(row.items_json)) continue;

            const lastMs = parseIsoMs(row.last_seen_at);
            if (lastMs == null) continue;

            const status = String(row.status || '');
            let meta = safeMetaParse(row.metadata_json);

            if ((status === 'active' || status === 'checkout_started') && nowMs - lastMs >= afterMs) {
                if (Number(row.order_id || 0) > 0) continue;
                meta = { ...meta, abandonedAt: iso };
                await run(
                    db,
                    `UPDATE abandoned_carts SET status = 'abandoned', metadata_json = ?, updated_at = ? WHERE id = ?`,
                    [safeMetaStringify(meta), iso, row.id]
                );
                row.status = 'abandoned';
                row.metadata_json = safeMetaStringify(meta);
                abandonedN++;
            }
        }

        const itemsJsonNonEmptySql = `LENGTH(COALESCE(items_json, '')) > 2 AND COALESCE(items_json, '') != '[]'`;
        const notifyRows = await all(
            db,
            `SELECT * FROM abandoned_carts
             WHERE status IN ('abandoned','notified')
               AND (${itemsJsonNonEmptySql})
               AND notification_count < ?
               AND (order_id IS NULL OR CAST(order_id AS INTEGER) <= 0)
             ORDER BY id ASC
             LIMIT 50`,
            [maxNotifications]
        );

        if (telegramNotifyEnabled) {
            for (const row of notifyRows) {
                const cnt = Number(row.notification_count || 0);
                if (!(cnt < maxNotifications)) continue;

                const meta = safeMetaParse(row.metadata_json);
                let abandonedAtMs = parseIsoMs(meta.abandonedAt);
                if (abandonedAtMs == null) abandonedAtMs = parseIsoMs(row.updated_at);

                const lastSeenMs = parseIsoMs(row.last_seen_at);
                const idleBaseline = abandonedAtMs != null ? abandonedAtMs : lastSeenMs != null ? lastSeenMs : null;
                if (idleBaseline == null) continue;

                const lastNotMs = parseIsoMs(row.last_notified_at);

                let maySend = false;
                if (cnt === 0) {
                    maySend = nowMs >= idleBaseline + notifyLagMs;
                } else if (lastNotMs != null) {
                    maySend = nowMs >= lastNotMs + repeatMs;
                }

                if (!maySend) continue;

                const tg = await sendTelegramNotify(row);
                if (tg && tg.skipped) continue;
                const isoN = nowIso();
                const firstAt = cnt === 0 ? isoN : null;
                const nextCount = cnt + 1;
                const nextAt =
                    nextCount < maxNotifications && repeatMs > 0 ? new Date(nowMs + repeatMs).toISOString() : null;
                await bumpNotificationRow(row.id, {
                    count: nextCount,
                    firstAt,
                    lastAt: isoN,
                    nextAt,
                    status: 'notified',
                    err: tg && tg.ok ? null : String(tg?.message || tg?.errorCode || 'SEND_FAILED').slice(0, 900),
                    meta: safeMetaParse(row.metadata_json)
                });
                notifiedN++;
            }
        }

        if (expiredN || abandonedN || notifiedN) {
            logger.log('[AbandonedCart] scan_tick', { expiredN, abandonedN, notifiedN });
        }
        return { scanned: true, expiredN, abandonedN, notifiedN };
    }

    async function notifyNowAdmin(id, actorTgId) {
        void actorTgId;
        const row = await get(db, `SELECT * FROM abandoned_carts WHERE id = ?`, [Number(id)]);
        if (!row) return { ok: false, error: 'NOT_FOUND' };
        if (!itemsNonEmpty(row.items_json)) return { ok: false, error: 'EMPTY_CART' };
        const st = String(row.status || '');
        if (st === 'recovered' || st === 'cleared' || st === 'expired') return { ok: false, error: 'BAD_STATUS' };
        if (Number(row.notification_count || 0) >= maxNotifications) return { ok: false, error: 'NOTIFY_LIMIT' };

        if (!telegramNotifyEnabled) {
            return { ok: false, error: 'TELEGRAM_NOTIFICATIONS_DISABLED' };
        }

        const tg = await sendTelegramNotify(row);
        if (tg && tg.skipped) return { ok: false, error: 'TELEGRAM_NOTIFICATIONS_SKIP' };
        const isoN = nowIso();
        const cnt = Number(row.notification_count || 0) + 1;
        await bumpNotificationRow(row.id, {
            count: cnt,
            firstAt: cnt === 1 ? isoN : null,
            lastAt: isoN,
            nextAt:
                cnt < maxNotifications ? new Date(Date.now() + repeatHours * 60 * 60 * 1000).toISOString() : null,
            status: 'notified',
            err: tg && tg.ok ? null : String(tg?.message || tg?.errorCode || 'SEND_FAILED').slice(0, 900),
            meta: safeMetaParse(row.metadata_json)
        });
        return { ok: !!(tg && tg.ok), telegram: tg };
    }

    async function adminList({ status = '', limit = 100 } = {}) {
        const lim = Math.min(250, Math.max(1, Math.round(Number(limit) || 100)));
        let sql = `SELECT id, cart_key, tg_user_id, customer_name, customer_phone, customer_address,
                          items_json, total_amount, currency, status, order_id, source,
                          user_agent, last_seen_at, checkout_started_at, recovered_at, cleared_at,
                          first_notified_at, last_notified_at, notification_count, next_notification_at, last_error,
                          metadata_json, created_at, updated_at
                   FROM abandoned_carts`;
        const params = [];
        const st = String(status || '').trim().toLowerCase();
        const allowed = new Set(['active', 'checkout_started', 'abandoned', 'notified', 'recovered', 'cleared', 'expired']);
        if (st && allowed.has(st)) {
            sql += ` WHERE status = ?`;
            params.push(st);
        }
        sql += ` ORDER BY last_seen_at DESC LIMIT ?`;
        params.push(lim);
        return all(db, sql, params);
    }

    async function adminGetOne(id) {
        return get(db, `SELECT * FROM abandoned_carts WHERE id = ?`, [Number(id)]);
    }

    async function adminMarkExpired(id) {
        const row = await get(db, `SELECT id, status FROM abandoned_carts WHERE id = ?`, [Number(id)]);
        if (!row) return { ok: false, error: 'NOT_FOUND' };
        if (row.status === 'recovered') return { ok: false, error: 'BAD_STATUS' };
        await markExpiredRow(row.id);
        return { ok: true };
    }

    /** Агрегаты для дашборда Mini App — снимок сейчас (без временного фильтра). */
    async function fetchSummaryCounts() {
        return fetchAbandonedCartDashboardSnapshot(db);
    }

    return {
        sync,
        checkoutStarted,
        recoveredSafe,
        markRecovered,
        scanAndProcess,
        notifyNowAdmin,
        adminList,
        adminGetOne,
        adminMarkExpired,
        fetchSummaryCounts,
        itemsNonEmpty
    };
}

/**
 * Snapshot по `abandoned_carts` (для админ‑дашборда / API).
 * @param {import('sqlite3').Database} database
 */
async function fetchAbandonedCartDashboardSnapshot(database) {
    const rows = await all(
        database,
        `SELECT status, COUNT(*) AS c, COALESCE(SUM(total_amount), 0) AS sum_kopecks FROM abandoned_carts GROUP BY status`
    );
    /** @type {Record<string, number>} */
    const by = {};
    /** @type {Record<string, number>} */
    const sumKopecksByStatusKey = {};
    for (const r of rows || []) {
        const st = String(r.status);
        by[st] = Math.round(Number(r.c || 0));
        sumKopecksByStatusKey[st] = Math.round(Number(r.sum_kopecks || 0));
    }
    const recovered = Number(by.recovered || 0);
    const abandoned = Number(by.abandoned || 0);
    const notified = Number(by.notified || 0);
    const denom = Math.max(1, abandoned + notified + recovered);
    const recoveryVsAbandonPct = Math.round((recovered / denom) * 1000) / 10;

    const problemStatuses = ['active', 'checkout_started', 'abandoned', 'notified'];
    let problemTotalKopecks = 0;
    let problemCartsCount = 0;
    for (const st of problemStatuses) {
        problemTotalKopecks += Number(sumKopecksByStatusKey[st] || 0);
        problemCartsCount += Number(by[st] || 0);
    }

    let problemLastErrors = [];
    try {
        const errRows = await all(
            database,
            `SELECT DISTINCT TRIM(last_error) AS err
             FROM abandoned_carts
             WHERE status IN ('active','checkout_started','abandoned','notified')
               AND last_error IS NOT NULL
               AND LENGTH(TRIM(last_error)) > 0
             LIMIT 5`
        );
        problemLastErrors = (errRows || [])
            .map((r) => String(r.err || '').trim().slice(0, 400))
            .filter(Boolean);
    } catch (_) {
        problemLastErrors = [];
    }

    return {
        active: Number(by.active || 0) + Number(by.checkout_started || 0),
        activeOnly: Number(by.active || 0),
        checkout_started: Number(by.checkout_started || 0),
        abandoned,
        notified,
        recovered,
        cleared: Number(by.cleared || 0),
        expired: Number(by.expired || 0),
        recoveryVsAbandonPct,
        totalsByStatus: by,
        problemTotalKopecks,
        problemCartsCount,
        sumKopecksByStatus: {
            active: Number(sumKopecksByStatusKey.active || 0),
            checkout_started: Number(sumKopecksByStatusKey.checkout_started || 0),
            abandoned: Number(sumKopecksByStatusKey.abandoned || 0),
            notified: Number(sumKopecksByStatusKey.notified || 0)
        },
        problemLastErrors
    };
}

/** Для юнит-тестов: та же фильтрация items */
createAbandonedCartService.UUID_V4_RE = UUID_V4_RE;
createAbandonedCartService.sanitizeItemsForTest = sanitizeItems;
createAbandonedCartService.validateCartKeyForTest = validateCartKey;

module.exports = {
    createAbandonedCartService,
    fetchAbandonedCartDashboardSnapshot
};
