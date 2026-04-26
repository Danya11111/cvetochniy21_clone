'use strict';

/**
 * Кольцевые метрики latency для user-facing Telegram flows (без PII).
 * Хранит последние N замеров на класс операций.
 */

const RING = 24;

/** @type {Record<string, number[]>} */
const buffers = {};
/** @type {Record<string, { count: number, sumMs: number }>} */
const aggregates = {};

function record(kind, ms) {
    const k = String(kind || 'unknown').slice(0, 64);
    const t = Number(ms);
    if (!Number.isFinite(t) || t < 0 || t > 600_000) return;
    if (!buffers[k]) buffers[k] = [];
    const b = buffers[k];
    b.push(Math.round(t));
    if (b.length > RING) b.splice(0, b.length - RING);
    if (!aggregates[k]) aggregates[k] = { count: 0, sumMs: 0 };
    aggregates[k].count += 1;
    aggregates[k].sumMs += t;
}

function percentile(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function snapshotForKind(k) {
    const b = buffers[k];
    if (!b || !b.length) {
        return { samples: 0, lastMs: null, p50Ms: null, p95Ms: null, maxMs: null };
    }
    const sorted = [...b].sort((a, x) => a - x);
    return {
        samples: b.length,
        lastMs: b[b.length - 1],
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1]
    };
}

function getInteractiveLatencySnapshot() {
    const kinds = Object.keys(buffers);
    const byKind = {};
    for (const k of kinds) {
        byKind[k] = snapshotForKind(k);
    }
    const totals = { ...aggregates };
    return {
        ringCapacity: RING,
        byKind,
        totalsSinceProcessStart: totals
    };
}

/** Только для unit-тестов. */
function resetInteractiveMetricsForTests() {
    for (const k of Object.keys(buffers)) delete buffers[k];
    for (const k of Object.keys(aggregates)) delete aggregates[k];
}

module.exports = {
    record,
    getInteractiveLatencySnapshot,
    resetInteractiveMetricsForTests
};
