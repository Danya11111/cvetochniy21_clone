'use strict';

const assert = require('assert');
const {
    orderPaidRevenueKopecksFromRow,
    orderAmountKopecksFromRow,
    sqlOrderPaidRevenueKopecks
} = require('../money');
const {
    isOrderPaidForOps,
    deriveOrderAdminPresentation,
    isRevenueOrderStatus,
    sqlPaidOrderStatusFamily
} = require('../order-status');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('checkout-shaped pending: not paid, no revenue, correct admin label', () => {
    const row = {
        status: 'PENDING_PAYMENT',
        total_paid: 0,
        total: 300,
        total_before_bonus: 30000,
        bonuses_used: 0
    };
    assert.strictEqual(isOrderPaidForOps(row), false);
    assert.strictEqual(orderPaidRevenueKopecksFromRow(row), 0);
    assert.strictEqual(isRevenueOrderStatus(row), false);
    assert.strictEqual(orderAmountKopecksFromRow(row), 30000);
    const ui = deriveOrderAdminPresentation(row);
    assert.strictEqual(ui.status_code, 'awaiting_payment');
    assert.ok(String(ui.status_label).includes('Ожидает'));
});

test('legacy bug-shaped pending with prefilled total_paid: still unpaid', () => {
    const row = { status: 'PENDING_PAYMENT', total_paid: 30000, total: 300 };
    assert.strictEqual(isOrderPaidForOps(row), false);
    assert.strictEqual(orderPaidRevenueKopecksFromRow(row), 0);
    const ui = deriveOrderAdminPresentation(row);
    assert.strictEqual(ui.status_code, 'awaiting_payment');
});

test('paid after webhook: revenue and paid flag', () => {
    const row = {
        status: 'PAID',
        total_paid: 30000,
        total: 300,
        total_before_bonus: 30000,
        bonuses_used: 0
    };
    assert.strictEqual(isOrderPaidForOps(row), true);
    assert.strictEqual(orderPaidRevenueKopecksFromRow(row), 30000);
    assert.strictEqual(isRevenueOrderStatus(row), true);
    const ui = deriveOrderAdminPresentation(row);
    assert.strictEqual(ui.status_code, 'paid');
});

test('sql revenue expr: never uses total_paid without paid status', () => {
    const expr = sqlOrderPaidRevenueKopecks('o');
    assert.ok(expr.includes('PAID'));
    assert.ok(expr.includes('total_paid'));
});

test('sql paid family export stable', () => {
    assert.ok(sqlPaidOrderStatusFamily('ox').includes('ox.status'));
});
