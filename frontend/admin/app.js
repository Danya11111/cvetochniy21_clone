const INIT_DATA_PARAM = 'tgWebAppData';
const UI_STATE_KEY = 'admin_mobile_ui_state_v1';
const SCREEN_IDS = [
    'dashboard',
    'promo',
    'orders',
    'clients_new',
    'clients_all',
    'client_card',
    'home',
    'actions',
    'clients',
    'client_detail',
    'broadcasts',
    'broadcast_detail',
    'more',
    'support',
    'analytics',
    'topics',
    'system'
];

/** Доступные из нижнего меню вкладки (Mini App v2). */
const BOTTOM_NAV_IDS = /** @type {const} */ ({ DASHBOARD: 'dashboard', PROMO: 'promo' });

const BOTTOM_NAV = [
    { id: BOTTOM_NAV_IDS.DASHBOARD, label: 'Дашборд' },
    { id: BOTTOM_NAV_IDS.PROMO, label: 'Продвижение' }
];

const SCREEN_META = {
    dashboard: { title: 'Админка', subtitle: '', nav: 'dashboard' },
    promo: { title: 'Продвижение', subtitle: 'Источники и кампании', nav: 'promo' },
    home: { title: 'Главная', subtitle: 'Сводка дня', nav: 'home' },
    actions: { title: 'Действия', subtitle: 'Приоритеты', nav: 'home' },
    orders: { title: 'Заказы', subtitle: '', nav: 'dashboard' },
    clients_new: { title: 'Новые клиенты', subtitle: '', nav: 'dashboard' },
    clients_all: { title: 'Все клиенты', subtitle: '', nav: 'dashboard' },
    client_card: { title: 'Клиент', subtitle: '', nav: 'dashboard' },
    clients: { title: 'Клиенты', subtitle: 'Сегменты и LTV', nav: 'clients' },
    client_detail: { title: 'Клиент', subtitle: 'Карточка', nav: 'clients' },
    broadcasts: { title: 'Рассылки', subtitle: 'Кампании', nav: 'broadcasts' },
    broadcast_detail: { title: 'Рассылка', subtitle: 'Детали кампании', nav: 'broadcasts' },
    more: { title: 'Ещё', subtitle: 'Поддержка и сервис', nav: 'more' },
    support: { title: 'Поддержка', subtitle: 'Очередь ответов', nav: 'more' },
    analytics: { title: 'Аналитика', subtitle: 'Срезы', nav: 'more' },
    topics: { title: 'Темы', subtitle: 'Темы клиентов', nav: 'more' },
    system: { title: 'Система', subtitle: 'Состояние', nav: 'more' }
};

/** Справка по метрикам дашборда v2 (тап для bottom-sheet на мобильных). */
const DASH_METRIC_HELP = {
    revenue: { title: 'Выручка', body: 'Сумма оплаченных заказов за выбранный период.' },
    orders_count: { title: 'Заказов', body: 'Количество всех созданных заказов за выбранный период.' },
    avg_check: { title: 'Ср. чек', body: 'Выручка за период, делённая на количество оплаченных заказов за этот период.' },
    new_clients: { title: 'Новые клиенты', body: 'Клиенты, у которых первый заказ попал в выбранный период.' },
    clients_total: { title: 'Все клиенты', body: 'Общее количество клиентов в базе (или оценка по заказам, если в базе пользователей пусто).' },
    cr: {
        title: 'CR',
        body: 'Прокси-конверсия: доля оплаченных заказов среди всех созданных заказов за выбранный период. Это не «визит → покупка».'
    },
    repeat_orders: {
        title: 'Повторные заказы',
        body: 'Доля заказов за период от клиентов, у которых больше одного заказа за всё время.'
    },
    avg_ltv: {
        title: 'Средний LTV',
        body: 'Средняя оплаченная выручка за всё время на одного платящего клиента (за всё время, не только за период).'
    },
    clients_block: {
        title: 'Клиенты',
        body: 'Текущее количество клиентов в базе (или оценка по уникальным telegram_id в заказах), как на сервере в метрике clientsTotal.'
    },
    response_time: {
        title: 'Скорость ответа',
        body: 'Среднее время до первого ответа менеджера по «окнам»: первое сообщение клиента в течение 2 часов после начала окна, затем первый ответ сотрудника.'
    },
    abandoned_carts: {
        title: 'Брошенные корзины',
        body: 'Пока не рассчитывается: серверных данных о брошенных корзинах нет.'
    },
    returns_cancel: {
        title: 'Возвраты / отмены после оплаты',
        body: 'Доля оплаченных заказов за период, которые завершились отменой или возвратом (по статусам в базе данных).'
    },
    top_products: {
        title: 'Топ популярных товаров',
        body: 'Товары с наибольшим количеством продаж в оплаченных заказах за выбранный период (разбор позиций items_json).'
    },
    order_sources: {
        title: 'Лучшие источники заказов',
        body: 'Пока не рассчитывается: источники заказов ещё не собираются.'
    }
};

function dashYmdFromDate(dt) {
    const d = dt instanceof Date ? dt : new Date(dt);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dashYmdAddDays(ymd, deltaDays) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim());
    if (!m) return dashYmdFromDate(new Date());
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    dt.setDate(dt.getDate() + Number(deltaDays || 0));
    return dashYmdFromDate(dt);
}

/** @returns {boolean} */
function dashIsValidYmd(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

function migrateDashboardDatesInState(saved) {
    const rx = /^\d{4}-\d{2}-\d{2}$/;
    if (state.dashboardPreset === 'all') {
        state.dashboardDateFrom = '2025-01-01';
        state.dashboardDateTo = dashYmdFromDate(new Date());
        return;
    }
    if (rx.test(state.dashboardDateFrom) && rx.test(state.dashboardDateTo)) return;
    const today = dashYmdFromDate(new Date());
    const legacy = saved && saved.dashboardPeriod === '7d' ? '7d' : 'today';
    if (legacy === '7d') {
        state.dashboardDateFrom = dashYmdAddDays(today, -6);
        state.dashboardDateTo = today;
        state.dashboardPreset = '7d';
    } else {
        state.dashboardDateFrom = today;
        state.dashboardDateTo = today;
        state.dashboardPreset = 'today';
    }
}

let telegramInitData = '';
let adminConfig = null;
let renderVersion = 0;
let pendingConfirmationHandler = null;
const inFlightActionKeys = new Set();

const state = {
    currentScreen: 'dashboard',
    dashboardDateFrom: '',
    dashboardDateTo: '',
    /** @type {'today'|'7d'|'all'|''} */
    dashboardPreset: 'today',
    dashboardRangeUiError: '',
    message: '',
    /** @type {'clients_new'|'clients_all'|''} */
    clientListReturnScreen: '',
    orderFilter: 'all',
    orderClientTelegramId: '',
    clientFilter: 'all',
    supportFilter: 'all',
    supportClientTelegramId: '',
    analyticsPeriod: '7d',
    broadcastsFilter: 'all',
    clientsQ: '',
    selectedClientId: '',
    selectedBroadcastId: '',
    clientDetailTab: 'orders',
    clientsContextFilter: 'all',
    clientsContextQ: '',
    broadcastsContextFilter: 'all',
    lastRefreshedAt: '',
    activePlaybook: null,
    playbooksSummary: null,
    confirmation: null,
    loading: false,
    orderDetails: {},
    clientDetails: {},
    clientV2DetailById: {},
    supportDetails: {},
    broadcastDetails: {},
    promoSourcesList: [],
    promoBroadcastsList: [],
    promoBotConfigured: false,
    promoExpandedSources: {},
    promoDetailByCode: {},
    promoExpandedBroadcasts: {},
    promoDetailById: {},
    promoFormSourceOpen: false,
    promoFormBroadcastOpen: false,
    promoFlash: '',
    ordersV2RangeLabel: ''
};

function loadUiState() {
    /** @type {Record<string, any>} */
    let saved = {};
    try {
        const raw = window.localStorage.getItem(UI_STATE_KEY);
        if (!raw) {
            migrateDashboardDatesInState(saved);
            return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            migrateDashboardDatesInState(saved);
            return;
        }
        saved = parsed;
        const keys = [
            'currentScreen',
            'dashboardDateFrom',
            'dashboardDateTo',
            'dashboardPreset',
            'clientListReturnScreen',
            'orderFilter',
            'orderClientTelegramId',
            'clientFilter',
            'supportFilter',
            'supportClientTelegramId',
            'analyticsPeriod',
            'broadcastsFilter',
            'clientsQ',
            'selectedClientId',
            'selectedBroadcastId',
            'clientDetailTab',
            'clientsContextFilter',
            'clientsContextQ',
            'broadcastsContextFilter',
            'activePlaybook'
        ];
        keys.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(saved, key)) {
                state[key] = saved[key];
            }
        });
    } catch (_) {}
    migrateDashboardDatesInState(saved);
}

function saveUiState() {
    try {
        const payload = {
            currentScreen: state.currentScreen,
            dashboardDateFrom: state.dashboardDateFrom,
            dashboardDateTo: state.dashboardDateTo,
            dashboardPreset: state.dashboardPreset,
            clientListReturnScreen: state.clientListReturnScreen,
            orderFilter: state.orderFilter,
            orderClientTelegramId: state.orderClientTelegramId,
            clientFilter: state.clientFilter,
            supportFilter: state.supportFilter,
            supportClientTelegramId: state.supportClientTelegramId,
            analyticsPeriod: state.analyticsPeriod,
            broadcastsFilter: state.broadcastsFilter,
            clientsQ: state.clientsQ,
            selectedClientId: state.selectedClientId,
            selectedBroadcastId: state.selectedBroadcastId,
            clientDetailTab: state.clientDetailTab,
            clientsContextFilter: state.clientsContextFilter,
            clientsContextQ: state.clientsContextQ,
            broadcastsContextFilter: state.broadcastsContextFilter,
            activePlaybook: state.activePlaybook
        };
        window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(payload));
    } catch (_) {}
}

function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function friendlyDashboardBadRange(detail) {
    const d = String(detail || '');
    if (d === 'RANGE_INVERTED') return 'Дата «С» позже, чем «По». Укажите корректный диапазон.';
    if (d === 'BAD_YMD') return 'Неверный формат даты. Используйте календарь.';
    if (d === 'RANGE_TOO_WIDE') return 'Диапазон не больше 366 дней.';
    return 'Некорректный диапазон дат.';
}

/** Runtime build id for telemetry (window + meta; must match server-injected HTML). */
function getF21AdminRuntimeBuild() {
    const fromWin = typeof window.__F21_BUILD__ !== 'undefined' ? String(window.__F21_BUILD__).trim() : '';
    let fromMeta = '';
    try {
        const meta = document.querySelector('meta[name="f21-admin-build"]');
        fromMeta = meta ? String(meta.getAttribute('content') || '').trim() : '';
    } catch (_) {}
    const raw = fromWin || fromMeta;
    if (!raw || raw === '__F21_BUILD__') {
        console.warn('[AdminClient] missing_build', { fromWin, fromMeta, tag: 'missing_build' });
        return 'missing_build';
    }
    if (fromWin && fromMeta && fromWin !== fromMeta) {
        console.warn('[AdminClient] build_mismatch', { window: fromWin, meta: fromMeta });
    }
    return raw.slice(0, 64);
}

const MONEY_MINOR_PER_MAJOR = 100;

/**
 * Единый форматтер денег для админки: на входе всегда целые копейки (контракт `/api/admin/*`).
 * Витрина и `orders.total` для пользователя — рубли; здесь не используем.
 */
function formatKopecksAsRub(kopecks) {
    const minor = Math.round(Number(kopecks || 0));
    if (!Number.isFinite(minor)) return `0 ₽`;
    const rub = minor / MONEY_MINOR_PER_MAJOR;
    const whole = minor % MONEY_MINOR_PER_MAJOR === 0;
    const n = whole ? Math.round(rub) : Math.round(rub * 100) / 100;
    return `${n.toLocaleString('ru-RU', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function formatNum(value) {
    return Math.round(Number(value || 0)).toLocaleString('ru-RU');
}

function formatDateTime(value) {
    if (!value) return '—';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value).replace('T', ' ').slice(0, 16);
    return dt.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatTime(value) {
    if (!value) return '—';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDaysAgo(days) {
    const n = Number(days);
    if (!Number.isFinite(n)) return 'нет заказов';
    if (n <= 0) return 'сегодня';
    if (n === 1) return '1 день назад';
    if (n < 5) return `${n} дня назад`;
    return `${n} дней назад`;
}

function valueTierLabel(valueTier) {
    if (valueTier === 'vip') return 'VIP-уровень';
    if (valueTier === 'high') return 'Высокая ценность';
    return 'Стандартная ценность';
}

function retentionStageLabel(stage) {
    if (stage === 'new') return 'Новый';
    if (stage === 'active') return 'Активный';
    if (stage === 'loyal') return 'Лояльный';
    if (stage === 'sleeping') return 'Спящий';
    if (stage === 'at_risk') return 'В зоне риска';
    return 'Активный';
}

function actionPriorityMeta(priority) {
    if (priority === 'critical') return { label: 'Критично', tone: 'alert' };
    if (priority === 'important') return { label: 'Важно', tone: 'warn' };
    return { label: 'Нормальный приоритет', tone: 'ok' };
}

function eventTypeLabel(type) {
    if (type === 'order') return 'Заказ';
    if (type === 'support') return 'Поддержка';
    if (type === 'broadcast') return 'Рассылка';
    return 'Событие';
}

function actionPriorityTone(priority) {
    if (priority === 'critical') return 'alert';
    if (priority === 'high') return 'warn';
    if (priority === 'medium') return 'info';
    return 'ok';
}

function actionPriorityLabel(priority) {
    if (priority === 'critical') return 'Критично';
    if (priority === 'high') return 'Высокий';
    if (priority === 'medium') return 'Средний';
    return 'Низкий';
}

function actionCategoryLabel(category) {
    if (category === 'revenue') return 'Деньги';
    if (category === 'retention') return 'Клиенты';
    if (category === 'marketing') return 'Рассылки';
    if (category === 'support') return 'Поддержка';
    if (category === 'operations') return 'Операции';
    if (category === 'growth') return 'Рост';
    return 'Действия';
}

function toneByDelta(delta) {
    const d = Number(delta || 0);
    if (d > 0) return 'ok';
    if (d < 0) return 'alert';
    return 'info';
}

function formatDelta(delta) {
    const d = Number(delta || 0);
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}%`;
}

