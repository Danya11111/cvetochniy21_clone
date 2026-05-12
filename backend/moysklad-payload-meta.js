'use strict';

/**
 * Узнаёт тип сущности МойСклад по href Meta (JSON API 1.2).
 * @param {string} href
 * @returns {string|null}
 */
function inferMetaTypeByHref(href) {
    const h = String(href || '');

    if (h.includes('/entity/saleschannel/')) return 'saleschannel';
    if (h.includes('/entity/organization/')) return 'organization';
    if (h.includes('/entity/counterparty/')) return 'counterparty';
    if (h.includes('/entity/product/')) return 'product';
    if (h.includes('/entity/variant/')) return 'variant';
    if (h.includes('/entity/service/')) return 'service';
    if (h.includes('/entity/bundle/')) return 'bundle';

    // metadata заказа покупателя — до общего /entity/customerorder/, иначе href «…/customerorder/metadata/…»
    // ошибочно классифицируется как customerorder
    if (h.includes('/entity/customerorder/metadata/attributes/')) return 'attributemetadata';
    if (h.includes('/entity/customerorder/metadata/states/')) return 'state';

    if (h.includes('/entity/customerorder/')) return 'customerorder';
    if (h.includes('/entity/paymentin/')) return 'paymentin';

    // относительные href на статусы
    if (h.includes('/metadata/states/')) return 'state';

    // custom entity значения
    if (h.includes('/entity/customentity/')) return 'customentity';

    return null;
}

function isValidMeta(m) {
    return (
        m &&
        typeof m === 'object' &&
        String(m.type || '').trim().length > 0 &&
        String(m.href || '').trim().length > 0
    );
}

/**
 * Нормализует meta из ответов API: добавляет href/type/mediaType, не копирует «лишние» поля в итоговый payload.
 * @param {object|null|undefined} meta
 * @param {string|null} [fallbackHref]
 * @returns {object|null}
 */
function fixMeta(meta, fallbackHref = null) {
    if (!meta || typeof meta !== 'object') return null;

    const out = { ...meta };

    if (!out.href && fallbackHref) out.href = fallbackHref;
    if (!out.mediaType) out.mediaType = 'application/json';

    if (!out.type || !String(out.type).trim()) {
        const t = inferMetaTypeByHref(out.href);
        if (t) out.type = t;
    }

    return out;
}

/**
 * Компактный Meta для отправки в МойСклад (только href/type/mediaType).
 * @param {object|null|undefined} meta
 * @param {string|null} [forcedType]
 * @returns {{ href: string, type: string, mediaType: string }|null}
 */
function metaOrNull(meta, forcedType = null) {
    if (!meta || typeof meta !== 'object') return null;

    const href = String(meta.href || '').trim();
    if (!href) return null;

    let type = forcedType ? String(forcedType).trim() : String(meta.type || '').trim();
    if (!type) {
        const inferred = inferMetaTypeByHref(href);
        if (inferred) type = inferred;
    }
    if (!type) return null;

    return { href, type, mediaType: 'application/json' };
}

/**
 * Рекурсивно находит пути к полю meta, где отсутствует непустой type.
 * @param {unknown} v
 * @param {string} basePath
 * @returns {string[]}
 */
function collectMetaTypeMissingPaths(v, basePath = 'payload') {
    const out = [];

    const walk = (node, p) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) walk(node[i], `${p}[${i}]`);
            return;
        }

        if (Object.prototype.hasOwnProperty.call(node, 'meta')) {
            const m = node.meta;
            if (m && typeof m === 'object') {
                const t = m.type;
                const bad = t === undefined || t === null || String(t).trim().length === 0;
                if (bad) out.push(`${p}.meta.type`);
            } else if (m == null) {
                out.push(`${p}.meta`);
            }
        }

        for (const k of Object.keys(node)) {
            if (k === 'meta') continue;
            walk(node[k], `${p}.${k}`);
        }
    };

    walk(v, basePath);
    return out;
}

/**
 * Удаляет любой ключ `meta`, если значение не является валидным Meta (нет href/type).
 * Исправляет регрессию deepDropInvalidMeta: не оставляет объекты с одним metadataHref без type.
 * @param {unknown} root
 */
function pruneInvalidMetaKeys(root) {
    const visit = v => {
        if (!v || typeof v !== 'object') return;

        if (Array.isArray(v)) {
            for (const it of v) visit(it);
            return;
        }

        if (Object.prototype.hasOwnProperty.call(v, 'meta')) {
            const m = v.meta;
            if (!isValidMeta(m)) delete v.meta;
        }

        for (const k of Object.keys(v)) {
            if (k === 'meta') continue;
            visit(v[k]);
        }
    };

    visit(root);
}

function summarizeCustomerOrderPayloadForLog(payload) {
    if (!payload || typeof payload !== 'object') {
        return { positions: 0, attributes: 0, hasOrg: false, hasAgent: false, hasSalesChannel: false };
    }
    return {
        positions: Array.isArray(payload.positions) ? payload.positions.length : 0,
        attributes: Array.isArray(payload.attributes) ? payload.attributes.length : 0,
        hasOrg: !!(payload.organization && payload.organization.meta),
        hasAgent: !!(payload.agent && payload.agent.meta),
        hasSalesChannel: !!(payload.salesChannel && payload.salesChannel.meta),
        vatEnabled: !!payload.vatEnabled,
        hasDeliveryPlannedMoment: payload.deliveryPlannedMoment != null && payload.deliveryPlannedMoment !== ''
    };
}

/**
 * @param {object} p
 * @param {unknown} p.orderId
 * @param {boolean} p.createPayment
 * @param {string[]} p.paths
 * @param {unknown} [p.payload]
 * @param {{ error?: Function, log?: Function }} [p.logger]
 */
function logPayloadMetaTypeMissing({ orderId, createPayment, paths, payload, logger = console }) {
    const logError = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);
    const summary = summarizeCustomerOrderPayloadForLog(payload);
    logError(
        '[MoySklad] payload_meta_type_missing',
        JSON.stringify({
            orderId: orderId != null ? orderId : null,
            createPayment: !!createPayment,
            paths,
            summary
        })
    );
}

module.exports = {
    inferMetaTypeByHref,
    isValidMeta,
    fixMeta,
    metaOrNull,
    collectMetaTypeMissingPaths,
    pruneInvalidMetaKeys,
    summarizeCustomerOrderPayloadForLog,
    logPayloadMetaTypeMissing
};
