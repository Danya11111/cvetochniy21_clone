const assert = require('assert');
const { computeThreadWaitingForStaff } = require('../support-waiting');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('closed thread never waiting', () => {
    assert.strictEqual(
        computeThreadWaitingForStaff({
            status: 'CLOSED',
            waiting_for_staff: 1,
            last_message_direction: 'CLIENT_TO_TOPIC'
        }),
        false
    );
});

test('denorm waiting_for_staff wins', () => {
    assert.strictEqual(
        computeThreadWaitingForStaff({
            status: 'OPEN',
            waiting_for_staff: 1,
            last_message_direction: 'TOPIC_TO_CLIENT'
        }),
        true
    );
    assert.strictEqual(
        computeThreadWaitingForStaff({
            status: 'OPEN',
            waiting_for_staff: 0,
            last_message_direction: 'CLIENT_TO_TOPIC'
        }),
        false
    );
});

test('fallback last message CLIENT_TO_TOPIC', () => {
    assert.strictEqual(
        computeThreadWaitingForStaff({
            status: 'OPEN',
            waiting_for_staff: null,
            last_message_direction: 'CLIENT_TO_TOPIC'
        }),
        true
    );
    assert.strictEqual(
        computeThreadWaitingForStaff({
            status: 'OPEN',
            waiting_for_staff: undefined,
            last_message_direction: 'TOPIC_TO_CLIENT'
        }),
        false
    );
    assert.strictEqual(
        computeThreadWaitingForStaff({ status: 'OPEN', waiting_for_staff: null, last_message_direction: '' }),
        false
    );
});