function formatSignedPercent(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0%';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

function priorityMeta(priority) {
    if (priority === 'critical') return { label: 'Критично', tone: 'alert' };
    if (priority === 'important') return { label: 'Важно', tone: 'warn' };
    return { label: 'Наблюдать', tone: 'info' };
}

function playbookPriorityMeta(priority) {
    if (priority === 'high' || priority === 'critical') return { label: 'Высокий приоритет', tone: 'alert' };
    if (priority === 'important' || priority === 'medium') return { label: 'Важно', tone: 'warn' };
    return { label: 'Планово', tone: 'info' };
}

function playbookCategoryLabel(category) {
    if (category === 'retention') return 'Удержание';
    if (category === 'growth') return 'Рост';
    if (category === 'revenue') return 'Выручка';
    if (category === 'support') return 'Поддержка';
    return 'Сценарий';
}

function playbookSteps(playbookId) {
    if (playbookId === 'vip_return') {
        return [
            'Откройте первых клиентов в списке',
            'Проверьте последний заказ и паузу в покупках',
            'Перейдите в тему клиента',
            'Запустите персональный touch'
        ];
    }
    if (playbookId === 'second_order_push') {
        return [
            'Начните с клиентов с недавним первым заказом',
            'Откройте карточку клиента и оцените контекст',
            'Запустите follow-up через тему или рассылку',
            'Отметьте клиентов с явным потенциалом повтора'
        ];
    }
    if (playbookId === 'frozen_revenue_recovery') {
        return [
            'Начните с крупных неоплаченных заказов',
            'Проверьте срочные доставки',
            'Откройте карточку клиента для повторных заказов',
            'Зафиксируйте результат обработки'
        ];
    }
    if (playbookId === 'support_waiting_recovery') {
        return [
            'Сначала откройте критичные диалоги',
            'Приоритизируйте VIP и новые обращения',
            'Проверьте клиентов с недавним заказом',
            'Закройте риск потери первым ответом'
        ];
    }
    if (playbookId === 'repeat_strong_campaign') {
        return [
            'Откройте сильные кампании',
            'Проверьте доставляемость и блокировки',
            'Выберите лучшую основу для повтора',
            'Перейдите к следующему запуску'
        ];
    }
    if (playbookId === 'lost_reach_reduction') {
        return [
            'Откройте проблемные кампании',
            'Разберите ошибки и блокировки',
            'Проверьте сегмент и качество аудитории',
            'Подготовьте безопасный повтор'
        ];
    }
    if (playbookId === 'high_value_recover') {
        return [
            'Начните с клиентов с максимальным чеком',
            'Проверьте паузу и историю покупок',
            'Запустите персональный сценарий возврата',
            'Передайте в follow-up маркетингу'
        ];
    }
    return [
        'Откройте приоритетные элементы',
        'Проверьте контекст и риск',
        'Выполните ключевое действие',
        'Зафиксируйте результат'
    ];
}

function playbookRelatedActions(playbook) {
    const id = playbook && playbook.id ? playbook.id : '';
    if (id === 'vip_return' || id === 'high_value_recover') {
        return [
            { label: 'К рассылкам для возврата', action: { screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' } } },
            { label: 'Открыть клиентов', action: { screen: 'clients', filters: playbook.prefilled_filters || {} } }
        ];
    }
    if (id === 'second_order_push') {
        return [
            { label: 'Открыть сегмент', action: { screen: 'clients', filters: playbook.prefilled_filters || {} } },
            { label: 'Перейти к рассылкам', action: { screen: 'broadcasts', filters: { broadcastsFilter: 'all' } } }
        ];
    }
    if (id === 'frozen_revenue_recovery') {
        return [
            { label: 'Открыть неоплаченные', action: { screen: 'orders', filters: { orderFilter: 'unpaid' } } },
            { label: 'Открыть крупные', action: { screen: 'orders', filters: { orderFilter: 'large_unpaid' } } }
        ];
    }
    if (id === 'support_waiting_recovery' || id === 'post_support_retention') {
        return [
            { label: 'К критичным диалогам', action: { screen: 'support', filters: { supportFilter: 'critical' } } },
            { label: 'VIP без ответа', action: { screen: 'support', filters: { supportFilter: 'vip_waiting' } } }
        ];
    }
    if (id === 'repeat_strong_campaign' || id === 'lost_reach_reduction') {
        return [
            { label: 'Открыть кандидатов', action: { screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' } } },
            { label: 'Проблемные кампании', action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' } } }
        ];
    }
    return [{ label: 'Открыть целевой экран', action: { screen: playbook.suggested_target, filters: playbook.prefilled_filters || {} } }];
}

function createPlaybookIndex(rows) {
    const items = Array.isArray(rows) ? rows : [];
    const index = {};
    items.forEach((item) => {
        if (!item || !item.id) return;
        index[item.id] = item;
    });
    return index;
}

function renderPlaybookBanner(screenId) {
    const pb = state.activePlaybook;
    if (!pb || pb.suggested_target !== screenId) return '';
    const pr = playbookPriorityMeta(pb.priority);
    const steps = playbookSteps(pb.id);
    const related = playbookRelatedActions(pb).slice(0, 2);
    return `
        <article class="playbook-banner ${esc(pr.tone)}${screenId === 'home' ? ' playbook-banner--tight' : ''}">
            <div class="list-card-footer">
                <h3 class="list-card-title">Сценарий: ${esc(pb.title || 'Рабочий playbook')}</h3>
                ${statusBadge(pr.label, pr.tone)}
            </div>
            <p class="list-card-meta">${esc(pb.message || '')}</p>
            <p class="list-card-meta mt-2">Цель: ${esc(pb.business_goal || 'Сделать действие быстрее и точнее')}</p>
            <div class="order-meta-row">
                ${statusBadge(playbookCategoryLabel(pb.category), 'info')}
                ${pb.estimate_label ? statusBadge(pb.estimate_label, 'warn') : ''}
                ${pb.entry_source ? statusBadge(`Источник: ${pb.entry_source}`, 'ok') : ''}
            </div>
            <div class="playbook-steps">
                ${steps.map((line, idx) => `<div class="playbook-step"><span>${idx + 1}.</span><span>${esc(line)}</span></div>`).join('')}
            </div>
            <div class="playbook-banner-actions">
                ${related.map((item) => `<button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.label)}</button>`).join('')}
                <button class="secondary" data-action="playbook-dismiss">Скрыть сценарий</button>
                <button data-action="playbook-back-source">Назад к источнику</button>
            </div>
        </article>
    `;
}

function renderPlaybookCalmState(screenId) {
    const pb = state.activePlaybook;
    if (!pb || pb.suggested_target !== screenId) return '';
    return `
        <article class="state-card calm">
            <h3 class="list-card-title">Сценарий сейчас под контролем</h3>
            <p class="list-card-meta">По playbook "${esc(pb.title || 'Сценарий')}" сейчас нет элементов для обработки. Можно перейти к следующему шагу.</p>
            <div class="inline-actions mt-2">
                <button class="secondary" data-action="playbook-dismiss">Скрыть сценарий</button>
                <button data-action="playbook-back-source">Назад к источнику</button>
            </div>
        </article>
    `;
}

function applyPlaybookTarget(playbook) {
    if (!playbook) return;
    applyActionFilters(playbook.prefilled_filters || {});
}

async function launchPlaybook(playbookId, entrySource = '') {
    const summaryItems = createPlaybookIndex(state.playbooksSummary && state.playbooksSummary.playbooks);
    const base = summaryItems[playbookId] || null;
    if (!base) return;
    const next = {
        ...base,
        entry_source: entrySource || state.currentScreen || ''
    };
    if (!next.prefilled_filters) next.prefilled_filters = {};
    if (!next.prefilled_context) next.prefilled_context = {};
    next.prefilled_context = {
        ...(next.prefilled_context || {}),
        sourceScreen: state.currentScreen
    };
    state.activePlaybook = next;
    applyPlaybookTarget(next);
    saveUiState();
    navigateTo(next.suggested_target || 'dashboard');
}

function renderPlaybookCards({ source = '', target = '', limit = 4 } = {}) {
    const rows = Array.isArray(state.playbooksSummary && state.playbooksSummary.playbooks)
        ? state.playbooksSummary.playbooks
        : [];
    const filtered = rows
        .filter((row) => (target ? row.suggested_target === target : true))
        .slice(0, Math.max(1, Number(limit || 4)));
    if (!filtered.length) return '';
    return `
        <article class="list-card">
            <h3 class="list-card-title">Playbook execution light</h3>
            <p class="list-card-meta">Запускайте полуготовые сценарии и начинайте действие без лишних шагов.</p>
            <div class="playbook-card-list">
                ${filtered.map((row) => `
                    <article class="playbook-card ${esc(playbookPriorityMeta(row.priority).tone)}">
                        <div class="list-card-footer">
                            <strong>${esc(row.title || 'Сценарий')}</strong>
                            ${statusBadge(playbookCategoryLabel(row.category), 'info')}
                        </div>
                        <p class="list-card-meta">${esc(row.message || '')}</p>
                        ${row.estimate_label ? `<p class="list-card-meta mt-2">${esc(row.estimate_label)}</p>` : ''}
                        <button class="mt-2" data-action="launch-playbook" data-id="${esc(row.id)}" data-source="${esc(source || 'screen')}">${esc(row.cta_label || 'Запустить')}</button>
                    </article>
                `).join('')}
            </div>
        </article>
    `;
}

function inferPlaybookIdFromAction(action) {
    const title = String((action && action.title) || '').toLowerCase();
    const category = String((action && action.category) || '').toLowerCase();
    const targetScreen = String((action && action.target_screen) || '').toLowerCase();
    const filters = action && action.target_filters ? action.target_filters : {};

    if (title.includes('vip') || (category === 'retention' && String(filters.clientFilter || '') === 'return')) return 'vip_return';
    if (title.includes('втор') || title.includes('повтор')) return 'second_order_push';
    if (targetScreen === 'orders' && (String(filters.orderFilter || '') === 'unpaid' || title.includes('неоплач'))) return 'frozen_revenue_recovery';
    if (targetScreen === 'support' && (String(filters.supportFilter || '') === 'waiting' || String(filters.supportFilter || '') === 'critical')) return 'support_waiting_recovery';
    if (targetScreen === 'broadcasts' && (String(filters.broadcastsFilter || '') === 'repeatable')) return 'repeat_strong_campaign';
    if (targetScreen === 'broadcasts' && (String(filters.broadcastsFilter || '') === 'problematic' || String(filters.broadcastsFilter || '') === 'blocked' || String(filters.broadcastsFilter || '') === 'failed')) return 'lost_reach_reduction';
    if (targetScreen === 'clients' && String(filters.clientFilter || '') === 'sleeping') return 'high_value_recover';
    return '';
}

function encodeActionPayload(action) {
    if (!action) return '';
    try {
        return encodeURIComponent(JSON.stringify(action));
    } catch (_) {
        return '';
    }
}

function decodeActionPayload(value) {
    if (!value) return null;
    try {
        return JSON.parse(decodeURIComponent(value));
    } catch (_) {
        return null;
    }
}

function friendlyActionError(message) {
    const text = String(message || '').toUpperCase();
    /** До общего NOT_FOUND — иначе «PROMOTION_BROADCAST_NOT_FOUND» попадает под подстроку NOT_FOUND */
    if (text.includes('PROMOTION_BROADCAST_NOT_FOUND'))
        return 'Рассылка уже удалена или недоступна.';
    if (text.includes('NOT_FOUND')) return 'Не удалось найти нужные данные. Обновите экран и попробуйте снова.';
    if (text.includes('HTTP_401') || text.includes('HTTP_403')) return 'Недостаточно прав для этого действия.';
    if (text.includes('HTTP_5')) return 'Сервис временно недоступен. Повторите через минуту.';
    if (text.includes('PROMOTION_BROADCAST_DELETE_FAILED'))
        return 'Не удалось удалить рассылку. Попробуйте ещё раз.';
    if (text.includes('PROMOTION_SOURCE_DELETE_FAILED'))
        return 'Не удалось удалить источник. Попробуйте позже.';
    if (text.includes('ALREADY_PLACED')) return 'Эта карточка уже размещена в теме рассылок.';
    if (text.includes('BROADCAST_TOPIC_NOT_CONFIGURED'))
        return 'Тема рассылок в Telegram не настроена на сервере.';
    if (text.includes('BROADCASTS_DISABLED')) return 'Массовые рассылки отключены в конфигурации сервера.';
    if (text.includes('TELEGRAM_SEND_FAILED') || text.includes('CAMPAIGN_START_FAILED'))
        return 'Не удалось опубликовать в теме или запустить сценарий рассылки. Проверьте настройки бота.';
    if (text.includes('PROMOTION_BROADCAST_PLACE_FAILED'))
        return 'Не удалось разместить рассылку. Попробуйте ещё раз или проверьте журнал ошибок.';
    if (text.includes('TELEGRAM_BOT_USERNAME_REQUIRED')) return 'Не задан username бота для ссылок. Укажите TELEGRAM_BOT_USERNAME в настройках сервера.';
    return 'Не удалось выполнить действие. Попробуйте снова.';
}

function openConfirmationSheet(config, onConfirm) {
    state.confirmation = {
        title: String(config && config.title || 'Подтвердите действие'),
        message: String(config && config.message || ''),
        impact_summary: String(config && config.impact_summary || ''),
        severity: String(config && config.severity || 'normal'),
        confirm_label: String(config && config.confirm_label || 'Подтвердить'),
        cancel_label: String(config && config.cancel_label || 'Отмена'),
        secondary_note: String(config && config.secondary_note || ''),
        count_summary: String(config && config.count_summary || ''),
        irreversible_warning: Boolean(config && config.irreversible_warning),
        loading: false
    };
    pendingConfirmationHandler = typeof onConfirm === 'function' ? onConfirm : null;
}

function closeConfirmationSheet(force = false) {
    if (!force && state.confirmation && state.confirmation.loading) return;
    state.confirmation = null;
    pendingConfirmationHandler = null;
}

async function runGuardedAction(actionKey, handler) {
    const key = String(actionKey || '').trim();
    if (!key || typeof handler !== 'function') return;
    if (inFlightActionKeys.has(key)) return;
    inFlightActionKeys.add(key);
    try {
        await handler();
    } finally {
        inFlightActionKeys.delete(key);
    }
}

function isActionInFlight(actionKey) {
    return inFlightActionKeys.has(String(actionKey || '').trim());
}

function requiresPlaybookConfirm(playbookId) {
    return ['repeat_strong_campaign', 'lost_reach_reduction'].includes(String(playbookId || ''));
}

function renderConfirmationSheet() {
    const c = state.confirmation;
    if (!c) return '';
    const severity = String(c.severity || 'normal');
    return `
        <div class="confirm-overlay" data-action="confirm-cancel">
            <div class="confirm-sheet ${esc(severity)}" data-action="confirm-sheet" role="dialog" aria-modal="true" aria-label="${esc(c.title)}">
                <div class="confirm-sheet-handle"></div>
                <h3 class="confirm-title">${esc(c.title)}</h3>
                ${c.message ? `<p class="confirm-message">${esc(c.message)}</p>` : ''}
                ${c.impact_summary ? `<div class="confirm-impact">${esc(c.impact_summary)}</div>` : ''}
                ${c.count_summary ? `<div class="confirm-meta">${esc(c.count_summary)}</div>` : ''}
                ${c.secondary_note ? `<div class="confirm-meta">${esc(c.secondary_note)}</div>` : ''}
                ${c.irreversible_warning ? `<div class="confirm-warning">Действие может быть необратимым.</div>` : ''}
                <div class="confirm-actions">
                    <button class="secondary" data-action="confirm-cancel" ${c.loading ? 'disabled' : ''}>${esc(c.cancel_label || 'Отмена')}</button>
                    <button class="${severity === 'destructive' ? 'destructive' : ''}" data-action="confirm-submit" ${c.loading ? 'disabled' : ''}>
                        ${c.loading ? 'Выполняем…' : esc(c.confirm_label || 'Подтвердить')}
                    </button>
                </div>
            </div>
        </div>
    `;
}

function applyActionFilters(filters) {
    const next = filters || {};
    if (Object.prototype.hasOwnProperty.call(next, 'orderFilter')) state.orderFilter = String(next.orderFilter || 'all');
    if (Object.prototype.hasOwnProperty.call(next, 'orderClientTelegramId')) state.orderClientTelegramId = String(next.orderClientTelegramId || '');
    if (Object.prototype.hasOwnProperty.call(next, 'clientFilter')) state.clientFilter = String(next.clientFilter || 'all');
    if (Object.prototype.hasOwnProperty.call(next, 'broadcastsFilter')) state.broadcastsFilter = String(next.broadcastsFilter || 'all');
    if (Object.prototype.hasOwnProperty.call(next, 'supportFilter')) state.supportFilter = String(next.supportFilter || 'all');
    if (Object.prototype.hasOwnProperty.call(next, 'supportClientTelegramId')) state.supportClientTelegramId = String(next.supportClientTelegramId || '');
    if (Object.prototype.hasOwnProperty.call(next, 'analyticsPeriod')) state.analyticsPeriod = String(next.analyticsPeriod || '7d');
}

function isToday(value) {
    return String(value || '').slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function buildTopicLink(chatId, threadId) {
    const s = String(chatId || '');
    if (!s.startsWith('-100') || !threadId) return '';
    return `https://t.me/c/${s.slice(4)}/${Number(threadId)}`;
}

function resolveScreenFromHash() {
    const raw = String((location.hash || '').replace('#', '') || '').trim().toLowerCase();
    const candidate = raw || 'dashboard';
    if (SCREEN_IDS.includes(candidate)) {
        return candidate;
    }
    return BOTTOM_NAV_IDS.DASHBOARD;
}

function resolveStorefrontReturnPath() {
    try {
        const params = new URLSearchParams(location.search || '');
        const raw = String(params.get('returnTo') || '').trim();
        // Закрываем open-redirect: разрешаем только локальные относительные пути.
        if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/?tab=profile';
        return raw;
    } catch (_) {
        return '/?tab=profile';
    }
}

function isEmbeddedMode() {
    try {
        const params = new URLSearchParams(location.search || '');
        if (String(params.get('embedded') || '') === '1') return true;
    } catch (_) {}
    return window.self !== window.top;
}

function returnToStorefront() {
    const target = resolveStorefrontReturnPath();
    console.log('[AdminEmbedApp] return_to_storefront', { via: 'location_assign', target });
    window.location.assign(target || '/');
}

function navigateTo(screenId) {
    let next = String(screenId || '').trim().toLowerCase();
    if (!SCREEN_IDS.includes(next)) {
        next = BOTTOM_NAV_IDS.DASHBOARD;
    }
    if (location.hash !== `#${next}`) {
        saveUiState();
        location.hash = next;
        return;
    }
    state.currentScreen = next;
    saveUiState();
    renderApp();
}

function setViewportHeightVar() {
    document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
}

function initTelegramWebApp() {
    try {
        if (!window.Telegram || !window.Telegram.WebApp) return;
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();
        if (tg.setHeaderColor) tg.setHeaderColor('#5e7256');
        if (tg.setBackgroundColor) tg.setBackgroundColor('#f7f5f0');
        if (tg.setBottomBarColor) tg.setBottomBarColor('#f7f5f0');
    } catch (_) {}
}

async function api(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };
    if (telegramInitData) {
        headers['x-telegram-init-data'] = telegramInitData;
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        let message = data.error ? String(data.error) : `HTTP_${res.status}`;
        if (String(data.error) === 'DASHBOARD_V2_BAD_RANGE' && data.detail) {
            message = friendlyDashboardBadRange(data.detail);
        }
        /** @type {Error & { code?: string; detail?: string }} */
        const err = /** @type {any} */ (new Error(message));
        err.code = data.error != null ? String(data.error) : undefined;
        err.detail = data.detail != null ? String(data.detail) : undefined;
        throw err;
    }
    return data;
}

function resolveInitData() {
    try {
        if (typeof window.__F21_EMBEDDED_INIT_DATA === 'string' && window.__F21_EMBEDDED_INIT_DATA.length) {
            return String(window.__F21_EMBEDDED_INIT_DATA).trim();
        }
    } catch (_) {
        /* ignore */
    }
    const qs = new URLSearchParams(location.search);
    const fromQuery = qs.get(INIT_DATA_PARAM);
    if (fromQuery) {
        qs.delete(INIT_DATA_PARAM);
        const next = qs.toString();
        history.replaceState(null, '', `${location.pathname}${next ? `?${next}` : ''}${location.hash || ''}`);
        return String(fromQuery).trim();
    }
    try {
        if (window.Telegram && window.Telegram.WebApp) {
            return String(window.Telegram.WebApp.initData || '').trim();
        }
    } catch (_) {
        return '';
    }
    return '';
}

async function ensureAuth() {
    telegramInitData = resolveInitData();
    if (!telegramInitData) {
        throw new Error('Не найдены данные Telegram WebApp-сессии');
    }
    adminConfig = await api('/api/admin/config');
    try {
        await ensurePlaybooksSummary();
    } catch (_) {}
}

async function ensurePlaybooksSummary(force = false) {
    if (!force && state.playbooksSummary && Array.isArray(state.playbooksSummary.playbooks)) {
        return state.playbooksSummary;
    }
    const payload = (await api('/api/admin/playbooks/summary')).data || {};
    state.playbooksSummary = payload;
    return payload;
}

function statusBadge(text, tone = 'info') {
    return `<span class="status-badge ${esc(tone)}">${esc(text)}</span>`;
}

function sectionHeader(title, subtitle = '') {
    return `
        <div class="section-header">
            <div>
                <h2 class="section-title">${esc(title)}</h2>
                ${subtitle ? `<p class="section-subtitle">${esc(subtitle)}</p>` : ''}
            </div>
        </div>
    `;
}

function sectionKicker(text) {
    return `<p class="section-kicker">${esc(text)}</p>`;
}

function renderHomeSegmentFilters(quickActions) {
    const extras = (Array.isArray(quickActions) ? quickActions : []).slice(0, 2);
    const extraHtml = extras
        .map((a) => {
            const pl = a.action || { screen: 'home', filters: {} };
            const label = String(a.label || 'Ещё').trim().slice(0, 22);
            return `<button type="button" class="segment-pill segment-pill--secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(pl))}">${esc(label)}</button>`;
        })
        .join('');
    return `
        <nav class="home-segment-filters" aria-label="Быстрые фильтры">
            <button type="button" class="segment-pill" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: 'orders', filters: { orderFilter: 'unpaid' } }))}">Неоплаченные</button>
            <button type="button" class="segment-pill segment-pill--secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: 'support', filters: { supportFilter: 'waiting' } }))}">Без ответа</button>
            ${extraHtml}
        </nav>
    `;
}

function kpiCard(label, value, note = '') {
    return `
        <article class="card">
            <div class="kpi-label">${esc(label)}</div>
            <div class="kpi-value">${esc(value)}</div>
            ${note ? `<div class="kpi-note">${esc(note)}</div>` : ''}
        </article>
    `;
}

function bigKpiCard(label, value, note = '') {
    return `
        <article class="big-kpi-card">
            <div class="kpi-label">${esc(label)}</div>
            <div class="kpi-value">${esc(value)}</div>
            ${note ? `<div class="kpi-note">${esc(note)}</div>` : ''}
        </article>
    `;
}

function emptyState(title, message, actionLabel = '', actionScreen = '') {
    return `
        <article class="state-card empty">
            <h3 class="list-card-title">${esc(title)}</h3>
            <p class="list-card-meta">${esc(message)}</p>
            ${actionLabel ? `<button class="mt-2 secondary" data-go="${esc(actionScreen)}">${esc(actionLabel)}</button>` : ''}
        </article>
    `;
}

function calmState(title, message, actionLabel = '', actionScreen = '') {
    return `
        <article class="state-card calm">
            <h3 class="list-card-title">${esc(title)}</h3>
            <p class="list-card-meta">${esc(message)}</p>
            ${actionLabel ? `<button class="mt-2 secondary" data-go="${esc(actionScreen)}">${esc(actionLabel)}</button>` : ''}
        </article>
    `;
}

function errorState(message) {
    return `
        <article class="state-card error">
            <h3 class="list-card-title">Данные временно недоступны</h3>
            <p class="list-card-meta">${esc(message || 'Проверьте соединение и попробуйте снова')}</p>
            <button class="mt-2 secondary" data-action="reload-screen">Повторить</button>
        </article>
    `;
}

function renderDashboardMetricHelpSheet() {
    return `
        <div id="f21-dashboard-metric-help" class="metric-help" hidden aria-hidden="true">
            <button type="button" class="metric-help__backdrop" data-action="dash-tip-close" aria-label="Закрыть справку"></button>
            <div class="metric-help__sheet" role="dialog" aria-modal="true" aria-labelledby="f21-dashboard-metric-help-title">
                <h2 id="f21-dashboard-metric-help-title" class="metric-help__title"></h2>
                <p id="f21-dashboard-metric-help-body" class="metric-help__body"></p>
                <button type="button" class="metric-help__done" data-action="dash-tip-close">Понятно</button>
            </div>
        </div>
    `;
}

function openDashboardMetricHelp(tipId) {
    const cfg = DASH_METRIC_HELP[String(tipId || '')];
    if (!cfg) return;
    const root = document.getElementById('f21-dashboard-metric-help');
    const tEl = document.getElementById('f21-dashboard-metric-help-title');
    const bEl = document.getElementById('f21-dashboard-metric-help-body');
    if (!root || !tEl || !bEl) return;
    tEl.textContent = cfg.title;
    bEl.textContent = cfg.body;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
}

function closeDashboardMetricHelp() {
    const root = document.getElementById('f21-dashboard-metric-help');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
}

function loadingSkeleton() {
    return `
        <div class="screen screen-enter">
            <article class="skeleton-card hero"></article>
            <article class="skeleton-card"></article>
            <article class="skeleton-card lines"></article>
            <article class="skeleton-card lines"></article>
        </div>
    `;
}

function compactChartCard(rows, title, valueKey = 'value') {
    const max = Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1);
    const bars = rows.map((row) => {
        const h = Math.max(6, Math.round((Number(row[valueKey] || 0) / max) * 100));
        return `<div class="chart-bar" style="height:${h}%"></div>`;
    }).join('');
    const labels = rows.map((row) => `<div>${esc(String(row.day || '').slice(5))}</div>`).join('');
    return `
        <article class="chart-card">
            <div class="kpi-label">${esc(title)}</div>
            <div class="chart-bars">${bars}</div>
            <div class="chart-labels">${labels}</div>
        </article>
    `;
}

function renderShell(contentHtml) {
    const meta = SCREEN_META[state.currentScreen] || SCREEN_META.home;
    const adminName = adminConfig && adminConfig.admin ? `${adminConfig.admin.name} · ${adminConfig.admin.adminId}` : '';
    const navBase = meta.nav;
    const isDetailLike =
        state.currentScreen === 'client_detail' ||
        state.currentScreen === 'broadcast_detail' ||
        state.currentScreen === 'client_card';
    let headerBackAction = '';
    if (state.currentScreen === 'client_detail') headerBackAction = 'client-back';
    else if (state.currentScreen === 'broadcast_detail') headerBackAction = 'broadcast-back';
    else if (state.currentScreen === 'client_card') headerBackAction = 'client-card-back';
    else if (state.currentScreen === 'clients_new' || state.currentScreen === 'clients_all') headerBackAction = 'mini-stack-back';
    else if (state.currentScreen === 'orders') headerBackAction = 'orders-back';
    /** Вторую кнопку шапки не подписываем «Назад», если уже есть возврат по стеку (иначе две «Назад»). */
    const headerStorefrontLabel = isDetailLike || headerBackAction ? 'К витрине' : 'Назад';
    let contextHint = '';
    if (state.currentScreen === 'orders') {
        contextHint = String(state.ordersV2RangeLabel || '').trim() || 'Заказы за период дашборда';
    } else if (state.currentScreen === 'clients') {
        contextHint = state.clientFilter === 'all' ? 'Все клиенты' : `Сегмент: ${state.clientFilter}`;
    } else if (state.currentScreen === 'broadcasts') {
        contextHint = state.broadcastsFilter === 'all' ? 'Все кампании' : `Срез: ${state.broadcastsFilter}`;
    } else if (state.currentScreen === 'support') {
        contextHint = state.supportFilter === 'all' ? 'Все диалоги' : `Срез: ${state.supportFilter}`;
    } else if (state.currentScreen === 'analytics') {
        contextHint = `Период: ${state.analyticsPeriod}`;
    }
    const refreshedAtLabel = formatTime(state.lastRefreshedAt || new Date().toISOString());
    return `
        <main class="admin-shell admin-app-shell">
            <header class="admin-compact-header" role="banner">
                <div class="admin-compact-header__bar">
                    <div class="admin-compact-header__lead">
                        <h1 class="admin-compact-header__title">${esc(meta.title)}</h1>
                        ${meta.subtitle ? `<p class="admin-compact-header__subtitle">${esc(meta.subtitle)}</p>` : ''}
                    </div>
                    <div class="admin-compact-header__toolbar" role="toolbar" aria-label="Действия шапки">
                        ${headerBackAction ? `<button type="button" class="header-action header-action--ghost header-action--sm" data-action="${esc(headerBackAction)}">Назад</button>` : ''}
                        <button type="button" class="header-action header-action--ghost header-action--sm" data-action="open-storefront">${esc(headerStorefrontLabel)}</button>
                        <button type="button" class="header-action header-action--primary header-action--icon" data-action="reload-screen" title="Обновить" aria-label="Обновить данные">
                            <span class="header-action__glyph" aria-hidden="true">↻</span>
                        </button>
                    </div>
                </div>
                <div class="admin-compact-header__session" aria-label="Сессия">
                    <span class="admin-compact-header__admin">${esc(adminName)}</span>
                    <span class="admin-compact-header__fresh">· ${esc(refreshedAtLabel)}</span>
                </div>
                ${contextHint ? `<p class="admin-compact-header__context">${esc(contextHint)}</p>` : ''}
            </header>
            <section id="screenContent" class="screen screen-enter admin-screen-content">${contentHtml}</section>
            <nav class="bottom-nav" aria-label="Основные разделы">
                ${BOTTOM_NAV.map((item) => `
                    <button type="button" class="bottom-nav-item ${navBase === item.id ? 'active' : ''}" data-go="${esc(item.id)}">
                        <span class="bottom-nav-item__label">${esc(item.label)}</span>
                    </button>
                `).join('')}
            </nav>
            ${renderConfirmationSheet()}
            ${renderDashboardMetricHelpSheet()}
        </main>
    `;
}

function getBroadcastTone(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'DONE') return 'ok';
    if (s === 'FAILED' || s === 'DELETED') return 'alert';
    return 'warn';
}

function broadcastHealthLabel(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'healthy') return 'Канал стабилен';
    if (v === 'problematic') return 'Есть риски канала';
    if (v === 'running') return 'Кампания выполняется';
    return 'Рабочий диапазон';
}

function broadcastTierLabel(value) {
    const v = String(value || '').toLowerCase();
    if (v === 'successful') return 'Сильная';
    if (v === 'repeatable') return 'Перспективная';
    if (v === 'problematic') return 'Проблемная';
    if (v === 'running') return 'В процессе';
    if (v === 'deleted') return 'Удалена';
    if (v === 'completed') return 'Завершена';
    return 'Нейтральная';
}

function repeatabilityTone(status) {
    if (status === 'repeat') return 'ok';
    if (status === 'do_not_repeat') return 'alert';
    return 'warn';
}

function repeatabilityLabel(status) {
    if (status === 'repeat') return 'Стоит повторить';
    if (status === 'do_not_repeat') return 'Лучше не повторять';
    return 'Можно доработать и повторить';
}

function insightTone(tone) {
    if (tone === 'alert') return 'alert';
    if (tone === 'warn') return 'warn';
    if (tone === 'ok') return 'ok';
    return 'info';
}

/**
 * Отображение долей без лишних нулей.
 */
function dashboardFormatPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    const r = Math.round(n * 10) / 10;
    if (Math.abs(r - Math.round(r)) < 1e-9) return String(Math.round(r));
    return r.toFixed(1);
}

