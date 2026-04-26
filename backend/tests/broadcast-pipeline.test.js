const assert = require('assert');
const { createTelegramClient } = require('../telegram-client');
const { interpretBroadcastOutcome } = require('../broadcast-service');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('copyMessage is not ok when outbound HTTP disabled', async () => {
    const client = createTelegramClient({
        botToken: 'dummy',
        outboundHttpEnabled: false,
        logger: console
    });
    const r = await client.copyMessage({
        fromChatId: -100,
        messageId: 1,
        chatId: 12345
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.errorCode, 'OUTBOUND_DISABLED');
});

test('interpretBroadcastOutcome: zero audience', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 0,
        delivered: 0,
        blocked: 0,
        failed: 0,
        pending: 0,
        retry_wait: 0,
        metrics: {},
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'ZERO_AUDIENCE');
});

test('interpretBroadcastOutcome: enqueue aborted (audience>0, zero inserted)', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 10,
        deliveriesInserted: 0,
        delivered: 0,
        blocked: 0,
        failed: 0,
        pending: 0,
        retry_wait: 0,
        metrics: {},
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'ENQUEUE_FAILED_OR_ABORTED');
});

test('interpretBroadcastOutcome: queue incomplete', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 5,
        deliveriesInserted: 5,
        delivered: 0,
        blocked: 0,
        failed: 0,
        pending: 2,
        retry_wait: 0,
        metrics: {},
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'QUEUE_INCOMPLETE');
});

test('interpretBroadcastOutcome: zero deliveries finished with permanent failures in metrics', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 3,
        deliveriesInserted: 3,
        delivered: 0,
        blocked: 0,
        failed: 3,
        pending: 0,
        retry_wait: 0,
        metrics: { broadcast_failed_permanent: 3 },
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'ZERO_DELIVERIES_WITH_FAILURES');
});

test('interpretBroadcastOutcome: retry_wait scheduling leaves queue incomplete', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 2,
        deliveriesInserted: 2,
        delivered: 0,
        blocked: 0,
        failed: 0,
        pending: 0,
        retry_wait: 2,
        metrics: { broadcast_retry_scheduled: 2 },
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'QUEUE_INCOMPLETE');
});

test('interpretBroadcastOutcome: success path', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 2,
        deliveriesInserted: 2,
        delivered: 2,
        blocked: 0,
        failed: 0,
        pending: 0,
        retry_wait: 0,
        metrics: { broadcast_sent_ok: 2 },
        topicTestMode: false
    });
    assert.strictEqual(o.primary, 'DELIVERIES_OK');
});
