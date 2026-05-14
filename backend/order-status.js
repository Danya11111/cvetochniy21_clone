/**
 * Единая модель статусов заказа (платёжный контур приложения vs внешние подписи).
 *
 * Источник истины по оплате:
 * - Платёжный этап: orders.status (PENDING_PAYMENT / AUTHORIZED / PAID / PAYMENT_FAILED).
 * - Фактически полученные деньги: orders.total_paid (копейки) выставляется только после webhook T-Bank Status=CONFIRMED
 *   (до этого при оформлении — 0; «сумма к оплате» живёт в total_before_bonus/bonuses_used и orders.total в рублях).
 * Состояние заказа в МойСклад — только orders.ms_state_name (не перезаписывает платёжный status).
 */

const PAID_CONFIRMED = new Set(['PAID', 'COMPLETED', 'DELIVERED']);
const PAYMENT_AWAIT = new Set(['PENDING_PAYMENT']);
const PAYMENT_AUTHORIZED = new Set(['AUTHORIZED']);
const PAYMENT_FAILED = new Set(['PAYMENT_FAILED']);
/** Сырые коды исторических / неактуальных записей из старых интеграций (не платёжный контур приложения сейчас). */
const LEGACY_INACTIVE_EXACT = new Set(['CANCELLED', 'CANCELED', 'FAILED', 'ERROR', 'REFUNDED', 'RETURNED']);

function hasRecordedPayment(row) {
    return Math.round(Number(row && row.total_paid)) > 0;
}

/** SQL: строка заказа (alias) в финальной «оплаченной» семье статусов приложения (без учёта total_paid). */
function sqlPaidOrderStatusFamily(alias = 'o') {
    const a = String(alias || 'o').trim() || 'o';
    return `UPPER(TRIM(COALESCE(${a}.status,''))) IN ('PAID','COMPLETED','DELIVERED')`;
}

/** Статус в БД считается «оплачен/завершён» для бизнес-логики (без учёта total_paid). */
function isPaidStatusString(status) {
    const u = String(status || '').trim().toUpperCase();
    return PAID_CONFIRMED.has(u);
}

function isPaidOrderStatus(status) {
    return isPaidStatusString(status);
}

function isPendingPaymentStatus(status) {
    const u = String(status || '').trim().toUpperCase();
    return PAYMENT_AWAIT.has(u);
}

/**
 * Выручка / KPI: только финально оплаченные по статусу; сумма — через total_paid или legacy total в рублях.
 * Не использует «total_paid > 0» в одиночку — иначе ломается разделение «сумма к оплате» vs «оплачено».
 */
function isRevenueOrderStatus(row) {
    if (!isPaidStatusString(row && row.status)) return false;
    const k = Math.round(Number(row && row.total_paid));
    if (k > 0) return true;
    const rub = Number(row && row.total);
    return Number.isFinite(rub) && Math.round(rub * 100) > 0;
}

/** Неактивируемый «архивный» статус строки заказа: не смешиваем с PAYMENT_FAILED и не добавляем сценариев отмены/возврата в продукт. */
function isLegacyInactiveRawStatus(raw) {
    const u = String(raw || '').trim().toUpperCase();
    if (!u) return false;
    if (PAYMENT_FAILED.has(u)) return false;
    if (LEGACY_INACTIVE_EXACT.has(u)) return true;
    if (u.includes('CANCEL')) return true;
    if (u.includes('REFUND')) return true;
    return false;
}

/**
 * Оплачен для операционки/админки: только явный финальный статус (PAID/COMPLETED/DELIVERED).
 * total_paid > 0 без PAID — не считаем оплатой (исторический баг checkout заполнял total_paid до webhook).
 */
function isOrderPaidForOps(row) {
    return isPaidStatusString(row && row.status);
}

function deriveOrderAdminPresentation(row) {
    const raw = String((row && row.status) || '').trim();
    const u = raw.toUpperCase();
    const msHint = String((row && row.ms_state_name) || '').trim();

    if (isOrderPaidForOps(row)) {
        return {
            status_code: 'paid',
            status_label: 'Оплачен',
            status_tone: 'ok',
            status_raw: raw
        };
    }
    if (PAYMENT_AWAIT.has(u)) {
        return { status_code: 'awaiting_payment', status_label: 'Ожидает оплаты', status_tone: 'warn', status_raw: raw };
    }
    if (PAYMENT_AUTHORIZED.has(u)) {
        return { status_code: 'authorized', status_label: 'Оплата авторизована', status_tone: 'info', status_raw: raw };
    }
    if (PAYMENT_FAILED.has(u)) {
        return {
            status_code: 'payment_failed',
            status_label: 'Оплата не прошла',
            status_tone: 'alert',
            status_raw: raw
        };
    }
    if (isLegacyInactiveRawStatus(raw)) {
        return {
            status_code: 'legacy_inactive',
            status_label: 'Архивный статус',
            status_tone: 'info',
            status_raw: raw
        };
    }

    const display = (msHint || raw || 'В работе').trim();
    const short = display.length > 42 ? `${display.slice(0, 39)}…` : display;
    return {
        status_code: 'fulfillment_external',
        status_label: short,
        status_tone: 'info',
        status_raw: raw
    };
}

