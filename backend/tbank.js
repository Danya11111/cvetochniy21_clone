const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const { TBANK_TERMINAL_KEY, TBANK_PASSWORD, APP_PUBLIC_URL, BASE_URL, TBANK_API_URL } = require('./config');
const {
    buildMoySkladOrderPayloadFromDbRow,
    countCartLinesMissingMsId
} = require('./checkout-moysklad-order');

/** Публичный origin без завершающего `/` — prefer APP_PUBLIC_URL, fallback BASE_URL legacy */
function resolvedPublicOrigin() {
    const raw = String(APP_PUBLIC_URL || BASE_URL || '').trim().replace(/\/+$/, '');
    return raw;
}

// Формирование токена согласно доке Т-Банка (TerminalKey + Password + параметры)
function buildToken(params) {
    const data = { ...params };

    delete data.Token;
    delete data.Receipt;

    data.Password = TBANK_PASSWORD;

    const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);

    entries.sort(([a], [b]) => a.localeCompare(b));

    const concat = entries.map(([, v]) => String(v)).join('');

    return crypto.createHash('sha256').update(concat, 'utf8').digest('hex');
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function buildReceiptItemsExpanded(orderItems, deliveryFeeRub) {
    const out = [];

    for (const item of orderItems || []) {
        const priceKopecks = Math.round(Number(item.price || 0) * 100);
        const qty = Math.max(1, Number(item.quantity || 1));

        for (let i = 0; i < qty; i++) {
            out.push({
                Name: String(item.name || 'Товар').substring(0, 128),
                Price: priceKopecks,
                Quantity: 1,
                Amount: priceKopecks,
                Tax: 'none',
                PaymentMethod: 'full_prepayment',
                PaymentObject: 'commodity'
            });
        }
    }

    const feeRub = Number(deliveryFeeRub || 0);
    const feeK = Math.round(feeRub * 100);

    if (Number.isFinite(feeK) && feeK > 0) {
        out.push({
            Name: 'Доставка',
            Price: feeK,
            Quantity: 1,
            Amount: feeK,
            Tax: 'none',
            PaymentMethod: 'full_prepayment',
            PaymentObject: 'service'
        });
    }

    return out;
}

function applyDiscountToReceiptItems(items, discountKopecks) {
    if (!discountKopecks || discountKopecks <= 0) return items;

    const total = items.reduce((s, it) => s + (it.Amount || 0), 0);
    if (total <= 0) return items;

    let remaining = discountKopecks;

    const discounted = items.map(it => ({ ...it }));

    for (let i = 0; i < discounted.length; i++) {
        const it = discounted[i];
        if (remaining <= 0) break;

        const share = Math.floor((it.Amount * discountKopecks) / total);
        const use = Math.min(remaining, share);

        it.Price = Math.max(0, it.Price - use);
        it.Amount = it.Price;
        remaining -= use;
    }

    for (let i = discounted.length - 1; i >= 0 && remaining > 0; i--) {
        const it = discounted[i];
        if (it.Price <= 0) continue;

        const use = Math.min(remaining, it.Price);
        it.Price -= use;
        it.Amount = it.Price;
        remaining -= use;
    }

    return discounted;
}

/**
 * Инициализация платежа в Т-Банке по заказу
 * order: { id, items, phone, totalPaidK, bonusesUsedK }
 */
