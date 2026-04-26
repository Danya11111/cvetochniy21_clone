const axios = require('axios');
const db = require('./db');
const {
    MOYSKLAD_TOKEN,
    MOYSKLAD_ORGANIZATION_NAME,
    MOYSKLAD_ROOT_FOLDER_NAME,
    MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE
} = require('./config');
const {
    upsertCustomerOrderHttp,
    isStaleCustomerOrderNotFoundError,
    isStaleCustomerOrderMappingError
} = require('./moysklad-customerorder-upsert');


// БАЗОВЫЙ URL JSON API 1.2
// ВАЖНО: именно api.moysklad.ru, а не online.moysklad.ru и не apps-api.moysklad.ru
const MS_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

const ms = axios.create({
    baseURL: MS_BASE_URL,
    headers: {
        Authorization: `Bearer ${MOYSKLAD_TOKEN}`,
        'Content-Type': 'application/json;charset=utf-8',
        Accept: 'application/json;charset=utf-8'
    }
});

function dropInvalidMeta(obj) {
    const isValidMeta = (m) => m && typeof m === 'object' && String(m.type || '').trim() && String(m.href || '').trim();

    // верхний уровень
    if (obj.salesChannel && !isValidMeta(obj.salesChannel.meta)) delete obj.salesChannel;
    if (obj.organization && !isValidMeta(obj.organization.meta)) delete obj.organization;
    if (obj.agent && !isValidMeta(obj.agent.meta)) delete obj.agent;

    // attributes
    if (Array.isArray(obj.attributes)) {
        obj.attributes = obj.attributes.filter(a => isValidMeta(a?.meta));
        for (const a of obj.attributes) {
            if (a.value && a.value.meta && !isValidMeta(a.value.meta)) {
                delete a.value; // выбрасываем значение, иначе MS падает
            }
        }
    }

    // positions assortment
    if (Array.isArray(obj.positions)) {
        obj.positions = obj.positions.filter(p => isValidMeta(p?.assortment?.meta));
    }
}

function inferMetaTypeByHref(href) {
    const h = String(href || '');

    if (h.includes('/entity/saleschannel/')) return 'saleschannel';
    if (h.includes('/entity/organization/')) return 'organization';
    if (h.includes('/entity/counterparty/')) return 'counterparty';
    if (h.includes('/entity/product/')) return 'product';
    if (h.includes('/entity/customerorder/')) return 'customerorder';
    if (h.includes('/entity/paymentin/')) return 'paymentin';

    // атрибуты заказов (metadata/attributes)
    if (h.includes('/entity/customerorder/metadata/attributes/')) return 'attributemetadata';

    // custom entity значения (часто /entity/customentity/)
    if (h.includes('/entity/customentity/')) return 'customentity';

    return null;
}

function fixMeta(meta, fallbackHref = null) {
    if (!meta || typeof meta !== 'object') return null;

    const out = { ...meta };

    if (!out.href && fallbackHref) out.href = fallbackHref;
    if (!out.mediaType) out.mediaType = 'application/json';

    if (!out.type) {
        const t = inferMetaTypeByHref(out.href);
        if (t) out.type = t;
    }

    // если type так и не появился — вернём как есть (ниже мы это залогируем)
    return out;
}

function logMissingMetaTypesStrict(obj, path = 'payload') {
    const bad = [];

    const walk = (v, p) => {
        if (!v) return;

        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) walk(v[i], `${p}[${i}]`);
            return;
        }

        if (typeof v !== 'object') return;

        // если это meta-объект (есть href или mediaType) — проверяем type
        const looksLikeMeta = ('href' in v) || ('mediaType' in v) || ('metadataHref' in v);

        if (looksLikeMeta) {
            const t = v.type;
            if (t === undefined || t === null || String(t).trim().length === 0) {
                bad.push({ path: p, href: v.href, type: v.type, mediaType: v.mediaType });
            }
        }

        for (const k of Object.keys(v)) {
            walk(v[k], `${p}.${k}`);
        }
    };

    walk(obj, path);

    if (bad.length) {
        console.error('[MoySklad][META] Found meta without type (or empty type):', bad);
    } else {
        console.log('[MoySklad][META] OK: all meta have non-empty type');
    }
}

function deepDropInvalidMeta(obj) {
    const isValidMeta = (m) =>
        m && typeof m === 'object' &&
        String(m.type || '').trim() &&
        String(m.href || '').trim();

    const walk = (v) => {
        if (!v) return;

        if (Array.isArray(v)) {
            for (const item of v) walk(item);
            return;
        }

        if (typeof v !== 'object') return;

        // если это meta-объект — проверим и "обнулим" если невалидный
        const looksLikeMeta = ('href' in v) || ('mediaType' in v) || ('metadataHref' in v);
        if (looksLikeMeta) {
            if (!isValidMeta(v)) {
                // удаляем поля так, чтобы MS не видел "meta без type"
                delete v.href;
                delete v.type;
                delete v.mediaType;
            }
        }

        // если это объект вида { meta: {...} } — удаляем meta целиком, если невалидная
        if (v.meta && typeof v.meta === 'object' && !isValidMeta(v.meta)) {
            delete v.meta;
        }

        for (const k of Object.keys(v)) {
            walk(v[k]);
        }
    };

    walk(obj);
}




let cachedPaidStateMeta = null;

async function getCustomerOrderStateMetaByName(stateName) {
    const name = String(stateName || '').trim();
    if (!name) return null;

    if (cachedPaidStateMeta && cachedPaidStateMeta.__name === name) return cachedPaidStateMeta.meta;

    const res = await ms.get('/entity/customerorder/metadata');
    const states = res.data?.states || res.data?.state?.rows || res.data?.states?.rows || [];

    const list = Array.isArray(states) ? states : (states.rows || []);
    const found = (list || []).find(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase());

    if (!found?.meta) return null;

    cachedPaidStateMeta = { __name: name, meta: found.meta };
    return found.meta;
}

async function markCustomerOrderPaid(msOrderId) {
    const paidMeta = await getCustomerOrderStateMetaByName('ОПЛАЧЕНО');
    if (!paidMeta) {
        console.warn('[MoySklad] Cannot find state "ОПЛАЧЕНО" in customerorder metadata');
        return;
    }

    await ms.put(`/entity/customerorder/${msOrderId}`, {
        state: { meta: paidMeta }
    });
}


let cachedOrganizationMeta = null;

let cachedSalesChannelMeta = null;

