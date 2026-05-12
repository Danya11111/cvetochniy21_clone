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

/**
 * Объект похож на Meta МойСклад (нужен type + href/metadataHref для 1.2).
 * Не путать с произвольными JSON-объектами.
 * @param {unknown} v
 */
function isMetaLikePlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;

    const hrefRaw = v.href;
    const href = typeof hrefRaw === 'string' ? hrefRaw.trim() : '';
    const mhRaw = v.metadataHref;
    const mh = typeof mhRaw === 'string' ? mhRaw.trim() : '';
    const dhRaw = v.downloadHref;
    const dh = typeof dhRaw === 'string' ? dhRaw.trim() : '';

    if (mh.length > 0) return true;

    // Относительные href в ответах API («entity/...» без домена)
    if (
        href.length > 0 &&
        (href.includes('/entity/') ||
            href.includes('/metadata/') ||
            href.startsWith('entity/') ||
            href.toLowerCase().includes('api.moysklad.ru'))
    ) {
        return true;
    }

    const mt = v.mediaType;
    const mtStr = typeof mt === 'string' ? mt.toLowerCase() : '';
    if (mtStr.includes('json') && (href.length > 0 || mh.length > 0)) {
        return true;
    }
    // мета файлов/изображений в разметке МС
    if (dh.length > 0 && (dh.includes('/download/') || dh.includes('moysklad'))) {
        return true;
    }

    // meta-подобный фрагмент: есть type и ссылка не из белого списка полей заказа
    if (
        Object.prototype.hasOwnProperty.call(v, 'type') &&
        (href.length > 0 || mh.length > 0 || dh.length > 0)
    ) {
        return true;
    }

    return false;
}

function metaLikeHasNonEmptyType(node) {
    const t = node && node.type;
    return t !== undefined && t !== null && String(t).trim().length > 0;
}

/** Для логов: вид href без домена и query (без PII). */
function abbreviateHrefForMetaDebug(href) {
    if (!href || typeof href !== 'string') return null;
    try {
        let s = href.trim();
        s = s.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/i, '');
        s = s.replace(/^https?:\/\/[^/]+/i, '');
        const q = s.indexOf('?');
        if (q >= 0) s = s.slice(0, q);
        return s.length > 120 ? `${s.slice(0, 120)}…` : s;
    } catch (_) {
        return '[href]';
    }
}

/**
 * Снимок meta-like узла для [MoySklad] payload_meta_debug (без телефонов, имён, адресов).
 * @param {object} node
 * @param {string} path
 */
function snapshotMetaLikeForDebug(node, path) {
    const hasHref = typeof node.href === 'string' && node.href.trim().length > 0;
    const hasMetadataHref =
        typeof node.metadataHref === 'string' && node.metadataHref.trim().length > 0;
    const hasMediaType = Object.prototype.hasOwnProperty.call(node, 'mediaType');
    const typeStr = node.type === undefined || node.type === null ? '' : String(node.type).trim();
    const hasType = typeStr.length > 0;
    const mtVal = node.mediaType;
    const mediaType =
        mtVal === undefined || mtVal === null ? null : String(mtVal);

    return {
        path,
        hasHref,
        hasMetadataHref,
        hasMediaType,
        hasType,
        type: hasType ? typeStr : null,
        href: hasHref ? abbreviateHrefForMetaDebug(node.href) : null,
        metadataHref: hasMetadataHref ? abbreviateHrefForMetaDebug(node.metadataHref) : null,
        mediaType: mediaType,
        keys: Object.keys(node).sort()
    };
}

/**
 * Обходит дерево JSON и собирает снимки всех meta-like объектов (в т.ч. value.meta, assortment.meta).
 * @param {unknown} root
 * @param {string} [basePath]
 * @returns {object[]}
 */
function buildPayloadMetaDebugEntries(root, basePath = 'payload') {
    const entries = [];

    const walk = (node, p) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) walk(node[i], `${p}[${i}]`);
            return;
        }

        for (const k of Object.keys(node)) {
            walk(node[k], `${p}.${k}`);
        }

        if (isMetaLikePlainObject(node)) {
            entries.push(snapshotMetaLikeForDebug(node, p));
        }
    };

    walk(root, basePath);
    return entries;
}

/**
 * Пути к meta-like объектам без непустого type (то, что даёт MS 412/3000).
 * @param {unknown} root
 * @param {string} [basePath]
 * @returns {string[]}
 */
function collectMetaLikeObjectsMissingType(root, basePath = 'payload') {
    const out = [];

    const walk = (node, p) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) walk(node[i], `${p}[${i}]`);
            return;
        }

        for (const k of Object.keys(node)) {
            walk(node[k], `${p}.${k}`);
        }

        if (isMetaLikePlainObject(node) && !metaLikeHasNonEmptyType(node)) {
            out.push(p);
        }
    };

    walk(root, basePath);
    return out;
}

