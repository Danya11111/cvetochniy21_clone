const assert = require('assert');
const {
    deriveBroadcastStallState,
    interpretBroadcastOutcome
} = require('../broadcast-service');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

const now = 1_720_000_000_000;

test('deriveBroadcastStallState: PAUSED_TRANSPORT surfaces transport pause', () => {
    const d = deriveBroadcastStallState(
        { status: 'PAUSED_TRANSPORT', created_at: new Date(now - 600_000).toISOString() },
        {
            totalRows: 100,
            queueRemaining: 40,
            futureRetryScheduled: 0,
            dueWorkNow: 40,
            nowMs: now,
            workerActiveForThisCampaign: false
        }
    );
    assert.strictEqual(d.progressState, 'TRANSPORT_PAUSED');
    assert.strictEqual(d.stallReason, 'BROADCAST_PAUSED_BY_TRANSPORT_BREAKER');
});

test('deriveBroadcastStallState: pre-enqueue young campaign', () => {
    const d = deriveBroadcastStallState(
        { status: 'RUNNING', created_at: new Date(now - 10_000).toISOString() },
        {
            totalRows: 0,
            queueRemaining: 0,
            futureRetryScheduled: 0,
            dueWorkNow: 0,
            nowMs: now,
            workerActiveForThisCampaign: false
        }
    );
    assert.strictEqual(d.progressState, 'PRE_ENQUEUE');
    assert.strictEqual(d.stallReason, 'WAITING_ENQUEUE_OR_JOB');
});

test('deriveBroadcastStallState: waiting scheduled retry (not stalled)', () => {
    const d = deriveBroadcastStallState(
        {
            status: 'RUNNING',
            created_at: new Date(now - 600_000).toISOString(),
            delivery_enqueue_completed_at: new Date(now - 500_000).toISOString(),
            delivery_last_progress_at: new Date(now - 60_000).toISOString(),
            delivery_wave_count: 2
        },
        {
            totalRows: 10,
            queueRemaining: 5,
            futureRetryScheduled: 5,
            dueWorkNow: 0,
            nowMs: now,
            workerActiveForThisCampaign: true,
            transportLikelyFromLastRun: false
        }
    );
    assert.strictEqual(d.progressState, 'WAITING_SCHEDULED_RETRY');
    assert.strictEqual(d.stallReason, null);
});

test('deriveBroadcastStallState: worker inactive but queue open', () => {
    const d = deriveBroadcastStallState(
        {
            status: 'RUNNING',
            delivery_enqueue_completed_at: new Date(now - 100_000).toISOString(),
            delivery_last_progress_at: new Date(now - 100_000).toISOString()
        },
        {
            totalRows: 5,
            queueRemaining: 3,
            futureRetryScheduled: 0,
            dueWorkNow: 3,
            nowMs: now,
            workerActiveForThisCampaign: false
        }
    );
    assert.strictEqual(d.progressState, 'STALLED');
    assert.strictEqual(d.stallReason, 'WORKER_INACTIVE_BUT_QUEUE_OPEN');
});

test('deriveBroadcastStallState: active worker no stall', () => {
    const d = deriveBroadcastStallState(
        {
            status: 'RUNNING',
            delivery_enqueue_completed_at: new Date(now - 100_000).toISOString(),
            delivery_last_progress_at: new Date(now - 30_000).toISOString(),
            delivery_wave_count: 1
        },
        {
            totalRows: 5,
            queueRemaining: 3,
            futureRetryScheduled: 0,
            dueWorkNow: 3,
            nowMs: now,
            workerActiveForThisCampaign: true
        }
    );
    assert.strictEqual(d.progressState, 'ACTIVE');
});

test('interpretBroadcastOutcome: internal handler exceptions tag', () => {
    const o = interpretBroadcastOutcome({
        audienceSize: 5,
        deliveriesInserted: 5,
        delivered: 0,
        blocked: 0,
        failed: 0,
        pending: 0,
        retry_wait: 0,
        metrics: { broadcast_internal_exceptions: 2, broadcast_sent_ok: 0 },
        topicTestMode: false
    });
    assert.ok(o.tags.includes('INTERNAL_HANDLER_EXCEPTIONS'));
});

test('safe per-item isolation: catch inside iterator lets siblings complete', async () => {
    async function mapWithConcurrency(items, concurrency, iterator) {
        if (!items.length) return;
        let ix = 0;
        const c = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
        async function worker() {
            while (true) {
                const my = ix++;
                if (my >= items.length) break;
                await iterator(items[my], my);
            }
        }
        const workers = [];
        for (let w = 0; w < c; w += 1) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }
    const results = [];
    await mapWithConcurrency([1, 2, 3], 2, async (x) => {
        try {
            if (x === 2) throw new Error('boom');
            results.push(x);
        } catch (e) {
            results.push(0);
        }
    });
    assert.deepStrictEqual(results.sort((a, b) => a - b), [0, 1, 3]);
});
