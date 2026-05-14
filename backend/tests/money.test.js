const assert = require('assert');
const {
    orderAmountKopecksFromRow,
    orderPaidRevenueKopecksFromRow,
    orderUnpaidExposureKopecksFromRow,
    kopecksToWholeRub,
    rubThresholdToKopecks,
    formatKopecksRu
} = require('../money');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('paid order: total_before_bonus wins', () => {
    assert.strictEqual(
        orderAmountKopecksFromRow({
            total_paid: 278000,
            total: 27.8,
            total_before_bonus: 278000,
            bonuses_used: 0,
            status: 'PAID'
        }),
        278000
    );
});

test('unpaid: total rubles to kopecks', () => {
    assert.strictEqual(
        orderAmountKopecksFromRow({ total_paid: 0, total: 2780, status: 'PENDING_PAYMENT' }),
        278000
    );
});

test('pending with bogus total_paid: no revenue', () => {
    assert.strictEqual(
        orderPaidRevenueKopecksFromRow({ total_paid: 30000, total: 300, status: 'PENDING_PAYMENT' }),
        0
    );
});

test('legacy PAID without total_paid uses total rubles', () => {
    assert.strictEqual(
        orderPaidRevenueKopecksFromRow({ total_paid: 0, total: 1500, status: 'PAID' }),
        150000
    );
});

test('unpaid revenue exposure', () => {
    assert.strictEqual(orderUnpaidExposureKopecksFromRow({ total_paid: 0, total: 100, status: 'NEW' }), 10000);
    assert.strictEqual(orderUnpaidExposureKopecksFromRow({ total_paid: 5000, total: 100, status: 'PAID' }), 0);
});

test('unpaid revenue exposure ignores stray total_paid on pending', () => {
    assert.strictEqual(
        orderUnpaidExposureKopecksFromRow({ total_paid: 5000, total: 100, status: 'PENDING_PAYMENT' }),
        10000
    );
});

test('kopecksToWholeRub', () => {
    assert.strictEqual(kopecksToWholeRub(278050), 2781);
    assert.strictEqual(kopecksToWholeRub(278000), 2780);
});

test('rubThresholdToKopecks', () => {
    assert.strictEqual(rubThresholdToKopecks(7000), 700000);
});

test('formatKopecksRu', () => {
    assert.ok(formatKopecksRu(278000).includes('2'));
    assert.ok(formatKopecksRu(278000).includes('₽'));
});
