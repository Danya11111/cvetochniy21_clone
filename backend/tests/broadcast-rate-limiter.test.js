const assert = require('assert');
const { createBroadcastRateLimiter } = require('../broadcast-rate-limiter');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('broadcast rate limiter snapshot exposes tuning', () => {
    const rl = createBroadcastRateLimiter({
        globalMessagesPerSec: 18,
        perChatMinIntervalMs: 1000,
        logger: console
    });
    const s = rl.snapshot();
    assert.strictEqual(s.globalMessagesPerSec, 18);
    assert.strictEqual(s.perChatMinIntervalMs, 1000);
    assert.ok(typeof s.tokensApprox === 'number');
});