async function getOrCreateSalesChannelMeta() {
    if (
        cachedSalesChannelMeta &&
        cachedSalesChannelMeta.href &&
        cachedSalesChannelMeta.type === 'saleschannel'
    ) {
        return cachedSalesChannelMeta;
    }

    const name = 'Telegram Bot';

    // ищем
    const res = await ms.get('/entity/saleschannel', {
        params: { filter: `name=${name}` }
    });

    const row = res.data?.rows?.[0];
    if (row?.id) {
        cachedSalesChannelMeta = {
            href: `${MS_BASE_URL}/entity/saleschannel/${row.id}`,
            type: 'saleschannel',
            mediaType: 'application/json'
        };
        return cachedSalesChannelMeta;
    }

    // создаём
    const created = await ms.post('/entity/saleschannel', { name });
    if (!created.data?.id) return null;

    cachedSalesChannelMeta = {
        href: `${MS_BASE_URL}/entity/saleschannel/${created.data.id}`,
        type: 'saleschannel',
        mediaType: 'application/json'
    };

    return cachedSalesChannelMeta;
}


async function debugGetCustomerOrderFull(msOrderId) {
    try {
        if (!msOrderId) {
            console.log('[debugGetCustomerOrderFull] msOrderId is empty');
            return;
        }

        console.log('============================================');
        console.log('====== CUSTOMERORDER FULL (with salesChannel & attributes) ======');

        // ВАЖНО: expand помогает раскрыть вложенные meta (где возможно)
        // attributes обычно возвращаются массивом объектов с meta + value
        const orderRes = await ms.get(`/entity/customerorder/${msOrderId}`, {
            params: {
                expand: 'agent,organization,salesChannel,attributes'
            }
        });

        const order = orderRes.data || {};
        console.log(JSON.stringify(order, null, 2));

        console.log('============================================');
        console.log('====== CUSTOMERORDER: salesChannel meta (if any) ======');
        console.log(JSON.stringify(order.salesChannel?.meta || null, null, 2));

        console.log('============================================');
        console.log('====== CUSTOMERORDER: attributes[] (raw) ======');
        console.log(JSON.stringify(order.attributes || [], null, 2));

        // Если у заказа установлен salesChannel — отдельно запросим этот справочник по href
        const scHref = order.salesChannel?.meta?.href;
        if (scHref) {
            console.log('============================================');
            console.log('====== SALESCHANNEL ENTITY (by href) ======');

            // переводим абсолютный href в относительный для твоего ms клиента
            const url = String(scHref).replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');
            const scRes = await ms.get(url);
            console.log(JSON.stringify(scRes.data || null, null, 2));
        } else {
            console.log('============================================');
            console.log('====== SALESCHANNEL ENTITY: not set on this order ======');
        }

        console.log('============================================');
        console.log('====== CUSTOMERORDER METADATA (fields & attributes meta) ======');

        const metaRes = await ms.get('/entity/customerorder/metadata');
        console.log(JSON.stringify(metaRes.data || null, null, 2));

        console.log('============================================');
    } catch (e) {
        console.error('[debugGetCustomerOrderFull] failed:', e.response?.data || e.message);
    }
}


// Удобная штука: посмотреть список saleschannel и их meta (чтобы выбрать правильный)
async function debugListSalesChannels() {
    try {
        console.log('============================================');
        console.log('====== SALESCHANNEL LIST ======');
        const res = await ms.get('/entity/saleschannel', { params: { limit: 100 } });
        const rows = res.data?.rows || [];
        console.log('count:', rows.length);

        // печатаем компактно: id, name, meta
        const out = rows.map(r => ({
            id: r.id,
            name: r.name,
            meta: r.meta
        }));
        console.log(JSON.stringify(out, null, 2));
        console.log('============================================');
    } catch (e) {
        console.error('[debugListSalesChannels] failed:', e.response?.data || e.message);
    }
}


// Ещё удобнее: по нашему order.id (локальному) взять ms_id и распечатать всё
async function debugGetCustomerOrderFullByLocalOrderId(localOrderId) {
    try {
        const row = await new Promise((resolve, reject) => {
            db.get('SELECT id, ms_id FROM orders WHERE id = ?', [localOrderId], (err, r) => {
                if (err) return reject(err);
                resolve(r);
            });
        });

        if (!row?.ms_id) {
            console.log('[debugGetCustomerOrderFullByLocalOrderId] order has no ms_id:', row);
            return;
        }

        await debugGetCustomerOrderFull(row.ms_id);
    } catch (e) {
        console.error('[debugGetCustomerOrderFullByLocalOrderId] failed:', e.response?.data || e.message);
    }
}



async function getOrganizationMeta() {
    if (cachedOrganizationMeta) return cachedOrganizationMeta;

    const res = await ms.get('/entity/organization', {
        params: {
            filter: `name=${MOYSKLAD_ORGANIZATION_NAME}`
        }
    });

    const rows = res.data.rows || [];
    if (!rows.length) {
        throw new Error(
            `Organization "${MOYSKLAD_ORGANIZATION_NAME}" not found in MoySklad`
        );
    }

    const org = rows[0];

    // ВАЖНО: не доверяем org.meta (иногда приходит без type)
    cachedOrganizationMeta = {
        href: `${MS_BASE_URL}/entity/organization/${org.id}`,
        type: 'organization',
        mediaType: 'application/json'
    };

    return cachedOrganizationMeta;
}



async function getOrCreateCounterpartyMeta(fullName, phone, email = '') {
    if (!phone) {
        throw new Error('Phone is required to search/create counterparty');
    }

    const safeEmail = String(email || '').trim().toLowerCase();

    // 1) пробуем найти по телефону
    const res = await ms.get('/entity/counterparty', {
        params: {
            filter: `phone=${phone}`
        }
    });

    let cp = (res.data.rows || [])[0];

    // 2) если не нашли — создаём нового
    if (!cp) {
        const payload = {
            name: fullName || phone,
            phone: phone
        };

        // NEW: email в карточку контрагента
        if (safeEmail) payload.email = safeEmail;

        const createRes = await ms.post('/entity/counterparty', payload);
        cp = createRes.data;
    } else {
        // NEW: если нашли существующего — и email задан, но в МС другой/пустой → обновляем
        const currentEmail = String(cp.email || '').trim().toLowerCase();
        if (safeEmail && safeEmail !== currentEmail) {
            try {
                await ms.put(`/entity/counterparty/${cp.id}`, { email: safeEmail });
                // чтобы дальше в коде всё было консистентно
                cp.email = safeEmail;
            } catch (e) {
                console.warn('[MoySklad] Cannot update counterparty email:', e.response?.data || e.message);
            }
        }
    }

    const id = cp?.id;
    if (!id) {
        throw new Error('Counterparty id is missing after search/create');
    }

    return {
        href: `${MS_BASE_URL}/entity/counterparty/${id}`,
        type: 'counterparty',
        mediaType: 'application/json'
    };
}



async function createCustomerPaymentForOrder(msOrder, organizationMeta, agentMeta) {
    // МойСклад уже посчитал сумму заказа в копейках
    const sum = msOrder.sum;

    if (!sum || sum <= 0) {
        console.log('[MoySklad] Order sum is 0, skip customerpayment');
        return;
    }

    const payload = {
        organization: { meta: organizationMeta },
        agent: { meta: agentMeta },
        sum, // в копейках
        operations: [
            {
                meta: msOrder.meta // ссылка на заказ покупателя
            }
        ]
    };

    console.log('[MoySklad] Creating customerpayment, sum =', sum);

    await ms.post('/entity/paymentin', payload);
}


