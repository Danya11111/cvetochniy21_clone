'use strict';

/**
 * Тело создания контрагента-физлица для МойСклад JSON API 1.2.
 * Без companyType МС может отклонить сохранение (412 / поле type в meta вложенных объектах).
 * @param {string} fullName
 * @param {string} phone
 * @param {string} [emailOpt]
 */
function buildCounterpartyCreatePayloadForMoySklad(fullName, phone, emailOpt) {
    const safeEmail = String(emailOpt || '').trim().toLowerCase();
    const payload = {
        name: fullName || phone,
        phone,
        companyType: 'individual'
    };
    if (safeEmail) payload.email = safeEmail;
    return payload;
}

function redactMoySkladErrorResponseBody(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    if (Array.isArray(data.errors)) {
        out.errors = data.errors.map(e => {
            if (!e || typeof e !== 'object') return e;
            return {
                code: e.code != null ? e.code : null,
                error: e.error != null ? String(e.error).slice(0, 600) : null
            };
        });
    }
    return Object.keys(out).length ? out : { note: 'empty_or_unknown_shape' };
}

function summarizeAxiosMoySkladError(err) {
    const statusCode = err && err.response && err.response.status != null ? err.response.status : null;
    const data = err && err.response && err.response.data;
    let msErrorCode = null;
    if (data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].code != null) {
        msErrorCode = Number(data.errors[0].code);
    }
    return {
        statusCode,
        msErrorCode,
        reason: err && err.message ? err.message : String(err),
        response: redactMoySkladErrorResponseBody(data)
    };
}

/**
 * @param {{ orderId: unknown, createPayment: boolean }} ctx
 * @param {{ error?: Function }} [logger]
 */
function createSendOrderHttpTracer(ctx, logger = console) {
    const logErr = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);
    const base = () => ({
        orderId: ctx.orderId != null ? ctx.orderId : null,
        createPayment: !!ctx.createPayment
    });

    return {
        /**
         * @param {string} step
         * @param {string} entity
         * @param {string} method
         * @param {string} requestPath
         * @param {() => Promise<{ status?: number, data?: unknown }>} execFn
         * @param {Record<string, unknown>} [extras]
         */
        async run(step, entity, method, requestPath, execFn, extras = {}) {
            logErr(`[MoySklad] ${step}_started`, JSON.stringify({ ...base(), entity, requestPath, method, ...extras }));
            try {
                const res = await execFn();
                const statusCode = res && res.status != null ? res.status : null;
                logErr(
                    `[MoySklad] ${step}_succeeded`,
                    JSON.stringify({ ...base(), entity, requestPath, method, statusCode, ...extras })
                );
                return res;
            } catch (err) {
                const sum = summarizeAxiosMoySkladError(err);
                const st = sum.statusCode;
                const soft = Array.isArray(extras.softFailStatuses) ? extras.softFailStatuses : [];
                if (soft.length && st != null && soft.includes(st)) {
                    logErr(
                        `[MoySklad] ${step}_miss`,
                        JSON.stringify({
                            ...base(),
                            entity,
                            requestPath,
                            method,
                            statusCode: st,
                            outcome: 'expected_miss',
                            ...extras,
                            response: sum.response
                        })
                    );
                } else {
                    logErr(
                        `[MoySklad] ${step}_failed`,
                        JSON.stringify({ ...base(), entity, requestPath, method, ...extras, ...sum })
                    );
                }
                throw err;
            }
        }
    };
}

module.exports = {
    buildCounterpartyCreatePayloadForMoySklad,
    redactMoySkladErrorResponseBody,
    summarizeAxiosMoySkladError,
    createSendOrderHttpTracer
};
