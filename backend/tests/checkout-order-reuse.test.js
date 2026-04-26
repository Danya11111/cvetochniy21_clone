'use strict';

const assert = require('assert');
const {
    getCheckoutOrderAgeMs,
    isCheckoutOrderReusableByAge,
    resolveCheckoutUnpaidOrderForReuse
} = require('../checkout-order-reuse');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('resolve: no row → none, no effective order', () => {
    const r = resolveCheckoutUnpaidOrderForReuse(null, 1_700_000_000_000, 86400000);
    assert.strictEqual(r.decision, 'none');
    assert.strictEqual(r.effectiveOrderRow, null);
    assert.strictEqual(r.reuseMaxMs, 86400000);
});

test('resolve: fresh unpaid → reuse, same id', () => {
    const created = new Date('2026-04-23T10:00:00.000Z').toISOString();
    const nowMs = new Date('2026-04-23T11:00:00.000Z').getTime();
    const row = { id: 42, status: 'PENDING_PAYMENT', created_at: created, checkout_hash: 'h0' };
    const r = resolveCheckoutUnpaidOrderForReuse(row, nowMs, 86400000);
    assert.strictEqual(r.decision, 'reuse');
    assert.strictEqual(r.effectiveOrderRow.id, 42);
    assert.strictEqual(r.previousOrderId, 42);
    assert.ok(r.ageMs != null && r.ageMs < 86400000);
});

test('resolve: unpaid older than max → expired, effective null (new checkout must INSERT)', () => {
    const created = new Date('2026-04-22T10:00:00.000Z').toISOString();
    const nowMs = new Date('2026-04-23T11:00:00.000Z').getTime();
    const row = { id: 7, status: 'PENDING_PAYMENT', created_at: created, checkout_hash: 'old' };
    const r = resolveCheckoutUnpaidOrderForReuse(row, nowMs, 86400000);
    assert.strictEqual(r.decision, 'expired');
    assert.strictEqual(r.effectiveOrderRow, null);
    assert.strictEqual(r.previousOrderId, 7);
    assert.ok(r.ageMs != null && r.ageMs >= 86400000);
});

test('resolve: age exactly reuseMaxMs → expired (not reused)', () => {
    const createdMs = 1_000_000;
    const row = {
        id: 1,
        status: 'AUTHORIZED',
        created_at: new Date(createdMs).toISOString(),
        checkout_hash: 'x'
    };
    const r = resolveCheckoutUnpaidOrderForReuse(row, createdMs + 1000, 1000);
    assert.strictEqual(r.decision, 'expired');
    assert.strictEqual(r.effectiveOrderRow, null);
    assert.strictEqual(r.ageMs, 1000);
    assert.strictEqual(r.reuseMaxMs, 1000);
});

test('resolve: age reuseMaxMs - 1 → reuse', () => {
    const createdMs = 1_000_000;
    const row = {
        id: 2,
        status: 'PENDING_PAYMENT',
        created_at: new Date(createdMs).toISOString(),
        checkout_hash: 'x'
    };
    const r = resolveCheckoutUnpaidOrderForReuse(row, createdMs + 999, 1000);
    assert.strictEqual(r.decision, 'reuse');
    assert.strictEqual(r.effectiveOrderRow.id, 2);
});

test('resolve: bad created_at → expired (safe, no reuse)', () => {
    const row = { id: 3, status: 'PENDING_PAYMENT', created_at: 'not-a-date', checkout_hash: 'x' };
    const r = resolveCheckoutUnpaidOrderForReuse(row, Date.now(), 86400000);
    assert.strictEqual(r.decision, 'expired');
    assert.strictEqual(r.effectiveOrderRow, null);
    assert.strictEqual(r.ageMs, null);
});

test('resolve: NaN reuseMaxMs falls back to 24h default', () => {
    const row = {
        id: 4,
        status: 'PENDING_PAYMENT',
        created_at: new Date().toISOString(),
        checkout_hash: 'x'
    };
    const r = resolveCheckoutUnpaidOrderForReuse(row, Date.now(), NaN);
    assert.strictEqual(r.reuseMaxMs, 86400000);
});

test('getCheckoutOrderAgeMs: computes delta', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    const t1 = new Date('2026-01-01T01:00:00.000Z').getTime();
    const age = getCheckoutOrderAgeMs({ created_at: new Date(t0).toISOString() }, t1);
    assert.strictEqual(age, 3600000);
});

test('isCheckoutOrderReusableByAge: mirrors resolve boundary', () => {
    const row = { created_at: new Date(0).toISOString() };
    assert.strictEqual(isCheckoutOrderReusableByAge(row, 1000, 2000), true);
    assert.strictEqual(isCheckoutOrderReusableByAge(row, 2000, 2000), false);
});

test('config: CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS default 86400000', () => {
    const orig = process.env.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS;
    delete process.env.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS;
    delete require.cache[require.resolve('../config')];
    const cfg = require('../config');
    assert.strictEqual(cfg.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS, 86400000);
    process.env.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS = '3600000';
    delete require.cache[require.resolve('../config')];
    const cfg2 = require('../config');
    assert.strictEqual(cfg2.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS, 3600000);
    if (orig === undefined) delete process.env.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS;
    else process.env.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS = orig;
    delete require.cache[require.resolve('../config')];
});