let cachedRootFolder = null;

async function getRootFolder() {
    if (cachedRootFolder) return cachedRootFolder;

    // 1) грузим все папки
    const res = await ms.get('/entity/productfolder', { params: { limit: 1000 } });
    const rows = res.data.rows || [];

    if (!rows.length) {
        throw new Error('[MoySklad] productfolder list is empty');
    }

    // 2) ищем по externalCode, если он задан
    if (MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE) {
        const found = rows.find(f => f.externalCode === MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE);
        if (!found) {
            throw new Error(
                `[MoySklad] Root folder not found by externalCode=${MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE}`
            );
        }
        cachedRootFolder = found;
        return cachedRootFolder;
    }

    // 3) fallback: ищем по имени
    if (MOYSKLAD_ROOT_FOLDER_NAME) {
        const found = rows.find(f => f.name === MOYSKLAD_ROOT_FOLDER_NAME);
        if (!found) {
            throw new Error(
                `[MoySklad] Root folder not found by name="${MOYSKLAD_ROOT_FOLDER_NAME}"`
            );
        }
        cachedRootFolder = found;
        return cachedRootFolder;
    }

    throw new Error('[MoySklad] Set MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE or MOYSKLAD_ROOT_FOLDER_NAME in config.js');
}





/**
 * Получение списка товаров из МойСклад
 * @returns {Promise<Array>} массив товаров из МС
 */
async function fetchProductsFromMoySklad() {
    const limit = 100;
    let products = [];
    let nextPath = `/entity/product?limit=${limit}`;

    while (nextPath) {
        const res = await ms.get(nextPath);
        const data = res.data;

        products = products.concat(data.rows || []);

        if (data.meta && data.meta.nextHref) {
            const url = new URL(data.meta.nextHref);
            const path = url.pathname.replace('/api/remap/1.2', '');
            nextPath = path + url.search;
        } else {
            nextPath = null;
        }
    }

    return products;
}


async function fetchStockReport() {
    const limit = 100;
    let rows = [];
    // Сразу просим expand=assortment, чтобы получить данные товара
    let nextPath = `/report/stock/all?limit=${limit}&expand=assortment`;

    while (nextPath) {
        const res = await ms.get(nextPath);
        const data = res.data;

        rows = rows.concat(data.rows || []);

        if (data.meta && data.meta.nextHref) {
            const url = new URL(data.meta.nextHref);
            const path = url.pathname.replace('/api/remap/1.2', '');
            nextPath = path + url.search;
        } else {
            nextPath = null;
        }
    }

    return rows;
}


function formatMsDateTime(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const YYYY = date.getFullYear();
    const MM = pad(date.getMonth() + 1);
    const DD = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    // Формат: "2025-12-12 02:54:00"
    return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}



/**
 * Синхронизация каталога:
 * - если товар с таким ms_id есть → обновляем цену и остаток
 * - если нет → создаём новый
 */

function extractUuidFromDownloadHref(href) {
    if (!href) return null;
    const tail = href.substring(href.lastIndexOf('/') + 1);
    return tail.split('?')[0];
}

// Пытаемся получить картинки товара “правильным” способом.
// 1) /entity/product/{id}/images (если доступно)
// 2) /entity/product/{id}/files (часто там лежат изображения как файлы)
// 3) fallback: /entity/product/{id} и поиск /download/ внутри
async function fetchProductImageUuids(msId, max = 5) {
    const out = [];

    // A) images collection
    try {
        const r = await ms.get(`/entity/product/${msId}/images`, { params: { limit: 50 } });
        const rows = r.data?.rows || [];
        for (const img of rows) {
            const href = img?.meta?.href; // иногда meta.href уже download, иногда entity/image
            // пробуем найти downloadHref/miniature/tiny — зависит от структуры
            const uuid =
                extractUuidFromDownloadHref(img?.meta?.downloadHref) ||
                extractUuidFromDownloadHref(img?.miniature?.downloadHref) ||
                extractUuidFromDownloadHref(img?.tiny?.href) ||
                extractUuidFromDownloadHref(href);

            if (uuid && !out.includes(uuid)) out.push(uuid);
            if (out.length >= max) break;
        }
        if (out.length) return out;
    } catch (_) {
        // если эндпоинт не существует или запрещён — идём дальше
    }

    // B) files collection
    try {
        const r = await ms.get(`/entity/product/${msId}/files`, { params: { limit: 50 } });
        const rows = r.data?.rows || [];
        for (const f of rows) {
            // у файлов чаще всего есть ссылка на download в meta.href или в content/meta
            const uuid =
                extractUuidFromDownloadHref(f?.meta?.downloadHref) ||
                extractUuidFromDownloadHref(f?.meta?.href) ||
                extractUuidFromDownloadHref(f?.content?.meta?.href) ||
                null;

            if (uuid && !out.includes(uuid)) out.push(uuid);
            if (out.length >= max) break;
        }
        if (out.length) return out;
    } catch (_) {}

    // C) fallback: взять карточку товара и найти любой /download/ внутри (грубый, но помогает)
    try {
        const r = await ms.get(`/entity/product/${msId}`);
        const s = JSON.stringify(r.data);
        const m = s.match(/\/download\/([0-9a-f-]{20,})/i);
        if (m && m[1]) return [m[1]];
    } catch (_) {}

    return [];
}