async function initPaymentForOrder(order) {
    if (!TBANK_TERMINAL_KEY || !TBANK_PASSWORD) {
        throw new Error('TBANK_TERMINAL_KEY or TBANK_PASSWORD is not set');
    }

    const publicBase = resolvedPublicOrigin();
    if (!publicBase) {
        console.error('[T-Bank] APP_PUBLIC_URL/BASE_URL is empty — SuccessURL/FailURL/NotificationURL may be invalid');
    }

    let receiptItems = buildReceiptItemsExpanded(order.items || [], order.deliveryFeeRub);

    const totalBeforeK = receiptItems.reduce((sum, it) => sum + (it.Amount || 0), 0);
    const bonusesUsedK = Math.max(0, Number(order.bonusesUsedK || 0));

    const amountKopecks = Number.isFinite(Number(order.totalPaidK))
        ? Math.max(0, Number(order.totalPaidK))
        : Math.max(0, totalBeforeK - bonusesUsedK);

    if (amountKopecks <= 0) {
        throw new Error('Cannot init payment with zero amount');
    }

    const discountK = Math.max(0, totalBeforeK - amountKopecks);

    if (discountK > 0) {
        receiptItems = applyDiscountToReceiptItems(receiptItems, discountK);
    }

    const itemsSum = receiptItems.reduce((sum, it) => sum + it.Amount, 0);
    if (itemsSum !== amountKopecks) {
        const diff = amountKopecks - itemsSum;
        const last = receiptItems[receiptItems.length - 1];
        if (!last) {
            throw new Error('Receipt items are empty');
        }
        last.Price = Math.max(0, last.Price + diff);
        last.Amount = last.Price;
    }

    const receipt = {
        Phone: order.phone || undefined,
        Taxation: 'usn_income',
        Items: receiptItems
    };

    const bankOrderId = `${order.id}_${Date.now()}`;

    const payload = {
        TerminalKey: TBANK_TERMINAL_KEY,
        Amount: amountKopecks,
        OrderId: bankOrderId,
        Description: `Заказ #${order.id} в Telegram-магазине`,
        Receipt: receipt,
        NotificationURL: publicBase ? `${publicBase}/api/tbank/notify` : '/api/tbank/notify'
    };

    if (publicBase) {
        payload.SuccessURL = `${publicBase}/?payment=success`;
        payload.FailURL = `${publicBase}/?payment=fail`;
    }

    payload.Token = buildToken(payload);

    const initUrl = `${String(TBANK_API_URL || '').replace(/\/+$/, '')}/Init`;
    const res = await axios.post(initUrl, payload, {
        headers: { 'Content-Type': 'application/json' }
    });

    console.log('[T-Bank Init] response:', JSON.stringify(res.data, null, 2));

    if (!res.data.Success) {
        const msg = `${res.data.ErrorCode || ''} ${res.data.Message || ''}`.trim();
        console.error('[T-Bank Init] failed', {
            orderId: order.id,
            amountKopecks,
            error: msg
        });
        throw new Error(`T-Bank Init error: ${msg}`);
    }

    const { PaymentId, PaymentURL, Status } = res.data;

    await new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO payments (order_id, payment_id, amount, status, raw_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                order.id,
                String(PaymentId),
                amountKopecks,
                Status || 'NEW',
                JSON.stringify(res.data),
                new Date().toISOString()
            ],
            err => (err ? reject(err) : resolve())
        );
    });

    await new Promise((resolve, reject) => {
        db.run(
            'UPDATE orders SET status = ? WHERE id = ?',
            ['PENDING_PAYMENT', order.id],
            err => (err ? reject(err) : resolve())
        );
    });

    return { paymentId: PaymentId, paymentUrl: PaymentURL };
}

/**
 * Обработка webhook от Т-Банка (NotificationURL)
 * body — JSON, который прислал банк
 */
