const assert = require('assert');
const { resolveConsentCallbackContext } = require('../consent-callback-context');

function test(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

test('trims callback_data', () => {
    const r = resolveConsentCallbackContext({ data: '  start_welcome_consent  ', message: { chat: { id: 1, type: 'private' } } });
    assert.strictEqual(r.data, 'start_welcome_consent');
});

test('uses message chat when present', () => {
    const r = resolveConsentCallbackContext({
        data: 'start_welcome_consent',
        message: { chat: { id: 42, type: 'private' } }
    });
    assert.strictEqual(r.chatId, 42);
    assert.strictEqual(r.chatType, 'private');
    assert.strictEqual(r.chatResolveSource, 'message');
});

test('fallback to from.id when message missing (private bot chat)', () => {
    const r = resolveConsentCallbackContext({
        data: 'start_welcome_consent',
        from: { id: 659921032, is_bot: false }
    });
    assert.strictEqual(r.chatId, 659921032);
    assert.strictEqual(r.chatType, 'private');
    assert.strictEqual(r.chatResolveSource, 'from_fallback_private');
});

test('does not fallback when message exists with group chat', () => {
    const r = resolveConsentCallbackContext({
        data: 'start_welcome_consent',
        message: { chat: { id: -1001, type: 'supergroup' } },
        from: { id: 123 }
    });
    assert.strictEqual(r.chatId, -1001);
    assert.strictEqual(r.chatType, 'supergroup');
    assert.strictEqual(r.chatResolveSource, 'message');
});
