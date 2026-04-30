'use strict';

/**
 * Telegram admin dashboard — SQL и агрегаты (без Bot API).
 * Денежные суммы в метриках периода — целые рубли (округление от копеек), как formatKopecksRu / kopecksToWholeRub.
 */

const db = require('./db');
const {
    orderPaidRevenueKopecksFromRow,
    kopecksToWholeRub,
    sqlOrderPaidRevenueKopecks
} = require('./money');

/** Должно совпадать с order-status.js (алиас o). */
const PAID_SQL_O = `(COALESCE(o.total_paid,0) > 0 OR UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED'))`;
const CANCELLED_SQL_O = `(UPPER(TRIM(COALESCE(o.status,''))) IN ('CANCELLED','CANCELED','FAILED','ERROR') OR UPPER(COALESCE(o.status,'')) LIKE '%CANCEL%')`;

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/** Тот же union allowlist, что и admin-auth (без проверки initData). */
function getAdminTelegramIdSet(config) {
    const ids = [...(config.ADMIN_TELEGRAM_IDS || []), ...(config.TELEGRAM_ADMIN_IDS || [])];
    return new Set(ids.map(String).filter(Boolean));
}

function isAdminTelegramId(rawId, config) {
    const id = String(rawId ?? '').trim();
    if (!id) return false;
    return getAdminTelegramIdSet(config).has(id);
}