function buildDashboardV2RequestPath() {
    if (state.dashboardPreset === 'all') {
        return '/api/admin/dashboard-v2?period=all';
    }
    const f = String(state.dashboardDateFrom || '').trim();
    const t = String(state.dashboardDateTo || '').trim();
    return `/api/admin/dashboard-v2?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`;
}

function buildOrdersV2RequestPath() {
    if (state.dashboardPreset === 'all') {
        return '/api/admin/orders-v2?period=all';
    }
    const f = String(state.dashboardDateFrom || '').trim();
    const t = String(state.dashboardDateTo || '').trim();
    return `/api/admin/orders-v2?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`;
}

function buildClientsNewV2RequestPath() {
    if (state.dashboardPreset === 'all') {
        return '/api/admin/clients-v2?kind=new&period=all';
    }
    const f = String(state.dashboardDateFrom || '').trim();
    const t = String(state.dashboardDateTo || '').trim();
    return `/api/admin/clients-v2?kind=new&from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`;
}

function renderMiniMetricCell(label, value, danger = false, tipId = '', navAction = '') {
    const dm = danger ? ' dashboard-v2__metric-cell--danger' : '';
    const tap = navAction ? ' dashboard-v2__metric-cell--tap' : '';
    const val = typeof value === 'string' ? value : esc(String(value ?? ''));
    if (navAction) {
        return `
        <button type="button" class="dashboard-v2__metric-cell${dm}${tap}" data-action="${esc(navAction)}" aria-label="${esc(`${label}, открыть`)}">
            <span class="dashboard-v2__metric-label">${esc(label)}</span>
            <span class="dashboard-v2__metric-value">${val}</span>
        </button>`;
    }
    const tipAttr = tipId ? ` data-action="dash-tip" data-tip-id="${esc(tipId)}"` : '';
    return `
        <button type="button" class="dashboard-v2__metric-cell${dm}"${tipAttr} aria-label="${esc(`${label}, справка`)}">
            <span class="dashboard-v2__metric-label">${esc(label)}</span>
            <span class="dashboard-v2__metric-value">${val}</span>
        </button>`;
}

function renderDashMetricRow(labelLeft, strongInnerHtml, danger, tipId) {
    const d = danger ? ' dashboard-v2__dash-row--danger' : '';
    return `
        <button type="button" class="dashboard-v2__dash-row${d}" data-action="dash-tip" data-tip-id="${esc(tipId)}">
            <span>${esc(labelLeft)}</span><strong>${strongInnerHtml}</strong>
        </button>`;
}

async function renderDashboardV2Screen() {
    migrateDashboardDatesInState({});
    const df = String(state.dashboardDateFrom || '').trim();
    const dt = String(state.dashboardDateTo || '').trim();

    let payload;
    try {
        payload = (await api(buildDashboardV2RequestPath())).data;
    } catch (e) {
        return errorState(e.message || 'Не удалось загрузить дашборд');
    }
    state.dashboardRangeUiError = '';

    const range = payload.range || {};
    /** @type {Record<string, any>} */
    const m = payload.metrics || {};
    const topProducts = Array.isArray(payload.topProducts) ? payload.topProducts : [];

    const speedMinutes = m.avgFirstResponseMinutes;
    const speedIsNum = typeof speedMinutes === 'number' && Number.isFinite(speedMinutes);
    const speedDanger = speedIsNum && speedMinutes > 12;
    const speedSuffix = speedDanger ? ' — выше нормы' : '';
    const speedText = speedIsNum ? `${Math.round(speedMinutes)} мин${speedSuffix}` : 'нет данных';

    const cancelPctRaw = m.paidCancelledPercent;
    const cancelIsNum = typeof cancelPctRaw === 'number' && Number.isFinite(cancelPctRaw);
    const cancelDanger = cancelIsNum && cancelPctRaw > 7;
    const cancelSuffix = cancelDanger ? ' — выше нормы' : '';
    const cancelText = cancelIsNum ? `${dashboardFormatPct(cancelPctRaw)}%${cancelSuffix}` : 'нет данных';

    /*
     * Proxy CR: paid_orders_count / orders_count · 100 за период (не конверсия «визит → покупка»).
     * Источник и определение — см. backend/admin-dashboard-service.js.
     */
    const crLine = dashboardFormatPct(m.crPercent);

    const topCarouselInner =
        topProducts.length === 0
            ? `<div class="dashboard-v2__empty-soft">Нет данных по товарам за период</div>`
            : `<div class="dashboard-v2__top-carousel" role="list">${topProducts
                  .map((row) => {
                      const name = row != null && row.name != null ? String(row.name).trim() : '';
                      const dispName = name || 'Товар';
                      const qty = Math.round(Number(row && row.quantity) || 0);
                      const img = String((row && (row.image_url || row.imageUrl)) || '').trim();
                      const imgBlock = img
                          ? `<img class="dashboard-v2__top-card-img" src="${esc(img)}" alt="" loading="lazy" />`
                          : `<div class="dashboard-v2__top-card-img dashboard-v2__top-card-img--ph" aria-hidden="true"></div>`;
                      return `<div class="dashboard-v2__top-card" role="listitem">
                        ${imgBlock}
                        <div class="dashboard-v2__top-card-body">
                            <div class="dashboard-v2__top-card-name">${esc(dispName)}</div>
                            <div class="dashboard-v2__top-card-buy">Купили: ${formatNum(qty)}</div>
                        </div>
                    </div>`;
                  })
                  .join('')}</div>`;

    const presetToday = state.dashboardPreset === 'today';
    const preset7d = state.dashboardPreset === '7d';
    const presetAll = state.dashboardPreset === 'all';

    const uiErrBanner = state.dashboardRangeUiError
        ? `<div class="dashboard-v2__banner dashboard-v2__banner--warn" role="alert">${esc(state.dashboardRangeUiError)}</div>`
        : '';

    const revenueEscaped = esc(formatKopecksAsRub(m.revenueKopecks));

    const dashSources = Array.isArray(payload.sources) ? payload.sources : [];
    const sourcesBlockInner =
        dashSources.length === 0
            ? `<div class="dashboard-v2__dash-row dashboard-v2__dash-row--single"><strong>нет данных</strong></div>`
            : dashSources
                  .map((s) => {
                      const title = esc(String((s && s.title) || (s && s.code) || ''));
                      const clicks = formatNum(Number(s && s.clicks) || 0);
                      const ord = formatNum(Number(s && s.ordersCount) || 0);
                      const paid = formatNum(Number(s && s.paidOrdersCount) || 0);
                      const rev = esc(formatKopecksAsRub(Number(s && s.revenueKopecks) || 0));
                      const sys = s && (s.isSystem === true || s.code === '__none__');
                      if (sys) {
                          return `<div class="dashboard-v2__source-row dashboard-v2__source-row--system">
                <div class="dashboard-v2__source-name">${title}</div>
                <div class="dashboard-v2__source-meta">Заказов: ${ord} · Оплат: ${paid} · ${rev}</div>
            </div>`;
                      }
                      return `<div class="dashboard-v2__source-row">
                <div class="dashboard-v2__source-name">${title}</div>
                <div class="dashboard-v2__source-meta">Переходы: ${clicks} · Заказов: ${ord} · Оплат: ${paid} · ${rev}</div>
            </div>`;
                  })
                  .join('');

    return `
        <div class="dashboard-v2 screen-enter">
            ${uiErrBanner}
            <section class="dashboard-v2__section" aria-labelledby="dash-heading-main">
                <h2 id="dash-heading-main" class="dashboard-v2__headline">Основные показатели</h2>
                <div class="dashboard-v2__period-panel" aria-labelledby="dash-period-heading">
                    <p id="dash-period-heading" class="dashboard-v2__period-heading">Период</p>
                    <div class="dashboard-v2__period-segments dashboard-v2__period-segments--flexwrap" role="group" aria-label="Пресет периода">
                        <button type="button" class="dashboard-v2__period-chip ${presetToday ? 'dashboard-v2__period-chip--active' : ''}" data-action="dashboard-preset-today">Сегодня</button>
                        <button type="button" class="dashboard-v2__period-chip ${preset7d ? 'dashboard-v2__period-chip--active' : ''}" data-action="dashboard-preset-7d">7 дней</button>
                        <button type="button" class="dashboard-v2__period-chip ${presetAll ? 'dashboard-v2__period-chip--active' : ''}" data-action="dashboard-preset-all">За всё время</button>
                    </div>
                    <div class="dashboard-v2__period-custom">
                        <div class="dashboard-v2__period-dates-row">
                            <label class="dashboard-v2__period-date-cell">
                                <span class="dashboard-v2__period-date-micro">С</span>
                                <span class="dashboard-v2__period-date-shell">
                                    <input type="date" id="dash-date-from" name="dash-from" class="dashboard-v2__period-date-native" value="${esc(df)}" autocomplete="off" />
                                </span>
                            </label>
                            <span class="dashboard-v2__period-sep" aria-hidden="true">—</span>
                            <label class="dashboard-v2__period-date-cell">
                                <span class="dashboard-v2__period-date-micro">По</span>
                                <span class="dashboard-v2__period-date-shell">
                                    <input type="date" id="dash-date-to" name="dash-to" class="dashboard-v2__period-date-native" value="${esc(dt)}" autocomplete="off" />
                                </span>
                            </label>
                        </div>
                        <button type="button" class="dashboard-v2__period-apply" data-action="dashboard-apply-range">Применить</button>
                        <p class="dashboard-v2__period-hint">${esc(range.label || '—')}</p>
                    </div>
                </div>

                <button type="button" class="dashboard-v2__revenue-card" data-action="dash-tip" data-tip-id="revenue" aria-label="Выручка, справка">
                    <div class="dashboard-v2__revenue-label">ВЫРУЧКА</div>
                    <div class="dashboard-v2__revenue-value">${revenueEscaped}</div>
                </button>

                <section class="dashboard-v2__grid4" aria-label="Ключевые метрики">
                    ${renderMiniMetricCell('Заказов', formatNum(m.ordersCount), false, '', 'dashboard-open-orders')}
                    ${renderMiniMetricCell('Ср. чек', formatKopecksAsRub(m.averageCheckKopecks), false, 'avg_check')}
                    ${renderMiniMetricCell('Новые клиенты', formatNum(m.newClientsCount), false, '', 'dashboard-open-new-clients')}
                    ${renderMiniMetricCell('Все клиенты', formatNum(m.clientsTotalCount), false, '', 'dashboard-open-all-clients')}
                </section>
            </section>

            <h3 class="dashboard-v2__section-title">Клиенты и заказы</h3>
            <div class="dashboard-v2__stack">
                ${renderDashMetricRow('CR', `${esc(crLine)}%`, false, 'cr')}
                ${renderDashMetricRow('Повторные заказы', `${esc(dashboardFormatPct(m.repeatOrdersPercent))}%`, false, 'repeat_orders')}
                ${renderDashMetricRow('Средний LTV', esc(formatKopecksAsRub(m.averageLtvKopecks)), false, 'avg_ltv')}
                ${renderDashMetricRow('Клиенты', esc(formatNum(m.clientsTotalCount)), false, 'clients_block')}
            </div>

            <h3 class="dashboard-v2__section-title">Сервис и качество</h3>
            <div class="dashboard-v2__stack">
                ${renderDashMetricRow('Скорость ответа', esc(speedText), speedDanger, 'response_time')}
                ${renderDashMetricRow('Брошенные корзины', esc('нет данных'), false, 'abandoned_carts')}
                ${renderDashMetricRow('Возвраты / отмены после оплаты', esc(cancelText), cancelDanger, 'returns_cancel')}
            </div>

            <h3 class="dashboard-v2__section-title">Аналитика</h3>
            <button type="button" class="dashboard-v2__analytics-tap" data-action="dash-tip" data-tip-id="top_products" aria-label="Топ товаров, справка">
                <span class="dashboard-v2__subhead">Топ популярных товаров</span>
                <span class="dashboard-v2__subhead-hint" aria-hidden="true">?</span>
            </button>
            <article class="dashboard-v2__card dashboard-v2__card--top-carousel">${topCarouselInner}</article>

            <button type="button" class="dashboard-v2__analytics-tap" data-action="dash-tip" data-tip-id="order_sources" aria-label="Источники заказов, справка">
                <span class="dashboard-v2__subhead">Лучшие источники заказов</span>
                <span class="dashboard-v2__subhead-hint" aria-hidden="true">?</span>
            </button>
            <article class="dashboard-v2__card dashboard-v2__card--muted dashboard-v2__card--sources">${sourcesBlockInner}</article>
        </div>`;
}

function formatOrderListDate(iso) {
    const raw = String(iso || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return raw.slice(0, 16).replace('T', ' ');
}

async function renderClientsNewScreen() {
    migrateDashboardDatesInState({});
    let wrap;
    try {
        wrap = (await api(buildClientsNewV2RequestPath())).data;
    } catch (e) {
        return errorState(e.message || 'Не удалось загрузить клиентов');
    }
    const clients = wrap.clients || [];
    const rangeLabel = wrap.range && wrap.range.label ? wrap.range.label : '—';
    if (!clients.length) {
        return `
        <div class="dashboard-v2 screen-enter">
            <p class="dashboard-v2__period-hint">${esc(rangeLabel)}</p>
            <div class="dashboard-v2__empty-soft">Новых клиентов за выбранный период нет</div>
        </div>`;
    }
    return `
    <div class="dashboard-v2 screen-enter">
        <p class="dashboard-v2__period-hint">${esc(rangeLabel)}</p>
        <div class="mini-clients-stack">
        ${clients
            .map((c) => {
                const id = esc(c.telegram_id);
                const name = esc(c.display_name || c.telegram_id);
                const rev = formatKopecksAsRub(c.total_revenue_kopecks || 0);
                const un = c.username ? `@${esc(c.username)}` : esc(c.telegram_id);
                const ph = c.phone ? ` · ${esc(c.phone)}` : '';
                return `<button type="button" class="mini-client-row" data-action="open-client-v2-card" data-id="${id}" data-list="new">
                <div class="mini-client-row__top">
                    <span class="mini-client-row__name">${name}</span>
                    <span class="mini-client-row__meta">${esc(formatOrderListDate(c.first_order_at))}</span>
                </div>
                <div class="mini-client-row__sub mono">${un}${ph}</div>
                <div class="mini-client-row__foot"><span>${formatNum(c.total_orders)} заказ.</span><span>${rev}</span></div>
            </button>`;
            })
            .join('')}
        </div>
    </div>`;
}

async function renderClientsAllScreen() {
    let wrap;
    try {
        wrap = (await api('/api/admin/clients-v2?kind=all')).data;
    } catch (e) {
        return errorState(e.message || 'Не удалось загрузить клиентов');
    }
    const clients = wrap.clients || [];
    if (!clients.length) {
        return `<div class="dashboard-v2 screen-enter"><div class="dashboard-v2__empty-soft">Клиентов пока нет</div></div>`;
    }
    return `
    <div class="dashboard-v2 screen-enter">
        <div class="mini-clients-stack">
        ${clients
            .map((c) => {
                const id = esc(c.telegram_id);
                const name = esc(c.display_name || c.telegram_id);
                const rev = formatKopecksAsRub(c.total_revenue_kopecks || 0);
                const un = c.username ? `@${esc(c.username)}` : esc(c.telegram_id);
                const ph = c.phone ? ` · ${esc(c.phone)}` : '';
                return `<button type="button" class="mini-client-row" data-action="open-client-v2-card" data-id="${id}" data-list="all">
                <div class="mini-client-row__top">
                    <span class="mini-client-row__name">${name}</span>
                </div>
                <div class="mini-client-row__sub mono">${un}${ph}</div>
                <div class="mini-client-row__foot"><span>${formatNum(c.total_orders)} заказ.</span><span>${rev}</span></div>
            </button>`;
            })
            .join('')}
        </div>
    </div>`;
}

async function renderClientCardV2Screen() {
    const clientId = String(state.selectedClientId || '').trim();
    if (!clientId) {
        return `<div class="dashboard-v2 screen-enter"><div class="dashboard-v2__empty-soft">Клиент не выбран</div></div>`;
    }
    if (!state.clientV2DetailById[clientId]) {
        const res = await api(`/api/admin/clients-v2/${encodeURIComponent(clientId)}`);
        state.clientV2DetailById[clientId] = res.data;
    }
    const d = state.clientV2DetailById[clientId];
    if (!d) {
        return `<div class="dashboard-v2 screen-enter"><div class="dashboard-v2__empty-soft">Клиент не найден</div></div>`;
    }
    const titleName = esc(d.full_name || d.username || d.telegram_id);
    const dateHdr = d.first_order_at ? esc(formatOrderListDate(d.first_order_at)) : '—';
    const idLine = esc(String(d.telegram_id));
    const pillOrders = formatNum(d.total_orders || 0);
    const pillSum = formatKopecksAsRub(d.total_revenue_kopecks || 0);
    const phone = d.phone ? esc(d.phone) : '—';
    const src = d.source_code ? esc(d.source_code) : '—';
    const tg = d.username ? `@${esc(d.username)}` : '—';
    const bonus = formatNum(d.bonus_balance || 0);

    return `
    <div class="client-v2-sheet screen-enter">
        <div class="client-v2-hero">
            <div class="client-v2-hero__row">
                <h2 class="client-v2-hero__name">${titleName}</h2>
                <span class="client-v2-hero__date">${dateHdr}</span>
            </div>
            <p class="client-v2-hero__id mono">ID: ${idLine}</p>
            <div class="client-v2-pills">
                <span class="client-v2-pill">Заказов: ${pillOrders}</span>
                <span class="client-v2-pill">Сумма: ${pillSum}</span>
            </div>
        </div>
        <div class="client-v2-grid">
            <div class="client-v2-k">Телефон</div><div class="client-v2-v">${phone}</div>
            <div class="client-v2-k">Источник</div><div class="client-v2-v">${src}</div>
            <div class="client-v2-k">Telegram</div><div class="client-v2-v">${tg}</div>
            <div class="client-v2-k">Заказов</div><div class="client-v2-v">${pillOrders}</div>
            <div class="client-v2-k">Сумма</div><div class="client-v2-v">${pillSum}</div>
            <div class="client-v2-k">Бонусы</div><div class="client-v2-v">${bonus}</div>
        </div>
        <button type="button" class="client-v2-fullprof" data-action="client-open-full-profile">Открыть карточку пользователя</button>
    </div>`;
}

function formatPromoBroadcastDateTime(iso) {
    const raw = String(iso || '')
        .replace('T', ' ')
        .replace(/\.\d{3}Z?$/, '')
        .trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})\s(\d{2}:\d{2})/.exec(raw);
    if (!m) return esc(raw.slice(0, 16));
    return `${m[3]}.${m[2]}.${m[1]} · ${m[4]}`;
}

/** @returns {'Черновик'|'Размещена'|'Ошибка размещения'} */
function promoBroadcastPlacementLabel(placementStatus) {
    const s = String(placementStatus || 'draft').toLowerCase();
    if (s === 'placed') return 'Размещена';
    if (s === 'place_failed') return 'Ошибка размещения';
    return 'Черновик';
}

function promoBroadcastCanPlace(placementStatus) {
    const s = String(placementStatus || 'draft').toLowerCase();
    return s === 'draft' || s === 'place_failed';
}

