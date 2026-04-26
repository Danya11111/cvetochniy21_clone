const assert = require('assert');
const {
    classifyTelegramDescription,
    isRetryableTelegramError,
    isPermanentBroadcastDeliveryError,
    computeNextRetryAt
} = require('../reliability-utils');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('classify BOT_BLOCKED', () => {
    assert.strictEqual(
        classifyTelegramDescription('Forbidden: bot was blocked by the user'),
        'BOT_BLOCKED'
    );
});

test('classify RATE_LIMIT', () => {
    assert.strictEqual(
        classifyTelegramDescription('Too Many Requests: retry after 10'),
        'RATE_LIMIT'
    );
});

test('retryable classification', () => {
    assert.strictEqual(isRetryableTelegramError('RATE_LIMIT'), true);
    assert.strictEqual(isRetryableTelegramError('INTERNAL_EXCEPTION'), true);
    assert.strictEqual(isRetryableTelegramError('BOT_BLOCKED'), false);
});

test('classify USER_DEACTIVATED', () => {
    assert.strictEqual(
        classifyTelegramDescription('Forbidden: user is deactivated'),
        'USER_DEACTIVATED'
    );
});

test('permanent broadcast delivery errors', () => {
    assert.strictEqual(isPermanentBroadcastDeliveryError('CHAT_NOT_FOUND'), true);
    assert.strictEqual(isPermanentBroadcastDeliveryError('USER_DEACTIVATED'), true);
    assert.strictEqual(isPermanentBroadcastDeliveryError('OUTBOUND_DISABLED'), true);
    assert.strictEqual(isPermanentBroadcastDeliveryError('NO_HTTP_CLIENT'), true);
    assert.strictEqual(isPermanentBroadcastDeliveryError('RATE_LIMIT'), false);
    assert.strictEqual(isPermanentBroadcastDeliveryError('NETWORK'), false);
});

test('computeNextRetryAt increases time', () => {
    const now = Date.now();
    const next = Date.parse(computeNextRetryAt(0));
    assert.ok(next > now, 'next retry must be in the future');
});

