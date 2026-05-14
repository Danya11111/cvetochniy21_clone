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
const { fetchAbandonedCartDashboardSnapshot } = require('./abandoned-cart-service');

/** Должно совпадать с order-status.js (алиас o). */
const PAID_SQL_O = `(COALESCE(o.total_paid,0) > 0 OR UPPER(TRIM(COALESCE(o.status,''))) IN ('PAID','COMPLETED','DELIVERED'))`;

const DASHBOARD_SYSTEM_NONE_CODE = '__none__';
/** Пользовательский заголовок для bucket без трекинга (не ошибка данных). */
const DASHBOARD_SYSTEM_NONE_TITLE = 'Не определено';
const DASHBOARD_LEGACY_SOURCES_NOTE =
    'Для клиентов, пришедших до внедрения трекинга, источник может быть не определён.';
const DASHBOARD_TOP_SOURCES_LIMIT = 5;

/**
 * Julian day для created_at заказа: не полагаться на MIN(created_at) как TEXT —
 * при смеси '…T…Z' и 'YYYY-MM-DD HH:MM:SS' лексикографический MIN неверен.
 * @param {string} colRef например `created_at` или `o.created_at`
 */
function sqlOrderCreatedJulianDay(colRef) {
    const c = String(colRef || 'created_at').trim() || 'created_at';
    const cast = `trim(cast(${c} AS TEXT))`;
    return `COALESCE(
        julianday(${c}),
        julianday(replace(substr(replace(${cast}, 'Z', ''), 1, 19), 'T', ' ')),
        julianday(substr(replace(${cast}, 'Z', ''), 1, 10))
    )`;
}

/**
 * Julian day для users.first_seen_at (TEXT ISO / локальные форматы).
 * @param {string} colRef например `u.first_seen_at`
 */
function sqlUserFirstSeenJulianDay(colRef) {
    const c = String(colRef || 'first_seen_at').trim() || 'first_seen_at';
    const cast = `trim(cast(${c} AS TEXT))`;
    return `COALESCE(
        julianday(${c}),
        julianday(replace(substr(replace(${cast}, 'Z', ''), 1, 19), 'T', ' ')),
        julianday(substr(replace(${cast}, 'Z', ''), 1, 10))
    )`;
}

/**
 * Устойчивая оценка «первого появления» для аналитики и legacy-БД без корректного first_seen_at.
 * Не мутирует данные — только SQL-выражение для SELECT/WHERE.
 */
function sqlUserEffectiveFirstSeenAtExpr(alias = 'u') {
    const a = alias;
    const ordMin = `(SELECT o.created_at FROM orders o
        WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(${a}.telegram_id AS TEXT))
          AND o.created_at IS NOT NULL AND TRIM(COALESCE(o.created_at, '')) <> ''
        ORDER BY ${sqlOrderCreatedJulianDay('o.created_at')} ASC
        LIMIT 1)`;
    const supMin = `(SELECT sm.created_at FROM support_messages sm
        INNER JOIN support_threads st ON st.id = sm.thread_id
        WHERE TRIM(CAST(st.telegram_user_id AS TEXT)) = TRIM(CAST(${a}.telegram_id AS TEXT))
          AND sm.created_at IS NOT NULL AND TRIM(COALESCE(sm.created_at, '')) <> ''
        ORDER BY sm.id ASC
        LIMIT 1)`;
    const thrMin = `(SELECT st2.created_at FROM support_threads st2
        WHERE TRIM(CAST(st2.telegram_user_id AS TEXT)) = TRIM(CAST(${a}.telegram_id AS TEXT))
          AND st2.created_at IS NOT NULL AND TRIM(COALESCE(st2.created_at, '')) <> ''
        ORDER BY ${sqlOrderCreatedJulianDay('st2.created_at')} ASC
        LIMIT 1)`;
    return `
        COALESCE(
            NULLIF(TRIM(CAST(${a}.first_seen_at AS TEXT)), ''),
            NULLIF(TRIM(CAST(${a}.created_at AS TEXT)), ''),
            ${ordMin},
            ${supMin},
            ${thrMin}
        )
    `;
}

/**
 * Bucket источника для новых клиентов: профиль (first/last), иначе source_code первого заказа,
 * иначе __none__ (честный «не определено» для legacy без трекинга).
 */
