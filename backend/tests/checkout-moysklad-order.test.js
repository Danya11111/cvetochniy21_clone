'use strict';

const assert = require('assert');
const {
    countCartLinesMissingMsId,
    syncOrderToMoySkladOnCheckout,
    buildMoySkladOrderPayloadFromDbRow,
    deliveryMethodFromOrderRow
} = require('../checkout-moysklad-order');

async function test(name, fn) {
    try {
        await Promise.resolve(fn());
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

(async function runAll() {
await test('countCartLinesMissingMsId: detects lines without ms id', () => {
    assert.strictEqual(
        countCartLinesMissingMsId([
            { msId: 'a', price: 1 },
            { price: 2 },
            { ms_id: 'b', price: 3 }
        ]),
        1
    );
    assert.strictEqual(countCartLinesMissingMsId([]), 0);
});

await test('syncOrderToMoySkladOnCheckout: fails validation when ms id missing', async () => {
    const r = await syncOrderToMoySkladOnCheckout({
        needMsSync: true,
        order: { id: 9, items: [{ name: 'x', price: 100 }], deliveryOption: 'city400', deliveryFeeRub: 350 },
        checkoutHash: 'h1',
        sendOrderToMoySklad: async () => {
            throw new Error('should not run');
        }
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'checkout_failed_missing_ms_ids');
    assert.strictEqual(r.msMissingLines, 1);
});

await test('syncOrderToMoySkladOnCheckout: returns error when MoySklad throws', async () => {
    const r = await syncOrderToMoySkladOnCheckout({
        needMsSync: true,
        order: { id: 2, items: [{ msId: 'uuid-here', price: 1 }], deliveryOption: 'pickup', deliveryFeeRub: 0 },
        checkoutHash: 'ab',
        sendOrderToMoySklad: async () => {
            const e = new Error('MS down');
            e.response = { data: { errors: [{ error: 'test' }] } };
            throw e;
        }
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'checkout_failed_moysklad_sync');
});

await test('syncOrderToMoySkladOnCheckout: skipped when needMsSync false', async () => {
    let called = false;
    const r = await syncOrderToMoySkladOnCheckout({
        needMsSync: false,
        order: { id: 3, items: [{ msId: 'x' }] },
        checkoutHash: 'x',
        sendOrderToMoySklad: async () => {
            called = true;
        }
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(called, false);
});

await test('syncOrderToMoySkladOnCheckout: succeeds and calls sendOrder', async () => {
    let called = false;
    const r = await syncOrderToMoySkladOnCheckout({
        needMsSync: true,
        order: { id: 4, items: [{ msId: 'p1', price: 10 }], deliveryOption: 'city400', deliveryFeeRub: 350 },
        checkoutHash: 'ch',
        sendOrderToMoySklad: async (order, opts) => {
            called = true;
            assert.strictEqual(order.id, 4);
            assert.deepStrictEqual(opts, { createPayment: false });
        }
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(called, true);
});

await test('buildMoySkladOrderPayloadFromDbRow: city400 + fee for post-payment delivery branch', () => {
    const row = {
        id: 100,
        telegram_id: 'tg1',
        full_name: 'Ivan Petrov',
        phone: '+79990001122',
        email: 'a@b.ru',
        address: 'ул. Ленина 1',
        delivery_date: '2026-04-24',
        delivery_time: '10:00 - 12:00',
        items_json: JSON.stringify([{ msId: 'u1', name: 'Букет', price: 1000, quantity: 1 }]),
        delivery_option: 'city400',
        delivery_fee_rub: 350,
        receiver_mode: 'self',
        recipient_full_name: 'Ivan Petrov',
        recipient_phone: '+79990001122',
        florist_comment: 'быстро',
        card_text: 'С любовью'
    };
    const o = buildMoySkladOrderPayloadFromDbRow(row);
    assert.strictEqual(o.deliveryOption, 'city400');
    assert.strictEqual(o.deliveryFeeRub, 350);
    assert.strictEqual(o.deliveryMethod, 'delivery');
    assert.strictEqual(o.recipientFullName, 'Ivan Petrov');
    assert.strictEqual(o.floristComment, 'быстро');
    assert.strictEqual(o.cardText, 'С любовью');
    assert.strictEqual(o.items.length, 1);
    assert.strictEqual(o.items[0].msId, 'u1');
    // Условие в sendOrderToMoySklad для строки доставки
    assert(o.deliveryOption === 'city400' && o.deliveryFeeRub > 0);
});

await test('buildMoySkladOrderPayloadFromDbRow: pickup — без city400/fee в смысле опции', () => {
    const row = {
        id: 101,
        telegram_id: 'tg2',
        full_name: 'Ann',
        phone: '+79991112233',
        email: '',
        address: 'САМОВЫВОЗ',
        delivery_date: '2026-04-25',
        delivery_time: '14:00',
        items_json: JSON.stringify([{ msId: 'u2', name: 'Розы', price: 500, quantity: 1 }]),
        delivery_option: 'pickup',
        delivery_fee_rub: 0,
        recipient_full_name: 'Ann',
        recipient_phone: '+79991112233',
        florist_comment: '',
        card_text: ''
    };
    const o = buildMoySkladOrderPayloadFromDbRow(row);
    assert.strictEqual(o.deliveryMethod, 'pickup');
    assert.strictEqual(o.deliveryFeeRub, 0);
    assert(!(o.deliveryOption === 'city400' && o.deliveryFeeRub > 0));
});

await test('deliveryMethodFromOrderRow: самовывоз по адресу', () => {
    assert.strictEqual(
        deliveryMethodFromOrderRow({ delivery_option: '', address: 'самовывоз' }),
        'pickup'
    );
});

await test('post-payment payload: полный набор полей для sendOrderToMoySklad', () => {
    const row = {
        id: 200,
        telegram_id: '99',
        full_name: 'A B',
        phone: '+70000000000',
        email: 'e@e.ru',
        address: 'Addr',
        delivery_date: '2026-01-02',
        delivery_time: '12:00 - 14:00',
        items_json: JSON.stringify([{ msId: 'mid', name: 'N', price: 1, quantity: 2 }]),
        delivery_option: 'city400',
        delivery_fee_rub: 350,
        receiver_mode: 'other',
        recipient_full_name: 'Other',
        recipient_phone: '+71111111111',
        florist_comment: 'c',
        card_text: 't',
        checkout_hash: 'hashx'
    };
    const o = buildMoySkladOrderPayloadFromDbRow(row);
    const required = [
        'id',
        'telegramId',
        'fullName',
        'phone',
        'email',
        'address',
        'deliveryDate',
        'deliveryTime',
        'items',
        'deliveryOption',
        'deliveryFeeRub',
        'deliveryMethod',
        'receiverMode',
        'recipientFullName',
        'recipientPhone',
        'floristComment',
        'cardText'
    ];
    for (const k of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(o, k), `missing key ${k}`);
    }
});

})().catch((e) => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});

/**
 * П.7 (PaymentIn + state «ОПЛАЧЕНО»): см. backend/moysklad.js при createPayment:true
 * (POST /entity/paymentin + markCustomerOrderPaid); e2e против живого МойСклад в unit-тест не выносили.
 */
