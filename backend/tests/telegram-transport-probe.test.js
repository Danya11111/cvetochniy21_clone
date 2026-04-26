const assert = require('assert');
const { computeNextProbeDelayMs } = require('../telegram-transport-probe');
const {
    recordTelegramOutboundResult,
    recordTransportProbeResult,
    shouldBlockBroadcastTrigger,
    resetTelegramTransportHealthRuntimeForTests,
    getTransportProbeSnapshot
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

test('computeNextProbeDelayMs: backoff grows then caps', () => {
    const d0 = computeNextProbeDelayMs({ consecutiveFailures: 0, baseIntervalMs: 60_000, backoffMaxMs: 300_000 });
    const d2 = computeNextProbeDelayMs({ consecutiveFailures: 2, baseIntervalMs: 60_000, backoffMaxMs: 300_000 });
    const d8 = computeNextProbeDelayMs({ consecutiveFailures: 8, baseIntervalMs: 60_000, backoffMaxMs: 300_000 });
    assert.ok(d2 > d0);
    assert.strictEqual(d8, 300_000);
});

test('preflight: successful probe lifts block while passive snapshot still degraded', () => {
    resetTelegramTransportHealthRuntimeForTests();
    for (let i = 0; i < 4; i += 1) {
        recordTelegramOutboundResult({ ok: false, errorCode: 'TIMEOUT', method: 'copyMessage' });
    }
    assert.strictEqual(shouldBlockBroadcastTrigger(baseCtx).block, true);
    recordTransportProbeResult({ ok: true, errorCode: '', method: 'getMe' });
    const r = shouldBlockBroadcastTrigger(baseCtx, { probePreflightTrustMs: 120_000 });
    assert.strictEqual(r.block, false);
    assert.strictEqual(r.allowedByActiveProbe, true);
});

test('probe: repeated failures keep consecutiveProbeFailures', () => {
    resetTelegramTransportHealthRuntimeForTests();
    recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });
    recordTransportProbeResult({ ok: false, errorCode: 'TIMEOUT', method: 'getMe' });
    const snap = getTransportProbeSnapshot({ enabled: true, method: 'getMe', intervalMs: 60_000, backoffMaxMs: 300_000 });
    assert.strictEqual(snap.consecutiveProbeFailures, 2);
    assert.strictEqual(snap.probeState, 'DEGRADED');
});

test('health: transportProbe snapshot has stable keys', () => {
    resetTelegramTransportHealthRuntimeForTests();
    const s = getTransportProbeSnapshot({
        enabled: true,
        method: 'getMe',
        intervalMs: 60_000,
        backoffMaxMs: 300_000,
        preflightTrustMs: 120_000
    });
    assert.ok('enabled' in s);
    assert.ok('nextProbeDueAt' in s);
    assert.ok('consecutiveProbeFailures' in s);
});
