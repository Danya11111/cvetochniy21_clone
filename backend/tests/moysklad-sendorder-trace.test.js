'use strict';

const assert = require('assert');
const {
    buildCounterpartyCreatePayloadForMoySklad,
    summarizeAxiosMoySkladError,
    createSendOrderHttpTracer,
    redactMoySkladErrorResponseBody
} = require('../moysklad-sendorder-trace');

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
    await test('buildCounterpartyCreatePayloadForMoySklad: companyType individual + email', () => {
        const p = buildCounterpartyCreatePayloadForMoySklad('Иван', '+79990001122', 'A@b.com');
        assert.strictEqual(p.companyType, 'individual');
        assert.strictEqual(p.phone, '+79990001122');
        assert.strictEqual(p.email, 'a@b.com');
    });

    await test('summarizeAxiosMoySkladError вытаскивает code 3000', () => {
        const err = {
            message: 'Request failed with status code 412',
            response: {
                status: 412,
                data: { errors: [{ code: 3000, error: "поле 'type'..." }] }
            }
        };
        const s = summarizeAxiosMoySkladError(err);
        assert.strictEqual(s.statusCode, 412);
        assert.strictEqual(s.msErrorCode, 3000);
        assert.ok(Array.isArray(s.response.errors));
    });

    await test('redactMoySkladErrorResponseBody не тащит лишние поля', () => {
        const r = redactMoySkladErrorResponseBody({
            errors: [{ code: 1, error: 'x', extraLeak: 'nope' }]
        });
        assert.strictEqual(r.errors[0].code, 1);
        assert.strictEqual(r.errors[0].extraLeak, undefined);
    });

    await test('createSendOrderHttpTracer: failed логирует msErrorCode', async () => {
        const lines = [];
        const logger = {
            error(_a, b) {
                lines.push(JSON.parse(b));
            }
        };
        const tracer = createSendOrderHttpTracer({ orderId: 7, createPayment: false }, logger);
        const boom = {
            message: 'fail',
            response: { status: 412, data: { errors: [{ code: 3000, error: 'type' }] } }
        };
        try {
            await tracer.run('precustomerorder_x', 'counterparty', 'POST', '/entity/counterparty', async () => {
                throw boom;
            });
            assert.fail('should throw');
        } catch (e) {
            assert.strictEqual(e, boom);
        }
        const failed = lines.find(x => x.reason === 'fail');
        assert.ok(failed);
        assert.strictEqual(failed.msErrorCode, 3000);
        assert.strictEqual(failed.statusCode, 412);
    });

    await test('createSendOrderHttpTracer: softFailStatuses → _miss, не _failed', async () => {
        const kinds = [];
        const logger = {
            error(tag, payload) {
                kinds.push(tag.split('] ')[1].split('_').pop());
            }
        };
        const tracer = createSendOrderHttpTracer({ orderId: 1, createPayment: false }, logger);
        const e404 = { message: 'n', response: { status: 404, data: {} } };
        try {
            await tracer.run('precustomerorder_probe', 'product', 'GET', '/entity/product/x', async () => {
                throw e404;
            }, { softFailStatuses: [404] });
        } catch (e) {
            assert.strictEqual(e, e404);
        }
        assert.ok(kinds.includes('miss'));
        assert.ok(!kinds.includes('failed'));
    });
})().catch(e => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
