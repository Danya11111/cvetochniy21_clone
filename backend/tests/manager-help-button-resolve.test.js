const assert = require('assert');
const { normalizeTelegramBotUsername } = require('../manager-help-button-resolve');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('normalize strips @ and accepts valid username', () => {
    assert.strictEqual(normalizeTelegramBotUsername('@cvetochnyj21_bot'), 'cvetochnyj21_bot');
});

test('normalize rejects empty', () => {
    assert.strictEqual(normalizeTelegramBotUsername(''), '');
});

test('normalize rejects too short', () => {
    assert.strictEqual(normalizeTelegramBotUsername('ab'), '');
});