/** DD.MM.YYYY в локальной TZ процесса. */
function formatRuDate(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(dt.getDate())}.${pad(dt.getMonth() + 1)}.${dt.getFullYear()}`;
}

/**
 * @param {'today'|'7d'} periodKey
 * @returns {{ periodKey: string, periodStart: Date, periodEnd: Date, periodStartIso: string, periodEndIso: string, labelFrom: string, labelTo: string }}
 */
function getDashboardPeriodRange(periodKey, now = new Date()) {
    const periodEnd = new Date(now.getTime());
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    let periodStart;
    if (periodKey === 'today') {
        periodStart = new Date(todayStart.getTime());
    } else {
        periodStart = new Date(todayStart.getTime());
        periodStart.setDate(periodStart.getDate() - 6);
    }

    let labelFrom;
    let labelTo;
    if (periodKey === 'today') {
        const day = formatRuDate(todayStart);
        labelFrom = day;
        labelTo = day;
    } else {
        labelFrom = formatRuDate(periodStart);
        labelTo = formatRuDate(now);
    }

    return {
        periodKey,
        periodStart,
        periodEnd,
        periodStartIso: periodStart.toISOString(),
        periodEndIso: periodEnd.toISOString(),
        labelFrom,
        labelTo
    };
}

/** @param {string} ymd */
function parseYmdPartsStrict(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { y, mo, d };
}

/**
 * Диапазон по календарным дням в локальной TZ процесса: с 00:00:00 «from» до 23:59:59.999 «to».
 * @throws {Error} BAD_YMD | RANGE_INVERTED | RANGE_TOO_WIDE
 */
function getCustomDashboardPeriodRange(fromYmd, toYmd) {
    const pf = parseYmdPartsStrict(fromYmd);
    const pt = parseYmdPartsStrict(toYmd);
    if (!pf || !pt) {
        throw new Error('BAD_YMD');
    }
    const periodStart = new Date(pf.y, pf.mo - 1, pf.d, 0, 0, 0, 0);
    const periodEnd = new Date(pt.y, pt.mo - 1, pt.d, 23, 59, 59, 999);
    if (periodStart.getTime() > periodEnd.getTime()) {
        throw new Error('RANGE_INVERTED');
    }
    const maxMs = 366 * 24 * 60 * 60 * 1000;
    if (periodEnd.getTime() - periodStart.getTime() > maxMs) {
        throw new Error('RANGE_TOO_WIDE');
    }
    return {
        periodKey: 'custom',
        periodStart,
        periodEnd,
        periodStartIso: periodStart.toISOString(),
        periodEndIso: periodEnd.toISOString(),
        labelFrom: formatRuDate(periodStart),
        labelTo: formatRuDate(periodEnd)
    };
}

function isPaidOrderRow(row) {
    return orderPaidRevenueKopecksFromRow(row) > 0;
}

/** Парсинг позиций заказа для топа (оставляем в сервисе рядом с SQL). */
function extractItemContribution(item) {
    if (!item || typeof item !== 'object') return null;
    const nameRaw = item.name ?? item.title ?? item.productName ?? '';
    const name = String(nameRaw || 'Товар').trim() || 'Товар';
    let qty = item.quantity ?? item.qty ?? item.count ?? 1;
    const n = Number(qty);
    const q = Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
    return { name, qty: q };
}

function aggregateTopProductsFromOrders(orderRows) {
    const counts = new Map();
    for (const row of orderRows) {
        if (!isPaidOrderRow(row)) continue;
        let items = [];
        try {
            items = JSON.parse(String(row.items_json || '[]'));
        } catch (_) {
            continue;
        }
        if (!Array.isArray(items)) continue;
        for (const it of items) {
            const ext = extractItemContribution(it);
            if (!ext) continue;
            counts.set(ext.name, (counts.get(ext.name) || 0) + ext.qty);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

/**
 * Все агрегаты для произвольного диапазона [periodStartIso, periodEndIso] (как у preset-периода).
 */
async function fetchDashboardMetricsForRange(range) {
    const { periodStartIso, periodEndIso } = range;

    const revExpr = sqlOrderPaidRevenueKopecks('o');

    const [
        orderRows,
        lifetimeRow,
        newClientsRow,
        usersRow,
        ordersDistinctRow,
        ordersRepeatInPeriodRow,
        supportRow,
        paidInPeriodRow,
        paidCancelledInPeriodRow
    ] = await Promise.all([
        dbAll(
            `
            SELECT id, telegram_id, created_at, status, total, total_paid, items_json
            FROM orders
            WHERE created_at >= ? AND created_at <= ?
            `,
            [periodStartIso, periodEndIso]
        ),
        dbGet(
            `
            SELECT
                COALESCE(SUM((${revExpr})), 0) AS revenue_k,
                COUNT(DISTINCT CASE WHEN (${revExpr}) > 0 THEN o.telegram_id END) AS paying_clients
            FROM orders o
            `,
            []
        ),
        dbGet(
            `
            SELECT COUNT(*) AS c
            FROM (
                SELECT telegram_id
                FROM orders
                GROUP BY telegram_id
                HAVING MIN(created_at) >= ? AND MIN(created_at) <= ?
            ) t
            `,
            [periodStartIso, periodEndIso]
        ),
        dbGet(`SELECT COUNT(*) AS c FROM users`, []),
        dbGet(`SELECT COUNT(DISTINCT telegram_id) AS c FROM orders`, []),
        dbGet(
            `
            SELECT COUNT(*) AS c
            FROM orders o
            WHERE o.created_at >= ? AND o.created_at <= ?
              AND (SELECT COUNT(*) FROM orders ox WHERE ox.telegram_id = o.telegram_id) > 1
            `,
            [periodStartIso, periodEndIso]
        ),
        dbGet(
            `
            SELECT AVG(
                (julianday(first_response_at) - julianday(created_at)) * 24 * 60
            ) AS avg_minutes
            FROM support_threads
            WHERE created_at >= ? AND created_at <= ?
              AND first_response_at IS NOT NULL
              AND TRIM(first_response_at) <> ''
            `,
            [periodStartIso, periodEndIso]
        ),
        dbGet(
            `
            SELECT COUNT(*) AS c
            FROM orders o
            WHERE o.created_at >= ? AND o.created_at <= ?
              AND (${PAID_SQL_O})
            `,
            [periodStartIso, periodEndIso]
        ),
        dbGet(
            `
            SELECT COUNT(*) AS c
            FROM orders o
            WHERE o.created_at >= ? AND o.created_at <= ?
              AND (${PAID_SQL_O})
              AND (${CANCELLED_SQL_O})
            `,
            [periodStartIso, periodEndIso]
        )
    ]);

    const orderRowsArr = orderRows;
    const allOrders = orderRowsArr.length;
    const paidOrderRows = orderRowsArr.filter(isPaidOrderRow);
    const paidOrders = paidOrderRows.length;
    const revenueK = paidOrderRows.reduce((acc, r) => acc + orderPaidRevenueKopecksFromRow(r), 0);
    const revenueRub = kopecksToWholeRub(revenueK);
    const avgCheckRub = paidOrders > 0 ? Math.round(revenueRub / paidOrders) : 0;
    const avgCheckKopecks = paidOrders > 0 ? Math.round(revenueK / paidOrders) : 0;

    /**
     * Proxy CR: доля оплаченных среди созданных в периоде (не визит → покупка).
     */
    const crPct = allOrders > 0 ? Math.round((paidOrders / allOrders) * 1000) / 10 : 0;
    const repeatSharePct =
        allOrders > 0 ? Math.round((Number(ordersRepeatInPeriodRow?.c || 0) / allOrders) * 1000) / 10 : 0;

    let usersTotal = Number(usersRow?.c || 0);
    if (!Number.isFinite(usersTotal) || usersTotal <= 0) {
        usersTotal = Number(ordersDistinctRow?.c || 0);
    }

    const lifetimeRevenueK = Math.round(Number(lifetimeRow?.revenue_k || 0));
    const payingClientsLifetime = Math.round(Number(lifetimeRow?.paying_clients || 0));
    const avgLtvRub = payingClientsLifetime > 0 ? Math.round(kopecksToWholeRub(lifetimeRevenueK) / payingClientsLifetime) : 0;
    const avgLtvKopecks = payingClientsLifetime > 0 ? Math.round(lifetimeRevenueK / payingClientsLifetime) : 0;
    const avgResp = supportRow?.avg_minutes;
    const avgResponseMinutes =
        avgResp != null && Number.isFinite(Number(avgResp)) ? Math.round(Number(avgResp)) : null;

    /**
     * paid_cancelled_orders / paid_orders в периоде;
     * PAID_SQL_O + CANCELLED_SQL_O как в order-status (без отдельного refund в БД).
     */
    const paidDen = Number(paidInPeriodRow?.c || 0);
    const paidCancelled = Number(paidCancelledInPeriodRow?.c || 0);
    let returnsAfterPayPct = null;
    if (paidDen > 0) {
        returnsAfterPayPct = Math.round((paidCancelled / paidDen) * 1000) / 10;
    }

    const topProducts = aggregateTopProductsFromOrders(orderRowsArr);

    return {
        revenueKopecks: revenueK,
        revenueRub,
        ordersTotal: allOrders,
        paidOrders,
        avgCheckRub,
        avgCheckKopecks,
        newClients: Math.round(Number(newClientsRow?.c || 0)),
        clientsTotal: usersTotal,
        crPct,
        repeatSharePct,
        avgLtvRub,
        avgLtvKopecks,
        avgResponseMinutes,
        returnsAfterPayPct,
        topProducts
    };
}

/**
 * @param {'today'|'7d'} periodKey
 */
async function fetchDashboardMetrics(periodKey) {
    const range = getDashboardPeriodRange(periodKey);
    const metrics = await fetchDashboardMetricsForRange(range);
    return { range, ...metrics };
}

/**
 * Ответ Mini App для GET /api/admin/dashboard-v2:
 * (?period=today|7d) или (?from=YYYY-MM-DD&to=YYYY-MM-DD).
 */
async function getDashboardV2ApiPayload(opts) {
    /** @type {ReturnType<typeof getDashboardPeriodRange>|ReturnType<typeof getCustomDashboardPeriodRange>} */
    let range;
    /** @type {string} */
    let periodApi;

    if (opts && typeof opts === 'object' && opts.fromYmd && opts.toYmd) {
        range = getCustomDashboardPeriodRange(String(opts.fromYmd).trim(), String(opts.toYmd).trim());
        periodApi = 'custom';
    } else {
        const pk = opts === '7d' || (opts && opts.periodKey === '7d') ? '7d' : 'today';
        range = getDashboardPeriodRange(pk);
        periodApi = pk;
    }

    const m = await fetchDashboardMetricsForRange(range);
    return {
        period: periodApi,
        range: {
            from: range.periodStartIso,
            to: range.periodEndIso,
            label: `${range.labelFrom} — ${range.labelTo}`
        },
        metrics: {
            revenueKopecks: Math.round(Number(m.revenueKopecks || 0)),
            ordersCount: m.ordersTotal,
            paidOrdersCount: m.paidOrders,
            averageCheckKopecks: Math.round(Number(m.avgCheckKopecks || 0)),
            newClientsCount: m.newClients,
            clientsTotalCount: m.clientsTotal,
            crPercent: m.crPct,
            repeatOrdersPercent: m.repeatSharePct,
            averageLtvKopecks: Math.round(Number(m.avgLtvKopecks || 0)),
            avgFirstResponseMinutes:
                m.avgResponseMinutes == null ? null : Math.round(Number(m.avgResponseMinutes)),
            abandonedCarts: null,
            paidCancelledPercent: m.returnsAfterPayPct
        },
        topProducts: (Array.isArray(m.topProducts) ? m.topProducts : []).map(([name, qty]) => ({
            name: String(name || ''),
            quantity: Math.round(Number(qty || 0))
        })),
        sources: []
    };
}

module.exports = {
    getAdminTelegramIdSet,
    isAdminTelegramId,
    getDashboardPeriodRange,
    getCustomDashboardPeriodRange,
    fetchDashboardMetricsForRange,
    fetchDashboardMetrics,
    getDashboardV2ApiPayload,
    formatRuDate
};
