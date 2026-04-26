'use strict';

const assert = require('assert');
const {
    record,
    getInteractiveLatencySnapshot,
    resetInteractiveMetricsForTests
} = require('../telegram-interactive-metrics');

resetInteractiveMetricsForTests();
record('webhook_ack_before_dispatch_ms', 12);
record('webhook_ack_before_dispatch_ms', 20);
const snap = getInteractiveLatencySnapshot();
assert.ok(snap.byKind.webhook_ack_before_dispatch_ms);
assert.strictEqual(snap.byKind.webhook_ack_before_dispatch_ms.samples, 2);
process.stdout.write('PASS interactive metrics ring buffer\n');