async function renderPromoScreen() {
    let loadErr = '';
    try {
        const [sRes, bRes] = await Promise.all([
            api('/api/admin/promotion/sources'),
            api('/api/admin/promotion/broadcasts?limit=30')
        ]);
        const wrap = sRes.data || {};
        state.promoSourcesList = Array.isArray(wrap.sources) ? wrap.sources : [];
        state.promoBotConfigured = wrap.bot_username_configured === true;
        state.promoBroadcastsList = Array.isArray(bRes.data) ? bRes.data : [];
    } catch (e) {
        loadErr = friendlyActionError(e && e.message) || String(e && e.message);
    }

    const notice = state.promoFlash ? `<div class="promo-banner promo-banner--ok">${esc(state.promoFlash)}</div>` : '';
    state.promoFlash = '';

    const botWarn = state.promoBotConfigured
        ? ''
        : `<div class="promo-banner promo-banner--warn">Для корректных ссылок задайте <span class="mono">TELEGRAM_BOT_USERNAME</span> или дождитесь запуска бота (getMe).</div>`;

    const sources = state.promoSourcesList || [];

    function renderSourceRow(r) {
        const code = String(r.code || '');
        const isSystem = r.is_system === true || code === '__none__';
        const expanded = !!state.promoExpandedSources[code];
        const d = expanded ? state.promoDetailByCode[code] : null;
        const listClicks = Number(r.clicks_count || 0);
        const listPaid = Number(r.paid_orders_count || 0);
        const listOrd = Number(r.orders_count != null ? r.orders_count : 0);
        const listRevStr = esc(formatKopecksAsRub(r.paid_revenue_kopecks || 0));
        const url = String(r.tracking_url || '').trim();
        const metricsLine = isSystem
            ? `Заказов: ${formatNum(listOrd)} · Оплат: ${formatNum(listPaid)} · ${listRevStr}`
            : `Переходы: ${formatNum(listClicks)} · Оплат: ${formatNum(listPaid)} · ${listRevStr}`;
        const chipOrPill = isSystem
            ? `<span class="promo-row__sys-pill" aria-hidden="true">системный</span>`
            : `<span class="promo-code-chip mono promo-code-chip--src">${esc(code)}</span>`;
        const head = `
            <button type="button" class="promo-row promo-row--src${isSystem ? ' promo-row--system' : ''}${expanded ? ' promo-row--open' : ''}"
                aria-expanded="${expanded ? 'true' : 'false'}"
                data-action="promo-src-toggle"
                data-code="${esc(code)}">
                <span class="promo-row__title promo-row__title--src">${esc(String(r.title || code))}</span>
                <span class="promo-row__metrics promo-row__metrics--src">${metricsLine}</span>
                ${chipOrPill}
            </button>`;
        if (!expanded) return `<div class="promo-row-wrap">${head}</div>`;
        const fullUrl = url || (d && String(d.tracking_url || '').trim()) || '';
        const clicksN = Number((d || r).clicks_count ?? listClicks ?? 0);
        const paidDetail = Number((d || r).paid_orders_count ?? listPaid ?? 0);
        const createdN = Number((d || r).created_orders_count ?? r.orders_count ?? 0);
        const sumStr = esc(formatKopecksAsRub((d || r).paid_revenue_kopecks ?? r.paid_revenue_kopecks ?? 0));
        const kvRow = (label, numHtml) =>
            `<div class="promo-src-kv-row">
                <span class="promo-src-kv-row__lab">${esc(label)}: </span>
                <span class="promo-src-kv-row__lead" aria-hidden="true"></span>
                <span class="promo-src-kv-row__val">${numHtml}</span>
            </div>`;
        const kvRubRow = `<div class="promo-src-kv-row promo-src-kv-row--emph">
                <span class="promo-src-kv-row__lab">Сумма оплат: </span>
                <span class="promo-src-kv-row__lead" aria-hidden="true"></span>
                <span class="promo-src-kv-row__val">${sumStr}</span>
            </div>`;
        const detailMetrics = isSystem
            ? `<div class="promo-src-kv-stack" role="group" aria-label="Метрики источника">
                ${kvRow('Создано заказов', formatNum(createdN))}
                ${kvRow('Оплаченных заказов', formatNum(paidDetail))}
                ${kvRubRow}
            </div>`
            : `<div class="promo-src-kv-stack" role="group" aria-label="Метрики источника">
                ${kvRow('Переходы', formatNum(clicksN))}
                ${kvRow('Создано заказов', formatNum(createdN))}
                ${kvRow('Оплаченных заказов', formatNum(paidDetail))}
                ${kvRubRow}
            </div>`;
        const noUrlFoot =
            isSystem || fullUrl
                ? ''
                : `<p class="promo-muted promo-muted--src-foot">Ссылка будет доступна после настройки username бота.</p>`;
        const actionsHtml = isSystem
            ? ''
            : `<div class="promo-src-actions${fullUrl ? '' : ' promo-src-actions--solo'}">
                ${fullUrl ? `<button type="button" class="promo-src-btn promo-src-btn--secondary" data-action="promo-copy" data-copy="${esc(fullUrl)}">Скопировать ссылку</button>` : ''}
                <button type="button" class="promo-src-btn promo-src-btn--danger" data-action="promo-src-delete-prompt" data-code="${esc(code)}">Удалить</button>
            </div>`;
        const detailBlock = `
            <div class="promo-row-detail promo-row-detail--src">
                ${detailMetrics}
                ${noUrlFoot}
                ${actionsHtml}
            </div>`;
        return `<div class="promo-row-wrap">${head}${detailBlock}</div>`;
    }

    const broadcasts = state.promoBroadcastsList || [];
    function renderBcRow(b) {
        const id = String(b.id ?? '');
        const expanded = !!state.promoExpandedBroadcasts[id];
        const d = expanded ? state.promoDetailById[id] : null;
        const txt = String(b.text || b.body_text || '');
        const prevSrc = txt.replace(/\s+/g, ' ').trim();
        const prev = prevSrc.length > 200 ? `${prevSrc.slice(0, 200)}…` : prevSrc;
        const cnt = Number(b.response_count != null ? b.response_count : 0);
        const kw = String(b.keyword || '');
        const extUrl = String(b.image_url || '').trim();
        const useLocal = !!(b.has_uploaded_image && Number(id) > 0);
        const localImgPath = useLocal && !extUrl ? `/api/admin/promotion/broadcasts/${encodeURIComponent(id)}/image` : '';
        const extraPhotos = Number(b.extra_images_count != null ? b.extra_images_count : 0);
        let imgSmall = '';
        if (extUrl) {
            imgSmall = `<span class="promo-bc-thumb-wrap"><img class="promo-bc-thumb" src="${esc(extUrl)}" alt="" loading="lazy" />${
                extraPhotos > 0 ? `<span class="promo-bc-thumb-badge">+${esc(String(extraPhotos))}</span>` : ''
            }</span>`;
        } else if (localImgPath) {
            imgSmall = `<span class="promo-bc-thumb-wrap"><img class="promo-bc-thumb promo-bc-await-auth" src="" data-promo-auth-src="${esc(localImgPath)}" alt="" loading="lazy" />${
                extraPhotos > 0 ? `<span class="promo-bc-thumb-badge">+${esc(String(extraPhotos))}</span>` : ''
            }</span>`;
        } else {
            imgSmall = `<span class="promo-bc-ph" aria-hidden="true"></span>`;
        }
        const ps = String(b.placement_status || 'draft').toLowerCase();
        const placeLabel = promoBroadcastPlacementLabel(ps);
        const canPlace = promoBroadcastCanPlace(ps);
        const showRepeatPlace = ps === 'placed';
        const createdLine = formatPromoBroadcastDateTime(b.created_at || '');
        const detailHint =
            ps === 'place_failed' && String(b.place_error || '').trim()
                ? `<p class="promo-bc-place-err">${esc(String(b.place_error).slice(0, 220))}</p>`
                : '';

        const head = `
            <button type="button" class="promo-bc-head${expanded ? ' promo-bc-head--open' : ''}"
                aria-expanded="${expanded ? 'true' : 'false'}"
                data-action="promo-bc-toggle" data-bc-id="${esc(id)}">
              <span class="promo-bc-head__media">${imgSmall}</span>
              <span class="promo-bc-head__body">
                <span class="promo-bc-head__meta">
                  <span class="promo-bc-head__date">${createdLine}</span>
                  <span class="promo-bc-pill">${esc(placeLabel)}</span>
                </span>
                <span class="promo-bc-head__preview">${esc(prev || 'Без текста')}</span>
                <span class="promo-bc-head__kw-line">Кодовое слово: <strong>${esc(kw)}</strong></span>
                <span class="promo-bc-head__responses">Отклики: <strong>${formatNum(cnt)}</strong></span>
                ${ps === 'placed' && b.placed_at ? `<span class="promo-bc-head__sub">В теме рассылок: ${formatPromoBroadcastDateTime(b.placed_at)}</span>` : ''}
              </span>
            </button>`;
        const placeBtnHtml = canPlace
            ? `<button type="button" class="promo-bc-place-btn" data-action="promo-bc-place-prompt" data-bc-id="${esc(id)}">Разместить рассылку</button>`
            : showRepeatPlace
              ? `<button type="button" class="promo-bc-place-btn" data-action="promo-bc-place-repeat-prompt" data-bc-id="${esc(id)}">Разместить ещё раз</button>`
              : '';
        const deleteBtnHtml = `<button type="button" class="promo-bc-del-btn" data-action="promo-bc-delete-prompt" data-bc-id="${esc(id)}">Удалить</button>`;
        const foot = `<div class="promo-bc-foot"><div class="promo-bc-actions">${placeBtnHtml}${deleteBtnHtml}</div></div>`;

        if (!expanded) {
            return `<div class="promo-bc-shell promo-row-wrap">${head}${foot}</div>`;
        }
        const merged = d || b;
        const fullTxt = esc(String(merged.text || merged.body_text || txt || ''));
        const imgList = Array.isArray(merged.images) ? merged.images : [];
        let bigImg = '';
        if (imgList.length > 1) {
            bigImg = `<div class="promo-bc-img-grid">${imgList
                .map((im) => {
                    const url = esc(String(im.local_image_url || ''));
                    if (!url) return '';
                    const needsAuth = url.includes('/api/admin/promotion/broadcasts') && url.includes('/image');
                    return needsAuth
                        ? `<img class="promo-bc-grid-cell promo-bc-await-auth" src="" data-promo-auth-src="${url}" alt="" loading="lazy" />`
                        : `<img class="promo-bc-grid-cell" src="${url}" alt="" loading="lazy" />`;
                })
                .filter(Boolean)
                .join('')}</div>`;
        } else if (imgList.length === 1) {
            const u = esc(String(imgList[0].local_image_url || ''));
            const needsAuth = u.includes('/api/admin/promotion/broadcasts') && u.includes('/image');
            bigImg = needsAuth
                ? `<img class="promo-bc-full promo-bc-await-auth" src="" data-promo-auth-src="${u}" alt="" loading="lazy" />`
                : `<img class="promo-bc-full" src="${u}" alt="" loading="lazy" />`;
        }
        if (!bigImg) {
            const bigExt = String((d && d.image_url) || b.image_url || '').trim();
            const bigLocal = d && d.local_image_url ? String(d.local_image_url) : localImgPath ? localImgPath : '';
            const bigSrc = bigExt || bigLocal;
            if (bigSrc) {
                const needsAuth = bigSrc.includes('/api/admin/promotion/broadcasts') && bigSrc.includes('/image');
                bigImg = needsAuth
                    ? `<img class="promo-bc-full promo-bc-await-auth" src="" data-promo-auth-src="${esc(bigSrc)}" alt="" loading="lazy" />`
                    : `<img class="promo-bc-full" src="${esc(bigSrc)}" alt="" loading="lazy" />`;
            }
        }
        const detailMeta = `<p class="promo-bc-detail-meta">${createdLine} · ${esc(placeLabel)}${ps === 'placed' && b.placed_at ? ` · размещено ${formatPromoBroadcastDateTime(b.placed_at)}` : ''}</p>`;
        const detailBlock = `
            <div class="promo-row-detail promo-row-detail--bc">
              ${detailHint}
              ${detailMeta}
              ${bigImg}
              <p class="promo-bc-body">${fullTxt}</p>
              <p class="promo-bc-detail-kw">Кодовое слово: <strong>${esc(kw)}</strong></p>
              <p class="promo-muted promo-bc-detail-resp">Откликов: ${formatNum(Number((d && d.response_count != null ? d.response_count : null) ?? cnt))}</p>
            </div>`;
        return `<div class="promo-bc-shell promo-row-wrap">${head}${detailBlock}${foot}</div>`;
    }

    const sourceFormHtml = state.promoFormSourceOpen
        ? `
      <div class="promo-inline-form">
        <p class="promo-inline-form__label">Новый источник</p>
        <label class="promo-field">
          Название
          <input type="text" id="promoSrcTitle" maxlength="120" placeholder="Instagram май 2026" />
        </label>
        <label class="promo-field">
          Код (латиница, опционально)
          <input type="text" id="promoSrcCode" maxlength="64" placeholder="instagram_may_2026" class="mono" />
        </label>
        <p class="promo-hint-small">Если код пустой, он будет сгенерирован из названия.</p>
        <div class="promo-form-actions">
          <button type="button" class="promo-btn-secondary" data-action="promo-cancel-source">Отмена</button>
          <button type="button" class="promo-cta promo-cta--grow" data-action="promo-submit-source">Создать источник</button>
        </div>
      </div>`
        : '';

    const broadcastFormHtml = state.promoFormBroadcastOpen
        ? `
      <div class="promo-inline-form">
        <p class="promo-inline-form__label">Новая карточка рассылки</p>
        <label class="promo-field">
          Изображения
          <input type="file" id="promoBcImg" accept="image/*" multiple />
        </label>
        <p id="promoBcImgHint" class="promo-muted promo-muted--tight" hidden></p>
        <label class="promo-field">
          Текст рассылки
          <textarea id="promoBcText" rows="5" maxlength="4096" required placeholder="Скидка 10% на букеты…"></textarea>
        </label>
        <label class="promo-field">
          Кодовое слово
          <input type="text" id="promoBcKw" maxlength="64" placeholder="роза" required />
        </label>
        <div class="promo-form-actions">
          <button type="button" class="promo-btn-secondary" data-action="promo-cancel-broadcast">Отмена</button>
          <button type="button" class="promo-cta promo-cta--grow" data-action="promo-submit-broadcast">Сохранить карточку</button>
        </div>
      </div>`
        : '';

    const loadBlock = loadErr
        ? `<div class="dashboard-v2__banner dashboard-v2__banner--warn promo-banner-msg">${esc(loadErr)}</div>`
        : '';

    const sourcesEmpty =
        sources.length === 0
            ? `<div class="promo-empty">
            <div class="promo-empty__icon" aria-hidden="true"></div>
            <p class="promo-empty__title">Источников пока нет</p>
            <p class="promo-empty__text">Создайте первый источник — появится отслеживаемая ссылка, переходы, оплаты и выручка по кампании.</p>
           </div>`
            : '';

    const bcEmpty =
        broadcasts.length === 0
            ? `<div class="promo-empty">
            <div class="promo-empty__icon promo-empty__icon--mail" aria-hidden="true"></div>
            <p class="promo-empty__title">Карточек рассылок пока нет</p>
            <p class="promo-empty__text">Создайте карточку с текстом, изображением и кодовым словом — отклики пользователей сохранятся автоматически.</p>
           </div>`
            : '';

    return `
        <div class="dashboard-v2 promo-screen promo-screen--v2 screen-enter">
            <div class="promo-alerts">${notice}${botWarn}${loadBlock}</div>

            <section class="promo-section-card" aria-labelledby="promo-sources-heading">
              <header class="promo-section-card__header">
                <h2 id="promo-sources-heading" class="promo-section-card__title">Источники</h2>
                <button type="button" class="promo-cta" data-action="promo-open-source-form"><span class="promo-cta__plus" aria-hidden="true">+</span>Создать источник</button>
              </header>
              <div class="promo-section-card__body">
                ${sourceFormHtml}
                ${sourcesEmpty}
                ${sources.length ? `<div class="promo-stack promo-stack--in-card">${sources.map(renderSourceRow).join('')}</div>` : ''}
              </div>
            </section>

            <section class="promo-section-card" aria-labelledby="promo-bc-heading">
              <header class="promo-section-card__header">
                <h2 id="promo-bc-heading" class="promo-section-card__title">Рассылки</h2>
                <button type="button" class="promo-cta" data-action="promo-open-broadcast-form"><span class="promo-cta__plus" aria-hidden="true">+</span>Создать рассылку</button>
              </header>
              <div class="promo-section-card__body">
                ${broadcastFormHtml}
                ${bcEmpty}
                ${broadcasts.length ? `<div class="promo-stack promo-stack--in-card">${broadcasts.map(renderBcRow).join('')}</div>` : ''}
              </div>
            </section>
        </div>`;
}

