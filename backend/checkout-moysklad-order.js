'use strict';

/**
 * Число товарных строк корзины без msId/ms_id (по одной на SKU-строку, без размножения по quantity).
 * @param {Array<{ msId?: string, ms_id?: string }>} items
 */
function countCartLinesMissingMsId(items) {
    let n = 0;
    for (const it of items || []) {
        const id = String(it.msId || it.ms_id || '').trim();
        if (!id) n += 1;
    }
    return n;
}

/**
 * Синхронизация заказа в МойСклад на checkout (до оплаты).
 * @param {object} p
 * @param {boolean} p.needMsSync
 * @param {object} p.order — объект для sendOrderToMoySklad
 * @param {string} p.checkoutHash
 * @param {(order: object, opts: object) => Promise<void>} p.sendOrderToMoySklad
 * @param {{ log?: Function, error?: Function }} [p.logger]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, needMsSync: boolean, itemsCount: number, msMissingLines: number, cause?: unknown }>}
 */
async function syncOrderToMoySkladOnCheckout({
    needMsSync,
    order,
    checkoutHash,
    sendOrderToMoySklad,
    logger = console
}) {
    const log = typeof logger.log === 'function' ? logger.log.bind(logger) : console.log.bind(console);
    const logError =
        typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);

    const itemsCount = (order.items || []).length;
    const msMissingLines = countCartLinesMissingMsId(order.items);
    const deliveryOption = order.deliveryOption;
    const deliveryFeeRub = order.deliveryFeeRub;

    if (!needMsSync) {
        return { ok: true, skipped: true, needMsSync: false, itemsCount, msMissingLines };
    }

    if (msMissingLines > 0) {
        logError(
            '[MoySklad] positions_validation_failed',
            JSON.stringify({
                orderId: order.id,
                checkoutHash,
                needMsSync: true,
                deliveryOption,
                deliveryFeeRub,
                itemsCount,
                msMissingLines
            })
        );
        return {
            ok: false,
            error: 'checkout_failed_missing_ms_ids',
            needMsSync: true,
            itemsCount,
            msMissingLines
        };
    }

    log(
        '[Checkout] moysklad_sync_started',
        JSON.stringify({
            orderId: order.id,
            checkoutHash,
            needMsSync: true,
            deliveryOption,
            deliveryFeeRub,
            itemsCount,
            msMissingLines: 0
        })
    );

    try {
        await sendOrderToMoySklad(order, { createPayment: false });
    } catch (cause) {
        logError(
            '[Checkout] moysklad_sync_failed',
            JSON.stringify({
                orderId: order.id,
                checkoutHash,
                needMsSync: true,
                deliveryOption,
                deliveryFeeRub,
                itemsCount,
                msMissingLines: 0,
                reason: cause && cause.message ? cause.message : String(cause),
                response: cause && cause.response && cause.response.data ? cause.response.data : undefined
            })
        );
        return {
            ok: false,
            error: 'checkout_failed_moysklad_sync',
            needMsSync: true,
            itemsCount,
            msMissingLines: 0,
            cause
        };
    }

    log(
        '[Checkout] moysklad_sync_succeeded',
        JSON.stringify({
            orderId: order.id,
            checkoutHash,
            needMsSync: true,
            deliveryOption,
            deliveryFeeRub,
            itemsCount,
            msMissingLines: 0
        })
    );

    return { ok: true, skipped: false, needMsSync: true, itemsCount, msMissingLines: 0 };
}

function deliveryMethodFromOrderRow(row) {
    const opt = String(row.delivery_option || '').trim().toLowerCase();
    if (opt === 'pickup') return 'pickup';
    const addr = String(row.address || '').trim().toLowerCase();
    if (addr === 'самовывоз') return 'pickup';
    return 'delivery';
}

/**
 * Полный объект заказа для sendOrderToMoySklad из строки SQLite orders.*.
 * @param {object} orderRow
 */
function buildMoySkladOrderPayloadFromDbRow(orderRow) {
    if (!orderRow || orderRow.id == null) {
        throw new Error('buildMoySkladOrderPayloadFromDbRow: orderRow.id required');
    }

    let items = [];
    try {
        items = JSON.parse(orderRow.items_json || '[]');
    } catch (_) {
        items = [];
    }

    const feeRaw = Number(orderRow.delivery_fee_rub);
    const deliveryFeeRub = Number.isFinite(feeRaw) ? Math.round(feeRaw) : 0;
    const deliveryOption = String(orderRow.delivery_option || '').trim();
    const email = String(orderRow.email || '').trim().toLowerCase();

    return {
        id: orderRow.id,
        telegramId: orderRow.telegram_id,
        fullName: String(orderRow.full_name || '').trim(),
        phone: String(orderRow.phone || '').trim(),
        email: email || undefined,
        address: String(orderRow.address || '').trim(),
        deliveryDate: String(orderRow.delivery_date || '').trim(),
        deliveryTime: String(orderRow.delivery_time || '').trim(),
        items,
        deliveryOption,
        deliveryFeeRub,
        deliveryMethod: deliveryMethodFromOrderRow(orderRow),
        receiverMode: String(orderRow.receiver_mode || 'self').trim(),
        recipientFullName: String(orderRow.recipient_full_name || '').trim(),
        recipientPhone: String(orderRow.recipient_phone || '').trim(),
        floristComment: String(orderRow.florist_comment || '').trim(),
        cardText: String(orderRow.card_text || '').trim()
    };
}

module.exports = {
    countCartLinesMissingMsId,
    syncOrderToMoySkladOnCheckout,
    buildMoySkladOrderPayloadFromDbRow,
    deliveryMethodFromOrderRow
};
