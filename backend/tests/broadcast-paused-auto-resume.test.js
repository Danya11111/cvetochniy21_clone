/**
 * Чистая логика cooldown для авто-resume (дублирование с broadcast-service для тестируемости констант).
 */
const assert = require('assert');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

function shouldSkipGlobalResume({ nowMs, lastAutoResumeAtMs, minIntervalMs }) {
    if (lastAutoResumeAtMs == null) return false;
    return nowMs - lastAutoResumeAtMs < minIntervalMs;
}

function shouldSkipPerCampaignResume({ nowMs, lastAttemptMs, cooldownMs }) {
    if (lastAttemptMs == null) return false;
    return nowMs - lastAttemptMs < cooldownMs;
}

test('auto-resume: global cooldown blocks rapid repeats', () => {
    const now = 1_000_000;
    assert.strictEqual(
        shouldSkipGlobalResume({ nowMs: now, lastAutoResumeAtMs: now - 60_000, minIntervalMs: 120_000 }),
        true
    );
    assert.strictEqual(
        shouldSkipGlobalResume({ nowMs: now, lastAutoResumeAtMs: now - 130_000, minIntervalMs: 120_000 }),
        false
    );
});

test('auto-resume: per-campaign cooldown', () => {
    const now = 2_000_000;
    assert.strictEqual(
        shouldSkipPerCampaignResume({ nowMs: now, lastAttemptMs: now - 60_000, cooldownMs: 180_000 }),
        true
    );
    assert.strictEqual(
        shouldSkipPerCampaignResume({ nowMs: now, lastAttemptMs: now - 200_000, cooldownMs: 180_000 }),
        false
    );
});
