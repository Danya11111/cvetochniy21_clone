'use strict';

/**
 * Mini App админка v2: заказы и клиенты по диапазону дат (как dashboard-v2).
 */

const db = require('./db');
const {
    getDashboardPeriodRange,
    getCustomDashboardPeriodRange,
    getAllTimeDashboardPeriodRange,
    getSqlNewClientsFirstOrderInRangeSubquery,
    sqlOrderCreatedJulianDay
} = require('./admin-dashboard-service');
const { orderPaidRevenueKopecksFromRow, kopecksToWholeRub, sqlOrderPaidRevenueKopecks } = require('./money');

const PAID_SQL_OX = `(COALESCE(ox.total_paid,0) > 0 OR UPPER(TRIM(COALESCE(ox.status,''))) IN ('PAID','COMPLETED','DELIVERED'))`;

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

/**
 * @param {Record<string, unknown>} q — req.query
 * @throws {Error} BAD_YMD | RANGE_INVERTED | RANGE_TOO_WIDE
 */
function resolveDashboardLikeRangeFromQuery(q) {
    const ymdRx = /^\d{4}-\d{2}-\d{2}$/;
    const qFrom = String(q.from ?? '').trim();
    const qTo = String(q.to ?? '').trim();
    const rawPeriod = String(q.period ?? '').toLowerCase();

    if (rawPeriod === 'all') {
        return { range: getAllTimeDashboardPeriodRange(), periodApi: 'all' };
    }
    if (qFrom && qTo && ymdRx.test(qFrom) && ymdRx.test(qTo)) {
        return { range: getCustomDashboardPeriodRange(qFrom, qTo), periodApi: 'custom' };
    }
    const periodKey = rawPeriod === '7d' ? '7d' : 'today';
    const range = getDashboardPeriodRange(periodKey);
    return { range, periodApi: periodKey };
}

function orderItemsCount(itemsJson) {
    try {
        const items = JSON.parse(String(itemsJson || '[]'));
        if (!Array.isArray(items)) return 0;
        return items.length;
    } catch (_) {
        return 0;
    }
}

async function listOrdersV2ForRange(range) {
    const rows = await dbAll(
        `
        SELECT id, telegram_id, full_name, phone, status, total, total_paid, items_json, source_code, created_at
        FROM orders
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY id DESC
        LIMIT 400
        `,
        [range.periodStartIso, range.periodEndIso]
    );
    return rows.map((o) => {
        const k = orderPaidRevenueKopecksFromRow(o);
        return {
            id: Number(o.id),
            created_at: o.created_at,
            telegram_id: String(o.telegram_id || ''),
            client_name: String(o.full_name || '').trim() || null,
            status: String(o.status || ''),
            is_paid: k > 0,
            payment_label: k > 0 ? 'Оплачен' : 'Не оплачен',
            amount_kopecks: k,
            amount_rub: kopecksToWholeRub(k),
            items_count: orderItemsCount(o.items_json),
            source_code: o.source_code ? String(o.source_code) : null
        };
    });
}