function normalizeOrderStatusForAdmin(row) {
    return deriveOrderAdminPresentation(row);
}

/** Фильтр «оплаченных» заказов в SQL: только статус, не total_paid (см. MONEY_MODEL / payment flow). */
const PAID_SQL = `(${sqlPaidOrderStatusFamily('o')})`;
const PAYMENT_FAILED_SQL = `UPPER(TRIM(COALESCE(o.status,''))) = 'PAYMENT_FAILED'`;
/**
 * История / «спящие» технические коды без отдельного продукта «отмена».
 * Отдельно от PAYMENT_FAILED (клиент может повторить оплату — это не архив статусов отмен из старых правил).
 */
const LEGACY_INACTIVE_SQL = `(
    UPPER(TRIM(COALESCE(o.status,''))) IN ('CANCELLED','CANCELED','FAILED','ERROR','REFUNDED','RETURNED')
    OR UPPER(COALESCE(o.status,'')) LIKE '%CANCEL%'
    OR UPPER(COALESCE(o.status,'')) LIKE '%REFUND%'
)`;

/**
 * Фильтр списка заказов в админке по каноническому status_code (предпочтительно) или legacy status.
 * @returns {{ clause: string, args: unknown[] }}
 */
function buildOrdersListWhereClause({ status_code: statusCode = '', status: legacyStatus = '' } = {}) {
    const c = String(statusCode || '').trim().toLowerCase();
    const legacy = String(legacyStatus || '').trim();

    if (c) {
        if (c === 'paid') return { clause: `WHERE ${PAID_SQL}`, args: [] };
        if (c === 'awaiting_payment') {
            return { clause: `WHERE UPPER(TRIM(COALESCE(o.status,''))) = 'PENDING_PAYMENT'`, args: [] };
        }
        if (c === 'authorized') {
            return { clause: `WHERE UPPER(TRIM(COALESCE(o.status,''))) = 'AUTHORIZED'`, args: [] };
        }
        // Намеренный «заглушечный» фильтр для старых клиентов: отмены/возвраты в приложении выключены, список не продвигаем.
        if (c === 'cancelled' || c === 'legacy_inactive') {
            return { clause: `WHERE ${LEGACY_INACTIVE_SQL}`, args: [] };
        }
        if (c === 'payment_failed') {
            return { clause: `WHERE ${PAYMENT_FAILED_SQL}`, args: [] };
        }
        if (c === 'unpaid') {
            return { clause: `WHERE NOT (${PAID_SQL}) AND NOT (${LEGACY_INACTIVE_SQL})`, args: [] };
        }
        if (c === 'fulfillment_external') {
            return {
                clause: `WHERE NOT (${PAID_SQL}) AND NOT (${LEGACY_INACTIVE_SQL}) AND NOT (${PAYMENT_FAILED_SQL}) AND UPPER(TRIM(COALESCE(o.status,''))) NOT IN ('PENDING_PAYMENT','AUTHORIZED')`,
                args: []
            };
        }
    }

    if (!legacy) return { clause: '', args: [] };

    const lu = legacy.toUpperCase();
    if (['PAID', 'COMPLETED', 'DELIVERED'].includes(lu)) return { clause: `WHERE ${PAID_SQL}`, args: [] };
    if (lu === 'PENDING_PAYMENT') {
        return { clause: `WHERE UPPER(TRIM(COALESCE(o.status,''))) = 'PENDING_PAYMENT'`, args: [] };
    }
    if (lu === 'AUTHORIZED') {
        return { clause: `WHERE UPPER(TRIM(COALESCE(o.status,''))) = 'AUTHORIZED'`, args: [] };
    }
    if (lu === 'PAYMENT_FAILED') {
        return { clause: `WHERE ${PAYMENT_FAILED_SQL}`, args: [] };
    }
    if (
        ['CANCELLED', 'CANCELED', 'FAILED', 'ERROR', 'REFUNDED', 'RETURNED'].includes(lu) ||
        lu.includes('CANCEL') ||
        lu.includes('REFUND')
    ) {
        return { clause: `WHERE ${LEGACY_INACTIVE_SQL}`, args: [] };
    }

    return { clause: 'WHERE o.status = ?', args: [legacy] };
}

module.exports = {
    hasRecordedPayment,
    isPaidStatusString,
    sqlPaidOrderStatusFamily,
    isPaidOrderStatus,
    isPendingPaymentStatus,
    isRevenueOrderStatus,
    isLegacyInactiveRawStatus,
    isOrderPaidForOps,
    deriveOrderAdminPresentation,
    normalizeOrderStatusForAdmin,
    buildOrdersListWhereClause,
    PAID_CONFIRMED,
    PAYMENT_AWAIT,
    PAYMENT_AUTHORIZED,
    PAYMENT_FAILED,
    LEGACY_INACTIVE_SQL
};
