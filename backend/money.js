const { isPaidStatusString } = require('./order-status');

/**
 * Денежная модель проекта (единый источник правил).
 *
 * Каноническое хранение в БД / платежах:
 * - orders.total_paid — INTEGER, копейки: фактически полученная оплата (после T-Bank CONFIRMED); до оплаты = 0.
 * - orders.total_before_bonus, orders.bonuses_used, orders.bonus_earned — INTEGER, копейки
 * - orders.total — REAL, рубли (витрина / подсказки; при оформлении = сумма к оплате после бонусов)
 * - payments.amount — INTEGER, копейки (инициализируется Init, обновляется webhook)
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

/** Сумма строки заказа «к оплате / номинал заказа» в копейках (не путать с total_paid до webhook). */
function orderAmountKopecksFromRow(row) {
    const beforeRaw = row && row.total_before_bonus;
    const bonusRaw = row && row.bonuses_used;
    const beforeFinite = beforeRaw != null && beforeRaw !== '' && Number.isFinite(Number(beforeRaw));
    const bonusFinite = bonusRaw != null && bonusRaw !== '' && Number.isFinite(Number(bonusRaw));
    if (beforeFinite || bonusFinite) {
        const before = beforeFinite ? Math.round(Number(beforeRaw)) : 0;
        const bonus = bonusFinite ? Math.round(Number(bonusRaw)) : 0;
        const k = Math.max(0, before - bonus);
        if (k > 0) return k;
    }
    const totalRub = toFiniteNumber(row && row.total);
    const fromTotal = Math.round(totalRub * KOPEKS_PER_RUB);
    if (fromTotal > 0) return fromTotal;
    const paidK = Math.round(toFiniteNumber(row && row.total_paid));
    if (paidK > 0) return paidK;
    return 0;
}

/**
 * Выручка по заказу для агрегатов (только финально оплаченные статусы).
 * total_paid > 0 без PAID не даёт выручку (защита от исторического бага checkout).
 */
function orderPaidRevenueKopecksFromRow(row) {
    if (!isPaidStatusString(row && row.status)) return 0;
    const paidK = Math.round(toFiniteNumber(row && row.total_paid));
    if (paidK > 0) return paidK;
    return Math.round(toFiniteNumber(row && row.total) * KOPEKS_PER_RUB);
}

/** Сумма «под риском» для неоплаченного заказа (ожидаемая оплата), копейки. */
function orderUnpaidExposureKopecksFromRow(row) {
    if (isPaidStatusString(row && row.status)) return 0;
    return orderAmountKopecksFromRow(row);
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
        WHEN UPPER(TRIM(COALESCE(${a}.status, ''))) IN ('PAID', 'COMPLETED', 'DELIVERED') THEN
            CASE
                WHEN COALESCE(${a}.total_paid, 0) > 0 THEN ${a}.total_paid
                ELSE CAST(ROUND(COALESCE(${a}.total, 0) * ${KOPEKS_PER_RUB}) AS INTEGER)
            END
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