async function listClientsNewForRange(range) {
    const revExpr = sqlOrderPaidRevenueKopecks('ox');
    const newSub = getSqlNewClientsFirstOrderInRangeSubquery();
    const foOrder = sqlOrderCreatedJulianDay('o2.created_at');
    const rows = await dbAll(
        `
        SELECT
            x.telegram_id,
            (SELECT o2.created_at FROM orders o2
             WHERE TRIM(CAST(o2.telegram_id AS TEXT)) = x.telegram_id
               AND o2.created_at IS NOT NULL
               AND TRIM(COALESCE(o2.created_at, '')) <> ''
             ORDER BY ${foOrder} ASC
             LIMIT 1) AS first_order_at,
            u.first_name,
            u.last_name,
            u.username,
            u.first_source_code,
            u.last_source_code,
            COALESCE(u.bonus_balance, 0) AS bonus_balance,
            (SELECT op.phone FROM orders op
             WHERE TRIM(CAST(op.telegram_id AS TEXT)) = x.telegram_id AND TRIM(COALESCE(op.phone,'')) <> ''
             ORDER BY op.id DESC LIMIT 1) AS phone_hint,
            COALESCE(oc.total_orders, 0) AS total_orders,
            COALESCE(oc.paid_orders, 0) AS paid_orders,
            COALESCE(oc.total_revenue, 0) AS total_revenue
        FROM (${newSub}) x
        LEFT JOIN users u ON TRIM(CAST(u.telegram_id AS TEXT)) = x.telegram_id
        LEFT JOIN (
            SELECT TRIM(CAST(ox.telegram_id AS TEXT)) AS telegram_id,
                COUNT(*) AS total_orders,
                SUM(CASE WHEN (${PAID_SQL_OX}) THEN 1 ELSE 0 END) AS paid_orders,
                COALESCE(SUM((${revExpr})), 0) AS total_revenue
            FROM orders ox
            WHERE ox.telegram_id IS NOT NULL AND TRIM(CAST(ox.telegram_id AS TEXT)) <> ''
            GROUP BY TRIM(CAST(ox.telegram_id AS TEXT))
        ) oc ON oc.telegram_id = x.telegram_id
        ORDER BY first_order_at DESC, x.telegram_id DESC
        LIMIT 500
        `,
        [range.periodStartIso, range.periodEndIso]
    );

    return rows.map((r) => {
        const uid = String(r.telegram_id || '');
        const fn = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
        const display = fn || (r.username ? `@${r.username}` : uid);
        return {
            telegram_id: uid,
            display_name: display,
            first_name: r.first_name || null,
            last_name: r.last_name || null,
            username: r.username || null,
            phone: r.phone_hint ? String(r.phone_hint) : null,
            first_order_at: r.first_order_at || null,
            first_source_code: r.first_source_code ? String(r.first_source_code) : null,
            last_source_code: r.last_source_code ? String(r.last_source_code) : null,
            bonus_balance: Math.round(Number(r.bonus_balance || 0)),
            total_orders: Math.round(Number(r.total_orders || 0)),
            paid_orders: Math.round(Number(r.paid_orders || 0)),
            total_revenue_kopecks: Math.round(Number(r.total_revenue || 0))
        };
    });
}

async function listClientsAllV2() {
    const revExpr = sqlOrderPaidRevenueKopecks('ox');
    const rows = await dbAll(
        `
        SELECT
            ai.telegram_id,
            u.first_name,
            u.last_name,
            u.username,
            u.first_source_code,
            u.last_source_code,
            COALESCE(u.bonus_balance, 0) AS bonus_balance,
            (SELECT op.phone FROM orders op
             WHERE op.telegram_id = ai.telegram_id AND TRIM(COALESCE(op.phone,'')) <> ''
             ORDER BY op.id DESC LIMIT 1) AS phone_hint,
            COALESCE(oc.first_order_at, NULL) AS first_order_at,
            COALESCE(oc.total_orders, 0) AS total_orders,
            COALESCE(oc.paid_orders, 0) AS paid_orders,
            COALESCE(oc.total_revenue, 0) AS total_revenue
        FROM (
            SELECT telegram_id FROM users
            UNION
            SELECT DISTINCT telegram_id FROM orders
            WHERE telegram_id IS NOT NULL AND TRIM(telegram_id) <> ''
        ) ai
        LEFT JOIN users u ON u.telegram_id = ai.telegram_id
        LEFT JOIN (
            SELECT ox.telegram_id,
                MIN(ox.created_at) AS first_order_at,
                MAX(ox.created_at) AS last_order_at,
                COUNT(*) AS total_orders,
                SUM(CASE WHEN (${PAID_SQL_OX}) THEN 1 ELSE 0 END) AS paid_orders,
                COALESCE(SUM((${revExpr})), 0) AS total_revenue
            FROM orders ox
            GROUP BY ox.telegram_id
        ) oc ON oc.telegram_id = ai.telegram_id
        ORDER BY
            COALESCE(oc.last_order_at, '') DESC,
            ai.telegram_id DESC
        LIMIT 800
        `
    );

    return rows.map((r) => {
        const uid = String(r.telegram_id || '');
        const fn = [r.first_name, r.last_name].filter(Boolean).join(' ').trim();
        const display = fn || (r.username ? `@${r.username}` : uid);
        return {
            telegram_id: uid,
            display_name: display,
            first_name: r.first_name || null,
            last_name: r.last_name || null,
            username: r.username || null,
            phone: r.phone_hint ? String(r.phone_hint) : null,
            first_order_at: r.first_order_at || null,
            first_source_code: r.first_source_code ? String(r.first_source_code) : null,
            last_source_code: r.last_source_code ? String(r.last_source_code) : null,
            bonus_balance: Math.round(Number(r.bonus_balance || 0)),
            total_orders: Math.round(Number(r.total_orders || 0)),
            paid_orders: Math.round(Number(r.paid_orders || 0)),
            total_revenue_kopecks: Math.round(Number(r.total_revenue || 0))
        };
    });
}

