'use strict';

const assert = require('assert');
const {
    getOrCreateSalesChannelMeta,
    resetMoySkladSalesChannelMetaCache
} = require('../moysklad');

async function test(name, fn) {
    try {
        await Promise.resolve(fn());
        process.stdout.write(`PASS ${name}\n`);
    } catch (e) {
        process.stderr.write(`FAIL ${name}: ${e.message}\n`);
        process.exitCode = 1;
    }
}

(async function runAll() {
    await test('config: MOYSKLAD_SALESCHANNEL_AUTO_CREATE false когда env не задан', () => {
        if (Object.prototype.hasOwnProperty.call(process.env, 'MOYSKLAD_SALESCHANNEL_AUTO_CREATE')) {
            process.stdout.write('SKIP config default (env MOYSKLAD_SALESCHANNEL_AUTO_CREATE is set)\n');
            return;
        }
        assert.strictEqual(require('../config').MOYSKLAD_SALESCHANNEL_AUTO_CREATE, false);
    });

    await test('saleschannel найден GET -> meta, POST не вызывается', async () => {
        resetMoySkladSalesChannelMetaCache();
        let postCalls = 0;
        const ms = {
            get: async (path, cfg) => {
                assert.strictEqual(path, '/entity/saleschannel');
                assert.ok(cfg && cfg.params && cfg.params.filter);
                return { data: { rows: [{ id: 'sc-found-uuid' }] }, status: 200 };
            },
            post: async () => {
                postCalls += 1;
                throw new Error('POST must not be called');
            }
        };
        const r = await getOrCreateSalesChannelMeta(
            { orderId: 1, createPayment: false, tracer: null },
            { ms, autoCreateSalesChannel: false }
        );
        assert.strictEqual(postCalls, 0);
        assert.strictEqual(r.type, 'saleschannel');
        assert.ok(r.href.includes('sc-found-uuid'));
    });

    await test('saleschannel не найден, auto-create off -> null, POST не вызывается', async () => {
        resetMoySkladSalesChannelMetaCache();
        let postCalls = 0;
        const ms = {
            get: async () => ({ data: { rows: [] }, status: 200 }),
            post: async () => {
                postCalls += 1;
                return { data: { id: 'x' } };
            }
        };
        const r = await getOrCreateSalesChannelMeta(
            { orderId: 2, createPayment: false, tracer: null },
            { ms, autoCreateSalesChannel: false }
        );
        assert.strictEqual(r, null);
        assert.strictEqual(postCalls, 0);
    });

    await test('saleschannel не найден, auto-create on -> POST create', async () => {
        resetMoySkladSalesChannelMetaCache();
        let postCalls = 0;
        const ms = {
            get: async () => ({ data: { rows: [] }, status: 200 }),
            post: async (path, body) => {
                postCalls += 1;
                assert.strictEqual(path, '/entity/saleschannel');
                assert.strictEqual(body.name, 'Telegram Bot');
                return { data: { id: 'new-sc-id' }, status: 200 };
            }
        };
        const r = await getOrCreateSalesChannelMeta(
            { orderId: 3, createPayment: true, tracer: null },
            { ms, autoCreateSalesChannel: true }
        );
        assert.strictEqual(postCalls, 1);
        assert.strictEqual(r.type, 'saleschannel');
        assert.ok(r.href.includes('new-sc-id'));
    });
})().catch(e => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