/**
 * Где href однозначно маппится на тип сущности, а поле type другое — МойСклад часто даёт 412/3000.
 * @param {unknown} root
 * @param {string} [basePath]
 * @returns {{ path: string, type: string, inferredFromHref: string }[]}
 */
function collectMetaLikeHrefTypeMismatches(root, basePath = 'payload') {
    const out = [];

    const walk = (node, p) => {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) walk(node[i], `${p}[${i}]`);
            return;
        }

        for (const k of Object.keys(node)) {
            walk(node[k], `${p}.${k}`);
        }

        if (isMetaLikePlainObject(node) && metaLikeHasNonEmptyType(node)) {
            const href = typeof node.href === 'string' ? node.href.trim() : '';
            if (!href) return;
            const inferred = inferMetaTypeByHref(href);
            if (!inferred) return;
            const t = String(node.type || '').trim();
            if (t && inferred.toLowerCase() !== t.toLowerCase()) {
                out.push({ path: p, type: t, inferredFromHref: inferred });
            }
        }
    };

    walk(root, basePath);
    return out;
}

/**
 * Рекурсивно убирает из копии payload поля с PII для однострочного лога тела запроса.
 * @param {unknown} input
 * @returns {unknown}
 */
function redactCustomerOrderWirePayloadForLog(input) {
    try {
        const root =
            input && typeof input === 'object'
                ? JSON.parse(JSON.stringify(input))
                : input;
        return redactNode(root);
    } catch (_) {
        return { error: 'redact_failed' };
    }
}

function redactNode(node) {
    if (node === null || node === undefined) return node;
    if (typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(redactNode);

    const out = {};
    for (const k of Object.keys(node)) {
        if (k === 'description' || k === 'shipmentAddress') {
            out[k] =
                typeof node[k] === 'string' && node[k].length > 0 ? '[REDACTED]' : node[k];
            continue;
        }
        if (k === 'attributes' && Array.isArray(node[k])) {
            out[k] = node[k].map(a => {
                if (!a || typeof a !== 'object') return a;
                const c = { ...a };
                if (typeof c.value === 'string' && c.value.length > 0) {
                    c.value = '[REDACTED]';
                }
                return c;
            });
            continue;
        }
        out[k] = redactNode(node[k]);
    }
    return out;
}

/**
 * JSON как у axios: без undefined, без циклов (customerorder payload — дерево).
 * @param {object} payload
 * @returns {object}
 */
function serializeMoySkladJsonPayload(payload) {
    return JSON.parse(JSON.stringify(payload));
}

/**
 * Структурированный обход meta-like; пишем в stderr — в journald видно при захвате только stderr.
 * @param {object} p
 * @param {unknown} p.orderId
 * @param {boolean} p.createPayment
 * @param {object[]} p.entries
 * @param {{ error?: Function }} [p.logger]
 */
function logPayloadMetaDebug({ orderId, createPayment, entries, logger = console }) {
    const logErr =
        typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);
    const lineObj = {
        orderId: orderId != null ? orderId : null,
        createPayment: !!createPayment,
        entriesCount: Array.isArray(entries) ? entries.length : 0,
        entries
    };
    try {
        logErr('[MoySklad] payload_meta_debug', JSON.stringify(lineObj));
    } catch (e) {
        logErr(
            '[MoySklad] payload_meta_debug_failed',
            JSON.stringify({
                orderId: orderId != null ? orderId : null,
                createPayment: !!createPayment,
                reason: e && e.message ? e.message : String(e)
            })
        );
    }
}

/**
 * Одна строка: wire payload без PII (для сравнения с тем, что уходит в axios).
 * @param {object} p
 * @param {unknown} p.orderId
 * @param {boolean} p.createPayment
 * @param {string} p.httpMethod
 * @param {boolean} p.hasMsOrderId
 * @param {object} p.wirePayload
 * @param {number} [p.maxLen]
 */
