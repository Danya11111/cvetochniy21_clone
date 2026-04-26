const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const { TBANK_TERMINAL_KEY, TBANK_PASSWORD, BASE_URL } = require('./config');
const {
    buildMoySkladOrderPayloadFromDbRow,
    countCartLinesMissingMsId
} = require('./checkout-moysklad-order');

const TBANK_API_URL = 'https://securepay.tinkoff.ru'; // боевой URL

// Формирование токена согласно доке Т-Банка (TerminalKey + Password + параметры) :contentReference[oaicite:1]{index=1}
function buildToken(params) {
    // Копируем все поля верхнего уровня
    const data = { ...params };

    // По правилам Т-Банка из токена исключаются Token и Receipt
    delete data.Token;
    delete data.Receipt;

    // Добавляем пароль
    data.Password = TBANK_PASSWORD;

    const entries = Object.entries(data)
        .filter(([, v]) => v !== undefined && v !== null);

    // Сортируем по имени параметра
    entries.sort(([a], [b]) => a.localeCompare(b));

    // Конкатенируем только значения
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

// 1) разворачиваем quantity в Quantity=1, чтобы скидку распределять корректно
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
        // доставка как отдельная услуга, qty=1 (чтобы скидка распределялась корректно)
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

// 2) распределяем скидку (бонусы) по позициям (Quantity=1 → легко)
function applyDiscountToReceiptItems(items, discountKopecks) {
    if (!discountKopecks || discountKopecks <= 0) return items;

    const total = items.reduce((s, it) => s + (it.Amount || 0), 0);
    if (total <= 0) return items;

    let remaining = discountKopecks;

    // распределяем по 1 копейке с конца (чтобы гарантированно уложиться)
    // сначала пропорционально
    const discounted = items.map(it => ({ ...it }));

    for (let i = 0; i < discounted.length; i++) {
        const it = discounted[i];
        if (remaining <= 0) break;

        const share = Math.floor((it.Amount * discountKopecks) / total);
        const use = Math.min(remaining, share);

        it.Price = Math.max(0, it.Price - use);   // qty=1
        it.Amount = it.Price;
        remaining -= use;
    }

    // добиваем остаток скидки по 1 копейке с конца
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

    // 1) Базовые позиции для чека (ТОВАРЫ + ДОСТАВКА)
    let receiptItems = buildReceiptItemsExpanded(order.items || [], order.deliveryFeeRub);

    const totalBeforeK = receiptItems.reduce((sum, it) => sum + (it.Amount || 0), 0);
    const bonusesUsedK = Math.max(0, Number(order.bonusesUsedK || 0));

    // 2) Amount = totalPaidK (которую сервер уже посчитал: товары+доставка-бонусы)
    const amountKopecks = Number.isFinite(Number(order.totalPaidK))
        ? Math.max(0, Number(order.totalPaidK))
        : Math.max(0, totalBeforeK - bonusesUsedK);

    if (amountKopecks <= 0) {
        throw new Error('Cannot init payment with zero amount');
    }

    // 3) Если применялись бонусы — уменьшаем позиции в чеке так, чтобы сумма Items == Amount
    const discountK = Math.max(0, totalBeforeK - amountKopecks);

    if (discountK > 0) {
        receiptItems = applyDiscountToReceiptItems(receiptItems, discountK);
    }

    // контроль: сумма позиций должна совпасть с Amount
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
        NotificationURL: `${BASE_URL}/api/tbank/notify`
    };

    payload.Token = buildToken(payload);

    const res = await axios.post(`${TBANK_API_URL}/v2/Init`, payload, {
        headers: { 'Content-Type': 'application/json' }
    });

    console.log('[T-Bank Init] response:', JSON.stringify(res.data, null, 2));

    if (!res.data.Success) {
        throw new Error(`T-Bank Init error: ${res.data.ErrorCode} ${res.data.Message || ''}`);
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
    onPaid // <-- новый аргумент
) {
    // 1) Проверяем подпись
    const { Token: receivedToken, ...rest } = body;
    const expectedToken = buildToken(rest);

    if (receivedToken !== expectedToken) {
        throw new Error('Invalid T-Bank notification token');
    }

    const { PaymentId, Status } = body;

    console.log('[T-Bank Notify] PaymentId:', PaymentId, 'Status:', Status);

    // 2) Обновляем payment
    await new Promise((resolve, reject) => {
        db.run(
            'UPDATE payments SET status = ?, raw_json = ? WHERE payment_id = ?',
            [Status, JSON.stringify(body), String(PaymentId)],
            err => (err ? reject(err) : resolve())
        );
    });

    // 3) Находим локальный заказ по payment_id
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
        // 1) отмечаем как оплаченный локально
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET status = ? WHERE id = ?',
                ['PAID', localOrderId],
                err => (err ? reject(err) : resolve())
            );
        });

        // 2) грузим заказ
        const orderRow = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM orders WHERE id = ?',
                [localOrderId],
                (err, row) => (err ? reject(err) : resolve(row))
            );
        });

        // 3) создаём оплату/обновляем МС (PaymentIn + статус)
        //    (ты уже защищаешься флагом ms_paymentin_created)
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

                    // фиксируем, что PaymentIn создан — чтобы не удваивать
                    await new Promise((resolve, reject) => {
                        db.run(
                            'UPDATE orders SET ms_paymentin_created = 1 WHERE id = ?',
                            [localOrderId],
                            err => (err ? reject(err) : resolve())
                        );
                    });

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
                    // флаг не ставим — можно повторить позже
                }
            } else {
                console.log('[T-Bank] PaymentIn already created for order', localOrderId, 'skip');
            }
        }

        // 4) сообщение в топик супергруппы "оплатил" (если есть groupId + topic_id)
        // try {
        //     if (forumGroupId && sendTelegramForumMessage && orderRow) {
        //         const userRow = await new Promise((resolve, reject) => {
        //             db.get(
        //                 'SELECT first_name, last_name, topic_id FROM users WHERE telegram_id = ?',
        //                 [orderRow.telegram_id],
        //                 (err, row) => (err ? reject(err) : resolve(row))
        //             );
        //         });
        //
        //         const topicId = Number(userRow?.topic_id || 0);
        //         if (topicId > 0) {
        //             const NAME =
        //                 `${String(userRow?.first_name || '').trim()} ${String(userRow?.last_name || '').trim()}`.trim() ||
        //                 'Клиент';
        //             const ID = String(orderRow.telegram_id);
        //
        //             await sendTelegramForumMessage(
        //                 forumGroupId,
        //                 topicId,
        //                 `Я к тебе с радостными новостями 🟢\n\nКлиент ${NAME}, ${ID}, оплатил свой заказ 🥳`
        //             );
        //         }
        //     }
        // } catch (e) {
        //     console.error('[TG] paid forum message error:', e.message || e);
        // }