function sqlUserSourceBucketExpr(alias = 'u') {
    const a = alias;
    const none = `'${DASHBOARD_SYSTEM_NONE_CODE}'`;
    const firstOrderSrc = `(
        SELECT TRIM(o.source_code) FROM orders o
        WHERE TRIM(CAST(o.telegram_id AS TEXT)) = TRIM(CAST(${a}.telegram_id AS TEXT))
          AND o.source_code IS NOT NULL AND TRIM(COALESCE(o.source_code, '')) <> ''
        ORDER BY o.id ASC
        LIMIT 1
    )`;
    return `
        CASE
            WHEN NULLIF(TRIM(COALESCE(${a}.first_source_code, '')), '') IS NOT NULL
                THEN TRIM(${a}.first_source_code)
            WHEN NULLIF(TRIM(COALESCE(${a}.last_source_code, '')), '') IS NOT NULL
                THEN TRIM(${a}.last_source_code)
            WHEN NULLIF(TRIM(COALESCE(${firstOrderSrc}, '')), '') IS NOT NULL
                THEN TRIM(${firstOrderSrc})
            ELSE ${none}
        END
    `;
}

/**
 * Пользователи, у которых effective-first-seen попадает в период (julianday границы как у dashboard).
 */
function getSqlNewUsersInPeriodSubquery() {
    const eff = sqlUserEffectiveFirstSeenAtExpr('u');
    const jd = sqlUserFirstSeenJulianDay(`(${eff})`);
    return `
        SELECT TRIM(CAST(u.telegram_id AS TEXT)) AS telegram_id
        FROM users u
        WHERE u.telegram_id IS NOT NULL
          AND TRIM('' || u.telegram_id) <> ''
          AND TRIM(COALESCE((${eff}), '')) <> ''
          AND (${jd}) IS NOT NULL
          AND (${jd}) >= julianday(?)
          AND (${jd}) <= julianday(?)
    `;
}

/**
 * @deprecated Использовалось для старой логики «первый заказ»; оставлено для совместимости тестовых импортов.
 */
function getSqlNewClientsFirstOrderInRangeSubquery() {
    return getSqlNewUsersInPeriodSubquery();
}

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

/** Начало диапазона «за всё время» в отчётах Mini App (локальная дата). */
const ALL_TIME_REPORTS_START_YMD = '2025-01-01';

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

/**
 * Пресет «за всё время»: с 01.01.2025 00:00 (локально) до текущего момента.
 */