function logPayloadWireRedactedJson({
    orderId,
    createPayment,
    httpMethod,
    hasMsOrderId,
    wirePayload,
    maxLen = 20000,
    logger = console
}) {
    const logErr =
        typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);
    try {
        const redacted = redactCustomerOrderWirePayloadForLog(wirePayload);
        let s = JSON.stringify(redacted);
        if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(truncated ${s.length})`;
        logErr(
            '[MoySklad] payload_wire_redacted_json',
            JSON.stringify({
                orderId: orderId != null ? orderId : null,
                createPayment: !!createPayment,
                httpMethod: String(httpMethod || ''),
                hasMsOrderId: !!hasMsOrderId,
                json: s
            })
        );
    } catch (e) {
        logErr(
            '[MoySklad] payload_wire_redacted_json_failed',
            JSON.stringify({
                orderId: orderId != null ? orderId : null,
                reason: e && e.message ? e.message : String(e)
            })
        );
    }
}

/**
 * Атрибуты без value после prune бессмысленны для МС и могут ломать разбор.
 * @param {unknown} attributes
 * @returns {unknown}
 */
function filterAttributesWithMissingValue(attributes) {
    if (!Array.isArray(attributes)) return attributes;
    return attributes.filter(a => {
        if (!a || !isValidMeta(a.meta)) return false;
        if (a.value === undefined || a.value === null) return false;
        return true;
    });
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

/** Рекурсивно убирает очевидные ПДн из произвольного JSON для логов pre-customerorder. */
function redactGenericMoySkladLogObject(val, depth = 0) {
    if (depth > 14) return '[MAX_DEPTH]';
    if (val == null) return val;
    const t = typeof val;
    if (t === 'string') {
        if (val.length > 80) return `[string len=${val.length}]`;
        return val;
    }
    if (t !== 'object') return val;
    if (Array.isArray(val)) return val.map(x => redactGenericMoySkladLogObject(x, depth + 1));

    const REDACT_KEYS = new Set([
        'phone',
        'email',
        'name',
        'actualAddress',
        'legalAddress',
        'shipmentAddress',
        'description',
        'comment',
        'text',
        'cardText',
        'recipientFullName',
        'fullName',
        'legalFirstName',
        'legalLastName',
        'legalMiddleName',
        'legalTitle'
    ]);

    const out = {};
    for (const k of Object.keys(val)) {
        if (REDACT_KEYS.has(k)) out[k] = '[REDACTED]';
        else out[k] = redactGenericMoySkladLogObject(val[k], depth + 1);
    }
    return out;
}

/**
 * Лог wire-тела запроса к МС до customerorder (PII вычищены).
 * @param {object} p
 * @param {unknown} p.orderId
 * @param {boolean} p.createPayment
 * @param {string} p.step
 * @param {string} p.entity
 * @param {object} p.wireObj
 * @param {{ error?: Function }} [p.logger]
 * @param {number} [p.maxLen]
 */
function logPreCustomerorderEntityPayload({
    orderId,
    createPayment,
    step,
    entity,
    wireObj,
    logger = console,
    maxLen = 6000
}) {
    const logErr = typeof logger.error === 'function' ? logger.error.bind(logger) : console.error.bind(console);
    try {
        const redacted = redactGenericMoySkladLogObject(wireObj);
        let s = JSON.stringify(redacted);
        if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(truncated ${s.length})`;
        logErr(
            '[MoySklad] precustomerorder_payload_wire',
            JSON.stringify({
                orderId: orderId != null ? orderId : null,
                createPayment: !!createPayment,
                step,
                entity,
                json: s
            })
        );
    } catch (e) {
        logErr(
            '[MoySklad] precustomerorder_payload_wire_failed',
            JSON.stringify({
                orderId: orderId != null ? orderId : null,
                createPayment: !!createPayment,
                step,
                entity,
                reason: e && e.message ? e.message : String(e)
            })
        );
    }
}

/**
 * Те же проверки meta-like, что у customerorder wire, для любого тела POST/PUT до апсерта заказа.
 * @param {unknown} wireObj
 * @param {string} errPrefix
 */
function validateWireMetaLikeOrThrow(wireObj, errPrefix) {
    const wire = serializeMoySkladJsonPayload(wireObj);
    const violations = [
        ...new Set([...collectMetaTypeMissingPaths(wire), ...collectMetaLikeObjectsMissingType(wire)])
    ];
    if (violations.length) {
        throw new Error(`${errPrefix}: broken meta-like objects (${violations.join('; ')})`);
    }
    const hrefMismatch = collectMetaLikeHrefTypeMismatches(wire);
    if (hrefMismatch.length) {
        const detail = hrefMismatch
            .map(m => `${m.path} type=${m.type} inferredFromHref=${m.inferredFromHref}`)
            .join('; ');
        throw new Error(`${errPrefix}: href/type mismatch (${detail})`);
    }
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
    isMetaLikePlainObject,
    fixMeta,
    metaOrNull,
    collectMetaTypeMissingPaths,
    collectMetaLikeObjectsMissingType,
    collectMetaLikeHrefTypeMismatches,
    buildPayloadMetaDebugEntries,
    serializeMoySkladJsonPayload,
    logPayloadMetaDebug,
    logPayloadWireRedactedJson,
    redactCustomerOrderWirePayloadForLog,
    filterAttributesWithMissingValue,
    pruneInvalidMetaKeys,
    summarizeCustomerOrderPayloadForLog,
    logPayloadMetaTypeMissing,
    redactGenericMoySkladLogObject,
    logPreCustomerorderEntityPayload,
    validateWireMetaLikeOrThrow
};
