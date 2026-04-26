const { isPaidStatusString } = require('./order-status');

/**
 * Денежная модель проекта (единый источник правил).
 *
 * Каноническое хранение в БД / платежах:
 * - orders.total_paid, orders.total_before_bonus, orders.bonuses_used, orders.bonus_earned — INTEGER, копейки
 * - orders.total — REAL, рубли (зеркало к оплате для витрины/уведомлений; задаётся как total_paid/100 при checkout)
 * - payments.amount — INTEGER, копейки (T-Bank Init)
 * - users.bonus_balance — INTEGER, целые рубли (1 бонус = 1 ₽)
 *
 * Админ API: денежные метрики в JSON — целые копейки (см. backend/MONEY_MODEL.md).
 * Нормализация строки заказа: orderAmountKopecksFromRow; строки для людей: formatKopecksRu.
 */

const KOPEKS_PER_RUB = 100;

function toFiniteNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** Сумма строки заказа «сколько клиент заплатил / должен заплатить» в копейках. */
function orderAmountKopecksFromRow(row) {
    const paidK = Math.round(toFiniteNumber(row && row.total_paid));
    if (paidK > 0) return paidK;
    const totalRub = toFiniteNumber(row && row.total);
    return Math.round(totalRub * KOPEKS_PER_RUB);
}

/**
 * Выручка по заказу для агрегатов (только оплаченные / подтверждённые суммы), копейки.
 * Неоплаченные дают 0.
 */
function orderPaidRevenueKopecksFromRow(row) {
    const paidK = Math.round(toFiniteNumber(row && row.total_paid));
    if (paidK > 0) return paidK;
    if (isPaidStatusString(row && row.status)) {
        return Math.round(toFiniteNumber(row && row.total) * KOPEKS_PER_RUB);
    }
    return 0;
}

/** Сумма «под риском» для неоплаченного заказа (ожидаемая оплата), копейки. */
function orderUnpaidExposureKopecksFromRow(row) {
    const paidK = Math.round(toFiniteNumber(row && row.total_paid));
    if (paidK > 0) return 0;
    return Math.round(toFiniteNumber(row && row.total) * KOPEKS_PER_RUB);
}

function rubThresholdToKopecks(rub) {
    return Math.round(toFiniteNumber(rub) * KOPEKS_PER_RUB);
}

/** Целые рубли для текстов / порогов (округление к ближайшему рублю). */
function kopecksToWholeRub(k) {
    return Math.round(toFiniteNumber(k) / KOPEKS_PER_RUB);
}

/** Единое строковое представление для логов и Telegram (целые рубли из копеек). */
function formatKopecksRu(minor) {
    return `${kopecksToWholeRub(minor).toLocaleString('ru-RU')} ₽`;
}

/**
 * Фрагмент SQL: выручка заказа в копейках (0 для неоплаченных без признаков оплаты).
 * @param {string} alias алиас таблицы orders
 */
function sqlOrderPaidRevenueKopecks(alias) {
    const a = String(alias || 'o').trim() || 'o';
    return `CASE
        WHEN COALESCE(${a}.total_paid, 0) > 0 THEN ${a}.total_paid
        WHEN UPPER(TRIM(COALESCE(${a}.status, ''))) IN ('PAID', 'COMPLETED', 'DELIVERED')
            THEN CAST(ROUND(COALESCE(${a}.total, 0) * ${KOPEKS_PER_RUB}) AS INTEGER)
        ELSE 0
    END`;
}

module.exports = {
    KOPEKS_PER_RUB,
    orderAmountKopecksFromRow,
    orderPaidRevenueKopecksFromRow,
    orderUnpaidExposureKopecksFromRow,
    rubThresholdToKopecks,
    kopecksToWholeRub,
    formatKopecksRu,
    sqlOrderPaidRevenueKopecks
};
