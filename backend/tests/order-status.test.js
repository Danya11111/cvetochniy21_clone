const assert = require('assert');
const {
    isOrderPaidForOps,
    deriveOrderAdminPresentation,
    buildOrdersListWhereClause
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

test('paid by total_paid', () => {
    assert.strictEqual(isOrderPaidForOps({ total_paid: 100, status: 'Создан' }), true);
});

test('paid by status', () => {
    assert.strictEqual(isOrderPaidForOps({ total_paid: 0, status: 'PAID' }), true);
});

test('label awaiting payment', () => {
    const u = deriveOrderAdminPresentation({ status: 'PENDING_PAYMENT', total_paid: 0 });
    assert.strictEqual(u.status_code, 'awaiting_payment');
});

test('legacy cyrillic status unpaid', () => {
    const u = deriveOrderAdminPresentation({ status: 'Создан', total_paid: 0, ms_state_name: 'Принят' });
    assert.strictEqual(u.status_code, 'fulfillment_external');
    assert.ok(String(u.status_label).length > 0);
});

test('label payment_failed', () => {
    const u = deriveOrderAdminPresentation({ status: 'PAYMENT_FAILED', total_paid: 0 });
    assert.strictEqual(u.status_code, 'payment_failed');
});

test('list filter payment_failed excludes cancelled bucket', () => {
    const { clause } = buildOrdersListWhereClause({ status_code: 'payment_failed', status: '' });
    assert.ok(clause.includes('PAYMENT_FAILED'));
    assert.ok(!clause.includes('CANCELLED'));
});

test('list filter paid by status_code', () => {
    const { clause } = buildOrdersListWhereClause({ status_code: 'paid', status: '' });
    assert.ok(clause.includes('total_paid'));
    assert.ok(clause.toUpperCase().includes('WHERE'));
});

test('list filter unpaid', () => {
    const { clause } = buildOrdersListWhereClause({ status_code: 'unpaid', status: '' });
    assert.ok(clause.includes('NOT'));
});

test('list filter legacy exact status', () => {
    const { clause, args } = buildOrdersListWhereClause({ status_code: '', status: 'Создан' });
    assert.strictEqual(clause, 'WHERE o.status = ?');
    assert.deepStrictEqual(args, ['Создан']);
});
