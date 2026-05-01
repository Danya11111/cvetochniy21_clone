'use strict';

const assert = require('assert');
const { getAllTimeDashboardPeriodRange, ALL_TIME_REPORTS_START_YMD } = require('../admin-dashboard-service');

const r = getAllTimeDashboardPeriodRange(new Date('2026-05-01T15:30:00.000Z'));
assert.strictEqual(r.periodKey, 'all');
assert.strictEqual(ALL_TIME_REPORTS_START_YMD, '2025-01-01');
assert.strictEqual(r.labelFrom, '01.01.2025');
assert.ok(r.periodStartIso);
assert.ok(r.periodEndIso);
assert.ok(r.periodStart.getTime() <= r.periodEnd.getTime());
process.stdout.write('PASS admin-dashboard all-time range\n');
