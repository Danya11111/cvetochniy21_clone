'use strict';

const assert = require('assert');
const {
    isStaleCustomerOrderMappingError,
    isStaleCustomerOrderNotFoundError,
    upsertCustomerOrderHttp
} = require('../moysklad-customerorder-upsert');

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
    await test('isStaleCustomerOrderNotFoundError: true for code 1021', () => {
        const err = {
            response: {
                status: 400,
                data: { errors: [{ code: 1021, error: 'Объект не найден' }] }
            }
        };
        assert.strictEqual(isStaleCustomerOrderNotFoundError(err), true);
        assert.strictEqual(isStaleCustomerOrderMappingError(err), true);
    });

    await test('isStaleCustomerOrderNotFoundError: true for HTTP 404', () => {
        const err = { response: { status: 404, data: {} } };
        assert.strictEqual(isStaleCustomerOrderNotFoundError(err), true);
    });

    await test('isStaleCustomerOrderNotFoundError: false for 401', () => {
        const err = { response: { status: 401, data: { errors: [] } } };
        assert.strictEqual(isStaleCustomerOrderNotFoundError(err), false);
    });

    await test('isStaleCustomerOrderNotFoundError: false for 500', () => {
        const err = { response: { status: 500, data: { errors: [{ code: 3000 }] } } };
        assert.strictEqual(isStaleCustomerOrderNotFoundError(err), false);
    });

    await test('isStaleCustomerOrderNotFoundError: false without response', () => {
        assert.strictEqual(isStaleCustomerOrderNotFoundError(new Error('net')), false);
    });

    await test('upsert: create path when msOrderId absent (single POST)', async () => {
        let postCalls = 0;
        const msHttp = {
            put: async () => {
                throw new Error('put should not be called');
            },
            post: async (path, payload) => {
                postCalls += 1;
                assert.strictEqual(path, '/entity/customerorder');
                assert.strictEqual(payload.v, 1);
                return { data: { id: 'new-uuid', name: '0007' } };
            }
        };
        const r = await upsertCustomerOrderHttp(msHttp, { msOrderId: null, payload: { v: 1 } });
        assert.strictEqual(postCalls, 1);
        assert.strictEqual(r.outcome, 'created');
        assert.strictEqual(r.msOrder.id, 'new-uuid');
    });

    await test('upsert: update success — один PUT, без POST', async () => {
        let putCalls = 0;
        let postCalls = 0;
        const msHttp = {
            put: async (url, payload) => {
                putCalls += 1;
                assert(url.includes('/entity/customerorder/existing-id'));
                assert.strictEqual(payload.x, 1);
            },
            post: async () => {
                postCalls += 1;
                return { data: {} };
            }
        };
        const r = await upsertCustomerOrderHttp(msHttp, {
            msOrderId: 'existing-id',
            payload: { x: 1 }
        });
        assert.strictEqual(r.outcome, 'updated');
        assert.strictEqual(r.msOrderId, 'existing-id');
        assert.strictEqual(putCalls, 1);
        assert.strictEqual(postCalls, 0);
    });

    await test('upsert: PUT 1021 → stale_put, без второго POST внутри upsert', async () => {
        const staleErr = {
            response: {
                status: 404,
                data: { errors: [{ code: 1021, error: 'не найден' }] }
            }
        };
        let putCalls = 0;
        let postCalls = 0;
        const msHttp = {
            put: async () => {
                putCalls += 1;
                throw staleErr;
            },
            post: async () => {
                postCalls += 1;
                return { data: { id: 'x' } };
            }
        };
        const r = await upsertCustomerOrderHttp(msHttp, {
            msOrderId: 'gone-id',
            payload: { p: 2 }
        });
        assert.strictEqual(putCalls, 1);
        assert.strictEqual(postCalls, 0);
        assert.strictEqual(r.outcome, 'stale_put');
        assert.strictEqual(r.staleMsOrderId, 'gone-id');
        assert.strictEqual(r.statusCode, 404);
    });

    await test('upsert: PUT 404 без errors → stale_put', async () => {
        let postCalls = 0;
        const msHttp = {
            put: async () => {
                const e = new Error('nf');
                e.response = { status: 404, data: {} };
                throw e;
            },
            post: async () => {
                postCalls += 1;
                return { data: {} };
            }
        };
        const r = await upsertCustomerOrderHttp(msHttp, { msOrderId: 'id', payload: {} });
        assert.strictEqual(r.outcome, 'stale_put');
        assert.strictEqual(postCalls, 0);
    });

    await test('upsert: не-stale ошибка — без fallback POST', async () => {
        let postCalls = 0;
        const msHttp = {
            put: async () => {
                const e = new Error('bad');
                e.response = { status: 400, data: { errors: [{ code: 3000 }] } };
                throw e;
            },
            post: async () => {
                postCalls += 1;
                return { data: {} };
            }
        };
        await assert.rejects(() =>
            upsertCustomerOrderHttp(msHttp, { msOrderId: 'id', payload: {} })
        );
        assert.strictEqual(postCalls, 0);
    });
})().catch(e => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