function getAllTimeDashboardPeriodRange(now = new Date()) {
    const pf = parseYmdPartsStrict(ALL_TIME_REPORTS_START_YMD);
    if (!pf) {
        throw new Error('BAD_YMD');
    }
    const periodStart = new Date(pf.y, pf.mo - 1, pf.d, 0, 0, 0, 0);
    const periodEnd = new Date(now.getTime());
    return {
        periodKey: 'all',
        periodStart,
        periodEnd,
        periodStartIso: periodStart.toISOString(),
        periodEndIso: periodEnd.toISOString(),
        labelFrom: formatRuDate(periodStart),
        labelTo: formatRuDate(now)
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

function extractItemImageUrl(item) {
    if (!item || typeof item !== 'object') return null;
    const keys = ['image_url', 'imageUrl', 'image', 'picture', 'photo', 'thumb', 'thumbnail', 'img'];
    for (const k of keys) {
        const v = item[k];
        if (typeof v === 'string' && v.trim()) return normalizeProductMediaUrl(v.trim());
        if (Array.isArray(v) && v.length) {
            const first = v.find((x) => typeof x === 'string' && x.trim());
            if (first) return normalizeProductMediaUrl(first.trim());
        }
    }
    return null;
}

/**
 * Нормализует относительные пути медиа до корневых URL мини-приложения (и мини-админки на том же origin).
 * Отмены/возвраты в бизнес-логике проекта намеренно не поддерживаются — этот слой только про отображение витрины/дашборда.
 */
function normalizeProductMediaUrl(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    if (s.startsWith('/')) return s;
    return `/${s}`;
}

function firstImageFromProductsJson(raw) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(String(raw));
        if (Array.isArray(parsed)) {
            for (const el of parsed) {
                if (typeof el === 'string' && el.trim()) return normalizeProductMediaUrl(el.trim());
                if (el && typeof el === 'object') {
                    const u =
                        el.url || el.src || el.image || el.image_url || el.imageUrl;
                    if (typeof u === 'string' && u.trim()) return normalizeProductMediaUrl(u.trim());
                }
            }
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

function aggregateTopProductsFromOrders(orderRows) {
    /** @type {Map<string, { name: string, qty: number, imageUrl: string | null }>} */
    const acc = new Map();
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
            const img = extractItemImageUrl(it);
            const prev = acc.get(ext.name);
            if (prev) {
                prev.qty += ext.qty;
                if (!prev.imageUrl && img) prev.imageUrl = img;
            } else {
                acc.set(ext.name, { name: ext.name, qty: ext.qty, imageUrl: img || null });
            }
        }
    }
    return [...acc.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);
}

/**
 * Сборка списка «Лучшие источники» для dashboard-v2 (чистая функция — удобно для тестов).
 * @param {Array<{code?: string, clicks?: number, c?: number}>} clickRows
 * @param {Array<{code?: string, orders_count?: number, paid_orders_count?: number, revenue_kopecks?: number}>} orderRows
 * @param {Array<{code?: string, clients_count?: number, cc?: number}>} userBucketRows — новые пользователи в периоде по bucket источника
 * @param {Array<{code?: string, title?: string}>} promoTitleRows
 */
function mergeDashboardSourcesForApi(clickRows, orderRows, userBucketRows, promoTitleRows) {
    const titleByCode = new Map(
        (promoTitleRows || []).map((r) => {
            const code = String(r.code || '').trim();
            return [code, String(r.title || code || '').trim() || code];
        })
    );

    /** @type {Map<string, number>} */
    const clickMap = new Map();
    for (const r of clickRows || []) {
        const code = String(r.code || '').trim();
        if (!code) continue;
        clickMap.set(code, Math.round(Number(r.clicks != null ? r.clicks : r.c || 0)));
    }

    /** @type {Map<string, { ordersCount: number, paidOrdersCount: number, revenueKopecks: number }>} */
    const orderMap = new Map();
    for (const r of orderRows || []) {
        const codeRaw = String(r.code || '').trim();
        const code = codeRaw || DASHBOARD_SYSTEM_NONE_CODE;
        orderMap.set(code, {
            ordersCount: Math.round(Number(r.orders_count || 0)),
            paidOrdersCount: Math.round(Number(r.paid_orders_count || 0)),
            revenueKopecks: Math.round(Number(r.revenue_kopecks || 0))
        });
    }

    /** @type {Map<string, number>} */
    const clientsMap = new Map();
    for (const r of userBucketRows || []) {
        const codeRaw = String(r.code || '').trim();
        const code = codeRaw || DASHBOARD_SYSTEM_NONE_CODE;
        clientsMap.set(code, Math.round(Number(r.clients_count != null ? r.clients_count : r.cc || 0)));
    }

    /** @type {Set<string>} */
    const codes = new Set();
    for (const c of titleByCode.keys()) {
        if (c && c !== DASHBOARD_SYSTEM_NONE_CODE) codes.add(c);
    }
    for (const c of clickMap.keys()) {
        if (c && c !== DASHBOARD_SYSTEM_NONE_CODE) codes.add(c);
    }
    for (const c of orderMap.keys()) {
        if (c && c !== DASHBOARD_SYSTEM_NONE_CODE) codes.add(c);
    }
    for (const c of clientsMap.keys()) {
        if (c && c !== DASHBOARD_SYSTEM_NONE_CODE) codes.add(c);
    }

    /** @type {Array<{ code: string, title: string, clicks: number, clientsCount: number, ordersCount: number, paidOrdersCount: number, revenueKopecks: number, isSystem: boolean }>} */
    const out = [];

    for (const code of codes) {
        const clicks = clickMap.get(code) || 0;
        const clientsCount = clientsMap.get(code) || 0;
        const o = orderMap.get(code) || { ordersCount: 0, paidOrdersCount: 0, revenueKopecks: 0 };
        if (clicks === 0 && clientsCount === 0 && o.ordersCount === 0 && o.paidOrdersCount === 0 && o.revenueKopecks === 0) {
            continue;
        }

        const title = titleByCode.get(code) || code;
        out.push({
            code,
            title,
            clicks,
            clientsCount,
            ordersCount: o.ordersCount,
            paidOrdersCount: o.paidOrdersCount,
            revenueKopecks: o.revenueKopecks,
            isSystem: false
        });
    }

    const noneClients = clientsMap.get(DASHBOARD_SYSTEM_NONE_CODE) || 0;
    const noneO = orderMap.get(DASHBOARD_SYSTEM_NONE_CODE) || {
        ordersCount: 0,
        paidOrdersCount: 0,
        revenueKopecks: 0
    };
    if (
        noneClients > 0 ||
        noneO.ordersCount > 0 ||
        noneO.paidOrdersCount > 0 ||
        noneO.revenueKopecks > 0
    ) {
        out.push({
            code: DASHBOARD_SYSTEM_NONE_CODE,
            title: DASHBOARD_SYSTEM_NONE_TITLE,
            clicks: 0,
            clientsCount: noneClients,
            ordersCount: noneO.ordersCount,
            paidOrdersCount: noneO.paidOrdersCount,
            revenueKopecks: noneO.revenueKopecks,
            isSystem: true
        });
    }

    out.sort((a, b) => {
        if (b.revenueKopecks !== a.revenueKopecks) return b.revenueKopecks - a.revenueKopecks;
        if (b.paidOrdersCount !== a.paidOrdersCount) return b.paidOrdersCount - a.paidOrdersCount;
        if (b.ordersCount !== a.ordersCount) return b.ordersCount - a.ordersCount;
        if (b.clientsCount !== a.clientsCount) return b.clientsCount - a.clientsCount;
        return b.clicks - a.clicks;
    });

    return out.slice(0, DASHBOARD_TOP_SOURCES_LIMIT);
}

async function fetchDashboardSourcesForRange(range) {
    const { periodStartIso, periodEndIso } = range;
    const revExpr = sqlOrderPaidRevenueKopecks('o');
    const bucketSql = sqlUserSourceBucketExpr('u');
    const effSeen = sqlUserEffectiveFirstSeenAtExpr('u');
    const uJd = sqlUserFirstSeenJulianDay(`(${effSeen})`);

    const [clickRows, orderRows, userBucketRows, promoTitleRows] = await Promise.all([
        dbAll(
            `
            SELECT TRIM(source_code) AS code, COUNT(*) AS clicks
            FROM promotion_source_clicks
            WHERE clicked_at >= ? AND clicked_at <= ?
            GROUP BY TRIM(source_code)
            `,
            [periodStartIso, periodEndIso]
        ),
        dbAll(
            `
            SELECT
                CASE
                    WHEN o.source_code IS NULL OR TRIM(COALESCE(o.source_code, '')) = ''
                    THEN '${DASHBOARD_SYSTEM_NONE_CODE}'
                    ELSE TRIM(o.source_code)
                END AS code,
                COUNT(*) AS orders_count,
                SUM(CASE WHEN (${PAID_SQL_O}) THEN 1 ELSE 0 END) AS paid_orders_count,
                COALESCE(SUM(CASE WHEN (${PAID_SQL_O}) THEN (${revExpr}) ELSE 0 END), 0) AS revenue_kopecks
            FROM orders o
            WHERE o.created_at >= ? AND o.created_at <= ?
            GROUP BY CASE
                WHEN o.source_code IS NULL OR TRIM(COALESCE(o.source_code, '')) = ''
                THEN '${DASHBOARD_SYSTEM_NONE_CODE}'
                ELSE TRIM(o.source_code)
            END
            `,
            [periodStartIso, periodEndIso]
        ),
        dbAll(
            `
            SELECT (${bucketSql}) AS code, COUNT(*) AS clients_count
            FROM users u
            WHERE u.telegram_id IS NOT NULL
              AND TRIM('' || u.telegram_id) <> ''
              AND TRIM(COALESCE((${effSeen}), '')) <> ''
              AND (${uJd}) IS NOT NULL
              AND (${uJd}) >= julianday(?)
              AND (${uJd}) <= julianday(?)
            GROUP BY (${bucketSql})
            `,
            [periodStartIso, periodEndIso]
        ),
        dbAll(`SELECT code, title FROM promotion_sources WHERE COALESCE(is_active, 1) = 1`, [])
    ]);

    return mergeDashboardSourcesForApi(clickRows, orderRows, userBucketRows, promoTitleRows);
}

/**
 * Fallback для метрики «скорость ответа», если support_response_windows пуст после импорта legacy-данных:
 * среднее время от CLIENT_TO_TOPIC до ближайшего следующего TOPIC_TO_CLIENT (SENT).
 */
async function fetchSupportAvgResponseMinutesFromMessages(range) {
    const { periodStartIso, periodEndIso } = range;
    const row = await dbGet(
        `
        SELECT AVG(
            (julianday(staff.created_at) - julianday(client.created_at)) * 24 * 60
        ) AS avg_minutes,
        COUNT(*) AS pair_count
        FROM support_messages client
        INNER JOIN support_messages staff
          ON staff.thread_id = client.thread_id
         AND staff.id = (
           SELECT MIN(s2.id) FROM support_messages s2
           WHERE s2.thread_id = client.thread_id
             AND s2.id > client.id
             AND s2.direction = 'TOPIC_TO_CLIENT'
             AND TRIM(COALESCE(s2.status, '')) IN ('', 'SENT')
         )
        WHERE client.direction = 'CLIENT_TO_TOPIC'
          AND client.created_at >= ? AND client.created_at <= ?
          AND staff.created_at IS NOT NULL
          AND TRIM(COALESCE(staff.created_at, '')) <> ''
          AND (julianday(client.created_at)) IS NOT NULL
          AND (julianday(staff.created_at)) IS NOT NULL
          AND julianday(staff.created_at) >= julianday(client.created_at)
        `,
        [periodStartIso, periodEndIso]
    );
    const pairs = Math.round(Number(row?.pair_count || 0));
    const avg = row?.avg_minutes;
    if (!pairs || avg == null || !Number.isFinite(Number(avg))) {
        return { avgMinutes: null, pairCount: pairs };
    }
    return { avgMinutes: Math.round(Number(avg)), pairCount: pairs };
}

async function hydrateTopProductImages(items) {
    const stamped = items.map((it) => {
        const u = it && it.imageUrl ? normalizeProductMediaUrl(it.imageUrl) : null;
        if (u) return u === it.imageUrl ? it : { ...it, imageUrl: u };
        return { ...it, imageUrl: null };
    });
    const missing = stamped.filter((x) => !x.imageUrl).map((x) => x.name);
    if (!missing.length) return stamped;
    const unique = [...new Set(missing)].slice(0, 30);
    const ph = unique.map(() => '?').join(',');
    let rows = [];
    try {
        rows = await dbAll(`SELECT name, images_json FROM products WHERE name IN (${ph})`, unique);
    } catch (_) {
        return stamped;
    }
    const byName = new Map((rows || []).map((r) => [String(r.name || ''), r]));
    return stamped.map((it) => {
        if (it.imageUrl) return it;
        const pr = byName.get(it.name);
        if (!pr) return it;
        const url = normalizeProductMediaUrl(firstImageFromProductsJson(pr.images_json));
        return url ? { ...it, imageUrl: url } : it;
    });
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
        supportRow
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
            `SELECT COUNT(*) AS c FROM (${getSqlNewUsersInPeriodSubquery()}) nc`,
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
                (julianday(first_manager_response_at) - julianday(first_client_message_at)) * 24 * 60
            ) AS avg_minutes
            FROM support_response_windows
            WHERE first_client_message_at >= ? AND first_client_message_at <= ?
              AND first_manager_response_at IS NOT NULL
              AND TRIM(first_manager_response_at) <> ''
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
    let avgResponseMinutes =
        avgResp != null && Number.isFinite(Number(avgResp)) ? Math.round(Number(avgResp)) : null;

    let avgResponsePairsFromMessages = 0;
    if (avgResponseMinutes == null) {
        const fb = await fetchSupportAvgResponseMinutesFromMessages(range);
        avgResponsePairsFromMessages = Math.round(Number(fb.pairCount || 0));
        if (fb.avgMinutes != null && Number.isFinite(Number(fb.avgMinutes))) {
            avgResponseMinutes = Math.round(Number(fb.avgMinutes));
        }
    }

    const avgResponseInsufficientData = avgResponseMinutes == null;

    const topRaw = aggregateTopProductsFromOrders(orderRowsArr);
    const topProducts = await hydrateTopProductImages(topRaw);

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
        avgResponseInsufficientData,
        avgResponsePairsFromMessages,
        topProducts
    };
}

