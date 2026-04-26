const assert = require('assert');
const {
    recordTelegramOutboundResult,
    getTelegramTransportHealthSnapshot,
    shouldBlockBroadcastTrigger,
    shouldHaltBroadcastDelivery,
    recordTransportProbeResult,
    resetTelegramTransportHealthRuntimeForTests
} = require('../telegram-transport-health');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

const baseCtx = {
    outboundEnabled: true,
    httpClientPresent: true,
    proxyConfigured: true,
    transportMode: 'proxied'
};

test('snapshot: success resets consecutive transport errors after failures', () => {
    resetTelegramTransportHealthRuntimeForTests();
    recordTelegramOutboundResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });
    recordTelegramOutboundResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });
    let s = getTelegramTransportHealthSnapshot(baseCtx);
    assert.strictEqual(s.consecutiveTransportErrors, 2);
    recordTelegramOutboundResult({ ok: true, errorCode: '', method: 'copyMessage' });
    s = getTelegramTransportHealthSnapshot(baseCtx);
    assert.strictEqual(s.consecutiveTransportErrors, 0);
});

test('snapshot: series of transport-like failures keeps degraded signal', () => {
    resetTelegramTransportHealthRuntimeForTests();
    for (let i = 0; i < 4; i += 1) {
        recordTelegramOutboundResult({ ok: false, errorCode: 'NETWORK', method: 'copyMessage' });
    }
    const s = getTelegramTransportHealthSnapshot(baseCtx);
    assert.strictEqual(s.consecutiveTransportErrors, 4);
    assert.strictEqual(s.degraded, true);
    assert.strictEqual(s.degradedReason, 'CONSECUTIVE_OUTBOUND_TRANSPORT_ERRORS');
});

test('snapshot: user-facing TG error code does not lengthen transport streak', () => {
    resetTelegramTransportHealthRuntimeForTests();
    recordTelegramOutboundResult({ ok: false, errorCode: 'BOT_BLOCKED', method: 'copyMessage' });
    const s = getTelegramTransportHealthSnapshot(baseCtx);
    assert.strictEqual(s.consecutiveTransportErrors, 0);
});

test('shouldBlockBroadcastTrigger: outbound disabled', () => {
    resetTelegramTransportHealthRuntimeForTests();
    const r = shouldBlockBroadcastTrigger({
        outboundEnabled: false,
        httpClientPresent: true,
        proxyConfigured: false,
        transportMode: 'unknown'
    });
    assert.strictEqual(r.block, true);
    assert.strictEqual(r.reason, 'OUTBOUND_DISABLED');
});

test('shouldBlockBroadcastTrigger: ok when healthy', () => {
    resetTelegramTransportHealthRuntimeForTests();
    const r = shouldBlockBroadcastTrigger(baseCtx);
    assert.strictEqual(r.block, false);
});

test('shouldHaltBroadcastDelivery: probe DEGRADED halts before passive streak', () => {
    resetTelegramTransportHealthRuntimeForTests();
    recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });
    const h = shouldHaltBroadcastDelivery(baseCtx);
    assert.strictEqual(h.halt, true);
    assert.strictEqual(h.source, 'probe');
});

test('shouldHaltBroadcastDelivery: healthy probe + healthy passive does not halt', () => {
    resetTelegramTransportHealthRuntimeForTests();
    recordTransportProbeResult({ ok: true, method: 'getMe' });
    const h = shouldHaltBroadcastDelivery(baseCtx);
    assert.strictEqual(h.halt, false);
});

test('snapshot exposes stable health contract fields', () => {
    resetTelegramTransportHealthRuntimeForTests();
    const s = getTelegramTransportHealthSnapshot(baseCtx);
    assert.ok('outboundEnabled' in s);
    assert.ok('httpClientPresent' in s);
    assert.ok('proxyConfigured' in s);
    assert.ok('transportMode' in s);
    assert.ok('lastOutboundSuccessAt' in s);
    assert.ok('lastOutboundErrorAt' in s);
    assert.ok('lastOutboundErrorCode' in s);
    assert.ok('consecutiveTransportErrors' in s);
    assert.ok('degraded' in s);
    assert.ok('degradedReason' in s);
});
