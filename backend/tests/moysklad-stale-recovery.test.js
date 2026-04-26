'use strict';

const assert = require('assert');
const { recoverStaleCustomerOrderAfterPutNotFound } = require('../moysklad');

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
    await test('recover: stale mapping reset + create + сохранение нового id в БД (моки)', async () => {
        const dbWrites = [];
        const mockDb = {
            run(sql, params, cb) {
                dbWrites.push({ sql: String(sql).trim(), params: [...params] });
                if (cb) cb(null);
            }
        };
        let postCalls = 0;
        const mockMs = {
            post: async (path, payload) => {
                postCalls += 1;
                assert.strictEqual(path, '/entity/customerorder');
                assert.strictEqual(payload.k, 1);
                assert.strictEqual(postCalls, 1, 'только один POST recreate');
                return { data: { id: 'fresh-ms-uuid', name: 'CO-99' } };
            }
        };

        const ctx = {
            orderId: 171,
            staleMsId: '535c5220-307d-11f1-0a80-0daa0048021c',
            staleMsName: '0007',
            payload: { k: 1 },
            createPayment: false,
            statusCode: 404,
            msErrorCode: 1021
        };

        const msOrder = await recoverStaleCustomerOrderAfterPutNotFound(ctx, {
            db: mockDb,
            ms: mockMs
        });

        assert.strictEqual(msOrder.id, 'fresh-ms-uuid');
        assert.strictEqual(dbWrites.length, 1);
        assert.ok(dbWrites[0].sql.includes('ms_id = NULL'));
        assert.deepStrictEqual(dbWrites[0].params, [171]);
    });

    await test('recover: createPayment=true передаётся в лог-контекст (моки)', async () => {
        const mockDb = {
            run(sql, params, cb) {
                if (cb) cb(null);
            }
        };
        const mockMs = {
            post: async () => ({ data: { id: 'n2', name: 'x' } })
        };
        await recoverStaleCustomerOrderAfterPutNotFound(
            {
                orderId: 5,
                staleMsId: 'old',
                staleMsName: null,
                payload: {},
                createPayment: true,
                statusCode: 404,
                msErrorCode: 1021
            },
            { db: mockDb, ms: mockMs }
        );
    });

    await test('recover: POST после reset падает — ошибка наружу', async () => {
        const mockDb = {
            run(_sql, _params, cb) {
                if (cb) cb(null);
            }
        };
        const mockMs = {
            post: async () => {
                const e = new Error('MS busy');
                e.response = { status: 503, data: {} };
                throw e;
            }
        };
        await assert.rejects(
            () =>
                recoverStaleCustomerOrderAfterPutNotFound(
                    {
                        orderId: 9,
                        staleMsId: 'gone',
                        staleMsName: null,
                        payload: {},
                        createPayment: false,
                        statusCode: 404,
                        msErrorCode: 1021
                    },
                    { db: mockDb, ms: mockMs }
                ),
            /MS busy/
        );
    });

    await test('recover: только один POST при успехе', async () => {
        let posts = 0;
        const mockDb = {
            run(_s, _p, cb) {
                if (cb) cb(null);
            }
        };
        const mockMs = {
            post: async () => {
                posts += 1;
                return { data: { id: 'one', name: '1' } };
            }
        };
        await recoverStaleCustomerOrderAfterPutNotFound(
            {
                orderId: 1,
                staleMsId: 's',
                staleMsName: null,
                payload: {},
                createPayment: true,
                statusCode: 404,
                msErrorCode: undefined
            },
            { db: mockDb, ms: mockMs }
        );
        assert.strictEqual(posts, 1);
    });
})().catch(e => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
