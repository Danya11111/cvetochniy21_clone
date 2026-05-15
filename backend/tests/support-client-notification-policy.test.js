'use strict';

const assert = require('assert');
const {
    DEFAULT_COOLDOWN_MINUTES,
    resolveSupportClientNotificationCooldownMs,
    shouldNotifySupportAboutClientMessage,
    parseIsoMsForTests
} = require('../support-client-notification-policy');

async function main() {
    const saved = process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES;
    process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES = '';
    assert.strictEqual(
        resolveSupportClientNotificationCooldownMs(),
        DEFAULT_COOLDOWN_MINUTES * 60 * 1000,
        'invalid/empty resolves to default 120m'
    );
    delete process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES;
    assert.strictEqual(resolveSupportClientNotificationCooldownMs('5'), 5 * 60 * 1000);
    assert.strictEqual(resolveSupportClientNotificationCooldownMs('0'), DEFAULT_COOLDOWN_MINUTES * 60 * 1000);
    assert.strictEqual(resolveSupportClientNotificationCooldownMs('nope'), DEFAULT_COOLDOWN_MINUTES * 60 * 1000);

    const now = 1_700_000_000_000;
    const cooldownMs = 120 * 60 * 1000;
    const rFirst = shouldNotifySupportAboutClientMessage(
        { last_client_notification_at: new Date(now - 10_000).toISOString() },
        { isFirstRelayedClientMessage: true },
        { nowMs: now, cooldownMs }
    );
    assert.strictEqual(rFirst.shouldNotify, true);
    assert.strictEqual(rFirst.reason, 'first_client_message');

    const rCool = shouldNotifySupportAboutClientMessage(
        { last_client_notification_at: new Date(now - cooldownMs - 1).toISOString() },
        { isFirstRelayedClientMessage: false },
        { nowMs: now, cooldownMs }
    );
    assert.strictEqual(rCool.shouldNotify, true);
    assert.strictEqual(rCool.reason, 'cooldown_elapsed');

    const rActive = shouldNotifySupportAboutClientMessage(
        { last_client_notification_at: new Date(now - 60_000).toISOString() },
        { isFirstRelayedClientMessage: false },
        { nowMs: now, cooldownMs }
    );
    assert.strictEqual(rActive.shouldNotify, false);
    assert.strictEqual(rActive.reason, 'cooldown_active');

    const emptyParse = parseIsoMsForTests('');
    assert.strictEqual(emptyParse.empty, true);

    if (saved === undefined) delete process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES;
    else process.env.SUPPORT_CLIENT_NOTIFICATION_COOLDOWN_MINUTES = saved;

    process.stdout.write('PASS support client notification policy\n');
}

main().catch((e) => {
    process.stderr.write(`FAIL support-client-notification-policy: ${e.stack || e}\n`);
    process.exitCode = 1;
});
