'use strict';

const assert = require('assert');

/** Перезагрузка `backend/config.js` после точечной подмены env (отдельный процесс через `npm test`). */
function loadFreshConfig(envPatch) {
    const keys = Object.keys(envPatch || {});
    const prev = {};
    for (const k of keys) {
        prev[k] = process.env[k];
        const v = envPatch[k];
        if (v === undefined || v === null) delete process.env[k];
        else process.env[k] = String(v);
    }
    const p = require.resolve('../config');
    delete require.cache[p];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const cfg = require('../config');
    for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
    }
    delete require.cache[p];
    return cfg;
}

(async function main() {
    const cfgSupportCanon = loadFreshConfig({
        TELEGRAM_SUPERGROUP_ID: '-1002929299522',
        TELEGRAM_TOPIC_SUPPORT_ID: '12104',
        TELEGRAM_SUPPORT_NOTIFY_THREAD_ID: '99999'
    });
    assert.strictEqual(Number(cfgSupportCanon.TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0), 12104);

    const cfgSupportLegacyOnly = loadFreshConfig({
        TELEGRAM_SUPERGROUP_ID: '-1002929299522',
        TELEGRAM_SUPPORT_NOTIFY_THREAD_ID: '12104'
    });
    assert.strictEqual(Number(cfgSupportLegacyOnly.TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0), 12104);

    const cfgErrors = loadFreshConfig({
        TELEGRAM_SUPERGROUP_ID: '-1002929299522',
        TELEGRAM_TOPIC_SUPPORT_ID: '12104',
        TELEGRAM_TOPIC_ERRORS_ID: '909'
    });
    assert.strictEqual(Number(cfgErrors.TELEGRAM_ERRORS_NOTIFY_THREAD_ID || 0), 909);

    const cfgErrorsFallbackSupport = loadFreshConfig({
        TELEGRAM_SUPERGROUP_ID: '-1002929299522',
        TELEGRAM_TOPIC_SUPPORT_ID: '12104'
    });
    assert.strictEqual(Number(cfgErrorsFallbackSupport.TELEGRAM_ERRORS_NOTIFY_THREAD_ID || 0), 12104);

    const cfgBroadcastCanon = loadFreshConfig({
        TELEGRAM_SUPERGROUP_ID: '-1002929299522',
        TELEGRAM_TOPIC_BROADCASTS_ID: '12106',
        TELEGRAM_BROADCAST_TOPIC_THREAD_ID: '4'
    });
    assert.strictEqual(Number(cfgBroadcastCanon.TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0), 12106);

    const cfgAbDisabledByEmptyTopic = loadFreshConfig({
        TELEGRAM_TOPIC_ABANDONED_CARTS_ID: ''
    });
    assert.strictEqual(Number(cfgAbDisabledByEmptyTopic.TELEGRAM_TOPIC_ABANDONED_CARTS_ID || 0), 0);
    assert.strictEqual(cfgAbDisabledByEmptyTopic.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED, false);

    const cfgAbForcedOffDespiteTopic = loadFreshConfig({
        TELEGRAM_TOPIC_ABANDONED_CARTS_ID: '9',
        ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED: 'false'
    });
    assert.strictEqual(Number(cfgAbForcedOffDespiteTopic.TELEGRAM_TOPIC_ABANDONED_CARTS_ID || 0), 9);
    assert.strictEqual(cfgAbForcedOffDespiteTopic.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED, false);

    const cfgAbForcedOnWithoutTopic = loadFreshConfig({
        TELEGRAM_TOPIC_ABANDONED_CARTS_ID: '',
        ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED: 'true'
    });
    assert.strictEqual(Number(cfgAbForcedOnWithoutTopic.TELEGRAM_TOPIC_ABANDONED_CARTS_ID || 0), 0);
    assert.strictEqual(cfgAbForcedOnWithoutTopic.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED, true);

    process.stdout.write('PASS config telegram topics mapping\n');
})().catch((e) => {
    console.error('FAIL config telegram topics mapping', e);
    process.exit(1);
});
