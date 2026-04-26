const assert = require('assert');
const { computeBroadcastRecoveryAction } = require('../broadcast-service');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

const now = 1_700_000_000_000;
const oldCreated = new Date(now - 300_000).toISOString();

test('recovery: skip when not RUNNING', () => {
    const d = computeBroadcastRecoveryAction(
        { status: 'DONE', created_at: oldCreated },
        { totalRows: 5, queueRemaining: 2 },
        { nowMs: now }
    );
    assert.strictEqual(d.action, 'skip');
});

test('recovery: resume_delivery when queue has pending/retry', () => {
    const d = computeBroadcastRecoveryAction(
        { status: 'RUNNING', created_at: oldCreated },
        { totalRows: 10, queueRemaining: 3 },
        { nowMs: now }
    );
    assert.strictEqual(d.action, 'resume_delivery');
});

test('recovery: PAUSED_TRANSPORT resumes delivery when queue open', () => {
    const d = computeBroadcastRecoveryAction(
        { status: 'PAUSED_TRANSPORT', created_at: oldCreated },
        { totalRows: 10, queueRemaining: 3 },
        { nowMs: now }
    );
    assert.strictEqual(d.action, 'resume_delivery');
});

test('recovery: resume_finalize when rows exist but queue empty', () => {
    const d = computeBroadcastRecoveryAction(
        { status: 'RUNNING', created_at: oldCreated },
        { totalRows: 10, queueRemaining: 0 },
        { nowMs: now }
    );
    assert.strictEqual(d.action, 'resume_finalize');
});

test('recovery: abandon_empty when no rows and campaign old enough', () => {
    const d = computeBroadcastRecoveryAction(
        { status: 'RUNNING', created_at: oldCreated },
        { totalRows: 0, queueRemaining: 0 },
        { nowMs: now, abandonNoRowsAfterMs: 60_000 }
    );
    assert.strictEqual(d.action, 'abandon_empty');
});

test('recovery: skip young campaign with zero rows (enqueue in flight)', () => {
    const young = new Date(now - 30_000).toISOString();
    const d = computeBroadcastRecoveryAction(
        { status: 'RUNNING', created_at: young },
        { totalRows: 0, queueRemaining: 0 },
        { nowMs: now, abandonNoRowsAfterMs: 120_000 }
    );
    assert.strictEqual(d.action, 'skip');
    assert.ok(String(d.reason).includes('WAITING') || String(d.reason).includes('TOO_YOUNG'));
});
