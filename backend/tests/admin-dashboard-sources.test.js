'use strict';

const assert = require('assert');
const { mergeDashboardSourcesForApi, DASHBOARD_SYSTEM_NONE_CODE } = require('../admin-dashboard-service');

let r = mergeDashboardSourcesForApi([{ code: 'tg_bot', clicks: 2 }], [], [{ code: 'tg_bot', title: 'Телеграмм бот' }]);
assert.strictEqual(r.length, 1, 'источник с переходами без заказов попадает в список');
assert.strictEqual(r[0].code, 'tg_bot');
assert.strictEqual(r[0].clicks, 2);
assert.strictEqual(r[0].ordersCount, 0);
assert.strictEqual(r[0].paidOrdersCount, 0);
assert.strictEqual(r[0].revenueKopecks, 0);
assert.strictEqual(r[0].isSystem, false);

r = mergeDashboardSourcesForApi(
    [],
    [{ code: DASHBOARD_SYSTEM_NONE_CODE, orders_count: 4, paid_orders_count: 1, revenue_kopecks: 350000 }],
    []
);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].code, DASHBOARD_SYSTEM_NONE_CODE);
assert.strictEqual(r[0].isSystem, true);
assert.strictEqual(r[0].ordersCount, 4);
assert.strictEqual(r[0].paidOrdersCount, 1);
assert.strictEqual(r[0].revenueKopecks, 350000);

r = mergeDashboardSourcesForApi(
    [
        { code: 'a', clicks: 100 },
        { code: 'b', clicks: 1 }
    ],
    [
        { code: 'a', orders_count: 1, paid_orders_count: 1, revenue_kopecks: 100 },
        { code: 'b', orders_count: 1, paid_orders_count: 1, revenue_kopecks: 500 }
    ],
    [
        { code: 'a', title: 'A' },
        { code: 'b', title: 'B' }
    ]
);
assert.strictEqual(r[0].code, 'b', 'сортировка: выше revenue первым');
assert.strictEqual(r[1].code, 'a');

r = mergeDashboardSourcesForApi([], [], [{ code: 'idle', title: 'Idle' }]);
assert.strictEqual(r.length, 0, 'источник без активности не показывается');

r = mergeDashboardSourcesForApi([], [], []);
assert.strictEqual(r.length, 0, 'полностью пустой ответ');

r = mergeDashboardSourcesForApi(
    [],
    [
        { code: 'low', orders_count: 0, paid_orders_count: 0, revenue_kopecks: 0 },
        { code: DASHBOARD_SYSTEM_NONE_CODE, orders_count: 0, paid_orders_count: 0, revenue_kopecks: 0 }
    ],
    []
);
assert.strictEqual(r.length, 0, '__none__ без заказов не добавляется');

process.stdout.write('PASS admin-dashboard sources merge\n');
