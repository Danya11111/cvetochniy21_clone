const assert = require('assert');
const {
    applyTransportBreakerStreakAfterFailedCopy,
    resetTransportBreakerStreak,
    applyTransportBreakerStreakAfterWave
} = require('../broadcast-transport-breaker');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('breaker: transport errors accumulate until user terminal resets', () => {
    let st = resetTransportBreakerStreak();
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'TIMEOUT');
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'TIMEOUT');
    assert.strictEqual(st.consecutiveTransportCopyFailures, 2);
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'BOT_BLOCKED');
    assert.strictEqual(st.consecutiveTransportCopyFailures, 0);
});

test('breaker: CHAT_NOT_FOUND resets streak (user-scoped)', () => {
    let st = resetTransportBreakerStreak();
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'NETWORK');
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'CHAT_NOT_FOUND');
    assert.strictEqual(st.consecutiveTransportCopyFailures, 0);
});

test('breaker: non-transport failure resets streak', () => {
    let st = resetTransportBreakerStreak();
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'TIMEOUT');
    st = applyTransportBreakerStreakAfterFailedCopy(st, 'WEIRD_USER_CODE');
    assert.strictEqual(st.consecutiveTransportCopyFailures, 0);
});

test('breaker: wave success clears streak', () => {
    let st = { consecutiveTransportCopyFailures: 9 };
    st = applyTransportBreakerStreakAfterWave(st, true);
    assert.strictEqual(st.consecutiveTransportCopyFailures, 0);
});

test('breaker: wave without success keeps streak', () => {
    let st = { consecutiveTransportCopyFailures: 9 };
    st = applyTransportBreakerStreakAfterWave(st, false);
    assert.strictEqual(st.consecutiveTransportCopyFailures, 9);
});