async function renderHomeScreen() {
    const [summaryRes, actionsRes] = await Promise.all([
        api('/api/admin/mobile-summary'),
        api('/api/admin/actions/summary')
    ]);
    const summary = summaryRes.data || {};
    const actionSummary = actionsRes.data || {};
    const topActions = Array.isArray(actionSummary.topActions) ? actionSummary.topActions.slice(0, 3) : [];
    const hero = summary.hero || {};
    const money = summary.money || {};
    const orders = summary.orders || {};
    const attention = Array.isArray(summary.attention) ? summary.attention : [];
    const losses = summary.losses && Array.isArray(summary.losses.items) ? summary.losses.items : [];
    const growthPoints = Array.isArray(summary.growthPoints) ? summary.growthPoints : [];
    const quickActions = Array.isArray(summary.quickActions) ? summary.quickActions : [];
    const comparison = summary.comparison || {};
    const insight = summary.insight || {};
    const charts = summary.charts || {};
    const revenue7d = Array.isArray(charts.revenue7d) ? charts.revenue7d : [];
    const orders7d = Array.isArray(charts.orders7d) ? charts.orders7d : [];

    const compareItems = [
        {
            title: 'К вчера',
            value: comparison.toYesterday && comparison.toYesterday.revenueDeltaPct,
            note: (comparison.toYesterday && comparison.toYesterday.revenueDeltaPct) >= 0
                ? 'Выручка выше, чем вчера в это же время'
                : 'Выручка ниже вчерашнего темпа'
        },
        {
            title: 'К 7-дневному среднему',
            value: comparison.to7dAverage && comparison.to7dAverage.revenueDeltaPct,
            note: (comparison.to7dAverage && comparison.to7dAverage.revenueDeltaPct) >= 0
                ? 'Идете выше среднего темпа недели'
                : 'Темп ниже среднего за 7 дней'
        },
        {
            title: 'К прошлой неделе',
            value: comparison.toSameWeekday && comparison.toSameWeekday.revenueDeltaPct,
            note: (comparison.toSameWeekday && comparison.toSameWeekday.revenueDeltaPct) >= 0
                ? 'Аналогичный день недели сильнее'
                : 'Прошлая неделя пока была лучше'
        }
    ];

    return `
        ${renderHomeSegmentFilters(quickActions)}
        <article class="big-kpi-card big-kpi-card--hero">
            <div class="kpi-label">Выручка сегодня</div>
            <div class="kpi-value">${formatKopecksAsRub(hero.revenueToday)}</div>
            <p class="kpi-note kpi-note--inline">${esc(hero.quickSense || 'Обновляется в течение дня')} · 7д ${formatKopecksAsRub(money.revenue7d)} · 30д ${formatKopecksAsRub(money.revenue30d)}</p>
        </article>
        ${sectionKicker('Показатели дня')}
        <div class="grid-2 hero-summary-grid">
            ${kpiCard('Оплаченные заказы', `${formatNum(hero.paidOrdersToday)} из ${formatNum(hero.totalOrdersToday)}`, `Конверсия в оплату: ${formatSignedPercent(hero.paymentConversionTodayPct)}`)}
            ${kpiCard('Средний чек сегодня', formatKopecksAsRub(hero.avgCheckToday), `К вчера: ${formatSignedPercent(comparison.toYesterday && comparison.toYesterday.avgCheckDeltaPct)}`)}
            ${kpiCard('Повторные заказы', formatNum(hero.repeatOrdersToday), `Повторных клиентов: ${formatNum(hero.repeatClientsToday)}`)}
            ${kpiCard('Неоплаченные', formatNum(orders.unpaidToday), `Потенциально заморожено: ${formatKopecksAsRub(summary.losses && summary.losses.totalFrozenRevenue)}`)}
        </div>
        ${renderPlaybookBanner('home')}

        ${sectionHeader('Сравнение периода', 'Лучше или хуже и что это значит')}
        <article class="card">
            <div class="compare-list">
                ${compareItems.map((item) => `
                    <div class="compare-item">
                        <div class="kpi-label">${esc(item.title)}</div>
                        <div class="metric-inline">
                            ${statusBadge(formatSignedPercent(item.value), toneByDelta(item.value))}
                            <span>${esc(item.note)}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </article>

        ${sectionHeader('Требует внимания')}
        ${attention.length ? attention.map((item) => `
            <article class="list-card attention ${esc(item.priority || 'watch')}">
                <h3 class="list-card-title">${esc(item.title)}</h3>
                <p class="list-card-meta">${esc(item.summary || item.message || '')}</p>
                <div class="list-card-footer">
                    ${statusBadge(priorityMeta(item.priority).label, priorityMeta(item.priority).tone)}
                    <strong>${esc(item.impactLabel || '')}</strong>
                </div>
                <div class="list-card-footer">
                    <span class="list-card-meta">Что делать: ${esc(item.ctaLabel || 'Открыть')}</span>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.ctaLabel || 'Открыть')}</button>
                </div>
            </article>
        `).join('') : calmState('Сегодня без критичных блокеров', 'Операционный контур стабилен. Можно усилить продажи через клиентские сценарии.')}

        ${sectionHeader('Потери прибыли', 'Где деньги уже теряются или заморожены')}
        <div class="grid-2">
            ${losses.map((loss) => `
                <article class="action-card">
                    <div class="kpi-label">${esc(loss.title)}</div>
                    <div class="kpi-value">${loss.money_minor ? formatKopecksAsRub(loss.amount) : `${formatNum(loss.amount)} ${esc(loss.unit || '')}`}</div>
                    <div class="kpi-note">${esc(loss.message || '')}</div>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(loss.action))}">Разобрать</button>
                </article>
            `).join('')}
        </div>

        ${sectionHeader('Точки роста', 'Где можно заработать больше')}
        ${growthPoints.map((point) => `
            <article class="list-card">
                <h3 class="list-card-title">${esc(point.title)}</h3>
                <p class="list-card-meta">${esc(point.summary || '')}</p>
                <div class="list-card-footer">
                    <strong>${esc(point.valueLabel || '')}</strong>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(point.action))}">${esc(point.actionLabel || 'Открыть')}</button>
                </div>
            </article>
        `).join('')}

        ${renderPlaybookCards({ source: 'Главная', limit: 4 })}

        <article class="list-card">
            <div class="list-card-footer">
                <h3 class="list-card-title">Главные действия сегодня</h3>
                <button class="secondary" data-go="actions">Все действия</button>
            </div>
            ${topActions.length ? topActions.map((item) => `
                <div class="list-card-footer">
                    <span class="list-card-meta">${esc(item.title)} · <strong>${esc(item.business_impact_label || '')}</strong></span>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: item.target_screen, filters: item.target_filters || {} }))}">${esc(item.cta_label || 'Открыть')}</button>
                </div>
            `).join('') : '<p class="list-card-meta">Критичных действий сейчас нет. Сфокусируйтесь на точках роста и quick wins.</p>'}
        </article>

        <article class="insight-card ${esc(insight.tone || 'info')}">
            <h4>${esc(insight.title || 'Инсайт дня')}</h4>
            <p>${esc(insight.message || 'Данные появятся после первых событий дня.')}</p>
        </article>

        <div class="grid-2">
            ${revenue7d.length ? compactChartCard(revenue7d, 'Выручка по дням (7 дней)', 'value') : ''}
            ${orders7d.length ? compactChartCard(orders7d, 'Заказы по дням (7 дней)', 'value') : ''}
        </div>
    `;
}

async function renderActionsScreen() {
    const data = (await api('/api/admin/actions/summary')).data || {};
    const topActions = Array.isArray(data.topActions) ? data.topActions : [];
    const grouped = data.groupedActions || {};
    const quickWins = Array.isArray(data.quickWins) ? data.quickWins : [];
    const brief = data.executiveBrief || {};
    const neutral = data.neutralState || null;
    const orderedCategories = ['revenue', 'retention', 'marketing', 'support', 'growth', 'operations'];

    return `
        ${sectionHeader('Центр действий', 'Где деньги, где риск и что делать в первую очередь')}
        ${renderPlaybookBanner('actions')}

        <article class="insight-card info">
            <h4>${esc(brief.title || 'Главное на сегодня')}</h4>
            <p>${esc(brief.message || 'Система собрала приоритетные действия по ключевым зонам бизнеса.')}</p>
            ${(Array.isArray(brief.lines) ? brief.lines : []).slice(0, 4).map((line) => `<p class="mt-2">${esc(line)}</p>`).join('')}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Top priority</h3>
            ${topActions.length ? topActions.slice(0, 3).map((action) => `
                <article class="action-focus-card ${esc(action.priority || 'medium')}">
                    <div class="list-card-footer">
                        <strong>${esc(action.title)}</strong>
                        ${statusBadge(actionPriorityLabel(action.priority), actionPriorityTone(action.priority))}
                    </div>
                    <p class="list-card-meta">${esc(action.message || '')}</p>
                    <div class="list-card-footer">
                        <span class="list-card-meta">${esc(action.business_impact_label || '')}${action.impact_value !== null && action.impact_value !== undefined ? ` · ${formatNum(action.impact_value)}` : ''}</span>
                        <div class="inline-actions">
                            ${inferPlaybookIdFromAction(action) ? `<button class="secondary" data-action="launch-playbook" data-id="${esc(inferPlaybookIdFromAction(action))}" data-source="Центр действий">Сценарий</button>` : ''}
                            <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: action.target_screen, filters: action.target_filters || {} }))}">${esc(action.cta_label || 'Открыть')}</button>
                        </div>
                    </div>
                </article>
            `).join('') : `<p class="list-card-meta">${esc((neutral && neutral.message) || 'Критичных действий сейчас нет. День проходит в спокойном режиме.')}</p>`}
        </article>

        ${orderedCategories.map((category) => {
            const rows = Array.isArray(grouped[category]) ? grouped[category] : [];
            if (!rows.length) return '';
            return `
                <article class="list-card">
                    <h3 class="list-card-title">${esc(actionCategoryLabel(category))}</h3>
                    ${rows.slice(0, 3).map((action) => `
                        <div class="client-timeline-item">
                            <div class="list-card-footer">
                                <strong>${esc(action.title)}</strong>
                                ${statusBadge(actionPriorityLabel(action.priority), actionPriorityTone(action.priority))}
                            </div>
                            <p class="list-card-meta">${esc(action.message || '')}</p>
                            <div class="list-card-footer">
                                <span class="list-card-meta">${esc(action.business_impact_label || '')}</span>
                                <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: action.target_screen, filters: action.target_filters || {} }))}">${esc(action.cta_label || 'Открыть')}</button>
                            </div>
                        </div>
                    `).join('')}
                </article>
            `;
        }).join('')}

        <article class="list-card">
            <h3 class="list-card-title">Quick wins</h3>
            ${quickWins.length ? quickWins.slice(0, 6).map((item) => `
                <div class="list-card-footer">
                    <span class="list-card-meta">${esc(item.title)} · ${esc(item.message || '')}</span>
                    <div class="inline-actions">
                        ${inferPlaybookIdFromAction(item) ? `<button class="secondary" data-action="launch-playbook" data-id="${esc(inferPlaybookIdFromAction(item))}" data-source="Quick wins">Сценарий</button>` : ''}
                        <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: item.target_screen, filters: item.target_filters || {} }))}">${esc(item.cta_label || 'Открыть')}</button>
                    </div>
                </div>
            `).join('') : '<p class="list-card-meta">Быстрых действий нет. Хороший момент для улучшения сегментов и сценариев роста.</p>'}
        </article>
        ${renderPlaybookCards({ source: 'Центр действий', limit: 6 })}
    `;
}

function filteredOrders(rows) {
    if (state.orderFilter === 'all') return rows;
    if (state.orderFilter === 'today') return rows.filter((row) => row.delivery_bucket === 'today' || isToday(row.created_at));
    if (state.orderFilter === 'tomorrow') return rows.filter((row) => row.delivery_bucket === 'tomorrow');
    if (state.orderFilter === 'paid') return rows.filter((row) => !!row.is_paid);
    if (state.orderFilter === 'unpaid') return rows.filter((row) => !!row.is_unpaid);
    if (state.orderFilter === 'urgent') return rows.filter((row) => !!row.is_urgent);
    if (state.orderFilter === 'problematic') return rows.filter((row) => !!row.is_problematic);
    if (state.orderFilter === 'repeat') return rows.filter((row) => !!row.is_repeat_client);
    if (state.orderFilter === 'large') return rows.filter((row) => !!row.is_large_order);
    if (state.orderFilter === 'large_unpaid') return rows.filter((row) => !!row.is_large_order && !!row.is_unpaid);
    if (state.orderFilter === 'no_attention') return rows.filter((row) => !row.is_problematic);
    return rows;
}

function orderAttentionTone(level) {
    if (level === 'critical') return 'alert';
    if (level === 'important') return 'warn';
    return 'ok';
}

function formatOrderDelivery(order) {
    const date = String(order.delivery_date || '').trim();
    const time = String(order.delivery_time || '').trim();
    if (!date && !time) return 'Доставка не указана';
    const datePart = date || 'дата не указана';
    const timePart = time || 'время уточняется';
    return `${datePart} · ${timePart}`;
}

function orderStatusTitle(order) {
    if (order.is_problematic) return order.attention_reason || 'Нужно внимание';
    if (order.is_paid) return 'Оплата подтверждена, заказ в работе';
    if (order.is_urgent) return 'Скоро доставка, проверьте готовность';
    return order.order_subtitle || 'Заказ в работе';
}

async function renderOrdersScreen() {
    migrateDashboardDatesInState({});
    let wrap;
    try {
        wrap = (await api(buildOrdersV2RequestPath())).data;
    } catch (e) {
        return errorState(e.message || 'Не удалось загрузить заказы');
    }
    const orders = wrap.orders || [];
    const rangeLabel = wrap.range && wrap.range.label ? String(wrap.range.label) : '—';
    state.ordersV2RangeLabel = rangeLabel;

    if (!orders.length) {
        return `
        <div class="dashboard-v2 screen-enter">
            <p class="dashboard-v2__period-hint">${esc(rangeLabel)}</p>
            <div class="dashboard-v2__empty-soft">Заказов за выбранный период нет</div>
        </div>`;
    }

    return `
        <div class="dashboard-v2 screen-enter">
            <p class="dashboard-v2__period-hint">${esc(rangeLabel)}</p>
            <div class="orders-v2-stack">
            ${orders
                .map((o) => {
                    const id = Number(o.id);
                    const paid = o.is_paid ? 'Оплачен' : 'Не оплачен';
                    const name =
                        o.client_name && String(o.client_name).trim()
                            ? esc(String(o.client_name).trim())
                            : o.telegram_id
                              ? esc(String(o.telegram_id))
                              : '—';
                    const dt = esc(formatOrderListDate(o.created_at));
                    const sum = formatKopecksAsRub(o.amount_kopecks || 0);
                    const src = o.source_code ? `Источник: ${esc(String(o.source_code))}` : '';
                    const pos = Number(o.items_count) > 0 ? `${formatNum(o.items_count)} поз.` : '';
                    return `<article class="orders-v2-card">
                        <div class="orders-v2-card__top">
                            <strong class="orders-v2-card__id">Заказ #${id}</strong>
                        </div>
                        <p class="orders-v2-card__line">${dt} · ${esc(paid)}</p>
                        <p class="orders-v2-card__line orders-v2-card__line--emph">${name} · ${sum}</p>
                        <p class="orders-v2-card__meta">${[src, pos].filter(Boolean).join(' · ') || '\u00A0'}</p>
                    </article>`;
                })
                .join('')}
            </div>
        </div>`;
}

function filterClients(rows) {
    const f = state.clientFilter;
    if (f === 'all') return rows;
    if (f === 'new') return rows.filter((r) => !!r.is_new_client);
    if (f === 'repeat') return rows.filter((r) => !!r.is_repeat_client);
    if (f === 'vip') return rows.filter((r) => !!r.is_vip_client);
    if (f === 'sleeping') return rows.filter((r) => !!r.is_sleeping_client);
    if (f === 'high-value') return rows.filter((r) => !!r.is_high_value_client);
    if (f === 'recent') return rows.filter((r) => !!r.is_recently_active);
    if (f === 'attention') return rows.filter((r) => String(r.attention_level || 'normal') !== 'normal');
    if (f === 'support') return rows.filter((r) => !!r.has_support_activity);
    if (f === 'topic') return rows.filter((r) => !!r.has_topic);
    if (f === 'return') return rows.filter((r) => !!r.is_recover_candidate);
    if (f === 'vip_sleeping') return rows.filter((r) => !!r.is_vip_client && !!r.is_sleeping_client);
    if (f === 'highvalue_sleeping') return rows.filter((r) => !!r.is_high_value_client && !!r.is_sleeping_client);
    if (f === 'new_without_repeat') return rows.filter((r) => !!r.is_new_client && !r.is_repeat_client);
    return rows;
}

async function renderClientsScreen() {
    const [rowsRes, summaryRes] = await Promise.all([
        api(`/api/admin/clients?limit=160&q=${encodeURIComponent(state.clientsQ || '')}`),
        api('/api/admin/clients/summary')
    ]);
    const rows = rowsRes.data || [];
    const summary = summaryRes.data || {};
    const totals = summary.totals || {};
    const segments = summary.segments || {};
    const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];
    const filtered = filterClients(rows);
    const summaryFilters = [
        { id: 'all', label: 'Всего клиентов', value: totals.all },
        { id: 'new', label: 'Новые', value: totals.new },
        { id: 'repeat', label: 'Повторные', value: totals.repeat },
        { id: 'vip', label: 'VIP', value: totals.vip },
        { id: 'sleeping', label: 'Спящие', value: totals.sleeping },
        { id: 'return', label: 'Стоит вернуть', value: totals.returnable }
    ];
    const chips = [
        { id: 'all', label: 'Все' },
        { id: 'new', label: 'Новые' },
        { id: 'new_without_repeat', label: 'Без повтора' },
        { id: 'repeat', label: 'Повторные' },
        { id: 'vip', label: 'VIP' },
        { id: 'vip_sleeping', label: 'VIP в паузе' },
        { id: 'sleeping', label: 'Спящие' },
        { id: 'high-value', label: 'Высокий чек' },
        { id: 'highvalue_sleeping', label: 'Высокий чек + пауза' },
        { id: 'recent', label: 'Недавно активные' },
        { id: 'attention', label: 'Требуют внимания' },
        { id: 'support', label: 'С поддержкой' },
        { id: 'topic', label: 'С темой' }
    ];

    return `
        ${sectionHeader('Клиенты как CRM прибыли', 'Кто приносит выручку, кто покупает повторно и кого вернуть')}
        ${renderPlaybookBanner('clients')}
        <form id="clientsSearchForm" class="search-row">
            <input type="search" id="clientsSearchInput" value="${esc(state.clientsQ)}" placeholder="Имя, username или Telegram ID" />
            <button type="submit">Найти</button>
        </form>

        <div class="clients-summary-strip">
            ${summaryFilters.map((item) => `
                <button class="client-summary-chip ${state.clientFilter === item.id ? 'active' : ''}" data-action="clients-filter" data-value="${esc(item.id)}">
                    <span>${esc(item.label)}</span>
                    <strong>${formatNum(item.value)}</strong>
                </button>
            `).join('')}
        </div>

        <div class="chips">
            ${chips.map((chip) => `<button class="chip ${state.clientFilter === chip.id ? 'active' : ''}" data-action="clients-filter" data-value="${esc(chip.id)}">${esc(chip.label)}</button>`).join('')}
        </div>

        <article class="list-card">
            <h3 class="list-card-title">Что важно по клиентам</h3>
            <p class="list-card-meta">Спящие: ${formatNum(totals.sleeping)} · VIP: ${formatNum(totals.vip)} · Требуют внимания: ${formatNum(segments.attention)}</p>
            <p class="list-card-meta">Новые без повтора: ${formatNum(segments.newWithoutRepeat)} · Можно вернуть: ${formatNum(totals.returnable)}</p>
        </article>
        ${renderPlaybookCards({ source: 'Клиенты', target: 'clients', limit: 3 })}

        ${highlights.slice(0, 4).map((item) => `
            <article class="list-card attention ${esc(item.tone || 'watch')}">
                <h3 class="list-card-title">${esc(item.title)}</h3>
                <p class="list-card-meta">${esc(item.description || '')}</p>
                <div class="list-card-footer">
                    <strong>${esc(item.valueLabel || '')}</strong>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.actionLabel || 'Открыть')}</button>
                </div>
            </article>
        `).join('')}

        <div class="list-card-meta">Показано: ${formatNum(filtered.length)} из ${formatNum(rows.length)}</div>
        ${filtered.length ? filtered.slice(0, 120).map((client) => {
            const id = String(client.telegram_id || '');
            const topicLink = buildTopicLink(client.chat_id, client.message_thread_id);
            const badges = [
                client.is_vip_client ? statusBadge('VIP', 'warn') : '',
                client.is_sleeping_client ? statusBadge('Спящий', 'alert') : '',
                client.is_repeat_client ? statusBadge('Повторный', 'info') : '',
                client.is_new_client ? statusBadge('Новый', 'ok') : '',
                client.is_high_value_client ? statusBadge('Высокий чек', 'warn') : '',
                client.attention_level !== 'normal' ? statusBadge('Требует внимания', 'alert') : ''
            ].filter(Boolean).join('');
            const name = (`${client.first_name || ''} ${client.last_name || ''}`.trim()) || (client.username ? `@${client.username}` : id);

            return `
                <article class="list-card client-card ${esc(client.attention_level || 'normal')}">
                    <div class="list-card-footer">
                        <h3 class="list-card-title">${esc(name)}</h3>
                        <strong class="client-revenue">${formatKopecksAsRub(client.total_revenue)}</strong>
                    </div>
                    <p class="list-card-meta">@${esc(client.username || 'без username')} · ${esc(id)}</p>
                    <p class="list-card-meta">${esc(client.customer_subtitle || 'Клиентская активность')}</p>
                    <div class="order-meta-row">${badges}</div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Заказов: ${formatNum(client.total_orders)} · Ср. чек: ${formatKopecksAsRub(client.avg_order_value)}</span>
                        <span class="list-card-meta">Последний заказ: ${esc(formatDaysAgo(client.days_since_last_order))}</span>
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Последняя покупка: ${esc(formatDateTime(client.last_order_at))}</span>
                        <span class="list-card-meta">${esc(client.attention_reason || 'Клиент активен')}</span>
                    </div>
                    <div class="order-actions">
                        <button data-action="client-open" data-id="${esc(id)}">Открыть</button>
                        ${topicLink
                            ? `<a class="order-topic-link" href="${esc(topicLink)}" target="_blank" rel="noopener">Тема</a>`
                            : `<button class="secondary" data-action="client-open" data-id="${esc(id)}">Тема</button>`}
                        <button class="secondary" data-action="client-open-orders" data-id="${esc(id)}">Заказы</button>
                        ${client.has_support_activity ? `<button class="secondary" data-action="client-open-support" data-id="${esc(id)}">Поддержка</button>` : ''}
                    </div>
                </article>
            `;
        }).join('') : (rows.length === 0
            ? emptyState('Клиентская база пока пустая', 'Первые клиенты появятся здесь после заказов и диалогов.')
            : (state.clientsQ
                ? `<article class="state-card empty"><h3 class="list-card-title">Поиск ничего не нашёл</h3><p class="list-card-meta">Проверьте написание имени, username или Telegram ID.</p><button class="mt-2 secondary" data-action="clients-search-clear">Сбросить поиск</button></article>`
                : (renderPlaybookCalmState('clients') || `<article class="state-card calm"><h3 class="list-card-title">В этом сегменте сейчас спокойно</h3><p class="list-card-meta">Активных клиентов в выбранном срезе нет. Проверьте другой сегмент или общий список.</p><button class="mt-2 secondary" data-action="clients-filter" data-value="all">Показать всех</button></article>`)
            )
        )}
    `;
}

async function renderClientDetailScreen() {
    const clientId = String(state.selectedClientId || '').trim();
    if (!clientId) {
        return emptyState('Клиент не выбран', 'Откройте карточку из списка клиентов.', 'К списку клиентов', 'clients');
    }
    if (!state.clientDetails[clientId]) {
        const data = (await api(`/api/admin/clients/${encodeURIComponent(clientId)}`)).data;
        state.clientDetails[clientId] = data;
    }
    const detail = state.clientDetails[clientId];
    if (!detail || !detail.profile) {
        return emptyState('Клиент не найден', 'Проверьте, что клиент существует в системе.', 'К списку', 'clients');
    }
    const profile = detail.profile || {};
    const actions = Array.isArray(detail.recommended_actions) ? detail.recommended_actions : [];
    const lastOrders = Array.isArray(detail.last_orders) ? detail.last_orders : [];
    const supportThreads = Array.isArray(detail.support_threads) ? detail.support_threads : [];
    const recentEvents = Array.isArray(detail.recent_events) ? detail.recent_events : [];
    const supportSummary = detail.support_summary || {};
    const topicLink = buildTopicLink(profile.chat_id, profile.message_thread_id);
    const priority = actionPriorityMeta(profile.action_priority);
    const tabs = [
        { id: 'orders', label: 'Заказы' },
        { id: 'support', label: 'Поддержка' },
        { id: 'events', label: 'Активность' }
    ];
    const valueRows = [
        { label: 'Принес выручки', value: formatKopecksAsRub(profile.total_revenue) },
        { label: 'Всего заказов', value: formatNum(profile.total_orders) },
        { label: 'Средний чек', value: formatKopecksAsRub(profile.avg_order_value) },
        { label: 'Первый заказ', value: formatDateTime(profile.first_order_at) },
        { label: 'Последний заказ', value: formatDateTime(profile.last_order_at) },
        { label: 'Дней с последнего заказа', value: profile.days_since_last_order === null ? '—' : formatNum(profile.days_since_last_order) }
    ];

    return `
        ${sectionHeader('Профиль клиента', 'Ценность, история и следующие действия')}
        ${renderPlaybookBanner('client_detail')}
        <article class="client-detail-hero">
            <div class="list-card-footer">
                <div>
                    <h2 class="client-detail-title">${esc(profile.full_name || profile.username || clientId)}</h2>
                    <p class="list-card-meta">@${esc(profile.username || 'без username')} · ${esc(clientId)}</p>
                </div>
                <strong class="client-detail-money">${formatKopecksAsRub(profile.total_revenue)}</strong>
            </div>
            <p class="client-detail-subtitle">${esc(profile.client_story_subtitle || profile.customer_subtitle || 'Профиль клиента')}</p>
            <div class="order-meta-row">
                ${statusBadge(profile.is_vip_client ? 'VIP' : valueTierLabel(profile.value_tier), profile.is_vip_client ? 'warn' : 'info')}
                ${statusBadge(retentionStageLabel(profile.retention_stage), profile.is_sleeping_client ? 'alert' : 'ok')}
                ${statusBadge(priority.label, priority.tone)}
                ${profile.is_recover_candidate ? statusBadge('Стоит вернуть', 'alert') : ''}
                ${profile.has_support_activity ? statusBadge('С поддержкой', 'warn') : ''}
            </div>
            <div class="grid-2 mt-2">
                ${kpiCard('Заказов', formatNum(profile.total_orders), `Повторных: ${formatNum(profile.repeat_orders_count)}`)}
                ${kpiCard('Средний чек', formatKopecksAsRub(profile.avg_order_value), `Последний: ${formatDaysAgo(profile.days_since_last_order)}`)}
            </div>
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Ценность клиента</h3>
            <div class="client-value-grid">
                ${valueRows.map((item) => `
                    <div class="client-value-row">
                        <span>${esc(item.label)}</span>
                        <strong>${esc(item.value)}</strong>
                    </div>
                `).join('')}
            </div>
        </article>

        <article class="list-card attention ${esc(profile.action_priority || 'watch')}">
            <h3 class="list-card-title">На что обратить внимание</h3>
            <p class="list-card-meta">${esc(profile.attention_reason || 'Клиент в стабильной зоне. Можно работать на рост среднего чека и повторов.')}</p>
            <p class="list-card-meta">Стадия удержания: <strong>${esc(retentionStageLabel(profile.retention_stage))}</strong> · Value tier: <strong>${esc(valueTierLabel(profile.value_tier))}</strong></p>
            <p class="list-card-meta">Поддержка: ${supportSummary.has_active_support ? 'есть активный диалог' : 'активных диалогов нет'} · Недавний touch: ${profile.has_recent_broadcast_activity ? 'да' : 'нет'}</p>
            ${(profile.is_recover_candidate || profile.is_vip_client || profile.is_high_value_client)
                ? `<button class="secondary mt-2" data-action="launch-playbook" data-id="${profile.is_vip_client ? 'vip_return' : (profile.is_high_value_client ? 'high_value_recover' : 'second_order_push')}" data-source="Карточка клиента">Открыть сценарий</button>`
                : ''}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Что делать с этим клиентом</h3>
            ${actions.length ? actions.map((item) => `
                <div class="client-reco-row">
                    <div>
                        <div class="list-card-title reco-title">${esc(item.title)}</div>
                        <p class="list-card-meta">${esc(item.message || '')}</p>
                    </div>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.ctaLabel || 'Открыть')}</button>
                </div>
            `).join('') : '<p class="list-card-meta">Сейчас критичных рекомендаций нет. Продолжайте наблюдение за активностью.</p>'}
        </article>

        <div class="chips">
            ${tabs.map((tab) => `<button class="chip ${state.clientDetailTab === tab.id ? 'active' : ''}" data-action="client-detail-tab" data-value="${esc(tab.id)}">${esc(tab.label)}</button>`).join('')}
        </div>

        ${state.clientDetailTab === 'orders' ? `
            <article class="list-card">
                <h3 class="list-card-title">Последние заказы</h3>
                ${lastOrders.length ? lastOrders.map((order) => `
                    <div class="client-timeline-item">
                        <div class="list-card-footer">
                            <strong>#${esc(order.id)}</strong>
                            <strong>${formatKopecksAsRub(order.amount)}</strong>
                        </div>
                        <p class="list-card-meta">${esc(order.subtitle || '')}</p>
                        <p class="list-card-meta">${esc(formatDateTime(order.created_at))}</p>
                    </div>
                `).join('') : '<p class="list-card-meta">У клиента пока нет заказов.</p>'}
            </article>
        ` : ''}

        ${state.clientDetailTab === 'support' ? `
            <article class="list-card">
                <h3 class="list-card-title">Поддержка клиента</h3>
                ${supportThreads.length ? supportThreads.map((thread) => `
                    <div class="client-timeline-item">
                        <div class="list-card-footer">
                            <strong>Диалог #${esc(thread.id)}</strong>
                            ${statusBadge(thread.is_waiting_response ? 'Ждёт ответа' : (thread.status || 'OPEN'), thread.is_waiting_response ? 'warn' : 'info')}
                        </div>
                        <p class="list-card-meta">Создан: ${esc(formatDateTime(thread.created_at))} · Обновлен: ${esc(formatDateTime(thread.updated_at))}</p>
                    </div>
                `).join('') : '<p class="list-card-meta">Нет истории поддержки по этому клиенту.</p>'}
            </article>
        ` : ''}

        ${state.clientDetailTab === 'events' ? `
            <article class="list-card">
                <h3 class="list-card-title">Активность и события</h3>
                ${recentEvents.length ? recentEvents.map((evt) => `
                    <div class="client-timeline-item">
                        <div class="list-card-footer">
                            <strong>${esc(eventTypeLabel(evt.type))}</strong>
                            <span class="list-card-meta">${esc(formatDateTime(evt.at))}</span>
                        </div>
                        <p class="list-card-meta">${esc(evt.title || '')}</p>
                        <p class="list-card-meta">${esc(evt.message || '')}</p>
                    </div>
                `).join('') : '<p class="list-card-meta">События пока не зафиксированы.</p>'}
            </article>
        ` : ''}

        <div class="screen-footer-actions">
            <button type="button" data-action="client-back">Назад в сегмент</button>
            ${topicLink ? `<a class="order-topic-link sticky-link" href="${esc(topicLink)}" target="_blank" rel="noopener">Открыть тему</a>` : '<button type="button" class="secondary" data-action="client-open-orders" data-id="' + esc(clientId) + '">К заказам</button>'}
            <button type="button" class="secondary" data-action="client-open-support" data-id="${esc(clientId)}">Поддержка</button>
        </div>
    `;
}

function filterBroadcasts(rows) {
    const raw = String(state.broadcastsFilter || '').trim();
    const filter = raw.toLowerCase();
    if (!raw || filter === 'all') return rows;

    const byStatus = (status) => rows.filter((row) => String(row.status || '').toUpperCase() === status);
    if (raw === 'RUNNING' || filter === 'running') return byStatus('RUNNING');
    if (raw === 'DONE' || filter === 'done' || filter === 'completed') return byStatus('DONE');
    if (raw === 'DELETED' || filter === 'deleted') return byStatus('DELETED');

    if (filter === 'latest') return rows.slice(0, 20);
    if (filter === 'successful') return rows.filter((row) => row.campaign_tier === 'successful');
    if (filter === 'problematic') return rows.filter((row) => !!row.is_problematic);
    if (filter === 'high-reach') return rows.filter((row) => !!row.is_high_reach);
    if (filter === 'errors' || filter === 'failed') return rows.filter((row) => Number(row.failed_count || 0) > 0);
    if (filter === 'blocked') return rows.filter((row) => Number(row.blocked_count || 0) > 0);
    if (filter === 'repeatable') return rows.filter((row) => !!row.is_repeatable_candidate);
    return rows;
}

async function renderBroadcastsScreen() {
    const [rowsRes, summaryRes] = await Promise.all([
        api('/api/admin/broadcasts?limit=120'),
        api('/api/admin/broadcasts/summary')
    ]);
    const rows = rowsRes.data || [];
    const summary = summaryRes.data || {};
    const totals = summary.totals || {};
    const segments = summary.segments || {};
    const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];
    const lostReach = summary.lostReach || {};
    const filtered = filterBroadcasts(rows);
    const summaryFilters = [
        { id: 'all', label: 'Кампаний', value: totals.totalCampaigns },
        { id: 'successful', label: 'Успешные', value: totals.successfulCampaigns },
        { id: 'problematic', label: 'Проблемные', value: totals.problematicCampaigns },
        { id: 'running', label: 'Идут сейчас', value: totals.runningCampaigns },
        { id: 'repeatable', label: 'Стоит повторить', value: segments.repeatableCampaigns }
    ];
    const chips = [
        { id: 'all', label: 'Все' },
        { id: 'latest', label: 'Последние' },
        { id: 'successful', label: 'Успешные' },
        { id: 'problematic', label: 'Проблемные' },
        { id: 'high-reach', label: 'Высокий охват' },
        { id: 'errors', label: 'С ошибками' },
        { id: 'blocked', label: 'С блокировками' },
        { id: 'running', label: 'Идут сейчас' },
        { id: 'repeatable', label: 'Можно повторить' },
        { id: 'done', label: 'Завершенные' },
        { id: 'deleted', label: 'Удаленные' }
    ];
    return `
        ${sectionHeader('Рассылки как канал роста', 'Какие кампании работают, где теряется охват и что повторить')}
        ${renderPlaybookBanner('broadcasts')}
        <article class="card">
            <div class="kpi-label">Доставлено сообщений</div>
            <div class="kpi-value">${formatNum(totals.deliveredMessages)}</div>
            <div class="kpi-note">Потерянный охват: ${formatNum(totals.lostReachCount)} · Блокировки: ${formatNum(totals.blockedMessages)}</div>
        </article>

        <div class="broadcasts-summary-strip">
            ${summaryFilters.map((item) => `
                <button class="broadcast-summary-chip ${(state.broadcastsFilter || 'all') === item.id ? 'active' : ''}" data-action="broadcasts-filter" data-value="${esc(item.id)}">
                    <span>${esc(item.label)}</span>
                    <strong>${formatNum(item.value)}</strong>
                </button>
            `).join('')}
        </div>

        <div class="chips">
            ${chips.map((chip) => `<button class="chip ${(state.broadcastsFilter || 'all') === chip.id ? 'active' : ''}" data-action="broadcasts-filter" data-value="${esc(chip.id)}">${esc(chip.label)}</button>`).join('')}
        </div>

        <article class="list-card">
            <h3 class="list-card-title">Что важно по рассылкам</h3>
            <p class="list-card-meta">Проблемные: ${formatNum(totals.problematicCampaigns)} · Успешные: ${formatNum(totals.successfulCampaigns)} · Повторить: ${formatNum(segments.repeatableCampaigns)}</p>
            <p class="list-card-meta">Потерянный охват: ${formatNum(lostReach.totalLostReach)} · Ошибки: ${formatNum(lostReach.failedMessages)} · Блокировки: ${formatNum(lostReach.blockedMessages)}</p>
        </article>
        ${renderPlaybookCards({ source: 'Рассылки', target: 'broadcasts', limit: 2 })}

        ${highlights.slice(0, 4).map((item) => `
            <article class="list-card attention ${esc(item.tone || 'watch')}">
                <h3 class="list-card-title">${esc(item.title)}</h3>
                <p class="list-card-meta">${esc(item.description || '')}</p>
                <div class="list-card-footer">
                    <strong>${esc(item.valueLabel || '')}</strong>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.actionLabel || 'Открыть')}</button>
                </div>
            </article>
        `).join('')}

        <article class="list-card">
            <h3 class="list-card-title">Потерянный охват</h3>
            ${Array.isArray(lostReach.topCampaigns) && lostReach.topCampaigns.length ? lostReach.topCampaigns.map((item) => `
                <div class="list-card-footer">
                    <span class="mono">#${esc(item.campaignId)} · Потеря ${formatNum(item.lostReach)} (блок ${formatNum(item.blocked)} · ошиб ${formatNum(item.failed)})</span>
                    <button class="secondary" data-action="broadcast-open" data-id="${esc(item.campaignId)}">Открыть</button>
                </div>
            `).join('') : '<p class="list-card-meta">Потерянный охват не зафиксирован.</p>'}
        </article>

        <div class="list-card-meta">Показано: ${formatNum(filtered.length)} из ${formatNum(rows.length)}</div>
        ${filtered.length ? filtered.map((row) => {
            const id = Number(row.id);
            const tierTone = row.is_problematic ? 'alert' : (row.is_repeatable_candidate ? 'ok' : 'info');
            const subtitle = row.campaign_subtitle || 'Кампания в обработке';
            return `
                <article class="list-card broadcast-card ${esc(row.campaign_attention_level || 'watch')}">
                    <h3 class="list-card-title">Кампания #${id}</h3>
                    <p class="list-card-meta">${esc(subtitle)}</p>
                    <p class="list-card-meta">Инициатор: ${esc(row.initiated_by_telegram_id || 'не указан')} · ${esc(formatDateTime(row.created_at))}</p>
                    <div class="list-card-footer">
                        ${statusBadge(row.status || '—', getBroadcastTone(row.status))}
                        ${statusBadge(row.estimated_outcome_label || 'Нейтрально', tierTone)}
                        <span class="list-card-meta">Score ${formatNum(row.campaign_quality_score || 0)}</span>
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Охват: ${formatNum(row.total_recipients)} · Доставлено: ${formatNum(row.delivered_count)} (${esc(String(row.delivered_pct || 0))}%)</span>
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Ошибки: ${formatNum(row.failed_count)} (${esc(String(row.failed_pct || 0))}%) · Блокировки: ${formatNum(row.blocked_count)} (${esc(String(row.blocked_pct || 0))}%)</span>
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Потерянный охват: ${formatNum(row.lost_reach_count)}</span>
                        <span class="list-card-meta">${esc(row.campaign_attention_reason || '')}</span>
                    </div>
                    <div class="list-card-footer">
                        <button class="secondary" data-action="broadcast-open" data-id="${id}">Открыть</button>
                        <button class="secondary" data-action="broadcast-repeatable-focus">Повторить</button>
                        <button data-action="broadcast-delete" data-id="${id}">Удалить у всех</button>
                    </div>
                </article>
            `;
        }).join('') : (rows.length === 0
            ? emptyState('Рассылок пока нет', 'После первых запусков здесь появится growth-контур по охвату и качеству канала.')
            : (renderPlaybookCalmState('broadcasts') || `<article class="state-card calm"><h3 class="list-card-title">По этому срезу всё спокойно</h3><p class="list-card-meta">Кампаний по текущему фильтру нет. Можно переключиться на общий список или другой срез.</p><button class="mt-2 secondary" data-action="broadcasts-filter" data-value="all">Показать все кампании</button></article>`)
        )}
    `;
}

async function renderBroadcastDetailScreen() {
    const id = Number(state.selectedBroadcastId || 0);
    if (!id) {
        return emptyState('Кампания не выбрана', 'Откройте карточку из экрана рассылок.', 'К списку рассылок', 'broadcasts');
    }

    if (!state.broadcastDetails[id]) {
        try {
            const data = (await api(`/api/admin/broadcasts/${id}`)).data;
            state.broadcastDetails[id] = data;
        } catch (e) {
            if (String(e.message || '').includes('NOT_FOUND')) {
                return emptyState('Кампания не найдена', 'Возможно, она была удалена или недоступна.', 'К списку рассылок', 'broadcasts');
            }
            throw e;
        }
    }

    const detail = state.broadcastDetails[id];
    if (!detail || !detail.campaign) {
        return emptyState('Недостаточно данных по кампании', 'Детальные метрики пока не готовы. Проверьте позже.', 'К списку рассылок', 'broadcasts');
    }

    const campaign = detail.campaign || {};
    const deliveryQuality = detail.delivery_quality || {};
    const breakdown = detail.recipient_breakdown || {};
    const lostReach = detail.lost_reach || {};
    const insights = Array.isArray(detail.quality_insights) ? detail.quality_insights : [];
    const nextActions = Array.isArray(detail.next_actions) ? detail.next_actions : [];
    const errorSummary = detail.error_summary || {};
    const details = detail.details || {};
    const deliveries = Array.isArray(detail.deliveries) ? detail.deliveries : [];
    const problematicDeliveries = deliveries
        .filter((item) =>
            ['FAILED', 'FAILED_PERMANENT', 'BLOCKED'].includes(String(item.status || '').toUpperCase())
        )
        .slice(0, 6);

    const totalRecipients = Number(breakdown.total_recipients || campaign.total_recipients || 0);
    const failedCount = Number(breakdown.failed_count || campaign.failed_count || 0);
    const blockedCount = Number(breakdown.blocked_count || campaign.blocked_count || 0);
    const lostReachCount = Number(lostReach.lost_reach_count || campaign.lost_reach_count || (failedCount + blockedCount));
    const deleteForAllCount = Number(details.delete_for_all_count || campaign.delete_for_all_count || 0);
    const sourcePreview = details.source_preview || {};
    const repeatabilityStatus = campaign.repeatability_status || 'improve_and_repeat';
    const repeatabilityReason = campaign.repeatability_reason || 'Оцените качество доставки и риски перед повтором.';

    return `
        ${sectionHeader('Карточка кампании', 'Качество канала, потери охвата и практические действия')}
        ${renderPlaybookBanner('broadcast_detail')}

        <article class="broadcast-detail-hero">
            <div class="list-card-footer">
                <div>
                    <h2 class="broadcast-detail-title">Кампания #${id}</h2>
                    <p class="list-card-meta">Запуск: ${esc(formatDateTime(campaign.created_at))}</p>
                </div>
                <div class="broadcast-detail-score">
                    <div class="kpi-label">Quality score</div>
                    <div class="kpi-value">${formatNum(campaign.campaign_quality_score || 0)}</div>
                </div>
            </div>
            <p class="broadcast-detail-subtitle">${esc(campaign.subtitle || campaign.campaign_subtitle || 'Кампания в рабочем диапазоне')}</p>
            <div class="order-meta-row">
                ${statusBadge(campaign.status || '—', getBroadcastTone(campaign.status))}
                ${statusBadge(broadcastHealthLabel(campaign.campaign_health), campaign.is_problematic ? 'alert' : 'ok')}
                ${statusBadge(`Tier: ${broadcastTierLabel(campaign.campaign_tier)}`, campaign.is_problematic ? 'warn' : 'info')}
                ${statusBadge(repeatabilityLabel(repeatabilityStatus), repeatabilityTone(repeatabilityStatus))}
            </div>
            <p class="list-card-meta mt-2">${esc(repeatabilityReason)}</p>
        </article>

        ${sectionHeader('Качество доставки', 'Насколько полно кампания коснулась аудитории')}
        <article class="list-card">
            <div class="broadcast-metric-grid">
                ${kpiCard('Получатели', formatNum(totalRecipients), 'База кампании')}
                ${kpiCard('Доставлено', formatNum(breakdown.delivered_count || campaign.delivered_count || 0), `${esc(String(deliveryQuality.delivered_pct || campaign.delivered_pct || 0))}%`)}
                ${kpiCard('Ошибки', formatNum(failedCount), `${esc(String(deliveryQuality.failed_pct || campaign.failed_pct || 0))}%`)}
                ${kpiCard('Блокировки', formatNum(blockedCount), `${esc(String(deliveryQuality.blocked_pct || campaign.blocked_pct || 0))}%`)}
            </div>
        </article>

        ${sectionHeader('Потерянный охват', 'Это не просто ошибки, это потеря касания с клиентами')}
        <article class="list-card lost-reach-focus ${lostReachCount > 0 ? 'warn' : 'ok'}">
            <div class="list-card-footer">
                <h3 class="list-card-title">Потеряно касаний: ${formatNum(lostReachCount)}</h3>
                ${statusBadge(`${esc(String(lostReach.lost_reach_pct || campaign.lost_reach_pct || 0))}%`, lostReachCount > 0 ? 'warn' : 'ok')}
            </div>
            <p class="list-card-meta">${esc(lostReach.summary_text || 'Потерянный охват не зафиксирован.')}</p>
            <div class="list-card-footer">
                <span class="list-card-meta">Ошибки: ${formatNum(failedCount)}</span>
                <span class="list-card-meta">Блокировки: ${formatNum(blockedCount)}</span>
            </div>
        </article>

        ${sectionHeader('Интерпретация роста', 'Почему кампания сильная или проблемная')}
        <article class="list-card">
            <div class="list-card-footer">
                <strong>${esc(repeatabilityLabel(repeatabilityStatus))}</strong>
                ${statusBadge(broadcastTierLabel(campaign.campaign_tier), campaign.is_problematic ? 'warn' : 'ok')}
            </div>
            <p class="list-card-meta">${esc(repeatabilityReason)}</p>
            ${insights.length ? insights.map((item) => `
                <div class="broadcast-insight-row ${esc(item.tone || 'info')}">
                    <div class="list-card-footer">
                        <strong>${esc(item.title || 'Инсайт кампании')}</strong>
                        ${statusBadge(item.priority || 'medium', insightTone(item.tone))}
                    </div>
                    <p class="list-card-meta">${esc(item.message || '')}</p>
                    ${item.cta && item.cta.action
                        ? `<button class="secondary mt-2" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.cta.action))}">${esc(item.cta.label || 'Открыть')}</button>`
                        : ''}
                </div>
            `).join('') : '<p class="list-card-meta">Для этой кампании пока нет дополнительных выводов.</p>'}
        </article>

        ${sectionHeader('Что делать дальше', 'Быстрые действия по кампании')}
        <article class="list-card">
            <div class="broadcast-action-stack">
                <button data-action="launch-playbook" data-id="repeat_strong_campaign" data-source="Карточка рассылки">Повторить сильную кампанию</button>
                <button class="secondary" data-action="launch-playbook" data-id="lost_reach_reduction" data-source="Карточка рассылки">Снизить потерянный охват</button>
                <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' } }))}">Использовать как основу</button>
                <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: 'broadcasts', filters: { broadcastsFilter: 'errors' } }))}">Открыть ошибки</button>
                <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload({ screen: 'broadcasts', filters: { broadcastsFilter: 'all' } }))}">Открыть получателей / сегмент</button>
                <button class="secondary" data-action="broadcast-delete" data-id="${id}">Удалить у всех</button>
                <button class="secondary" data-action="broadcast-back">Назад к рассылкам</button>
            </div>
            ${nextActions.length ? `
                <div class="broadcast-next-rows">
                    ${nextActions.map((item) => `
                        <div class="broadcast-next-row ${esc(item.priority || 'medium')}">
                            <div class="list-card-title">${esc(item.title || 'Следующий шаг')}</div>
                            <p class="list-card-meta">${esc(item.message || '')}</p>
                            ${item.action ? `<button class="secondary mt-2" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.ctaLabel || 'Открыть')}</button>` : ''}
                        </div>
                    `).join('')}
                </div>
            ` : '<p class="list-card-meta mt-2">Сейчас дополнительных действий не требуется.</p>'}
        </article>

        ${sectionHeader('Детали кампании', 'Вторичный слой: ошибки, длительность, технические детали')}
        <article class="list-card">
            <div class="list-card-footer">
                <span class="list-card-meta">Завершена: ${esc(formatDateTime(details.completed_at || campaign.completed_at))}</span>
                <span class="list-card-meta">Длительность: ${esc(details.duration_label || '—')}</span>
            </div>
            <div class="list-card-footer">
                <span class="list-card-meta">Delete-for-all: ${formatNum(deleteForAllCount)}</span>
                <span class="list-card-meta">Последняя ошибка: ${esc(errorSummary.last_error_summary ? 'есть' : 'нет')}</span>
            </div>
            ${errorSummary.last_error_summary
                ? `<p class="list-card-meta mt-2">${esc(errorSummary.last_error_summary)}</p>`
                : '<p class="list-card-meta mt-2">Ошибок доставки не зафиксировано.</p>'}
            ${Array.isArray(errorSummary.top_error_types) && errorSummary.top_error_types.length ? `
                <div class="broadcast-errors-list">
                    ${errorSummary.top_error_types.map((row) => `
                        <div class="list-card-footer">
                            <span class="list-card-meta">${esc(row.label || row.key)}</span>
                            <span class="list-card-meta">${formatNum(row.count)} · ${esc(String(row.pct || 0))}%</span>
                        </div>
                    `).join('')}
                </div>
            ` : '<p class="list-card-meta mt-2">Топ ошибок пока пуст: критичных отклонений нет.</p>'}
            <p class="list-card-meta mt-2">Источник: chat ${esc(sourcePreview.source_chat_id || '—')} · msg ${formatNum(sourcePreview.source_message_id || 0)} · thread ${sourcePreview.source_thread_id ? formatNum(sourcePreview.source_thread_id) : '—'}</p>
            ${deleteForAllCount > 0
                ? `<p class="list-card-meta mt-2">Сообщений удалено у получателей: ${formatNum(deleteForAllCount)}</p>`
                : '<p class="list-card-meta mt-2">Delete-for-all ещё не запускался.</p>'}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Проблемные получатели</h3>
            ${problematicDeliveries.length ? problematicDeliveries.map((item) => `
                <div class="list-card-footer">
                    <span class="mono">${esc(item.recipient_telegram_id || '—')}</span>
                    <span class="list-card-meta">${esc(String(item.status || 'FAILED'))}</span>
                </div>
            `).join('') : '<p class="list-card-meta">Нет проблемных получателей в последних событиях.</p>'}
        </article>
    `;
}

