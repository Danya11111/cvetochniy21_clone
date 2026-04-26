'use strict';

const assert = require('assert');
const {
    resetManagerHelpOpsForTests,
    isCooldownActive,
    markNotifyCooldown,
    bumpDuplicateSuppress,
    getManagerHelpOpsSnapshot
} = require('../manager-help-ops');

resetManagerHelpOpsForTests();

const uid = '12345';
const cooldownMs = 60_000;

assert.strictEqual(isCooldownActive(uid, cooldownMs), false, 'no cooldown before mark');
markNotifyCooldown(uid, 1_000_000);
assert.strictEqual(isCooldownActive(uid, cooldownMs, 1_000_000 + 1000), true, 'within window');
assert.strictEqual(isCooldownActive(uid, cooldownMs, 1_000_000 + cooldownMs + 1), false, 'after window');

bumpDuplicateSuppress();
bumpDuplicateSuppress();
const snap = getManagerHelpOpsSnapshot();
assert.strictEqual(snap.managerHelpDuplicateSuppressCount, 2);

resetManagerHelpOpsForTests();
assert.strictEqual(getManagerHelpOpsSnapshot().managerHelpDuplicateSuppressCount, 0);

process.stdout.write('PASS manager-help-ops cooldown and duplicate metrics\n');
