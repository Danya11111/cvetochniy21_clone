'use strict';

const assert = require('assert');
const {
    MOYSKLAD_CHECKOUT_WARNING_CODE,
    MOYSKLAD_CHECKOUT_WARNING_MESSAGE
} = require('../checkout-moysklad-order');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('MoySklad checkout warning code/message are stable', () => {
    assert.strictEqual(MOYSKLAD_CHECKOUT_WARNING_CODE, 'moysklad_degraded');
    assert.ok(MOYSKLAD_CHECKOUT_WARNING_MESSAGE.length > 20);
});

test('MoySklad checkout warning message avoids technical checkout tokens', () => {
    assert.ok(!MOYSKLAD_CHECKOUT_WARNING_MESSAGE.includes('checkout_failed'));
    assert.ok(!MOYSKLAD_CHECKOUT_WARNING_MESSAGE.includes('('));
    assert.ok(!/\bmoysklad_degraded\b/i.test(MOYSKLAD_CHECKOUT_WARNING_MESSAGE));
    assert.ok(MOYSKLAD_CHECKOUT_WARNING_MESSAGE.includes('администратор'));
});