async function renderMoreScreen() {
    return `
        ${sectionHeader('Разделы второго уровня', 'Служебные и углубленные экраны спрятаны в "Ещё"')}
        <article class="action-card">
            <h3 class="list-card-title">Центр действий</h3>
            <p class="list-card-meta">Что важнее всего сделать сегодня по деньгам, клиентам и рискам.</p>
            <button data-go="actions">Открыть действия</button>
        </article>
        <article class="action-card">
            <h3 class="list-card-title">Поддержка</h3>
            <p class="list-card-meta">Кто ждёт ответа и где риск потери клиента.</p>
            <button data-go="support">Открыть поддержку</button>
        </article>
        <article class="action-card">
            <h3 class="list-card-title">Аналитика</h3>
            <p class="list-card-meta">Заготовка для динамики продаж и воронки.</p>
            <button data-go="analytics">Открыть аналитику</button>
        </article>
        <article class="action-card">
            <h3 class="list-card-title">Темы клиентов</h3>
            <p class="list-card-meta">Навигация по клиентским темам Telegram.</p>
            <button data-go="topics">Открыть темы</button>
        </article>
        <article class="action-card">
            <h3 class="list-card-title">Система</h3>
            <p class="list-card-meta">Наблюдаемость, флаги и аудит действий.</p>
            <button data-go="system">Открыть систему</button>
        </article>
    `;
}

function filterSupportRows(rows) {
    const f = String(state.supportFilter || 'all').toLowerCase();
    if (f === 'all') return rows;
    if (f === 'waiting') return rows.filter((r) => !!r.is_waiting_response);
    if (f === 'critical') return rows.filter((r) => !!r.is_critical);
    if (f === 'vip') return rows.filter((r) => !!r.is_vip_client);
    if (f === 'new') return rows.filter((r) => !!r.is_new_client);
    if (f === 'repeat') return rows.filter((r) => !!r.is_repeat_client);
    if (f === 'vip_waiting') return rows.filter((r) => !!r.is_vip_client && !!r.is_waiting_response);
    if (f === 'attention') return rows.filter((r) => String(r.support_attention_level || 'normal') !== 'normal');
    if (f === 'active') return rows.filter((r) => !!r.is_open_thread);
    if (f === 'closed') return rows.filter((r) => !r.is_open_thread);
    if (f === 'with_orders') return rows.filter((r) => !!r.has_orders);
    return rows;
}