/**
 * @param {'today'|'7d'|'all'} periodKey
 */
async function fetchDashboardMetrics(periodKey) {
    const range =
        periodKey === 'all' ? getAllTimeDashboardPeriodRange() : getDashboardPeriodRange(periodKey);
    const metrics = await fetchDashboardMetricsForRange(range);
    return { range, ...metrics };
}

/**
 * Ответ Mini App для GET /api/admin/dashboard-v2:
 * (?period=today|7d|all) или (?from=YYYY-MM-DD&to=YYYY-MM-DD).
 */
async function getDashboardV2ApiPayload(opts) {
    /** @type {ReturnType<typeof getDashboardPeriodRange>|ReturnType<typeof getCustomDashboardPeriodRange>|ReturnType<typeof getAllTimeDashboardPeriodRange>} */
    let range;
    /** @type {string} */
    let periodApi;

    if (opts && typeof opts === 'object' && opts.fromYmd && opts.toYmd) {
        range = getCustomDashboardPeriodRange(String(opts.fromYmd).trim(), String(opts.toYmd).trim());
        periodApi = 'custom';
    } else {
        const pkRaw = opts === '7d' || (opts && opts.periodKey === '7d') ? '7d' : (opts && opts.periodKey === 'all' ? 'all' : 'today');
        const pk = pkRaw === 'all' ? 'all' : pkRaw === '7d' ? '7d' : 'today';
        range = pk === 'all' ? getAllTimeDashboardPeriodRange() : getDashboardPeriodRange(pk);
        periodApi = pk;
    }

    const [m, sources, abandonedSnapshot] = await Promise.all([
        fetchDashboardMetricsForRange(range),
        fetchDashboardSourcesForRange(range),
        (async () => {
            try {
                return await fetchAbandonedCartDashboardSnapshot(db);
            } catch (e) {
                console.warn('[DashboardV2] abandoned_carts_snapshot_failed', e && e.message ? e.message : e);
                return null;
            }
        })()
    ]);
    const srcArr = Array.isArray(sources) ? sources : [];
    let sourceKnownCount = 0;
    let sourceUnknownCount = 0;
    for (const s of srcArr) {
        const cc = Math.round(Number(s.clientsCount || 0));
        if (!cc) continue;
        if (s.isSystem && String(s.code) === DASHBOARD_SYSTEM_NONE_CODE) sourceUnknownCount += cc;
        else sourceKnownCount += cc;
    }
    const legacyTrackingNote =
        sourceUnknownCount > 0 && sourceKnownCount === 0 ? DASHBOARD_LEGACY_SOURCES_NOTE : null;
    const legacyUnknownCount = legacyTrackingNote ? sourceUnknownCount : 0;

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
            avgFirstResponseInsufficientData: !!m.avgResponseInsufficientData,
            avgFirstResponsePairSamples: Math.round(Number(m.avgResponsePairsFromMessages || 0)),
            abandonedCarts: abandonedSnapshot
        },
        topProducts: (Array.isArray(m.topProducts) ? m.topProducts : []).map((row) => {
            if (Array.isArray(row)) {
                const [name, qty] = row;
                return {
                    name: String(name || ''),
                    quantity: Math.round(Number(qty || 0)),
                    image_url: null
                };
            }
            return {
                name: String(row.name || ''),
                quantity: Math.round(Number(row.qty || row.quantity || 0)),
                image_url: row.imageUrl || row.image_url || null
            };
        }),
        sourcesAnalytics: {
            sourceKnownCount,
            sourceUnknownCount,
            legacyUnknownCount,
            legacyTrackingNote
        },
        sources: srcArr
    };
}

module.exports = {
    getAdminTelegramIdSet,
    isAdminTelegramId,
    getDashboardPeriodRange,
    getCustomDashboardPeriodRange,
    getAllTimeDashboardPeriodRange,
    ALL_TIME_REPORTS_START_YMD,
    fetchDashboardMetricsForRange,
    fetchDashboardMetrics,
    getDashboardV2ApiPayload,
    formatRuDate,
    getSqlNewUsersInPeriodSubquery,
    getSqlNewClientsFirstOrderInRangeSubquery,
    sqlOrderCreatedJulianDay,
    sqlUserFirstSeenJulianDay,
    sqlUserEffectiveFirstSeenAtExpr,
    sqlUserSourceBucketExpr,
    mergeDashboardSourcesForApi,
    fetchDashboardSourcesForRange,
    fetchSupportAvgResponseMinutesFromMessages,
    DASHBOARD_SYSTEM_NONE_CODE,
    DASHBOARD_SYSTEM_NONE_TITLE,
    DASHBOARD_LEGACY_SOURCES_NOTE
};
