'use strict';

/**
 * Заказ customerorder в МойСклад отсутствует (удалён / неверный id в БД).
 * Для PUT/GET по id: HTTP 404 и/или errors[].code === 1021.
 * Не использовать для 401/403/5xx без 1021/404.
 * @param {import('axios').AxiosError} err
 */
function isStaleCustomerOrderNotFoundError(err) {
    const status = err && err.response && err.response.status;
    if (status === 404) return true;
    const errors = err && err.response && err.response.data && err.response.data.errors;
    if (Array.isArray(errors) && errors.some(e => Number(e && e.code) === 1021)) return true;
    return false;
}

/** @deprecated use isStaleCustomerOrderNotFoundError */
const isStaleCustomerOrderMappingError = isStaleCustomerOrderNotFoundError;

/**
 * PUT существующего заказа или POST нового.
 * При stale (404 или 1021) на PUT — возвращает outcome `stale_put` без POST (повтор create — в moysklad.js после сброса mapping в БД).
 * @param {Pick<import('axios').AxiosInstance, 'put'|'post'>} msHttp
 * @param {{ msOrderId: string|null, payload: object }} opts
 * @returns {Promise<
 *   | { outcome: 'created'; msOrder: object }
 *   | { outcome: 'updated'; msOrderId: string }
 *   | { outcome: 'stale_put'; staleMsOrderId: string; statusCode?: number; msErrorCode?: number; putError: import('axios').AxiosError }
 * >}
 */
async function upsertCustomerOrderHttp(msHttp, { msOrderId, payload }) {
    const id = msOrderId && String(msOrderId).trim() ? String(msOrderId).trim() : null;

    if (!id) {
        const res = await msHttp.post('/entity/customerorder', payload);
        return { outcome: 'created', msOrder: res.data };
    }

    try {
        await msHttp.put(`/entity/customerorder/${id}`, payload);
        return { outcome: 'updated', msOrderId: id };
    } catch (e) {
        if (!isStaleCustomerOrderNotFoundError(e)) throw e;
        const statusCode = e && e.response && e.response.status;
        const errs = e && e.response && e.response.data && e.response.data.errors;
        const msErrorCode = Array.isArray(errs)
            ? Number(errs.find(x => x && x.code != null)?.code)
            : undefined;
        return {
            outcome: 'stale_put',
            staleMsOrderId: id,
            statusCode: statusCode != null ? statusCode : undefined,
            msErrorCode: Number.isFinite(msErrorCode) ? msErrorCode : undefined,
            putError: e
        };
    }
}

module.exports = {
    isStaleCustomerOrderNotFoundError,
    isStaleCustomerOrderMappingError,
    upsertCustomerOrderHttp
};