async function renderSupportScreen() {
    const [rowsRes, summaryRes] = await Promise.all([
        api('/api/admin/support/threads?limit=140'),
        api('/api/admin/support/summary')
    ]);
    const rows = rowsRes.data || [];
    const summary = summaryRes.data || {};
    const totals = summary.totals || {};
    const segments = summary.segments || {};
    const lossRisk = summary.lossRisk || {};
    const highlights = Array.isArray(summary.highlights) ? summary.highlights : [];

    const filtered = filterSupportRows(rows);
    const scoped = state.supportClientTelegramId
        ? filtered.filter((thread) => String(thread.telegram_user_id || '') === state.supportClientTelegramId)
        : filtered;

    const summaryFilters = [
        { id: 'all', label: 'Активные', value: totals.active },
        { id: 'waiting', label: 'Ждут ответа', value: totals.waiting },
        { id: 'critical', label: 'Критичные', value: totals.critical },
        { id: 'vip', label: 'VIP', value: totals.vip },
        { id: 'new', label: 'Новые', value: totals.newClients }
    ];
    const chips = [
        { id: 'all', label: 'Все' },
        { id: 'waiting', label: 'Ждут ответа' },
        { id: 'critical', label: 'Критичные' },
        { id: 'vip', label: 'VIP' },
        { id: 'vip_waiting', label: 'VIP без ответа' },
        { id: 'new', label: 'Новые' },
        { id: 'repeat', label: 'Повторные' },
        { id: 'active', label: 'Активные' },
        { id: 'closed', label: 'Закрытые' },
        { id: 'with_orders', label: 'С заказами' },
        { id: 'attention', label: 'Требуют внимания' }
    ];

    return `
        ${sectionHeader('Поддержка как удержание', 'Кто ждет ответа, где риск потери и кого открыть первым')}
        ${renderPlaybookBanner('support')}
        <article class="card">
            <div class="kpi-label">Сервисный пульс</div>
            <div class="kpi-value">${formatNum(totals.active)}</div>
            <div class="kpi-note">Ждут ответа: ${formatNum(totals.waiting)} · Критичные: ${formatNum(totals.critical)} · VIP в поддержке: ${formatNum(totals.vip)}</div>
            <div class="kpi-note">Среднее ожидание: ${formatNum(totals.avgWaitingMinutes)} мин · Первый ответ: ${formatNum(totals.avgFirstResponseMinutes)} мин</div>
        </article>

        <div class="support-summary-strip">
            ${summaryFilters.map((item) => `
                <button class="support-summary-chip ${state.supportFilter === item.id ? 'active' : ''}" data-action="support-filter" data-value="${esc(item.id)}">
                    <span>${esc(item.label)}</span>
                    <strong>${formatNum(item.value)}</strong>
                </button>
            `).join('')}
        </div>

        <div class="chips">
            ${chips.map((chip) => `<button class="chip ${state.supportFilter === chip.id ? 'active' : ''}" data-action="support-filter" data-value="${esc(chip.id)}">${esc(chip.label)}</button>`).join('')}
        </div>

        <article class="list-card">
            <h3 class="list-card-title">Что важно по поддержке</h3>
            <p class="list-card-meta">Без ответа: ${formatNum(totals.waiting)} · VIP ждут: ${formatNum(lossRisk.vipWaiting)} · Новые клиенты в поддержке: ${formatNum(totals.newClients)}</p>
            <p class="list-card-meta">В риске потери: ${formatNum(lossRisk.waitingTooLong)} · Требуют внимания: ${formatNum(segments.attention)}</p>
        </article>
        ${renderPlaybookCards({ source: 'Поддержка', target: 'support', limit: 2 })}

        ${highlights.slice(0, 4).map((item) => `
            <article class="list-card attention ${esc(item.tone || 'watch')}">
                <h3 class="list-card-title">${esc(item.title)}</h3>
                <p class="list-card-meta">${esc(item.description || '')}</p>
                <div class="list-card-footer">
                    <strong>${esc(item.valueLabel || '')}</strong>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">${esc(item.actionLabel || 'Открыть')}</button>
                </div>
            </article>
        `).join('')}

        <article class="list-card">
            <h3 class="list-card-title">Риск потери клиента</h3>
            ${Array.isArray(lossRisk.topRiskDialogs) && lossRisk.topRiskDialogs.length ? lossRisk.topRiskDialogs.map((item) => `
                <div class="list-card-footer">
                    <span class="mono">#${esc(item.threadId)} · ${esc(item.client)} · ждет ${formatNum(item.waitingMinutes)} мин</span>
                    <button class="secondary" data-action="support-open" data-id="${esc(item.threadId)}">Открыть</button>
                </div>
            `).join('') : '<p class="list-card-meta">Диалогов с повышенным риском сейчас нет.</p>'}
        </article>

        ${state.supportClientTelegramId ? `
            <article class="state-card">
                <h3 class="list-card-title">Фокус на поддержке клиента</h3>
                <p class="list-card-meta">Telegram ID: ${esc(state.supportClientTelegramId)}</p>
                <button class="mt-2 secondary" data-action="support-scope-clear">Показать все диалоги</button>
            </article>
        ` : ''}

        <div class="list-card-meta">Показано: ${formatNum(scoped.length)} из ${formatNum(rows.length)}</div>
        ${scoped.length ? scoped.map((thread) => {
            const id = Number(thread.id);
            const detail = state.supportDetails[id] || null;
            const tone = thread.is_critical ? 'alert' : (thread.is_waiting_response ? 'warn' : 'info');
            const topicLink = thread.topic_link || buildTopicLink(thread.topic_chat_id, thread.topic_thread_id || thread.message_thread_id);
            const clientId = String(thread.telegram_user_id || '');
            const clientName = thread.client_name || clientId || 'Клиент';
            return `
                <article class="list-card support-card ${esc(thread.support_attention_level || 'normal')}">
                    <div class="list-card-footer">
                        <h3 class="list-card-title">${esc(clientName)}</h3>
                        <strong>${formatNum(thread.waiting_minutes || 0)} мин</strong>
                    </div>
                    <p class="list-card-meta">${esc(thread.support_subtitle || 'Диалог поддержки')}</p>
                    <div class="order-meta-row">
                        ${statusBadge(thread.is_waiting_response ? 'Ждет ответа' : 'В работе', tone)}
                        ${thread.is_vip_client ? statusBadge('VIP', 'warn') : ''}
                        ${thread.is_new_client ? statusBadge('Новый', 'ok') : ''}
                        ${thread.is_repeat_client ? statusBadge('Повторный', 'info') : ''}
                        ${thread.has_recent_order ? statusBadge('Недавний заказ', 'warn') : ''}
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Заказов клиента: ${formatNum(thread.client_orders_count)} · Выручка: ${formatKopecksAsRub(thread.client_total_revenue)}</span>
                        <span class="list-card-meta">${esc(thread.support_attention_reason || 'Под контролем')}</span>
                    </div>
                    <div class="list-card-footer">
                        <span class="list-card-meta">Последнее сообщение: ${esc(formatDateTime(thread.last_message_at || thread.updated_at || thread.created_at))}</span>
                        <span class="list-card-meta">Диалог #${id}</span>
                    </div>
                    <div class="order-actions">
                        ${topicLink ? `<a class="order-topic-link" href="${esc(topicLink)}" target="_blank" rel="noopener">Тема</a>` : '<span class="list-card-meta">Тема недоступна</span>'}
                        <button class="secondary" data-action="support-open-client" data-id="${esc(clientId)}">Клиент</button>
                        <button class="secondary" data-action="client-open-orders" data-id="${esc(clientId)}">Заказы</button>
                        <button data-action="support-open" data-id="${id}">Открыть</button>
                    </div>
                    ${detail ? `
                        <div class="card mt-2">
                            <div class="kpi-label">Сообщения</div>
                            ${(detail.messages || []).slice(0, 4).map((m) => `<div class="mono">${esc(m.direction)} · ${esc(m.status)} · ${esc(String(m.created_at || '').slice(0, 16))}</div>`).join('')}
                        </div>
                    ` : ''}
                </article>
            `;
        }).join('') : (rows.length === 0
            ? emptyState('Обращений пока нет', 'Когда появятся диалоги, здесь будет retention-контроль поддержки.')
            : (renderPlaybookCalmState('support') || `<article class="state-card calm"><h3 class="list-card-title">Поддержка под контролем</h3><p class="list-card-meta">По выбранному фильтру нет открытых рисков. Можно вернуться к общему списку.</p><button class="mt-2 secondary" data-action="support-filter" data-value="all">Показать все диалоги</button></article>`)
        )}
        <div class="screen-footer-actions">
            <button type="button" data-go="home">Вернуться на главную</button>
            <button type="button" class="secondary" data-action="support-filter" data-value="critical">Открыть критичные</button>
        </div>
    `;
}

async function renderAnalyticsScreen() {
    const data = (await api(`/api/admin/analytics/summary?period=${encodeURIComponent(state.analyticsPeriod || '7d')}`)).data || {};
    const totals = data.totals || {};
    const sections = data.sections || {};
    const comparisons = data.comparisons || {};
    const charts = data.charts || {};
    const growthSignals = Array.isArray(data.growthSignals) ? data.growthSignals : [];
    const riskSignals = Array.isArray(data.riskSignals) ? data.riskSignals : [];
    const insights = Array.isArray(data.insights) ? data.insights : [];
    const periods = [
        { id: 'today', label: 'Сегодня' },
        { id: '7d', label: '7 дней' },
        { id: '30d', label: '30 дней' },
        { id: '90d', label: '90 дней' }
    ];
    const trendCards = [
        { key: 'revenue', label: 'Выручка', unit: 'money' },
        { key: 'orders', label: 'Заказы', unit: 'num' },
        { key: 'avgCheck', label: 'Средний чек', unit: 'money' },
        { key: 'repeatOrders', label: 'Повторные продажи', unit: 'num' }
    ];
    const sectionOrder = sections.orders || {};
    const sectionClients = sections.clients || {};
    const sectionBroadcasts = sections.broadcasts || {};
    const sectionSupport = sections.support || {};

    return `
        ${sectionHeader('Аналитика решений', 'Что растет, что падает и куда смотреть в первую очередь')}
        ${renderPlaybookBanner('analytics')}

        <div class="chips">
            ${periods.map((p) => `<button class="chip ${state.analyticsPeriod === p.id ? 'active' : ''}" data-action="analytics-period" data-value="${p.id}">${esc(p.label)}</button>`).join('')}
        </div>

        <article class="big-kpi-card">
            <div class="kpi-label">Executive summary периода</div>
            <div class="kpi-value">${formatKopecksAsRub(totals.revenue)}</div>
            <div class="kpi-note">Заказы: ${formatNum(totals.orders)} · Средний чек: ${formatKopecksAsRub(totals.avgCheck)} · Повторные: ${formatNum(totals.repeatOrders)}</div>
            <div class="kpi-note">К прошлому периоду: выручка ${formatSignedPercent(comparisons.revenue && comparisons.revenue.deltaPct)} · заказы ${formatSignedPercent(comparisons.orders && comparisons.orders.deltaPct)}</div>
        </article>

        <div class="grid-2">
            ${trendCards.map((card) => {
                const cmp = comparisons[card.key] || {};
                const val = card.unit === 'money' ? formatKopecksAsRub(cmp.current || 0) : formatNum(cmp.current || 0);
                return `
                    <article class="card">
                        <div class="kpi-label">${esc(card.label)}</div>
                        <div class="kpi-value">${val}</div>
                        <div class="metric-inline">
                            ${statusBadge(formatSignedPercent(cmp.deltaPct), toneByDelta(cmp.deltaPct))}
                            <span>${esc(cmp.interpretation || 'Без изменений')}</span>
                        </div>
                    </article>
                `;
            }).join('')}
        </div>

        <article class="list-card">
            <h3 class="list-card-title">Точки роста</h3>
            ${growthSignals.length ? growthSignals.map((item) => `
                <div class="list-card-footer">
                    <span class="list-card-meta">${esc(item.title)} · <strong>${esc(item.valueLabel || '')}</strong></span>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">Открыть</button>
                </div>
            `).join('') : '<p class="list-card-meta">Пока нет выраженных позитивных сигналов роста за выбранный период.</p>'}
        </article>
        ${renderPlaybookCards({ source: 'Аналитика', limit: 3 })}

        <article class="list-card attention important">
            <h3 class="list-card-title">Тревожные зоны</h3>
            ${riskSignals.length ? riskSignals.map((item) => `
                <div class="list-card-footer">
                    <span class="list-card-meta">${esc(item.title)} · <strong>${esc(item.valueLabel || '')}</strong></span>
                    <button class="secondary" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(item.action))}">Разобрать</button>
                </div>
            `).join('') : '<p class="list-card-meta">Критичных просадок по ключевым прокси-метрикам не обнаружено.</p>'}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Бизнес-выводы</h3>
            ${insights.length ? insights.map((ins) => `
                <div class="client-timeline-item">
                    <div class="list-card-footer">
                        <strong>${esc(ins.title || '')}</strong>
                        ${statusBadge(ins.priority || 'normal', (ins.tone === 'alert' ? 'alert' : (ins.tone === 'warn' ? 'warn' : (ins.tone === 'ok' ? 'ok' : 'info'))))}
                    </div>
                    <p class="list-card-meta">${esc(ins.message || '')}</p>
                    ${ins.action ? `<button class="secondary mt-2" data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(ins.action))}">Открыть связанный экран</button>` : ''}
                </div>
            `).join('') : '<p class="list-card-meta">Пока недостаточно данных для устойчивых выводов.</p>'}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">5 бизнес-блоков периода</h3>
            <p class="list-card-meta">Деньги: ${formatKopecksAsRub(sections.money && sections.money.revenue)} · Заказы: ${formatNum(sectionOrder.total)} · Конверсия в оплату: ${formatNum(sectionOrder.conversionPct)}%</p>
            <p class="list-card-meta">Клиенты: новые ${formatNum(sectionClients.new)} · повторные ${formatNum(sectionClients.repeat)} · VIP ${formatNum(sectionClients.vip)} · спящие ${formatNum(sectionClients.sleeping)}</p>
            <p class="list-card-meta">Рассылки: кампаний ${formatNum(sectionBroadcasts.campaigns)} · потерянный охват ${formatNum(sectionBroadcasts.lostReach)} · проблемные ${formatNum(sectionBroadcasts.problematic)}</p>
            <p class="list-card-meta">Поддержка: активные ${formatNum(sectionSupport.active)} · ждут ответа ${formatNum(sectionSupport.waiting)} · средний первый ответ ${formatNum(sectionSupport.avgFirstResponse)} мин</p>
        </article>

        <div class="grid-2">
            ${Array.isArray(charts.revenueByDay) && charts.revenueByDay.length ? compactChartCard(charts.revenueByDay, 'Выручка по дням', 'value') : ''}
            ${Array.isArray(charts.ordersByDay) && charts.ordersByDay.length ? compactChartCard(charts.ordersByDay, 'Заказы по дням', 'value') : ''}
            ${Array.isArray(charts.avgCheckByDay) && charts.avgCheckByDay.length ? compactChartCard(charts.avgCheckByDay, 'Средний чек по дням', 'value') : ''}
        </div>

        <div class="grid-2">
            <article class="action-card">
                <h3 class="list-card-title">Проблемные заказы</h3>
                <p class="list-card-meta">Разобрать неоплаченные и рисковые заказы.</p>
                <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(data.actionTargets && data.actionTargets.unpaidOrders))}">Открыть</button>
            </article>
            <article class="action-card">
                <h3 class="list-card-title">Спящие клиенты</h3>
                <p class="list-card-meta">Вернуть клиентов с паузой в покупках.</p>
                <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(data.actionTargets && data.actionTargets.sleepingClients))}">Открыть</button>
            </article>
            <article class="action-card">
                <h3 class="list-card-title">Проблемные рассылки</h3>
                <p class="list-card-meta">Проверить кампании с потерянным охватом.</p>
                <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(data.actionTargets && data.actionTargets.problematicBroadcasts))}">Открыть</button>
            </article>
            <article class="action-card">
                <h3 class="list-card-title">Поддержка без ответа</h3>
                <p class="list-card-meta">Снизить риск потери клиента в сервисе.</p>
                <button data-action="apply-nav-action" data-nav-action="${esc(encodeActionPayload(data.actionTargets && data.actionTargets.waitingSupport))}">Открыть</button>
            </article>
        </div>
    `;
}