async function syncProductsFromMoySklad() {
    if (!MOYSKLAD_TOKEN) {
        throw new Error('MOYSKLAD_TOKEN is not set in config.js');
    }

    console.log('[MoySklad] Starting products sync (products by folders + images from stock report, NO STOCK)...');

    // 1) Root folder (у тебя уже есть getRootFolder() — по name/externalCode как сделано)
    const rootFolder = await getRootFolder();
    const rootHref = rootFolder.meta?.href;

    if (!rootHref) {
        throw new Error('[MoySklad] Root folder meta.href is empty');
    }

    console.log('[MoySklad] ROOT folder:', {
        id: rootFolder.id,
        name: rootFolder.name,
        externalCode: rootFolder.externalCode,
        href: rootHref
    });

    // 2) Грузим все папки и строим дерево productfolder
    const foldersRes = await ms.get('/entity/productfolder', { params: { limit: 1000 } });
    const folders = foldersRes.data.rows || [];

    const byHref = new Map();      // folderHref -> folderObj
    const children = new Map();    // parentHref -> [childHref]

    for (const f of folders) {
        const href = f.meta?.href;
        if (!href) continue;

        byHref.set(href, f);

        const parentHref = f.productFolder?.meta?.href || null;
        if (!children.has(parentHref)) children.set(parentHref, []);
        children.get(parentHref).push(href);
    }

    // 3) Собираем root + всех потомков
    const allowedFolderHrefs = new Set();
    const stack = [rootHref];

    while (stack.length) {
        const cur = stack.pop();
        if (allowedFolderHrefs.has(cur)) continue;

        allowedFolderHrefs.add(cur);

        const kids = children.get(cur) || [];
        for (const k of kids) stack.push(k);
    }

    console.log('[MoySklad] Allowed folders count (root + descendants):', allowedFolderHrefs.size);

    // 4) Тянем ВСЕ товары и фильтруем по productFolder
    let msProductsAll = [];
    let nextPath = `/entity/product?limit=1000&expand=productFolder,salePrices`;

    while (nextPath) {
        const res = await ms.get(nextPath);
        const data = res.data;

        msProductsAll = msProductsAll.concat(data.rows || []);

        if (data.meta?.nextHref) {
            const url = new URL(data.meta.nextHref);
            nextPath = url.pathname.replace('/api/remap/1.2', '') + url.search;
        } else {
            nextPath = null;
        }
    }

    console.log('[MoySklad] Products fetched from entity/product:', msProductsAll.length);

    const msProducts = msProductsAll.filter(p => {
        const folderHref = p.productFolder?.meta?.href || null;
        return folderHref && allowedFolderHrefs.has(folderHref);
    });

    console.log('[MoySklad] Products after root-folder filter:', msProducts.length);

    // 5) Тянем отчет остатков ТОЛЬКО чтобы взять картинки (image uuid)
    //    (остатки/quantity игнорируем полностью)
    const stockRes = await ms.get('/report/stock/all', {
        params: { limit: 1000, expand: 'assortment' }
    });

    const stockRows = stockRes.data.rows || [];
    console.log('[MoySklad] Stock report rows fetched (for images):', stockRows.length);

    // productId -> imageUuid
    const imgUuidByProductId = new Map();

    for (const row of stockRows) {
        // В твоем сыром JSON row.meta.href = .../entity/product/<id>?expand=supplier
        const href = row.meta?.href;
        if (!href) continue;

        const productId = href.substring(href.lastIndexOf('/') + 1).split('?')[0];

        const imgHref = row.image?.meta?.href; // .../download/<uuid>
        if (!imgHref) continue;

        const uuid = imgHref.substring(imgHref.lastIndexOf('/') + 1).split('?')[0];
        imgUuidByProductId.set(productId, uuid);
    }

    console.log('[MoySklad] Images map size:', imgUuidByProductId.size);

    // 6) Чистим products
    await new Promise((resolve, reject) => {
        db.run('DELETE FROM products', err => (err ? reject(err) : resolve()));
    });

    const stmt = db.prepare(`
    INSERT INTO products (ms_id, name, price, stock, images_json, category, category_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

    let inserted = 0;
    let withImages = 0;

    for (const p of msProducts) {
        const msId = p.id;
        const name = p.name || 'Без названия';

        // цена (salePrices[0].value в копейках)
        let priceRub = 0;
        const sale = p.salePrices?.[0]?.value;
        if (typeof sale === 'number') priceRub = sale / 100;

        // категория: имя productFolder
        const folderHref = p.productFolder?.meta?.href || null;
        const folderObj = folderHref ? byHref.get(folderHref) : null;
        const category = folderObj?.name || rootFolder.name || 'Каталог';

        // category_path: цепочка папок
        let categoryPath = category;
        try {
            const parts = [];
            let curHref = folderHref;
            let guard = 0;
            while (curHref && guard < 30) {
                const f = byHref.get(curHref);
                if (!f) break;
                parts.push(f.name);
                curHref = f.productFolder?.meta?.href || null;
                guard++;
            }
            parts.reverse();
            categoryPath = parts.join('/');
        } catch (_) {}

        // остаток НЕ трогаем вообще
        const stock = 99;

        // картинки из stock report map
        // картинки: тянем из коллекции изображений/файлов товара
        const uuids = await fetchProductImageUuids(msId, 6); // до 6 картинок в галерее

        const images = uuids.map(u => `/api/moysklad/image/${u}`);
        const imagesJson = JSON.stringify(images);

// небольшой троттлинг, чтобы не упереться в лимит
        await new Promise(r => setTimeout(r, 80));




        stmt.run(
            msId,
            name,
            priceRub,
            stock,
            imagesJson,
            category,
            categoryPath
        );

        inserted++;
    }

    stmt.finalize();

    console.log('[MoySklad] Products sync completed. Inserted:', inserted, 'withImages:', withImages);
}

/**
 * Сброс локальной связи с customerorder после подтверждённого stale (перед единственным recreate POST).
 */
async function resetLocalMsMappingAfterStaleCustomerOrder(orderId, deps = null) {
    const dbi = deps && deps.db ? deps.db : db;
    await new Promise((resolve, reject) => {
        dbi.run(
            'UPDATE orders SET ms_id = NULL, ms_name = NULL, ms_sync_hash = NULL WHERE id = ?',
            [orderId],
            err => (err ? reject(err) : resolve())
        );
    });
}

/**
 * Stale PUT: обнулить ms_id/ms_name/ms_sync_hash, один POST create, структурированные логи.
 * @param {object} ctx
 * @param {{ db?: typeof db, ms?: typeof ms } | null} [deps] — подмена для тестов
 */
async function recoverStaleCustomerOrderAfterPutNotFound(ctx, deps = null) {
    const {
        orderId,
        staleMsId,
        staleMsName,
        payload,
        createPayment,
        statusCode,
        msErrorCode
    } = ctx;

    const msi = deps && deps.ms ? deps.ms : ms;

    console.error(
        '[MoySklad] stale_customerorder_detected',
        JSON.stringify({
            orderId,
            msId: staleMsId,
            msName: staleMsName != null ? staleMsName : null,
            createPayment: !!createPayment,
            statusCode: statusCode != null ? statusCode : null,
            msErrorCode: msErrorCode != null ? msErrorCode : null
        })
    );

    await resetLocalMsMappingAfterStaleCustomerOrder(orderId, deps);

    console.log(
        '[MoySklad] stale_customerorder_mapping_reset',
        JSON.stringify({
            orderId,
            previousMsId: staleMsId,
            createPayment: !!createPayment
        })
    );

    console.log(
        '[MoySklad] stale_customerorder_recreate_started',
        JSON.stringify({
            orderId,
            previousMsId: staleMsId,
            createPayment: !!createPayment
        })
    );

    try {
        const res = await msi.post('/entity/customerorder', payload);
        const newId = res.data && res.data.id;
        console.log(
            '[MoySklad] stale_customerorder_recreate_succeeded',
            JSON.stringify({
                orderId,
                previousMsId: staleMsId,
                newMsId: newId,
                createPayment: !!createPayment
            })
        );
        return res.data;
    } catch (recErr) {
        console.error(
            '[MoySklad] stale_customerorder_recreate_failed',
            JSON.stringify({
                orderId,
                previousMsId: staleMsId,
                createPayment: !!createPayment,
                reason: recErr && recErr.message ? recErr.message : String(recErr),
                statusCode: recErr && recErr.response && recErr.response.status,
                response:
                    recErr && recErr.response && recErr.response.data ? recErr.response.data : undefined
            })
        );
        throw recErr;
    }
}





/**
 * Отправка заказа в МойСклад
 * @param {Object} order - { id, telegramId, fullName, address, total, items }
 * items: [{ productId, name, price, quantity }]
 */
/**
 * Upsert заказа в МС + (опционально) создание PaymentIn после оплаты
 * order: { id, fullName, phone, address, items, deliveryDate, deliveryTime }
 */
async function sendOrderToMoySklad(order, { createPayment = false, paidSumKopecks = null } = {}) {
    if (!MOYSKLAD_TOKEN) {
        console.log('[MoySklad] Token not configured, skip send order');
        return;
    }

    // если у тебя здесь оставлен debugGetCustomerOrderFull — можешь оставить/убрать
    // await debugGetCustomerOrderFull('9ae2afa0-dedc-11f0-0a80-0494007c7b5f');

    console.log('[MoySklad] Upsert order', order.id, 'createPayment=', createPayment);

    // NEW: товары доставки в МС (UUID или externalCode можно хранить в config.js)
    const {
        MOYSKLAD_DELIVERY_CITY400_ASSORTMENT,
        MOYSKLAD_DELIVERY_TO10KM_ASSORTMENT
    } = require('./config');

    // кэш, чтобы не дергать МС на каждом апсерте
    const _deliveryAssortmentCache =
        sendOrderToMoySklad.__deliveryAssortmentCache ||
        (sendOrderToMoySklad.__deliveryAssortmentCache = new Map());

    const isUuid = (v) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            String(v || '').trim()
        );

    const resolveAssortmentMeta = async (codeOrId) => {
        const key = String(codeOrId || '').trim();
        if (!key) return null;

        if (_deliveryAssortmentCache.has(key)) return _deliveryAssortmentCache.get(key);

        const mk = (entity, id, type) => ({
            href: `${MS_BASE_URL}/entity/${entity}/${id}`,
            type,
            mediaType: 'application/json'
        });

        const tryGetById = async (entity, type) => {
            try {
                const r = await ms.get(`/entity/${entity}/${key}`);
                const id = r.data?.id;
                if (!id) return null;
                return mk(entity, id, type);
            } catch (_) {
                return null;
            }
        };

        const tryFindByExternalCode = async (entity, type) => {
            try {
                const r = await ms.get(`/entity/${entity}`, {
                    params: { filter: `externalCode=${key}` }
                });
                const row = r.data?.rows?.[0];
                if (!row?.id) return null;
                return mk(entity, row.id, type);
            } catch (_) {
                return null;
            }
        };

        let meta = null;
        if (isUuid(key)) {
            meta =
                (await tryGetById('product', 'product')) ||
                (await tryGetById('service', 'service')) ||
                (await tryGetById('bundle', 'bundle'));
        } else {
            meta =
                (await tryFindByExternalCode('product', 'product')) ||
                (await tryFindByExternalCode('service', 'service')) ||
                (await tryFindByExternalCode('bundle', 'bundle'));
        }

        if (meta) _deliveryAssortmentCache.set(key, meta);
        return meta;
    };

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

    // --- helpers для даты/времени доставки ---
    const parseDateToLocal = (s) => {
        const str = String(s || '').trim();
        if (!str) return null;

        // YYYY-MM-DD
        let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
            const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
            return new Date(y, mo, d, 0, 0, 0, 0);
        }

        // DD.MM.YYYY
        m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (m) {
            const d = Number(m[1]), mo = Number(m[2]) - 1, y = Number(m[3]);
            return new Date(y, mo, d, 0, 0, 0, 0);
        }

        // fallback
        const dt = new Date(str);
        return Number.isFinite(dt.getTime()) ? dt : null;
    };

    const parseStartTimeFromInterval = (interval) => {
        // "HH:MM - HH:MM"
        const s = String(interval || '').trim();
        const m = s.match(/^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})$/);
        if (!m) return null;
        return { hh: Number(m[1]), mm: Number(m[2]) };
    };

    // --- 1) берём ms_id если уже есть ---
    const existing = await new Promise((resolve, reject) => {
        db.get(
            'SELECT ms_id, ms_name FROM orders WHERE id = ?',
            [order.id],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    // --- 2) позиции ---
    const positions = [];
    for (const item of order.items || []) {
        const msId = item.msId || item.ms_id || null;
        if (!msId) continue;

        const priceRub = Number(item.price || 0);
        const priceKopecks = Math.round((Number.isFinite(priceRub) ? priceRub : 0) * 100);

        positions.push({
            quantity: Number(item.quantity || 1),
            price: priceKopecks,
            assortment: {
                meta: {
                    href: `${MS_BASE_URL}/entity/product/${msId}`,
                    type: 'product',
                    mediaType: 'application/json'
                }
            }
        });
    }

    // NEW: если выбран платный вариант доставки — добавляем "товар доставки" в заказ МС
    const deliveryOption = String(order.deliveryOption || '').trim();
    const deliveryFeeRub = Number(order.deliveryFeeRub ?? order.deliveryFee ?? 0);
    const safeDeliveryFeeRub =
        Number.isFinite(deliveryFeeRub) && deliveryFeeRub > 0 ? deliveryFeeRub : 0;

    let deliveryAssortmentCode = null;
    if (deliveryOption === 'city400') deliveryAssortmentCode = MOYSKLAD_DELIVERY_CITY400_ASSORTMENT;
    if (deliveryOption === 'to10km490') deliveryAssortmentCode = MOYSKLAD_DELIVERY_TO10KM_ASSORTMENT;

    if (deliveryAssortmentCode && safeDeliveryFeeRub > 0) {
        const deliveryMeta = await resolveAssortmentMeta(deliveryAssortmentCode);

        if (deliveryMeta?.href && deliveryMeta?.type) {
            positions.push({
                quantity: 1,
                price: Math.round(safeDeliveryFeeRub * 100),
                assortment: { meta: deliveryMeta }
            });
        } else {
            console.warn('[MoySklad] Delivery assortment not resolved. Check config.js keys for delivery products.');
        }
    }

    if (positions.length === 0) {
        throw new Error('[MoySklad] Positions are empty. Refuse to create empty order.');
    }

    // --- 3) организация + контрагент ---
    const organizationMeta = fixMeta(await getOrganizationMeta());
    const agentMeta = fixMeta(await getOrCreateCounterpartyMeta(order.fullName, order.phone, order.email));

    // --- 4) адрес / самовывоз ---
    const shipmentAddress = String(order.address || '').trim() || '';
    const isPickup =
        shipmentAddress.trim().toLowerCase() === 'самовывоз' ||
        order.deliveryMethod === 'pickup';

    // --- 5) "Время доставки" (АТРИБУТ): ТОЛЬКО интервал, без даты ---
    //     самовывоз: "самовывоз"
    const intervalOnly = String(order.deliveryTime || '').trim(); // ожидаем "HH:MM - HH:MM"
    const deliveryTimeAttrValue = isPickup ? 'самовывоз' : intervalOnly;

    // --- 6) "План дата отгрузки" (deliveryPlannedMoment)
// - доставка: дата + НАЧАЛО интервала
// - самовывоз: ТОЛЬКО дата самовывоза (время не учитываем)
    let deliveryPlannedMoment = null;
    {
        const dateObj = parseDateToLocal(order.deliveryDate);
        if (dateObj) {
            if (isPickup) {
                // самовывоз: ставим только дату, время остаётся в комментарии
                deliveryPlannedMoment = formatMsDateTime(dateObj); // "YYYY-MM-DD HH:MM:SS"
            } else {
                const start = parseStartTimeFromInterval(intervalOnly);
                if (start) {
                    dateObj.setHours(start.hh, start.mm, 0, 0);
                    deliveryPlannedMoment = formatMsDateTime(dateObj); // "YYYY-MM-DD HH:MM:SS"
                }
            }
        }
    }


    // --- 7) Атрибуты заказа (custom attributes) ---
    async function fetchCustomerOrderAttributesList() {
        const metaRes = await ms.get('/entity/customerorder/metadata');
        const meta = metaRes.data || {};
        const raw = meta.attributes;

        if (Array.isArray(raw)) return raw;
        if (raw && Array.isArray(raw.rows)) return raw.rows;

        const href = raw?.meta?.href || raw?.href || null;
        if (!href) return [];

        const url = href.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');
        const r = await ms.get(url);
        return r.data?.rows || [];
    }

    async function resolveCustomEntityCollectionUrl(attributeRow) {
        let href = attributeRow?.customEntityMeta?.href
            || attributeRow?.customEntityMeta?.meta?.href
            || null;

        if (!href) return null;

        let url = href.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');

        try {
            const metaResp = await ms.get(url);
            const d = metaResp.data || {};

            if (d.entityMeta?.href) {
                return d.entityMeta.href.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');
            }

            if (d.meta?.href) {
                let rel = d.meta.href.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');
                if (rel.includes('/entity/customentity/') && rel.includes('/metadata')) {
                    rel = rel.replace(/\/metadata.*/i, '');
                }
                if (rel.includes('/entity/customentity/')) return rel;
            }
        } catch (_) {}

        if (url.includes('/entity/customentity/') && url.includes('/metadata')) {
            url = url.replace(/\/metadata.*/i, '');
        }

        if (url.includes('/entity/customentity/')) return url;
        return null;
    }

    async function getOrCreateCustomEntityValueMeta(attributeRow, valueName) {
        if (!attributeRow || !valueName) return null;

        const collectionUrl = await resolveCustomEntityCollectionUrl(attributeRow);
        if (!collectionUrl) return null;

        try {
            const listRes = await ms.get(collectionUrl);
            const rows = listRes.data?.rows || [];

            const vn = String(valueName).trim().toLowerCase();
            let found = rows.find(r => String(r.name || '').trim().toLowerCase() === vn);

            if (!found) {
                try {
                    const created = await ms.post(collectionUrl, { name: valueName });
                    found = created.data;
                } catch (_) {
                    return null;
                }
            }

            return found?.meta ? fixMeta(found.meta, found.id ? `${MS_BASE_URL}/entity/customentity/${found.id}` : null) : null;
        } catch (_) {
            return null;
        }
    }

    const attrs = await fetchCustomerOrderAttributesList();
    const findAttr = (name) => {
        const needle = String(name || '').trim().toLowerCase();
        return (attrs || []).find(a => String(a.name || '').trim().toLowerCase() === needle) || null;
    };

    const attrDeliveryTime   = findAttr('Время доставки');
    const attrRecipientFio   = findAttr('ФИО получателя');
    const attrRecipientPhone = findAttr('Номер телефона получателя');
    const attrComment        = findAttr('Комментарий');
    const attrCardText       = findAttr('Текст открытки');

    let attributesPayload = [];

    function pushStringAttr(attrRow, valueStr, allowedTypes = ['string', 'text']) {
        if (!attrRow) return;
        const t = String(attrRow.type || '').toLowerCase();
        if (!allowedTypes.includes(t)) return;

        const v = String(valueStr || '').trim();
        if (!v) return;

        attributesPayload.push({
            meta: metaOrNull(attrRow.meta, 'attributemetadata'),
            value: v
        });
    }

    async function pushCounterpartyAttr(attrRow, fullName, phone) {
        if (!attrRow) return;
        const t = String(attrRow.type || '').toLowerCase();
        if (t !== 'counterparty') return;

        const fio = String(fullName || '').trim();
        if (!fio) return;

        const cpMeta = await getOrCreateCounterpartyMeta(fio, String(phone || '').trim());
        attributesPayload.push({
            meta: metaOrNull(attrRow.meta, 'attributemetadata'),
            value: { meta: metaOrNull(cpMeta, 'counterparty') }
        });
    }

    async function pushCustomEntityAttr(attrRow, valueName) {
        if (!attrRow) return;
        const t = String(attrRow.type || '').toLowerCase();
        if (t !== 'customentity') return;

        const name = String(valueName || '').trim();
        if (!name) return;

        const valueMeta = await getOrCreateCustomEntityValueMeta(attrRow, name);
        if (!valueMeta) return;

        attributesPayload.push({
            meta: metaOrNull(attrRow.meta, 'attributemetadata'),
            value: { meta: metaOrNull(valueMeta, 'customentity') }
        });
    }

    // Время доставки: если атрибут customentity — создаём/находим значение, если string/text — кладем строкой
    if (attrDeliveryTime) {
        const t = String(attrDeliveryTime.type || '').toLowerCase();
        if (t === 'customentity') await pushCustomEntityAttr(attrDeliveryTime, deliveryTimeAttrValue);
        else if (t === 'string') pushStringAttr(attrDeliveryTime, deliveryTimeAttrValue, ['string']);
        else if (t === 'text') pushStringAttr(attrDeliveryTime, deliveryTimeAttrValue, ['text', 'string']);
    }

    const recipientFullName = String(order.recipientFullName || order.fullName || '').trim();
    const recipientPhone = String(order.recipientPhone || order.phone || '').trim();

    await pushCounterpartyAttr(attrRecipientFio, recipientFullName, recipientPhone || order.phone);

    if (attrRecipientPhone) {
        const t = String(attrRecipientPhone.type || '').toLowerCase();
        if (t === 'customentity') await pushCustomEntityAttr(attrRecipientPhone, recipientPhone);
        else if (t === 'string') pushStringAttr(attrRecipientPhone, recipientPhone, ['string']);
        else if (t === 'text') pushStringAttr(attrRecipientPhone, recipientPhone, ['text', 'string']);
    }

    const floristComment = String(order.floristComment || '').trim();
    const cardText = String(order.cardText || '').trim();

    if (attrComment) {
        const t = String(attrComment.type || '').toLowerCase();
        if (t === 'string') pushStringAttr(attrComment, floristComment, ['string']);
        else if (t === 'text') pushStringAttr(attrComment, floristComment, ['text', 'string']);
        else if (t === 'customentity') await pushCustomEntityAttr(attrComment, floristComment);
    }

    if (attrCardText) {
        const t = String(attrCardText.type || '').toLowerCase();
        if (t === 'text' || t === 'string') pushStringAttr(attrCardText, cardText, ['text', 'string']);
        else if (t === 'customentity') await pushCustomEntityAttr(attrCardText, cardText);
    }

    // стандартное поле description оставляем как раньше: туда — комментарий флористу (если задан)
    let description = '';
    if (floristComment) description = floristComment;

    // чистим атрибуты от битых meta
    attributesPayload = attributesPayload.filter(a => a?.meta && a.meta.type && a.meta.href);
    for (const a of attributesPayload) {
        if (a.value && a.value.meta && (!a.value.meta.type || !a.value.meta.href)) delete a.value;
    }

    const payload = {
        vatEnabled: false,
        positions,
        organization: { meta: metaOrNull(organizationMeta, 'organization') },
        agent: { meta: metaOrNull(agentMeta, 'counterparty') },
        shipmentAddress,
        ...(description ? { description } : {}),
        ...(attributesPayload.length ? { attributes: attributesPayload } : {})
    };

    // <-- ВАЖНО: ставим "План дата отгрузки" (deliveryPlannedMoment) только если это доставка и всё валидно
    // План дата отгрузки:
// - доставка: ставим дату+время начала интервала
// - самовывоз: ЯВНО чистим поле, иначе MS оставит старое значение
    if (deliveryPlannedMoment) {
        payload.deliveryPlannedMoment = deliveryPlannedMoment;
    } else {
        payload.deliveryPlannedMoment = null;
    }


    // salesChannel — как у тебя сейчас
    const salesChannelMeta = await getOrCreateSalesChannelMeta();
    if (
        salesChannelMeta &&
        typeof salesChannelMeta === 'object' &&
        salesChannelMeta.href &&
        salesChannelMeta.type === 'saleschannel'
    ) {
        payload.salesChannel = {
            meta: {
                href: salesChannelMeta.href,
                type: 'saleschannel',
                mediaType: 'application/json'
            }
        };
    }

    const msOrderId = existing?.ms_id || null;

    // диагностика + чистка (оставляем как у тебя)
    logMissingMetaTypesStrict(payload, 'customerorder.payload(before-clean)');
    dropInvalidMeta(payload);
    deepDropInvalidMeta(payload);
    logMissingMetaTypesStrict(payload, 'customerorder.payload(after-clean)');

    let upsertResult = await upsertCustomerOrderHttp(ms, {
        msOrderId,
        payload
    });

    if (upsertResult.outcome === 'stale_put') {
        const msOrder = await recoverStaleCustomerOrderAfterPutNotFound(
            {
                orderId: order.id,
                staleMsId: upsertResult.staleMsOrderId,
                staleMsName: existing?.ms_name || null,
                payload,
                createPayment,
                statusCode: upsertResult.statusCode,
                msErrorCode: upsertResult.msErrorCode
            }
        );
        upsertResult = {
            outcome: 'created_after_stale',
            msOrder,
            staleMsOrderId: upsertResult.staleMsOrderId
        };
    }

    if (upsertResult.outcome === 'updated') {
        const effectiveMsId = upsertResult.msOrderId;
        console.log('[MoySklad] Order updated, ms_id =', effectiveMsId);

        if (createPayment) {
            const sumToPay = Number.isFinite(Number(paidSumKopecks)) ? Number(paidSumKopecks) : 0;
            if (sumToPay <= 0) return;

            const paymentPayload = {
                moment: formatMsDateTime(),
                organization: { meta: metaOrNull(organizationMeta, 'organization') },
                agent: { meta: metaOrNull(agentMeta, 'counterparty') },
                sum: sumToPay,
                operations: [
                    {
                        meta: {
                            href: `${MS_BASE_URL}/entity/customerorder/${effectiveMsId}`,
                            type: 'customerorder',
                            mediaType: 'application/json'
                        }
                    }
                ]
            };

            console.log('[MoySklad] Creating PaymentIn, sum =', sumToPay);
            await ms.post('/entity/paymentin', paymentPayload);
            await markCustomerOrderPaid(effectiveMsId);
        }

        return;
    }

    const msOrder = upsertResult.msOrder;
    const newId = msOrder.id;
    const msName = msOrder.name || msOrder.number || null;

    db.run(
        'UPDATE orders SET ms_id = ?, ms_name = ? WHERE id = ?',
        [newId, msName, order.id],
        err => err && console.error('Cannot save ms_id/ms_name for order', err)
    );

    if (upsertResult.outcome === 'created') {
        console.log('[MoySklad] Order created, ms_id =', newId);
    }

    if (createPayment) {
        const sumToPay = Number.isFinite(Number(paidSumKopecks)) ? Number(paidSumKopecks) : 0;
        if (sumToPay > 0) {
            const paymentPayload = {
                moment: formatMsDateTime(),
                organization: { meta: metaOrNull(organizationMeta, 'organization') },
                agent: { meta: metaOrNull(agentMeta, 'counterparty') },
                sum: sumToPay,
                operations: [
                    {
                        meta: {
                            href: `${MS_BASE_URL}/entity/customerorder/${newId}`,
                            type: 'customerorder',
                            mediaType: 'application/json'
                        }
                    }
                ]
            };

            console.log('[MoySklad] Creating PaymentIn, sum =', sumToPay);
            await ms.post('/entity/paymentin', paymentPayload);
            await markCustomerOrderPaid(newId);
        }
    }
}







let _cachedCustomerOrderAttrs = null;

async function getCustomerOrderAttributeMetaByName(attrName) {
    const res = await ms.get('/entity/customerorder/metadata');
    const attrs = res.data?.attributes || [];

    const target = String(attrName || '').trim().toLowerCase();

    const found = attrs.find(a => String(a?.name || '').trim().toLowerCase() === target);
    return found?.meta || null;
}




async function syncOrderStatusesFromMoySkladForUser(telegramId) {
    if (!MOYSKLAD_TOKEN) {
        throw new Error('MOYSKLAD_TOKEN is not set');
    }

    const rows = await new Promise((resolve, reject) => {
        db.all(
            'SELECT id, ms_id FROM orders WHERE telegram_id = ? AND ms_id IS NOT NULL',
            [telegramId],
            (err, rows) => (err ? reject(err) : resolve(rows))
        );
    });

    for (const row of rows) {
        try {
            const res = await ms.get(`/entity/customerorder/${row.ms_id}`, {
                params: { expand: 'state' }
            });

            const msOrder = res.data;
            let msStateName = 'Создан';
            if (msOrder.state && msOrder.state.name) {
                msStateName = String(msOrder.state.name);
            }

            // Не трогаем orders.status — там платёжный жизненный цикл (T-Bank / checkout).
            // Стадия заказа в МС хранится отдельно (см. backend/ORDER_STATUS_MODEL.md).
            db.run(
                'UPDATE orders SET ms_state_name = ? WHERE id = ?',
                [msStateName, row.id],
                err => {
                    if (err)
                        console.error(
                            'Error updating ms_state_name from MS:',
                            err
                        );
                }
            );
        } catch (err) {
            console.error(
                `[MoySklad] Error getting status for order ms_id=${row.ms_id}:`,
                err.response?.data || err.message
            );
        }
    }
}

// сырой запрос к отчету остатков (1 страница для начала)
async function getRawStockReportPage(limit = 100) {
    const res = await ms.get(`/report/stock/all`, {
        params: {
            limit,
            expand: 'assortment'
        }
    });
    return res.data; // тут и meta, и rows
}

async function downloadImageByUuid(uuid) {
    // В МойСклад download обычно по /download/<uuid>
    // Мы проксируем это с Bearer токеном
    const res = await ms.get(`/download/${uuid}`, {
        responseType: 'stream'
    });

    return {
        stream: res.data,
        contentType: res.headers['content-type'] || 'image/jpeg'
    };
}

async function fetchImageBuffer(uuid) {
    const url = `${MS_BASE_URL}/download/${uuid}`;

    const r = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            Authorization: `Bearer ${MOYSKLAD_TOKEN}`,
            Accept: '*/*'
        }
    });

    return {
        data: r.data,
        contentType: r.headers['content-type'] || 'image/jpeg'
    };
}

/**
 * DEBUG: получить и вывести полный JSON заказа из МойСклад
 * @param {string} msOrderId - UUID заказа в МойСклад
 */
async function debugGetMsCustomerOrder(msOrderId) {
    if (!msOrderId) {
        console.warn('[MoySklad][DEBUG] msOrderId is empty');
        return null;
    }

    const res = await ms.get(`/entity/customerorder/${msOrderId}`);

    console.log('========== MOYSKLAD CUSTOMER ORDER ==========');
    console.log(JSON.stringify(res.data, null, 2));
    console.log('============================================');

    return res.data;
}

async function fetchCustomerOrderAttributesFromMetadata(metadata) {
    const raw = metadata?.attributes;

    // 1) Иногда сразу массив
    if (Array.isArray(raw)) return raw;

    // 2) Иногда { rows: [...] }
    if (raw && Array.isArray(raw.rows)) return raw.rows;

    // 3) Частый кейс: attributes = { meta: { href: ".../metadata/attributes" } }
    const href = raw?.meta?.href || raw?.href || null;
    if (href) {
        // ms у тебя уже с baseURL, но href может быть абсолютным.
        // axios умеет абсолютный URL — но через ms удобнее относительный.
        const url = href.replace(/^https?:\/\/api\.moysklad\.ru\/api\/remap\/1\.2/, '');
        const res = await ms.get(url);
        return res.data?.rows || [];
    }

    return [];
}

async function debugListCustomerOrderAttributes() {
    const res = await ms.get('/entity/customerorder/metadata');
    const meta = res.data || {};

    console.log('====== CUSTOMERORDER METADATA KEYS ======');
    console.log(Object.keys(meta));
    console.log('========================================');

    console.log('====== RAW metadata.attributes (object) ======');
    console.log(JSON.stringify(meta.attributes, null, 2));
    console.log('=============================================');

    let attrs = [];
    try {
        attrs = await fetchCustomerOrderAttributesFromMetadata(meta);
    } catch (e) {
        console.error('[MoySklad][DEBUG] cannot fetch attributes list:', e.response?.data || e.message);
        attrs = [];
    }

    console.log('====== CUSTOMERORDER ATTRIBUTES (metadata) ======');
    console.log('count:', attrs.length);

    for (const a of attrs) {
        console.log(JSON.stringify({
            id: a.id,
            name: a.name,
            type: a.type,
            required: a.required,
            metaHref: a.meta?.href
        }, null, 2));
    }
    console.log('=================================================');

    return attrs;
}



function normalizeMetadataAttributes(metaData) {
    const raw = metaData?.attributes;

    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.rows)) return raw.rows;

    // иногда атрибуты лежат по другому ключу/пустые
    return [];
}



/**
 * Проверка ссылок orders.ms_id на существование customerorder в МойСклад (диагностика «битых» id).
 * @param {{ limit?: number }} [opts]
 */
async function scanStaleMsOrderLinks(opts = {}) {
    if (!MOYSKLAD_TOKEN) {
        return { ok: false, error: 'MOYSKLAD_TOKEN_NOT_CONFIGURED' };
    }

    const lim = Math.min(500, Math.max(1, Number(opts.limit) || 50));

    const rows = await new Promise((resolve, reject) => {
        db.all(
            `
            SELECT id, ms_id, ms_name, status
            FROM orders
            WHERE ms_id IS NOT NULL AND TRIM(ms_id) != ''
            ORDER BY id DESC
            LIMIT ?
            `,
            [lim],
            (err, r) => (err ? reject(err) : resolve(r || []))
        );
    });

    const stale = [];
    const foundOk = [];
    const probeErrors = [];

    for (const row of rows) {
        const msId = String(row.ms_id || '').trim();
        if (!msId) continue;

        try {
            await ms.get(`/entity/customerorder/${msId}`);
            foundOk.push({ id: row.id, ms_id: msId });
        } catch (e) {
            if (isStaleCustomerOrderNotFoundError(e)) {
                const errs = e && e.response && e.response.data && e.response.data.errors;
                const c1021 = Array.isArray(errs) && errs.some(x => Number(x && x.code) === 1021);
                stale.push({
                    id: row.id,
                    ms_id: msId,
                    ms_name: row.ms_name || null,
                    local_status: row.status || null,
                    httpStatus: e && e.response && e.response.status,
                    msErrorCode: c1021 ? 1021 : e && e.response && e.response.status === 404 ? 404 : null
                });
            } else {
                probeErrors.push({
                    id: row.id,
                    ms_id: msId,
                    httpStatus: e && e.response && e.response.status,
                    message: e && e.message ? e.message : String(e)
                });
            }
        }
    }

    return {
        ok: true,
        limit: lim,
        scanned: rows.length,
        staleCount: stale.length,
        stale,
        foundOkCount: foundOk.length,
        probeErrors
    };
}

module.exports = {
    syncProductsFromMoySklad,
    sendOrderToMoySklad,
    syncOrderStatusesFromMoySkladForUser,
    getRawStockReportPage,
    downloadImageByUuid,
    fetchImageBuffer,
    isStaleCustomerOrderNotFoundError,
    isStaleCustomerOrderMappingError,
    recoverStaleCustomerOrderAfterPutNotFound,
    resetLocalMsMappingAfterStaleCustomerOrder,
    scanStaleMsOrderLinks
};



