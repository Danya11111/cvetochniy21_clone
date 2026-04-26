'use strict';

/**
 * Возраст неоплаченного заказа (мс) от created_at до nowMs.
 * @param {{ created_at?: string }} orderRow
 * @param {number} nowMs
 * @returns {number|null} null если дату распарсить нельзя
 */
function getCheckoutOrderAgeMs(orderRow, nowMs) {
    if (!orderRow || orderRow.created_at == null) return null;
    const created = new Date(String(orderRow.created_at)).getTime();
    if (!Number.isFinite(created)) return null;
    return nowMs - created;
}

/**
 * Можно ли переиспользовать существующую строку orders при checkout (тот же id, UPDATE).
 * @param {{ created_at?: string }} orderRow
 * @param {number} nowMs
 * @param {number} reuseMaxMs
 */
function isCheckoutOrderReusableByAge(orderRow, nowMs, reuseMaxMs) {
    const ageMs = getCheckoutOrderAgeMs(orderRow, nowMs);
    if (ageMs == null) return false;
    return ageMs < reuseMaxMs;
}

/**
 * Решение: взять существующий unpaid-ряд для UPDATE или создать новый (INSERT).
 * Старый заказ при expired не модифицируется — effectiveOrderRow = null → ветка INSERT.
 *
 * @param {object|null} orderRow — последний PENDING_PAYMENT / AUTHORIZED из SELECT
 * @param {number} nowMs
 * @param {number} reuseMaxMs
 * @returns {{
 *   effectiveOrderRow: object|null,
 *   decision: 'none' | 'reuse' | 'expired',
 *   previousOrderId?: number,
 *   previousOrderStatus?: string,
 *   previousOrderCreatedAt?: string,
 *   ageMs?: number|null,
 *   reuseMaxMs: number
 * }}
 */
function resolveCheckoutUnpaidOrderForReuse(orderRow, nowMs, reuseMaxMs) {
    let max = Number(reuseMaxMs);
    if (!Number.isFinite(max) || max < 0) max = 86400000;

    if (!orderRow) {
        return { effectiveOrderRow: null, decision: 'none', reuseMaxMs: max };
    }

    const ageMs = getCheckoutOrderAgeMs(orderRow, nowMs);
    const meta = {
        previousOrderId: orderRow.id,
        previousOrderStatus: String(orderRow.status || ''),
        previousOrderCreatedAt: String(orderRow.created_at || ''),
        ageMs: ageMs != null ? ageMs : null,
        reuseMaxMs: max
    };

    if (ageMs == null || ageMs >= max) {
        return {
            effectiveOrderRow: null,
            decision: 'expired',
            ...meta
        };
    }

    return {
        effectiveOrderRow: orderRow,
        decision: 'reuse',
        ...meta
    };
}

module.exports = {
    getCheckoutOrderAgeMs,
    isCheckoutOrderReusableByAge,
    resolveCheckoutUnpaidOrderForReuse
};