async function handleNotification(
    body,
    sendOrderToMoySklad,
    sendTelegramBotMessage,
    sendTelegramForumMessage,
    forumGroupId,
    onPaid
) {
    const { Token: receivedToken, ...rest } = body;
    const expectedToken = buildToken(rest);

    if (receivedToken !== expectedToken) {
        throw new Error('Invalid T-Bank notification token');
    }

    const { PaymentId, Status, ErrorCode, Message, Details } = body;

    console.log(
        '[T-Bank Notify] PaymentId:',
        PaymentId,
        'Status:',
        Status,
        'ErrorCode:',
        ErrorCode || '',
        'Message:',
        Message || ''
    );

    await new Promise((resolve, reject) => {
        db.run(
            'UPDATE payments SET status = ?, raw_json = ? WHERE payment_id = ?',
            [Status, JSON.stringify(body), String(PaymentId)],
            err => (err ? reject(err) : resolve())
        );
    });

    const paymentRow = await new Promise((resolve, reject) => {
        db.get(
            'SELECT order_id, amount FROM payments WHERE payment_id = ?',
            [String(PaymentId)],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    if (!paymentRow || !paymentRow.order_id) {
        console.warn('[T-Bank] Payment not linked to order, PaymentId =', PaymentId);
        return { ok: false };
    }

    const localOrderId = paymentRow.order_id;

    if (Status === 'AUTHORIZED') {
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET status = ? WHERE id = ?',
                ['AUTHORIZED', localOrderId],
                err => (err ? reject(err) : resolve())
            );
        });

        return { ok: true };
    }

    if (Status === 'CONFIRMED') {
        const existing = await dbGet(
            `SELECT status, paid_user_msg_sent, ms_paymentin_created FROM orders WHERE id = ?`,
            [localOrderId]
        );
        const alreadyPaid =
            existing && String(existing.status || '').trim().toUpperCase() === 'PAID';

        if (alreadyPaid) {
            console.log('[T-Bank] idempotent CONFIRMED webhook: order already PAID', {
                orderId: localOrderId,
                paymentId: String(PaymentId || '')
            });
            return { ok: true, duplicate: true };
        }

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET status = ? WHERE id = ?',
                ['PAID', localOrderId],
                err => (err ? reject(err) : resolve())
            );
        });

        const orderRow = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM orders WHERE id = ?',
                [localOrderId],
                (err, row) => (err ? reject(err) : resolve(row))
            );
        });

        if (orderRow && sendOrderToMoySklad) {
            const alreadyCreated = Number(orderRow.ms_paymentin_created || 0) === 1;

            if (!alreadyCreated) {
                let parsedItemsForLog = [];
                try {
                    parsedItemsForLog = JSON.parse(orderRow.items_json || '[]');
                } catch (_) {
                    parsedItemsForLog = [];
                }

                try {
                    const paidSumKopecks = Number(paymentRow.amount || 0);
                    const msOrderPayload = buildMoySkladOrderPayloadFromDbRow(orderRow);
                    const checkoutHash = String(orderRow.checkout_hash || '');
                    const itemsCount = (msOrderPayload.items || []).length;
                    const msMissingLines = countCartLinesMissingMsId(msOrderPayload.items);

                    console.log(
                        '[TBank] moysklad_post_payment_sync_started',
                        JSON.stringify({
                            orderId: localOrderId,
                            paymentId: String(PaymentId || ''),
                            checkoutHash,
                            needMsSync: true,
                            deliveryOption: msOrderPayload.deliveryOption,
                            deliveryFeeRub: msOrderPayload.deliveryFeeRub,
                            itemsCount,
                            msMissingLines
                        })
                    );

                    await sendOrderToMoySklad(msOrderPayload, {
                        createPayment: true,
                        paidSumKopecks
                    });

                    console.log(
                        '[TBank] moysklad_post_payment_sync_succeeded',
                        JSON.stringify({
                            orderId: localOrderId,
                            paymentId: String(PaymentId || ''),
                            checkoutHash,
                            deliveryOption: msOrderPayload.deliveryOption,
                            deliveryFeeRub: msOrderPayload.deliveryFeeRub,
                            itemsCount,
                            msMissingLines
                        })
                    );

                    await dbRun(
                        'UPDATE orders SET ms_paymentin_created = 1, moysklad_sync_status = ?, moysklad_sync_error = NULL WHERE id = ?',
                        ['moysklad_synced', localOrderId]
                    );
                } catch (e) {
                    console.error(
                        '[TBank] moysklad_post_payment_sync_failed',
                        JSON.stringify({
                            orderId: localOrderId,
                            paymentId: String(PaymentId || ''),
                            checkoutHash: String(orderRow.checkout_hash || ''),
                            deliveryOption: String(orderRow.delivery_option || ''),
                            deliveryFeeRub: Number(orderRow.delivery_fee_rub || 0),
                            itemsCount: parsedItemsForLog.length,
                            msMissingLines: countCartLinesMissingMsId(parsedItemsForLog),
                            reason: e && e.message ? e.message : String(e),
                            response: e && e.response && e.response.data ? e.response.data : undefined
                        })
                    );
                    const reason = `${e && e.message ? e.message : String(e)}`.slice(0, 900);
                    try {
                        await dbRun(
                            'UPDATE orders SET moysklad_sync_status = ?, moysklad_sync_error = ? WHERE id = ?',
                            ['moysklad_failed', reason, localOrderId]
                        );
                    } catch (_) {
                        /**/
                    }
                }
            } else {
                console.log('[T-Bank] PaymentIn already created for order', localOrderId, 'skip');
            }
        }

        const userMsgGate = await dbRun(
            `
    UPDATE orders
    SET paid_user_msg_sent = 1
    WHERE id = ?
      AND COALESCE(paid_user_msg_sent, 0) = 0
    `,
            [localOrderId]
        );
        const shouldSendUserMsg = userMsgGate.changes === 1;

        try {
            if (typeof onPaid === 'function' && orderRow) {
                await onPaid({
                    telegram_id: orderRow.telegram_id,
                    order_id: orderRow.id,
                    ms_order: orderRow.ms_name || '',
                    payment_id: String(PaymentId || '')
                });
            }
        } catch (e) {
            console.error('[EVENT_PUBLISHER] onPaid error:', e.message || e);
        }

        if (shouldSendUserMsg) {
            try {
                if (sendTelegramBotMessage && orderRow) {
                    const msRow = await new Promise((resolve, reject) => {
                        db.get(
                            'SELECT ms_name FROM orders WHERE id = ?',
                            [localOrderId],
                            (err, row) => (err ? reject(err) : resolve(row))
                        );
                    });

                    const orderNumber = String(msRow?.ms_name || orderRow.id);

                    const items = JSON.parse(orderRow.items_json || '[]');
                    const lines = items.map(it => `"${it.name}" - ${it.quantity}шт`).join('\n');

                    const address = String(orderRow.address || '');
                    const deliveryDate = String(orderRow.delivery_date || '');
                    const deliveryTime = String(orderRow.delivery_time || '');
                    const sumRub = Number(orderRow.total || 0);

                    const addrLower = address.trim().toLowerCase();
                    const isPickup =
                        addrLower === 'самовывоз' ||
                        addrLower === 'самовывоз ' ||
                        addrLower === 'самовывоз.' ||
                        addrLower === 'самовывоз,' ||
                        addrLower === 'самовывоз;' ||
                        address.trim().toUpperCase() === 'САМОВЫВОЗ';

                    let text = `✨ Вы оформили заказ #${orderNumber}` + (lines ? `\n${lines}\n` : '\n');

                    if (isPickup) {
                        text +=
                            `\nСпособ получения: Самовывоз` +
                            `\nАдрес самовывоза: улица Пирогова, 1, корп. 2` +
                            `\nСумма заказа: ${sumRub} ₽` +
                            `\n\nОжидаем Вас 🌷`;
                    } else {
                        text +=
                            `\nАдрес доставки: ${address}` +
                            `\nДата доставки: ${deliveryDate}` +
                            `\nВремя доставки: ${deliveryTime}` +
                            `\nСумма заказа: ${sumRub} ₽` +
                            `\n\nОжидайте доставки 🌷`;
                    }

                    text += '\n\nОставьте отзыв о нашем цветочном магазине — ваше мнение важно для нас!';

                    const REVIEW_URL =
                        'https://yandex.ru/maps/org/tsvetochny21/136980805014/reviews/?ll=47.215033%2C56.141463&source=serp_navig&tab=reviews&z=18';

                    await sendTelegramBotMessage(String(orderRow.telegram_id), text, {
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Оставить отзыв', url: REVIEW_URL }]]
                        }
                    });
                }
            } catch (e) {
                console.error('[TG] post-paid user message error:', e.message || e);

                await dbRun('UPDATE orders SET paid_user_msg_sent = 0 WHERE id = ?', [localOrderId]).catch(() => {});
            }
        } else {
            console.log('[T-Bank] user DM already sent for order', localOrderId);
        }

        return { ok: true };
    }

    if (Status === 'REJECTED' || Status === 'CANCELED') {
        const reason = `${Status}${ErrorCode != null ? ` code=${ErrorCode}` : ''}${
            Message ? `: ${Message}` : ''
        }${Details ? ` details=${Details}` : ''}`;
        console.error('[T-Bank] payment declined', {
            orderId: localOrderId,
            paymentId: String(PaymentId || ''),
            reason
        });
        await dbRun(`UPDATE orders SET status = ?, moysklad_sync_error = ? WHERE id = ?`, [
            'PAYMENT_FAILED',
            reason.slice(0, 900),
            localOrderId
        ]);
        return { ok: true };
    }

    return { ok: true };
}

module.exports = {
    initPaymentForOrder,
    handleNotification,
    resolvedPublicOrigin
};
