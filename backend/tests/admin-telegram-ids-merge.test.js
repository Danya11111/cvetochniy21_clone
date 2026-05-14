/**
 * Проверка union дефолтов и ADMIN_TELEGRAM_IDS без загрузки основного config (там секреты в дефолтах).
 * Дублирует логику mergeAdminTelegramIdsWithDefaults из backend/config.js.
 */
const assert = require('assert');

function mergeAdminTelegramIdsWithDefaults(envName, defaults, env) {
    const raw = env[envName];
    const explicit =
        raw === undefined || raw === null || raw === ''
            ? []
            : String(raw)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
    const merged = new Set([...(defaults || []).map(String), ...explicit.map(String)]);
    return [...merged];
}

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('merge keeps defaults when env empty', () => {
    const m = mergeAdminTelegramIdsWithDefaults('ADMIN_TELEGRAM_IDS', ['67460775'], {});
    assert.ok(m.includes('67460775'));
});

test('merge unions env with defaults', () => {
    const m = mergeAdminTelegramIdsWithDefaults('ADMIN_TELEGRAM_IDS', ['67460775'], {
        ADMIN_TELEGRAM_IDS: '111'
    });
    assert.ok(m.includes('67460775'));
    assert.ok(m.includes('111'));
});