// === Idempotency: user DM (1 раз на заказ) ===
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


        // Публикация события оплаты в внутренний event-контур.
        // Идемпотентность дальнейшей доставки контролируется outbox dedupe.
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


        // 5) сообщение пользователю в личку (заказ # из МС + список товаров)
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

                    let text = `✨ Вы оформили заказ #${orderNumber}` +
                        (lines ? `\n${lines}\n` : '\n');

                    if (isPickup) {
                        // самовывоз — другой текст
                        text +=
                            `\nСпособ получения: Самовывоз` +
                            `\nАдрес самовывоза: улица Пирогова, 1, корп. 2` +
                            `\nСумма заказа: ${sumRub} ₽` +
                            `\n\nОжидаем Вас 🌷`;
                    } else {
                        // доставка — как было
                        text +=
                            `\nАдрес доставки: ${address}` +
                            `\nДата доставки: ${deliveryDate}` +
                            `\nВремя доставки: ${deliveryTime}` +
                            `\nСумма заказа: ${sumRub} ₽` +
                            `\n\nОжидайте доставки 🌷`;
                    }

                    text += '\n\nОставьте отзыв о нашем цветочном магазине — ваше мнение важно для нас!'

                    const REVIEW_URL = 'https://yandex.ru/maps/org/tsvetochny21/136980805014/reviews/?ll=47.215033%2C56.141463&source=serp_navig&tab=reviews&z=18';

                    await sendTelegramBotMessage(String(orderRow.telegram_id), text, {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Оставить отзыв', url: REVIEW_URL }]
                            ]
                        }
                    });

                }
            } catch (e) {
                console.error('[TG] post-paid user message error:', e.message || e);

                await dbRun('UPDATE orders SET paid_user_msg_sent = 0 WHERE id = ?', [localOrderId]).catch(() => {
                });
            }
        } else {
                console.log('[T-Bank] user DM already sent for order', localOrderId);
            }

        return { ok: true };
    }

    if (Status === 'REJECTED' || Status === 'CANCELED') {
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE orders SET status = ? WHERE id = ?',
                ['CANCELLED', localOrderId],
                err => (err ? reject(err) : resolve())
            );
        });

        return { ok: true };
    }

    return { ok: true };
}





module.exports = {
    initPaymentForOrder,
    handleNotification
};