async function renderTopicsScreen() {
    const rows = (await api('/api/admin/topics?limit=120')).data || [];
    return `
        ${sectionHeader('Клиентские темы', 'Быстрый доступ к Telegram-темам')}
        ${rows.length ? rows.map((topic) => {
            const link = buildTopicLink(topic.chat_id, topic.message_thread_id);
            return `
                <article class="list-card">
                    <h3 class="list-card-title">${esc(topic.topic_key || `Тема #${topic.id}`)}</h3>
                    <p class="list-card-meta">Клиент: ${esc(topic.telegram_user_id || 'не указан')}</p>
                    <div class="list-card-footer">
                        ${statusBadge(topic.is_active ? 'Активна' : 'Неактивна', topic.is_active ? 'ok' : 'warn')}
                        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Открыть в Telegram</a>` : '<span class="list-card-meta">Ссылка недоступна</span>'}
                    </div>
                </article>
            `;
        }).join('') : emptyState('Тем пока нет', 'Когда появятся активные темы клиентов, они появятся здесь.')}
    `;
}

async function renderSystemScreen() {
    const [healthRes, flagsRes, outboxRes, auditRes] = await Promise.all([
        api('/api/admin/health'),
        api('/api/admin/feature-flags'),
        api('/api/admin/outbox?limit=40'),
        api('/api/admin/audit-log?limit=30')
    ]);
    const health = healthRes.data || {};
    const flags = flagsRes.data || {};
    const outbox = outboxRes.data || [];
    const audit = auditRes.data || [];
    return `
        ${sectionHeader('Система и наблюдаемость', 'Служебный уровень, спрятанный глубже навигации')}
        <article class="list-card">
            <h3 class="list-card-title">Общее состояние</h3>
            <p class="list-card-meta">Ошибки очереди: ${formatNum(health.outbox && health.outbox.failed)} · В повторе: ${formatNum(health.outbox && health.outbox.retrying)}</p>
            <p class="list-card-meta">Проблемы данных: доставок без кампании ${formatNum(health.dataIntegrity && health.dataIntegrity.orphanBroadcastDeliveries)}</p>
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Флаги</h3>
            <p class="list-card-meta">Включайте только то, что нужно для текущего шага.</p>
            <div class="screen">
                ${Object.entries(flags).map(([key, value]) => `
                    <label class="list-card-meta">
                        <input type="checkbox" data-flag="${esc(key)}" ${value ? 'checked' : ''} />
                        ${esc(key)}
                    </label>
                `).join('')}
            </div>
            <button class="mt-2" data-action="save-flags">Сохранить флаги</button>
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Outbox</h3>
            ${(outbox || []).slice(0, 8).map((item) => `
                <div class="list-card-footer">
                    <span class="mono">${esc(item.event_type)} · ${esc(item.status)} · #${esc(item.id)}</span>
                    <button class="secondary" data-action="outbox-reprocess" data-id="${esc(item.id)}">Повторить</button>
                </div>
            `).join('')}
        </article>

        <article class="list-card">
            <h3 class="list-card-title">Аудит действий</h3>
            ${(audit || []).slice(0, 8).map((item) => `<div class="mono">#${esc(item.id)} · ${esc(item.action)} · ${esc(String(item.created_at || '').slice(0, 16))}</div>`).join('')}
        </article>
    `;
}

async function renderScreenContent() {
    if (state.currentScreen === 'dashboard') return renderDashboardV2Screen();
    if (state.currentScreen === 'promo') return renderPromoScreen();
    if (state.currentScreen === 'clients_new') return renderClientsNewScreen();
    if (state.currentScreen === 'clients_all') return renderClientsAllScreen();
    if (state.currentScreen === 'client_card') return renderClientCardV2Screen();
    if (state.currentScreen === 'home') return renderHomeScreen();
    if (state.currentScreen === 'actions') return renderActionsScreen();
    if (state.currentScreen === 'orders') return renderOrdersScreen();
    if (state.currentScreen === 'clients') return renderClientsScreen();
    if (state.currentScreen === 'client_detail') return renderClientDetailScreen();
    if (state.currentScreen === 'broadcasts') return renderBroadcastsScreen();
    if (state.currentScreen === 'broadcast_detail') return renderBroadcastDetailScreen();
    if (state.currentScreen === 'more') return renderMoreScreen();
    if (state.currentScreen === 'support') return renderSupportScreen();
    if (state.currentScreen === 'analytics') return renderAnalyticsScreen();
    if (state.currentScreen === 'topics') return renderTopicsScreen();
    if (state.currentScreen === 'system') return renderSystemScreen();
    return renderDashboardV2Screen();
}

async function renderApp() {
    const root = document.getElementById('app');
    if (!root) return;
    const version = ++renderVersion;
    root.innerHTML = renderShell(loadingSkeleton());
    try {
        const content = await renderScreenContent();
        if (version !== renderVersion) return;
        state.lastRefreshedAt = new Date().toISOString();
        root.innerHTML = renderShell(content);
        bindForms();
        await hydratePromoAuthImages();
        saveUiState();
    } catch (e) {
        if (version !== renderVersion) return;
        root.innerHTML = renderShell(errorState(e.message));
    }
}

function bindForms() {
    const form = document.getElementById('clientsSearchForm');
    if (!form) return;
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const input = document.getElementById('clientsSearchInput');
        state.clientsQ = input ? String(input.value || '').trim() : '';
        renderApp();
    });
}

async function hydratePromoAuthImages() {
    const imgs = Array.from(document.querySelectorAll('img.promo-bc-await-auth[data-promo-auth-src]'));
    if (!imgs.length) return;
    const headers = telegramInitData ? { 'x-telegram-init-data': telegramInitData } : {};
    await Promise.all(
        imgs.map(async (img) => {
            if (img.dataset.promoHydrated === '1') return;
            const u = img.getAttribute('data-promo-auth-src');
            if (!u) return;
            try {
                const res = await fetch(u, { headers, credentials: 'same-origin' });
                if (!res.ok) return;
                const blob = await res.blob();
                img.src = URL.createObjectURL(blob);
                img.dataset.promoHydrated = '1';
            } catch (_) {
                /* ignore */
            }
        })
    );
}

async function openOrderDetail(orderId) {
    const id = Number(orderId);
    if (!id) return;
    if (!state.orderDetails[id]) {
        const data = (await api(`/api/admin/orders/${id}`)).data;
        state.orderDetails[id] = data;
    }
}

async function openClientDetail(telegramId) {
    const id = String(telegramId || '');
    if (!id) return;
    if (!state.clientDetails[id]) {
        const data = (await api(`/api/admin/clients/${encodeURIComponent(id)}`)).data;
        state.clientDetails[id] = data;
    }
    state.selectedClientId = id;
}

async function openSupportDetail(threadId) {
    const id = Number(threadId);
    if (!id) return;
    if (!state.supportDetails[id]) {
        const data = (await api(`/api/admin/support/threads/${id}`)).data;
        state.supportDetails[id] = data;
    }
}

async function openBroadcastDetail(campaignId) {
    const id = Number(campaignId);
    if (!id) return;
    if (!state.broadcastDetails[id]) {
        const data = (await api(`/api/admin/broadcasts/${id}`)).data;
        state.broadcastDetails[id] = data;
    }
    state.selectedBroadcastId = id;
}

async function saveFlagsFromUi() {
    const partial = {};
    document.querySelectorAll('input[data-flag]').forEach((input) => {
        partial[input.getAttribute('data-flag')] = !!input.checked;
    });
    await api('/api/admin/feature-flags', {
        method: 'PATCH',
        body: JSON.stringify(partial)
    });
    state.message = 'Флаги сохранены';
}

async function handleAction(action, value, eventTarget) {
    if (action === 'confirm-sheet') {
        return;
    }
    if (action === 'confirm-cancel') {
        closeConfirmationSheet();
        await renderApp();
        return;
    }
    if (action === 'confirm-submit') {
        if (!state.confirmation || !pendingConfirmationHandler) return;
        if (state.confirmation.loading) return;
        state.confirmation.loading = true;
        await renderApp();
        try {
            await pendingConfirmationHandler();
            closeConfirmationSheet(true);
            await renderApp();
        } catch (e) {
            closeConfirmationSheet(true);
            await renderApp();
            throw e;
        }
        return;
    }
    if (action === 'reload-screen') {
        try {
            await ensurePlaybooksSummary(true);
        } catch (_) {}
        await renderApp();
        return;
    }
    if (action === 'dash-tip-close') {
        closeDashboardMetricHelp();
        return;
    }
    if (action === 'dash-tip') {
        const id = eventTarget && eventTarget.getAttribute ? eventTarget.getAttribute('data-tip-id') : '';
        openDashboardMetricHelp(id);
        return;
    }
    if (action === 'dashboard-preset-today') {
        const today = dashYmdFromDate(new Date());
        state.dashboardDateFrom = today;
        state.dashboardDateTo = today;
        state.dashboardPreset = 'today';
        state.dashboardRangeUiError = '';
        await renderApp();
        return;
    }
    if (action === 'dashboard-preset-7d') {
        const today = dashYmdFromDate(new Date());
        state.dashboardDateFrom = dashYmdAddDays(today, -6);
        state.dashboardDateTo = today;
        state.dashboardPreset = '7d';
        state.dashboardRangeUiError = '';
        await renderApp();
        return;
    }
    if (action === 'dashboard-preset-all') {
        state.dashboardDateFrom = '2025-01-01';
        state.dashboardDateTo = dashYmdFromDate(new Date());
        state.dashboardPreset = 'all';
        state.dashboardRangeUiError = '';
        await renderApp();
        return;
    }
    if (action === 'dashboard-open-orders') {
        navigateTo('orders');
        return;
    }
    if (action === 'orders-back') {
        navigateTo('dashboard');
        return;
    }
    if (action === 'dashboard-open-new-clients') {
        navigateTo('clients_new');
        return;
    }
    if (action === 'dashboard-open-all-clients') {
        navigateTo('clients_all');
        return;
    }
    if (action === 'open-client-v2-card') {
        const id = String(value || '').trim();
        if (!id) return;
        const list =
            eventTarget && eventTarget.getAttribute ? String(eventTarget.getAttribute('data-list') || '') : '';
        state.selectedClientId = id;
        state.clientListReturnScreen = list === 'all' ? 'clients_all' : 'clients_new';
        delete state.clientV2DetailById[id];
        navigateTo('client_card');
        return;
    }
    if (action === 'client-card-back') {
        navigateTo(state.clientListReturnScreen === 'clients_all' ? 'clients_all' : 'clients_new');
        return;
    }
    if (action === 'mini-stack-back') {
        navigateTo('dashboard');
        return;
    }
    if (action === 'client-open-full-profile') {
        const id = String(state.selectedClientId || '').trim();
        if (!id) return;
        state.clientsContextFilter = state.clientFilter;
        state.clientsContextQ = state.clientsQ;
        state.clientDetailTab = 'orders';
        await openClientDetail(id);
        navigateTo('client_detail');
        return;
    }
    if (action === 'dashboard-apply-range') {
        const frEl = document.getElementById('dash-date-from');
        const toEl = document.getElementById('dash-date-to');
        const nf = frEl ? String(frEl.value || '').trim() : '';
        const nt = toEl ? String(toEl.value || '').trim() : '';
        if (!dashIsValidYmd(nf) || !dashIsValidYmd(nt)) {
            state.dashboardRangeUiError = 'Выберите корректные даты.';
            await renderApp();
            return;
        }
        if (nf > nt) {
            state.dashboardRangeUiError = 'Дата «С» не может быть позже «По».';
            await renderApp();
            return;
        }
        state.dashboardDateFrom = nf;
        state.dashboardDateTo = nt;
        state.dashboardPreset = '';
        state.dashboardRangeUiError = '';
        await renderApp();
        return;
    }
    if (action === 'open-storefront') {
        returnToStorefront();
        return;
    }
    if (action === 'orders-filter') {
        state.orderFilter = value || 'all';
        await renderApp();
        return;
    }
    if (action === 'orders-scope-clear') {
        state.orderClientTelegramId = '';
        await renderApp();
        return;
    }
    if (action === 'clients-filter') {
        state.clientFilter = value || 'all';
        await renderApp();
        return;
    }
    if (action === 'clients-search-clear') {
        state.clientsQ = '';
        await renderApp();
        return;
    }
    if (action === 'client-detail-tab') {
        state.clientDetailTab = value || 'orders';
        await renderApp();
        return;
    }
    if (action === 'broadcasts-filter') {
        state.broadcastsFilter = value || 'all';
        await renderApp();
        return;
    }
    if (action === 'support-filter') {
        state.supportFilter = value || 'all';
        await renderApp();
        return;
    }
    if (action === 'analytics-period') {
        state.analyticsPeriod = value || '7d';
        await renderApp();
        return;
    }
    if (action === 'support-scope-clear') {
        state.supportClientTelegramId = '';
        await renderApp();
        return;
    }
    if (action === 'apply-nav-action') {
        const payload = decodeActionPayload(eventTarget && eventTarget.getAttribute('data-nav-action'));
        if (!payload || !payload.screen) return;
        if (payload.playbookId) {
            if (requiresPlaybookConfirm(payload.playbookId)) {
                openConfirmationSheet({
                    title: 'Подтвердите запуск сценария',
                    message: 'Сценарий может привести к массовому коммуникационному действию.',
                    impact_summary: 'Проверьте аудиторию и контекст перед следующим шагом.',
                    severity: 'high',
                    confirm_label: 'Продолжить',
                    cancel_label: 'Отмена',
                    secondary_note: 'Это high-impact сценарий роста',
                    irreversible_warning: false
                }, async () => {
                    await launchPlaybook(payload.playbookId, payload.entrySource || state.currentScreen);
                });
                await renderApp();
                return;
            }
            await launchPlaybook(payload.playbookId, payload.entrySource || state.currentScreen);
            return;
        }
        applyActionFilters(payload.filters || {});
        if (payload.campaignId) {
            state.broadcastsContextFilter = state.broadcastsFilter || 'all';
            await openBroadcastDetail(payload.campaignId);
            navigateTo('broadcast_detail');
            return;
        }
        navigateTo(payload.screen);
        return;
    }
    if (action === 'order-open') {
        await openOrderDetail(value);
        await renderApp();
        return;
    }
    if (action === 'order-open-client') {
        const clientId = String(value || '').trim();
        state.clientsContextFilter = state.clientFilter;
        state.clientsContextQ = state.clientsQ;
        state.clientDetailTab = 'orders';
        await openClientDetail(clientId);
        navigateTo('client_detail');
        return;
    }
    if (action === 'client-open') {
        state.clientsContextFilter = state.clientFilter;
        state.clientsContextQ = state.clientsQ;
        state.clientDetailTab = 'orders';
        await openClientDetail(value);
        navigateTo('client_detail');
        return;
    }
    if (action === 'client-back') {
        state.clientFilter = state.clientsContextFilter || 'all';
        state.clientsQ = state.clientsContextQ || '';
        navigateTo('clients');
        return;
    }
    if (action === 'client-open-orders') {
        state.orderClientTelegramId = String(value || '').trim();
        state.orderFilter = 'all';
        navigateTo('orders');
        return;
    }
    if (action === 'client-open-support') {
        state.supportClientTelegramId = String(value || '').trim();
        state.supportFilter = 'all';
        navigateTo('support');
        return;
    }
    if (action === 'support-open-client') {
        const clientId = String(value || '').trim();
        if (!clientId) return;
        state.clientDetailTab = 'support';
        await openClientDetail(clientId);
        navigateTo('client_detail');
        return;
    }
    if (action === 'support-open') {
        await openSupportDetail(value);
        await renderApp();
        return;
    }
    if (action === 'broadcast-open') {
        state.broadcastsContextFilter = state.broadcastsFilter || 'all';
        await openBroadcastDetail(value);
        navigateTo('broadcast_detail');
        return;
    }
    if (action === 'broadcast-repeatable-focus') {
        state.broadcastsFilter = 'repeatable';
        await renderApp();
        return;
    }
    if (action === 'broadcast-delete') {
        const id = Number(value);
        if (!id) return;
        const key = `broadcast-delete-${id}`;
        openConfirmationSheet({
            title: 'Подтвердите удаление рассылки у получателей',
            message: `Система попробует удалить уже доставленные сообщения кампании #${id} у тех, кому они были отправлены.`,
            impact_summary: 'Действие затрагивает получателей кампании и может быть необратимым.',
            severity: 'destructive',
            confirm_label: 'Удалить у получателей',
            cancel_label: 'Отмена',
            secondary_note: 'Проверьте, что выбрана нужная кампания.',
            irreversible_warning: true
        }, async () => {
            await runGuardedAction(key, async () => {
                await api(`/api/admin/broadcasts/${id}/delete-for-all`, { method: 'POST' });
                delete state.broadcastDetails[id];
                if (String(state.selectedBroadcastId || '') === String(id)) {
                    state.selectedBroadcastId = '';
                }
            });
        });
        await renderApp();
        return;
    }
    if (action === 'broadcast-back') {
        if (state.broadcastsContextFilter) {
            state.broadcastsFilter = state.broadcastsContextFilter;
        }
        navigateTo('broadcasts');
        return;
    }
    if (action === 'launch-playbook') {
        const playbookId = String(value || '').trim();
        const source = String((eventTarget && eventTarget.getAttribute('data-source')) || state.currentScreen || '');
        if (!playbookId) return;
        await ensurePlaybooksSummary();
        if (requiresPlaybookConfirm(playbookId)) {
            openConfirmationSheet({
                title: 'Подтвердите запуск сценария',
                message: 'Этот сценарий связан с коммуникациями по сегменту клиентов.',
                impact_summary: 'После запуска откроется prefilled flow для high-impact действий.',
                severity: 'high',
                confirm_label: 'Запустить сценарий',
                cancel_label: 'Отмена',
                secondary_note: 'Проверьте, что вы запускаете правильный сценарий.',
                irreversible_warning: false
            }, async () => {
                await launchPlaybook(playbookId, source);
            });
            await renderApp();
            return;
        }
        await launchPlaybook(playbookId, source);
        return;
    }
    if (action === 'playbook-dismiss') {
        state.activePlaybook = null;
        saveUiState();
        await renderApp();
        return;
    }
    if (action === 'playbook-back-source') {
        const source = state.activePlaybook && state.activePlaybook.prefilled_context
            ? String(state.activePlaybook.prefilled_context.sourceScreen || '')
            : '';
        state.activePlaybook = null;
        saveUiState();
        if (source && SCREEN_IDS.includes(source)) {
            navigateTo(source);
            return;
        }
        navigateTo('actions');
        return;
    }
    if (action === 'save-flags') {
        openConfirmationSheet({
            title: 'Подтвердите изменение флагов',
            message: 'Изменение runtime-флагов может повлиять на поведение админ-панели и сервисов.',
            impact_summary: 'Проверьте выбранные переключатели перед сохранением.',
            severity: 'high',
            confirm_label: 'Сохранить флаги',
            cancel_label: 'Отмена',
            secondary_note: 'Часть изменений может требовать перезапуск backend.',
            irreversible_warning: false
        }, async () => {
            await runGuardedAction('save-flags', async () => {
                await saveFlagsFromUi();
            });
        });
        await renderApp();
        return;
    }
    if (action === 'outbox-reprocess') {
        const id = Number(value);
        if (!id) return;
        openConfirmationSheet({
            title: 'Подтвердите повторную обработку события',
            message: `Событие outbox #${id} будет отправлено в повторную обработку.`,
            impact_summary: 'Действие может повторно запустить связанный процесс.',
            severity: 'normal',
            confirm_label: 'Повторить обработку',
            cancel_label: 'Отмена',
            secondary_note: 'Используйте только если уверены, что ошибка уже устранена.',
            irreversible_warning: false
        }, async () => {
            await runGuardedAction(`outbox-reprocess-${id}`, async () => {
                await api(`/api/admin/outbox/${id}/reprocess`, { method: 'POST' });
            });
        });
        await renderApp();
        return;
    }
    if (action === 'promo-open-source-form') {
        state.promoFormSourceOpen = true;
        await renderApp();
        return;
    }
    if (action === 'promo-cancel-source') {
        state.promoFormSourceOpen = false;
        await renderApp();
        return;
    }
    if (action === 'promo-open-broadcast-form') {
        state.promoFormBroadcastOpen = true;
        await renderApp();
        return;
    }
    if (action === 'promo-cancel-broadcast') {
        state.promoFormBroadcastOpen = false;
        await renderApp();
        return;
    }
    if (action === 'promo-src-delete-prompt') {
        const code = String(value || '').trim();
        if (!code) return;
        openConfirmationSheet(
            {
                title: 'Удалить источник?',
                message: 'Источник будет удалён из списка. Это действие нельзя отменить.',
                impact_summary: '',
                severity: 'destructive',
                confirm_label: 'Удалить',
                cancel_label: 'Отмена',
                irreversible_warning: false
            },
            async () => {
                await runGuardedAction(`promo-delete-${code}`, async () => {
                    try {
                        await api(`/api/admin/promotion/sources/${encodeURIComponent(code)}`, { method: 'DELETE' });
                        state.promoSourcesList = (state.promoSourcesList || []).filter((s) => String(s.code || '') !== code);
                        state.promoExpandedSources = Object.fromEntries(
                            Object.entries(state.promoExpandedSources || {}).filter(([k]) => k !== code)
                        );
                        state.promoDetailByCode = Object.fromEntries(
                            Object.entries(state.promoDetailByCode || {}).filter(([k]) => k !== code)
                        );
                        state.promoFlash = 'Источник удалён.';
                    } catch (e) {
                        window.alert(friendlyActionError(String((e && e.message) || '')) || 'Не удалось удалить источник.');
                    }
                });
            }
        );
        await renderApp();
        return;
    }
    if (action === 'promo-src-toggle') {
        const code = String(value || '').trim();
        if (!code) return;
        const nextOpen = !state.promoExpandedSources[code];
        state.promoExpandedSources = { ...state.promoExpandedSources, [code]: nextOpen };
        if (nextOpen) {
            try {
                const payload = await api(`/api/admin/promotion/sources/${encodeURIComponent(code)}`);
                state.promoDetailByCode = { ...state.promoDetailByCode, [code]: payload.data };
            } catch (_) {
                /* используем агрегаты из списка */
            }
        }
        await renderApp();
        return;
    }
    if (action === 'promo-bc-place-repeat-prompt') {
        const id = String(value || '').trim();
        if (!id) return;
        openConfirmationSheet(
            {
                title: 'Разместить рассылку ещё раз?',
                message:
                    'Карточка будет повторно опубликована в теме рассылок и снова запустит сценарий доставки.',
                impact_summary: '',
                severity: 'high',
                confirm_label: 'Разместить ещё раз',
                cancel_label: 'Отмена',
                irreversible_warning: false
            },
            async () => {
                await runGuardedAction(`promo-bc-place-repeat-${id}`, async () => {
                    try {
                        await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}/place`, {
                            method: 'POST'
                        });
                        const wasExpanded = !!state.promoExpandedBroadcasts[id];
                        state.promoDetailById = Object.fromEntries(
                            Object.entries(state.promoDetailById || {}).filter(([k]) => k !== id)
                        );
                        if (wasExpanded) {
                            try {
                                const payload = await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}`);
                                state.promoDetailById = { ...state.promoDetailById, [id]: payload.data };
                            } catch (_) {
                                /**/
                            }
                        }
                        state.promoFlash = 'Рассылка размещена повторно.';
                    } catch (e) {
                        window.alert(
                            friendlyActionError(String((e && e.message) || '')) ||
                                'Не удалось разместить рассылку повторно.'
                        );
                    }
                });
            }
        );
        await renderApp();
        return;
    }
    if (action === 'promo-bc-place-prompt') {
        const id = String(value || '').trim();
        if (!id) return;
        openConfirmationSheet(
            {
                title: 'Разместить рассылку?',
                message:
                    'Рассылка будет опубликована в теме рассылок. После размещения её можно будет использовать для отправки по существующему сценарию.',
                impact_summary: '',
                severity: 'high',
                confirm_label: 'Разместить',
                cancel_label: 'Отмена',
                irreversible_warning: false
            },
            async () => {
                await runGuardedAction(`promo-bc-place-${id}`, async () => {
                    try {
                        await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}/place`, {
                            method: 'POST'
                        });
                        const wasExpanded = !!state.promoExpandedBroadcasts[id];
                        state.promoDetailById = Object.fromEntries(
                            Object.entries(state.promoDetailById || {}).filter(([k]) => k !== id)
                        );
                        if (wasExpanded) {
                            try {
                                const payload = await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}`);
                                state.promoDetailById = { ...state.promoDetailById, [id]: payload.data };
                            } catch (_) {
                                /**/
                            }
                        }
                        state.promoFlash = 'Рассылка размещена в теме рассылок.';
                    } catch (e) {
                        window.alert(
                            friendlyActionError(String((e && e.message) || '')) ||
                                'Не удалось разместить рассылку.'
                        );
                    }
                });
            }
        );
        await renderApp();
        return;
    }
    if (action === 'promo-bc-delete-prompt') {
        const id = String(value || '').trim();
        if (!id) return;
        openConfirmationSheet(
            {
                title: 'Удалить рассылку?',
                message:
                    'Карточка рассылки будет скрыта из списка. Отклики и история размещений останутся в базе.',
                impact_summary: '',
                severity: 'destructive',
                confirm_label: 'Удалить',
                cancel_label: 'Отмена',
                irreversible_warning: false
            },
            async () => {
                await runGuardedAction(`promo-bc-delete-${id}`, async () => {
                    try {
                        await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}`, {
                            method: 'DELETE'
                        });
                        state.promoBroadcastsList = (state.promoBroadcastsList || []).filter(
                            (bc) => String(bc.id ?? '') !== id
                        );
                        state.promoExpandedBroadcasts = Object.fromEntries(
                            Object.entries(state.promoExpandedBroadcasts || {}).filter(([k]) => k !== id)
                        );
                        state.promoDetailById = Object.fromEntries(
                            Object.entries(state.promoDetailById || {}).filter(([k]) => k !== id)
                        );
                        state.promoFlash = 'Рассылка удалена.';
                    } catch (e) {
                        window.alert(
                            friendlyActionError(String((e && e.message) || '')) ||
                                'Не удалось удалить рассылку.'
                        );
                    }
                });
            }
        );
        await renderApp();
        return;
    }
    if (action === 'promo-bc-toggle') {
        const id = String(value || '').trim();
        if (!id) return;
        const nextOpen = !state.promoExpandedBroadcasts[id];
        state.promoExpandedBroadcasts = { ...state.promoExpandedBroadcasts, [id]: nextOpen };
        if (nextOpen) {
            try {
                const payload = await api(`/api/admin/promotion/broadcasts/${encodeURIComponent(id)}`);
                state.promoDetailById = { ...state.promoDetailById, [id]: payload.data };
            } catch (_) {
                /**/
            }
        }
        await renderApp();
        return;
    }
    if (action === 'promo-copy') {
        const url = (eventTarget && eventTarget.getAttribute('data-copy')) || '';
        let ok = false;
        try {
            if (navigator.clipboard && url && window.isSecureContext) {
                await navigator.clipboard.writeText(url);
                ok = true;
            }
        } catch (_) {
            ok = false;
        }
        state.promoFlash = ok ? 'Ссылка скопирована.' : '';
        await renderApp();
        if (!ok && url) {
            window.alert('Копирование в буфер недоступно в этом браузере или контексте (обычно нужен HTTPS).');
        }
        return;
    }
    if (action === 'promo-submit-source') {
        const titleEl = document.getElementById('promoSrcTitle');
        const codeEl = document.getElementById('promoSrcCode');
        const title = titleEl ? String(titleEl.value || '').trim() : '';
        const code = codeEl ? String(codeEl.value || '').trim() : '';
        if (!title) {
            window.alert('Укажите название источника.');
            return;
        }
        await runGuardedAction('promo-create-src', async () => {
            const r = await api('/api/admin/promotion/sources', {
                method: 'POST',
                body: JSON.stringify({ title, code: code || undefined })
            });
            state.promoFormSourceOpen = false;
            const data = r.data || {};
            const link = String(data.tracking_url || '').trim();
            state.promoFlash = link ? `Источник создан.` : 'Источник создан.';
            if (link) {
                state.promoExpandedSources = { ...state.promoExpandedSources, [String(data.code || code || '').trim()]: true };
                state.promoDetailByCode = {
                    ...state.promoDetailByCode,
                    [String(data.code || '').trim()]: { ...(data || {}), tracking_url: link }
                };
            }
        });
        await renderApp();
        return;
    }
    if (action === 'promo-submit-broadcast') {
        const tEl = document.getElementById('promoBcText');
        const kwEl = document.getElementById('promoBcKw');
        const fileEl = document.getElementById('promoBcImg');
        const text = tEl ? String(tEl.value || '').trim() : '';
        const keyword = kwEl ? String(kwEl.value || '').trim().toLowerCase() : '';
        if (!text || !keyword) {
            window.alert('Заполните текст и кодовое слово.');
            return;
        }
        const imagesBase64 = [];
        const fileList =
            fileEl && fileEl.files && fileEl.files.length
                ? Array.from(fileEl.files).slice(0, 10)
                : [];
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];
            if (file.size > 620000) {
                window.alert(`Файл «${file.name || `№${i + 1}`}» слишком большой (лимит ~600 KB).`);
                return;
            }
            const b64 = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
                fr.onerror = () => reject(new Error('FILE_READ_FAILED'));
                fr.readAsDataURL(file);
            });
            if (String(b64 || '').trim()) imagesBase64.push(b64);
        }
        await runGuardedAction('promo-create-bc', async () => {
            await api('/api/admin/promotion/broadcasts', {
                method: 'POST',
                body: JSON.stringify({
                    text,
                    keyword,
                    images_base64: imagesBase64.length ? imagesBase64 : undefined
                })
            });
            state.promoFormBroadcastOpen = false;
            state.promoFlash =
                'Карточка сохранена. Откройте список ниже и нажмите «Разместить рассылку», чтобы опубликовать её в теме рассылок.';
        });
        await renderApp();
        return;
    }
    if (eventTarget && eventTarget.dataset && eventTarget.dataset.go) {
        navigateTo(eventTarget.dataset.go);
    }
}

document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.id !== 'promoBcImg' || !t.files) return;
    const n = Math.min(t.files.length, 10);
    const hint = document.getElementById('promoBcImgHint');
    if (!hint) return;
    if (t.files.length > 10) {
        hint.hidden = false;
        hint.textContent = 'Выбрано больше 10 файлов — будут сохранены первые 10.';
        return;
    }
    hint.hidden = n === 0;
    hint.textContent = n > 0 ? `Выбрано фото: ${n}` : '';
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const el = document.getElementById('f21-dashboard-metric-help');
    if (el && !el.hidden) {
        closeDashboardMetricHelp();
    }
});

document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action], [data-go]');
    if (!target) return;
    event.preventDefault();
    const action = target.getAttribute('data-action');
    const val = target.getAttribute('data-value') || target.getAttribute('data-id') || target.getAttribute('data-code') || target.getAttribute('data-bc-id');
    if (target.getAttribute('data-go') && !action) {
        navigateTo(target.getAttribute('data-go'));
        return;
    }
    try {
        await handleAction(action, val, target);
    } catch (e) {
        window.alert(friendlyActionError(e && e.message));
    }
});

window.addEventListener('hashchange', () => {
    state.currentScreen = resolveScreenFromHash();
    saveUiState();
    renderApp();
});

document.addEventListener('DOMContentLoaded', async () => {
    const f21RuntimeBuild = getF21AdminRuntimeBuild();
    const embedded = isEmbeddedMode();
    const embLen =
        typeof window.__F21_EMBEDDED_INIT_DATA === 'string'
            ? window.__F21_EMBEDDED_INIT_DATA.length
            : 0;

    setViewportHeightVar();
    initTelegramWebApp();
    window.addEventListener('resize', setViewportHeightVar);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setViewportHeightVar);
    }
    loadUiState();
    state.currentScreen = resolveScreenFromHash();
    if (!String(location.hash || '').replace(/^#/, '')) {
        try {
            const q = typeof location.search === 'string' ? location.search : '';
            history.replaceState(null, '', `${location.pathname}${q}#${BOTTOM_NAV_IDS.DASHBOARD}`);
        } catch (_) {
            location.hash = BOTTOM_NAV_IDS.DASHBOARD;
        }
    }
    try {
        await ensureAuth();
        console.log('[AdminEmbedApp] mount_ok', {
            hasConfig: !!adminConfig,
            initDataLen: String(telegramInitData || '').length
        });
        try {
            fetch('/api/admin/client-log', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    step: 'admin_mount_ok',
                    build: f21RuntimeBuild,
                    path: location.pathname
                }),
                keepalive: true
            }).catch(() => {});
        } catch (_) {}
        await renderApp();
    } catch (e) {
        console.error('[AdminEmbedApp] mount_fail', {
            message: e && e.message,
            embedded,
            embeddedInitLen: embLen
        });
        const root = document.getElementById('app');
        if (root) {
            root.innerHTML = renderShell(errorState(`Ошибка авторизации: ${e.message}`));
        }
    }
});