function pickSourceCode(u, fallbackFirst, fallbackLast) {
    const a = u && u.first_source_code ? String(u.first_source_code) : '';
    const b = u && u.last_source_code ? String(u.last_source_code) : '';
    if (a && b && a !== b) return `${a} → ${b}`;
    if (a) return a;
    if (b) return b;
    if (fallbackFirst) return String(fallbackFirst);
    if (fallbackLast) return String(fallbackLast);
    return null;
}

async function getClientV2Detail(telegramId) {
    const id = String(telegramId || '').trim();
    if (!id) return null;

    const u = await dbGet(`SELECT * FROM users WHERE telegram_id = ? LIMIT 1`, [id]);
    const paidCond = `(COALESCE(o.total_paid,0) > 0 OR UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED'))`;
    const agg = await dbGet(
        `
        SELECT
            COUNT(*) AS total_orders,
            SUM(CASE WHEN ${paidCond} THEN 1 ELSE 0 END) AS paid_orders,
            COALESCE(SUM((${sqlOrderPaidRevenueKopecks('o')})), 0) AS total_revenue,
            MIN(created_at) AS first_order_at,
            MAX(created_at) AS last_order_at
        FROM orders o
        WHERE telegram_id = ?
        `,
        [id]
    );
    if (!u && Math.round(Number(agg?.total_orders || 0)) === 0) return null;

    const src = await dbGet(
        `
        SELECT source_code FROM orders
        WHERE telegram_id = ? AND source_code IS NOT NULL AND TRIM(source_code) <> ''
        ORDER BY id ASC LIMIT 1
        `,
        [id]
    );
    const srcLast = await dbGet(
        `
        SELECT source_code FROM orders
        WHERE telegram_id = ? AND source_code IS NOT NULL AND TRIM(source_code) <> ''
        ORDER BY id DESC LIMIT 1
        `,
        [id]
    );

    const phoneRow = await dbGet(
        `
        SELECT phone FROM orders
        WHERE telegram_id = ? AND TRIM(COALESCE(phone,'')) <> ''
        ORDER BY id DESC LIMIT 1
        `,
        [id]
    );

    const fn = u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() : '';
    const username = u && u.username ? String(u.username) : null;
    const bonus = u ? Math.round(Number(u.bonus_balance || 0)) : 0;

    return {
        telegram_id: id,
        full_name: fn || null,
        username,
        phone: phoneRow && phoneRow.phone ? String(phoneRow.phone) : null,
        source_code: pickSourceCode(u, src && src.source_code, srcLast && srcLast.source_code),
        first_source_code: u && u.first_source_code ? String(u.first_source_code) : (src && src.source_code ? String(src.source_code) : null),
        last_source_code: u && u.last_source_code ? String(u.last_source_code) : (srcLast && srcLast.source_code ? String(srcLast.source_code) : null),
        bonus_balance: bonus,
        total_orders: Math.round(Number(agg?.total_orders || 0)),
        paid_orders: Math.round(Number(agg?.paid_orders || 0)),
        total_revenue_kopecks: Math.round(Number(agg?.total_revenue || 0)),
        first_order_at: agg?.first_order_at || null,
        last_order_at: agg?.last_order_at || null
    };
}

module.exports = {
    resolveDashboardLikeRangeFromQuery,
    listOrdersV2ForRange,
    listClientsNewForRange,
    listClientsAllV2,
    getClientV2Detail
};
