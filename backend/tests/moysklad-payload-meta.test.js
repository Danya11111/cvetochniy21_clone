'use strict';

const assert = require('assert');
const {
    inferMetaTypeByHref,
    collectMetaTypeMissingPaths,
    collectMetaLikeObjectsMissingType,
    pruneInvalidMetaKeys,
    metaOrNull,
    fixMeta,
    isValidMeta,
    buildPayloadMetaDebugEntries,
    serializeMoySkladJsonPayload,
    filterAttributesWithMissingValue
} = require('../moysklad-payload-meta');

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
    await test('inferMetaTypeByHref: variant, service, bundle, state', () => {
        assert.strictEqual(
            inferMetaTypeByHref('https://api.moysklad.ru/api/remap/1.2/entity/variant/uuid'),
            'variant'
        );
        assert.strictEqual(
            inferMetaTypeByHref('https://api.moysklad.ru/api/remap/1.2/entity/service/uuid'),
            'service'
        );
        assert.strictEqual(
            inferMetaTypeByHref('https://api.moysklad.ru/api/remap/1.2/entity/bundle/uuid'),
            'bundle'
        );
        assert.strictEqual(
            inferMetaTypeByHref(
                'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/uuid'
            ),
            'state'
        );
    });

    await test('metaOrNull: принудительный type + href', () => {
        const m = metaOrNull(
            { href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/uuid' },
            'counterparty'
        );
        assert.ok(m && m.type === 'counterparty' && m.href.includes('/entity/counterparty/'));
    });

    await test('collectMetaLikeObjectsMissingType: ловит href без type даже когда родитель не .meta', () => {
        const payload = {
            positions: [
                {
                    assortment: {
                        meta: {
                            href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/x',
                            mediaType: 'application/json'
                        }
                    }
                }
            ]
        };
        const paths = collectMetaLikeObjectsMissingType(payload);
        assert.ok(paths.includes('payload.positions[0].assortment.meta'));
        assert.strictEqual(collectMetaTypeMissingPaths(payload).length, 1);
        assert.ok(
            collectMetaTypeMissingPaths(payload).some(p => p.includes('positions[0].assortment.meta.type'))
        );
    });

    await test('buildPayloadMetaDebugEntries: snapshot полей без лишних данных', () => {
        const payload = {
            organization: {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/u1',
                    type: 'organization',
                    mediaType: 'application/json',
                    downloadHref: 'http://evil.example/leak'
                }
            }
        };
        const entries = buildPayloadMetaDebugEntries(payload);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].path, 'payload.organization.meta');
        assert.strictEqual(entries[0].hasType, true);
        assert.ok(Array.isArray(entries[0].keys));
        assert.ok(entries[0].keys.includes('downloadHref'));
    });

    await test('serializeMoySkladJsonPayload: убирает undefined', () => {
        const o = serializeMoySkladJsonPayload({ a: 1, b: undefined, c: { d: undefined } });
        assert.strictEqual(JSON.stringify(o), JSON.stringify({ a: 1, c: {} }));
    });

    await test('filterAttributesWithMissingValue: убирает атрибуты только с meta', () => {
        const attrs = [
            {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/aa',
                    type: 'attributemetadata',
                    mediaType: 'application/json'
                }
            },
            {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/bb',
                    type: 'attributemetadata',
                    mediaType: 'application/json'
                },
                value: 'x'
            }
        ];
        const f = filterAttributesWithMissingValue(attrs);
        assert.strictEqual(f.length, 1);
        assert.strictEqual(f[0].value, 'x');
    });

    await test('attributes[*].value.meta без type — meta-like violation', () => {
        const payload = {
            attributes: [
                {
                    meta: {
                        href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/a1',
                        type: 'attributemetadata',
                        mediaType: 'application/json'
                    },
                    value: {
                        meta: {
                            href: 'https://api.moysklad.ru/api/remap/1.2/entity/customentity/e1',
                            mediaType: 'application/json'
                        }
                    }
                }
            ]
        };
        const v = collectMetaLikeObjectsMissingType(payload);
        assert.ok(v.some(p => p.includes('payload.attributes[0].value.meta')));
    });

    await test('pruneInvalidMetaKeys: удаляет целиком невалидный meta (в т.ч. «осиротевший» metadataHref)', () => {
        const payload = {
            positions: [
                {
                    assortment: {
                        meta: {
                            metadataHref: 'https://api.moysklad.ru/api/remap/1.2/entity/x/metadata',
                            mediaType: 'application/json'
                        }
                    }
                }
            ],
            organization: {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/uuid',
                    type: 'organization',
                    mediaType: 'application/json'
                }
            }
        };
        pruneInvalidMetaKeys(payload);
        assert.strictEqual(payload.positions[0].assortment.meta, undefined);
        assert.ok(isValidMeta(payload.organization.meta));
    });

    await test('pickup-подобный payload: валидные meta у позиции и контрагентов', () => {
        const payload = {
            vatEnabled: false,
            positions: [
                {
                    quantity: 1,
                    price: 50000,
                    assortment: {
                        meta: {
                            href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/prod-id',
                            type: 'product',
                            mediaType: 'application/json'
                        }
                    }
                }
            ],
            organization: {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/org-id',
                    type: 'organization',
                    mediaType: 'application/json'
                }
            },
            agent: {
                meta: {
                    href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/cp-id',
                    type: 'counterparty',
                    mediaType: 'application/json'
                }
            },
            shipmentAddress: 'САМОВЫВОЗ',
            deliveryPlannedMoment: null
        };
        assert.strictEqual(collectMetaTypeMissingPaths(payload).length, 0);
        assert.strictEqual(collectMetaLikeObjectsMissingType(payload).length, 0);
        pruneInvalidMetaKeys(payload);
        assert.strictEqual(collectMetaTypeMissingPaths(payload).length, 0);
        assert.strictEqual(payload.positions.length, 1);
    });

    await test('delivery: две позиции — товар и доставка, обе с type', () => {
        const payload = {
            positions: [
                {
                    quantity: 1,
                    price: 10000,
                    assortment: {
                        meta: {
                            href: 'https://api.moysklad.ru/api/remap/1.2/entity/product/p1',
                            type: 'product',
                            mediaType: 'application/json'
                        }
                    }
                },
                {
                    quantity: 1,
                    price: 40000,
                    assortment: {
                        meta: {
                            href: 'https://api.moysklad.ru/api/remap/1.2/entity/service/d1',
                            type: 'service',
                            mediaType: 'application/json'
                        }
                    }
                }
            ]
        };
        assert.strictEqual(collectMetaTypeMissingPaths(payload).length, 0);
    });

    await test('fixMeta: заполняет type по href для attributemetadata', () => {
        const raw = {
            href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/attributes/uuid',
            mediaType: 'application/json'
        };
        const fixed = fixMeta(raw);
        assert.strictEqual(fixed.type, 'attributemetadata');
        assert.ok(metaOrNull(fixed, 'attributemetadata'));
    });
})().catch(e => {
    process.stderr.write(`FAIL (runner): ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
});
