function env(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === null || v === '' ? fallback : v;
}

function envBool(name, fallback) {
    const v = process.env[name];
    if (v === undefined || v === null || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function envInt(name, fallback = 0) {
    const v = process.env[name];
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function envList(name, fallback = []) {
    const v = process.env[name];
    if (v === undefined || v === null || v === '') return fallback;
    return String(v)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

/** Доступ к admin Mini App после bootstrap: ADMIN_TELEGRAM_IDS (env) + только владелец в коде как safety net. */
const DEFAULT_ADMIN_TELEGRAM_IDS = ['67460775'];

function parseOptionalPublicUrl(primaryName, fallbackName) {
    const a = String(process.env[primaryName] || '').trim().replace(/\/+$/, '');
    const b = String(process.env[fallbackName] || '').trim().replace(/\/+$/, '');
    return a || b || '';
}

/** Публичный HTTPS origin без завершающего слэша: webhook/редиректы Т-Банка, абсолютные ссылки. */
const APP_PUBLIC_URL = parseOptionalPublicUrl('APP_PUBLIC_URL', 'BASE_URL');

/**
 * Начальный bootstrap списка admin_users (только при пустой таблице). Источник истины дальше — БД.
 */
const ADMIN_INITIAL_TG_IDS_LIST = envList('ADMIN_INITIAL_TG_IDS', []);

/**
 * CSV из env (только если ключ задан непустым) + дефолтные ID (union).
 * Так production может задать ADMIN_TELEGRAM_IDS=67460775 без потери дефолтных админов.
 */
function mergeAdminTelegramIdsWithDefaults(envName, defaults) {
    const raw = process.env[envName];
    const explicit =
        raw === undefined || raw === null || raw === ''
            ? []
            : String(raw)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
    const merged = new Set([...(defaults || []).map(String), ...explicit.map(String)]);
    return [...merged];
}

/**
 * Источник совпадения для логов [AdminAccess]: env = явный CSV в env, default = встроенный whitelist.
 */
function createAdminTelegramMatchClassifier(defaults, primaryTelegramId) {
    const defaultSet = new Set((defaults || []).map(String));
    const primaryTrim = String(primaryTelegramId || '').trim();
    const rawAdmin = process.env.ADMIN_TELEGRAM_IDS;
    const explicitAdmin =
        rawAdmin === undefined || rawAdmin === null || rawAdmin === ''
            ? null
            : String(rawAdmin)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map(String);
    const explicitAdminSet = explicitAdmin ? new Set(explicitAdmin) : null;

    const rawLegacy = process.env.TELEGRAM_ADMIN_IDS;
    const explicitLegacy =
        rawLegacy === undefined || rawLegacy === null || rawLegacy === ''
            ? null
            : String(rawLegacy)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map(String);
    const explicitLegacySet = explicitLegacy ? new Set(explicitLegacy) : null;

    return function classifyAdminTelegramMatchSource(telegramId) {
        const t = String(telegramId || '').trim();
        if (!t) return 'none';
        if (explicitAdminSet && explicitAdminSet.has(t)) return 'env';
        if (explicitLegacySet && explicitLegacySet.has(t)) return 'env';
        if (primaryTrim && t === primaryTrim) return 'default';
        if (defaultSet.has(t)) return 'default';
        return 'none';
    };
}

const path = require('path');

/** Владелец админки: ADMIN_OWNER_TG_ID приоритетнее legacy ADMIN_PRIMARY_TELEGRAM_ID */
const RESOLVED_ADMIN_PRIMARY_TELEGRAM_ID = String(
    env('ADMIN_OWNER_TG_ID', '') || env('ADMIN_PRIMARY_TELEGRAM_ID', '67460775')
).trim();

/**
 * TELEGRAM_PROXY_URL: не задан / пусто / direct|none|off|false|0 → прямой HTTPS к api.telegram.org.
 * Явный URL (socks5h/socks5/http/https) → трафик через прокси (см. createTelegramBotApiAxios).
 * Старый RU-деплой: TELEGRAM_PROXY_URL=socks5h://127.0.0.1:1080
 */
function envTelegramProxyUrl() {
    const raw = process.env.TELEGRAM_PROXY_URL;
    if (raw === undefined || raw === null) return '';
    const v = String(raw).trim();
    if (!v) return '';
    const t = v.toLowerCase();
    if (t === 'direct' || t === 'none' || t === 'off' || t === 'false' || t === '0') return '';
    return v;
}

const BROADCAST_DELIVERY_INTERVAL_MS_RESOLVED = envInt('BROADCAST_DELIVERY_INTERVAL_MS', 55);

/**
 * Служебная супергруппа-форум (один chat_id на заказы/рассылки/поддержку).
 * TELEGRAM_ADMIN_CHAT_ID — алиас к TELEGRAM_FORUM_GROUP_ID (последний с тем же смыслом, что в заданиях на миграцию).
 */
function resolveTelegramForumGroupId() {
    const z = String(process.env.TELEGRAM_SUPERGROUP_ID || '').trim();
    if (z) return z;
    const a = String(process.env.TELEGRAM_FORUM_GROUP_ID || '').trim();
    if (a) return a;
    const b = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
    if (b) return b;
    return '';
}

function resolveThreadId(primaryKey, aliasKey, defaultNum) {
    if (String(process.env[primaryKey] || '').trim() !== '') return envInt(primaryKey, defaultNum);
    if (String(process.env[aliasKey] || '').trim() !== '') return envInt(aliasKey, defaultNum);
    return defaultNum;
}

/** Первый заданный ключ из списка даёт thread_id; иначе fallback. */
function resolveThreadFromEnv(keys, fallbackNum) {
    const ks = Array.isArray(keys) ? keys : [];
    for (const k of ks) {
        if (String(process.env[k] || '').trim() !== '') return envInt(k, fallbackNum);
    }
    return fallbackNum;
}

/* Списоковые алиасы thread (см. resolveThreadId) — explicit process.env.* для discoverability / verify:manifest */
if (0) {
    void process.env.APP_PUBLIC_URL;
    void process.env.ABANDONED_CARTS_ENABLED;
    void process.env.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED;
    void process.env.ABANDONED_CART_AFTER_MINUTES;
    void process.env.ABANDONED_CART_NOTIFY_AFTER_MINUTES;
    void process.env.ABANDONED_CART_REPEAT_NOTIFY_HOURS;
    void process.env.ABANDONED_CART_MAX_NOTIFICATIONS;
    void process.env.ABANDONED_CART_EXPIRE_DAYS;
    void process.env.ABANDONED_CART_SCAN_INTERVAL_MINUTES;
    void process.env.TELEGRAM_SUPERGROUP_ID;
    void process.env.TELEGRAM_TOPIC_ORDERS_ID;
    void process.env.TELEGRAM_TOPIC_SUPPORT_ID;
    void process.env.TELEGRAM_TOPIC_BROADCASTS_ID;
    void process.env.TELEGRAM_TOPIC_ERRORS_ID;
    void process.env.TELEGRAM_TOPIC_ABANDONED_CARTS_ID;
    void process.env.ABANDONED_CART_CLIENT_NOTIFICATIONS_ENABLED;
    void process.env.TELEGRAM_BROADCAST_TOPIC_CHAT_ID;
    void process.env.TELEGRAM_BROADCAST_TOPIC_THREAD_ID;
    void process.env.TELEGRAM_ORDERS_NOTIFY_CHAT_ID;
    void process.env.TELEGRAM_ORDERS_NOTIFY_THREAD_ID;
    void process.env.TELEGRAM_SUPPORT_NOTIFY_CHAT_ID;
    void process.env.TELEGRAM_SUPPORT_NOTIFY_THREAD_ID;
    void process.env.TELEGRAM_ORDERS_THREAD_ID;
    void process.env.TELEGRAM_BROADCASTS_THREAD_ID;
    void process.env.TELEGRAM_SUPPORT_THREAD_ID;
    void process.env.MOYSKLAD_SALESCHANNEL_AUTO_CREATE;
}

const RESOLVED_TELEGRAM_FORUM_GROUP_ID = resolveTelegramForumGroupId();

/**
 * Abandoned-cart topic optional: пустой / не задан → 0 (Telegram-topic уведомления выключаются без ошибки).
 */
const RESOLVED_TELEGRAM_TOPIC_ABANDONED_CARTS_ID = envInt('TELEGRAM_TOPIC_ABANDONED_CARTS_ID', 0);

/**
 * Явное env переключает независимо от темы.
 * Если env не задан: телеграм‑уведомления включены только при thread_id > 0.
 */
function resolveAbandonedCartTelegramNotificationsEnabled(topicThreadId) {
    const tid = Number(topicThreadId || 0);
    const raw = process.env.ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED;
    if (raw === undefined || raw === null || String(raw).trim() === '') return tid > 0;
    return envBool('ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED', false);
}

/**
 * Личные сообщения клиентам о брошенной корзине (Bot API sendMessage в личку).
 * Если env не задан — по умолчанию повторяет TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED
 * (без исходящего HTTP всё равно не отправим).
 */
function resolveAbandonedCartClientNotificationsEnabled(outboundHttpEnabled) {
    const raw = process.env.ABANDONED_CART_CLIENT_NOTIFICATIONS_ENABLED;
    if (raw === undefined || raw === null || String(raw).trim() === '') return !!outboundHttpEnabled;
    return envBool('ABANDONED_CART_CLIENT_NOTIFICATIONS_ENABLED', true);
}

const RESOLVED_TELEGRAM_SUPPORT_TOPIC_THREAD_ID = resolveThreadFromEnv(
    ['TELEGRAM_TOPIC_SUPPORT_ID', 'TELEGRAM_SUPPORT_NOTIFY_THREAD_ID', 'TELEGRAM_SUPPORT_THREAD_ID'],
    6
);
const RESOLVED_TELEGRAM_ERRORS_ROUTING_THREAD_ID =
    String(process.env.TELEGRAM_TOPIC_ERRORS_ID || '').trim() !== ''
        ? envInt('TELEGRAM_TOPIC_ERRORS_ID', RESOLVED_TELEGRAM_SUPPORT_TOPIC_THREAD_ID)
        : RESOLVED_TELEGRAM_SUPPORT_TOPIC_THREAD_ID;

function resolveTelegramPerPurposeChatId(specificKey) {
    if (String(process.env[specificKey] || '').trim() !== '') return String(process.env[specificKey]).trim();
    return RESOLVED_TELEGRAM_FORUM_GROUP_ID;
}

function resolveBroadcastGlobalMessagesPerSec() {
    const raw = process.env.BROADCAST_GLOBAL_MESSAGES_PER_SEC;
    if (raw === undefined || raw === null || raw === '') {
        return Math.min(30, Math.max(1, Math.floor(1000 / Math.max(1, BROADCAST_DELIVERY_INTERVAL_MS_RESOLVED))));
    }
    return envInt('BROADCAST_GLOBAL_MESSAGES_PER_SEC', 18);
}

module.exports = {
    MOYSKLAD_TOKEN: env('MOYSKLAD_TOKEN', ''),
    /** true: при отсутствии канала «Telegram Bot» выполнить POST /entity/saleschannel (ломалось 412 без type в МС). По умолчанию false — заказ без salesChannel. */
    MOYSKLAD_SALESCHANNEL_AUTO_CREATE: envBool('MOYSKLAD_SALESCHANNEL_AUTO_CREATE', false),
    MOYSKLAD_ACCOUNT_ID: env('MOYSKLAD_ACCOUNT_ID', 'your_moysklad_account_id_here'),
    MOYSKLAD_ORGANIZATION_HREF: String(env('MOYSKLAD_ORGANIZATION_HREF', '')).trim(),
    MOYSKLAD_STORE_HREF: String(env('MOYSKLAD_STORE_HREF', '')).trim(),
    MOYSKLAD_AGENT_HREF: String(env('MOYSKLAD_AGENT_HREF', '')).trim(),
    MOYSKLAD_PROJECT_HREF: String(env('MOYSKLAD_PROJECT_HREF', '')).trim(),
    MOYSKLAD_ORGANIZATION_NAME: env('MOYSKLAD_ORGANIZATION_NAME', 'ИП Зайламова Анна Геннадьевна'),
    MOYSKLAD_DEFAULT_AGENT_ID: env('MOYSKLAD_DEFAULT_AGENT_ID', 'ID_КОНТРАГЕНТА_ДЛЯ_ЗАКАЗОВ'),
    MOYSKLAD_DELIVERY_CITY400_ASSORTMENT: env('MOYSKLAD_DELIVERY_CITY400_ASSORTMENT', 'mS3C4yVOihrURel027ui11'),
    MOYSKLAD_DELIVERY_TO10KM_ASSORTMENT: env('MOYSKLAD_DELIVERY_TO10KM_ASSORTMENT', 'ETaqRBSuhy9baDTd1yqpo1'),

    TBANK_TERMINAL_KEY: env('TBANK_TERMINAL_KEY', ''),
    TBANK_PASSWORD: env('TBANK_PASSWORD', ''),
    TBANK_API_URL: String(env('TBANK_API_URL', 'https://securepay.tinkoff.ru/v2')).trim().replace(/\/+$/, ''),
    APP_PUBLIC_URL,
    /** @deprecated используйте APP_PUBLIC_URL — оставлено для совместимости; должно совпадать с публичным origin */
    BASE_URL: APP_PUBLIC_URL || env('BASE_URL', ''),
    /** URL Mini App для кнопки Web App в /start; пусто = BASE_URL */
    MINI_APP_URL: env('MINI_APP_URL', ''),
    /** @username бота без @ — опционально (маркетинговые ссылки и т.п.); кнопка «Позвать менеджера» использует callback, не URL. */
    TELEGRAM_BOT_USERNAME: env('TELEGRAM_BOT_USERNAME', ''),
    /** Публичный канал (кнопка в welcome /start) */
    TELEGRAM_CHANNEL_URL: env('TELEGRAM_CHANNEL_URL', 'https://t.me/cvetochniy21'),
    /** HTTPS URL картинки для welcome step 2; fallback если локальный файл недоступен. Пусто = BASE_URL + /images/cvet_21_logo_1.jpg */
    TELEGRAM_START_WELCOME_IMAGE_URL: env('TELEGRAM_START_WELCOME_IMAGE_URL', ''),
    /** Локальный файл изображения для sendPhoto (multipart); надёжнее, чем URL. Пусто = корень репозитория photo_2026-04-13_00-16-43.jpg */
    TELEGRAM_START_WELCOME_IMAGE_PATH: env(
        'TELEGRAM_START_WELCOME_IMAGE_PATH',
        path.join(__dirname, '..', 'photo_2026-04-13_00-16-43.jpg')
    ),
    /** Локальный путь к PDF согласия (отдаётся через GET TELEGRAM_CONSENT_PUBLIC_PATH на BASE_URL для sendDocument по URL). */
    TELEGRAM_CONSENT_PDF_PATH: env(
        'TELEGRAM_CONSENT_PDF_PATH',
        path.join(__dirname, '..', 'Политика_конфиденциальности_данных_Цветочный_21_город_Чебоксары.pdf')
    ),
    /** Путь на веб-сервере для публичной отдачи PDF (Telegram загружает документ по HTTPS). */
    TELEGRAM_CONSENT_PUBLIC_PATH: env('TELEGRAM_CONSENT_PUBLIC_PATH', '/public/cvetochny21-consent.pdf'),
    /** Полный HTTPS URL PDF для sendDocument; если задан — TELEGRAM_CONSENT_PUBLIC_PATH на сервере не нужен для Telegram. */
    TELEGRAM_CONSENT_DOCUMENT_URL: env('TELEGRAM_CONSENT_DOCUMENT_URL', ''),
    /** Задержки welcome после шага 2 (сообщение с бонусами): мс от момента отправки шага 2. */
    TELEGRAM_ONBOARDING_MANAGER_DELAY_MS: envInt('TELEGRAM_ONBOARDING_MANAGER_DELAY_MS', 5000),
    TELEGRAM_ONBOARDING_CHANNEL_DELAY_MS: envInt('TELEGRAM_ONBOARDING_CHANNEL_DELAY_MS', 15000),
    /** Антиспам повторных нажатий «Позвать менеджера» после успешного уведомления в тему поддержки (мс). */
    MANAGER_HELP_COOLDOWN_MS: envInt('MANAGER_HELP_COOLDOWN_MS', 7 * 60 * 1000),

    MOYSKLAD_ROOT_FOLDER_NAME: env('MOYSKLAD_ROOT_FOLDER_NAME', 'БУКЕТЫ ТЕЛЕГРАММ ПРИЛОЖЕНИЕ'),
    MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE: env('MOYSKLAD_ROOT_FOLDER_EXTERNAL_CODE', 'ElFSfgBNhZEe4o9zuRx170'),

    /** В production задайте TELEGRAM_BOT_TOKEN в env; пустой дефолт — не хранить токен в репозитории. */
    TELEGRAM_BOT_TOKEN: env('TELEGRAM_BOT_TOKEN', ''),
    /** Супергруппа-форум; алиас env: TELEGRAM_ADMIN_CHAT_ID (если TELEGRAM_FORUM_GROUP_ID не задан). */
    TELEGRAM_FORUM_GROUP_ID: RESOLVED_TELEGRAM_FORUM_GROUP_ID,
    // false: не выполнять исходящие HTTPS к api.telegram.org (уведомления/топики/рассылки через бота отключены).
    // true: обычная работа Bot API. Токен бота всё равно нужен для проверки подписи Web App initData (локально, без запросов к Telegram).
    TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED: envBool('TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED', false),
    TELEGRAM_PROXY_URL: envTelegramProxyUrl(),

    // Event publisher flags
    EVENT_PUBLISHER_ENABLED: envBool('EVENT_PUBLISHER_ENABLED', true),

    // Stage 2 flags (по умолчанию включено для production-операций; отключайте явным env=0/false при необходимости)
    TELEGRAM_TOPICS_ENABLED: envBool('TELEGRAM_TOPICS_ENABLED', true),
    EVENT_OUTBOX_ENABLED: envBool('EVENT_OUTBOX_ENABLED', true),
    OUTBOX_WORKER_ENABLED: envBool('OUTBOX_WORKER_ENABLED', true),
    OUTBOX_WORKER_INTERVAL_MS: envInt('OUTBOX_WORKER_INTERVAL_MS', 5000),

    /**
     * Максимальный возраст (мс) неоплаченного заказа (PENDING_PAYMENT / AUTHORIZED) для reuse при checkout.
     * Старше — создаётся новый локальный заказ; старый не обновляется.
     */
    CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS: envInt('CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS', 86400000),

    BROADCASTS_ENABLED: envBool('BROADCASTS_ENABLED', true),
    BROADCAST_DELETE_ENABLED: envBool('BROADCAST_DELETE_ENABLED', false),
    SUPPORT_RELAY_ENABLED: envBool('SUPPORT_RELAY_ENABLED', true),
    ORDERS_TOPIC_NOTIFICATIONS_ENABLED: envBool('ORDERS_TOPIC_NOTIFICATIONS_ENABLED', true),
    CLIENT_TOPIC_REPLY_ENABLED: envBool('CLIENT_TOPIC_REPLY_ENABLED', true),

    // Темы форума: chat_id = TELEGRAM_FORUM_GROUP_ID (или TELEGRAM_SUPERGROUP_ID); thread_id канонических ключей TELEGRAM_TOPIC_*.
    // Fallback thread_id: см. TELEGRAM_*_NOTIFY_THREAD_ID / TELEGRAM_*_THREAD_ID (ориентиры см. docs/telegram-forum-topics-ru.md).
    TELEGRAM_BROADCAST_TOPIC_CHAT_ID: resolveTelegramPerPurposeChatId('TELEGRAM_BROADCAST_TOPIC_CHAT_ID'),
    TELEGRAM_BROADCAST_TOPIC_THREAD_ID: resolveThreadFromEnv(
        ['TELEGRAM_TOPIC_BROADCASTS_ID', 'TELEGRAM_BROADCAST_TOPIC_THREAD_ID', 'TELEGRAM_BROADCASTS_THREAD_ID'],
        4
    ),
    TELEGRAM_SUPPORT_NOTIFY_CHAT_ID: resolveTelegramPerPurposeChatId('TELEGRAM_SUPPORT_NOTIFY_CHAT_ID'),
    TELEGRAM_SUPPORT_NOTIFY_THREAD_ID: RESOLVED_TELEGRAM_SUPPORT_TOPIC_THREAD_ID,
    /** Если задан TELEGRAM_TOPIC_ERRORS_ID — отдельная тема ошибок; иначе те же thread_id что и поддержка. */
    TELEGRAM_ERRORS_NOTIFY_THREAD_ID: RESOLVED_TELEGRAM_ERRORS_ROUTING_THREAD_ID,
    TELEGRAM_ORDERS_NOTIFY_CHAT_ID: resolveTelegramPerPurposeChatId('TELEGRAM_ORDERS_NOTIFY_CHAT_ID'),
    TELEGRAM_ORDERS_NOTIFY_THREAD_ID: resolveThreadFromEnv(
        ['TELEGRAM_TOPIC_ORDERS_ID', 'TELEGRAM_ORDERS_NOTIFY_THREAD_ID', 'TELEGRAM_ORDERS_THREAD_ID'],
        2
    ),
    /** Опционально: отдельная тема «брошенные корзины» (0/пусто = без Telegram-уведомлений, только БД+админка). */
    TELEGRAM_TOPIC_ABANDONED_CARTS_ID: RESOLVED_TELEGRAM_TOPIC_ABANDONED_CARTS_ID,
    /**
     * Опционально: явный выключатель Telegram-уведомлений по брошенным корзинам.
     * Если env не задан — по умолчанию true только при ненулевом TELEGRAM_TOPIC_ABANDONED_CARTS_ID.
     */
    ABANDONED_CART_TELEGRAM_NOTIFICATIONS_ENABLED: resolveAbandonedCartTelegramNotificationsEnabled(
        RESOLVED_TELEGRAM_TOPIC_ABANDONED_CARTS_ID
    ),
    /**
     * Личные уведомления клиенту (sendMessage). Не путать с forum-topic уведомлением в супергруппу.
     * Дефолт согласован с TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED (см. resolveAbandonedCartClientNotificationsEnabled).
     */
    ABANDONED_CART_CLIENT_NOTIFICATIONS_ENABLED: resolveAbandonedCartClientNotificationsEnabled(
        envBool('TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED', false)
    ),

    ABANDONED_CARTS_ENABLED: envBool('ABANDONED_CARTS_ENABLED', false),
    ABANDONED_CART_AFTER_MINUTES: envInt('ABANDONED_CART_AFTER_MINUTES', 30),
    ABANDONED_CART_NOTIFY_AFTER_MINUTES: envInt('ABANDONED_CART_NOTIFY_AFTER_MINUTES', 30),
    ABANDONED_CART_REPEAT_NOTIFY_HOURS: envInt('ABANDONED_CART_REPEAT_NOTIFY_HOURS', 24),
    ABANDONED_CART_MAX_NOTIFICATIONS: envInt('ABANDONED_CART_MAX_NOTIFICATIONS', 2),
    ABANDONED_CART_EXPIRE_DAYS: envInt('ABANDONED_CART_EXPIRE_DAYS', 30),
    ABANDONED_CART_SCAN_INTERVAL_MINUTES: envInt('ABANDONED_CART_SCAN_INTERVAL_MINUTES', 5),

    BROADCAST_TOPIC_TEST_MODE: envBool('BROADCAST_TOPIC_TEST_MODE', true),
    BROADCAST_TOPIC_TEST_TELEGRAM_IDS: envList('BROADCAST_TOPIC_TEST_TELEGRAM_IDS', ['67460775', '659921032']),
    BROADCAST_TOPIC_TEST_LABEL: env('BROADCAST_TOPIC_TEST_LABEL', ''),

    /** Legacy: используется для дефолта BROADCAST_GLOBAL_MESSAGES_PER_SEC, если он не задан в env. */
    BROADCAST_DELIVERY_INTERVAL_MS: BROADCAST_DELIVERY_INTERVAL_MS_RESOLVED,
    /**
     * Глобальный потолок copyMessage/сек для рассылки (token bucket). Если env не задан — ~1000/BROADCAST_DELIVERY_INTERVAL_MS.
     */
    BROADCAST_GLOBAL_MESSAGES_PER_SEC: resolveBroadcastGlobalMessagesPerSec(),
    /** Параллельных воркеров доставки внутри одной кампании (pool). */
    BROADCAST_WORKER_CONCURRENCY: envInt('BROADCAST_WORKER_CONCURRENCY', 4),
    /** Не чаще одного сообщения одному chat_id за этот интервал (мс). */
    BROADCAST_PER_CHAT_MIN_INTERVAL_MS: envInt('BROADCAST_PER_CHAT_MIN_INTERVAL_MS', 1000),
    /** Пауза между опросами волн RETRY_WAIT (мс), когда очередь временно пуста. */
    BROADCAST_RETRY_WAVE_POLL_MS: envInt('BROADCAST_RETRY_WAVE_POLL_MS', 400),
    /** Максимум получателей в одной волне параллельной доставки (защита от огромных IN). */
    BROADCAST_DELIVERY_WAVE_BATCH_SIZE: envInt('BROADCAST_DELIVERY_WAVE_BATCH_SIZE', 500),
    /** Сколько попыток доставки одному получателю (каждая попытка = один HTTP copyMessage + при неудаче retry_wait/backoff). */
    BROADCAST_MAX_COPY_ATTEMPTS: envInt('BROADCAST_MAX_COPY_ATTEMPTS', 8),
    /**
     * Подряд неуспешных copyMessage с transport-like кодами без успеха в волне — пауза кампании (circuit breaker).
     */
    BROADCAST_TRANSPORT_BREAKER_COPY_STREAK: envInt('BROADCAST_TRANSPORT_BREAKER_COPY_STREAK', 12),

    /** Активный probe getMe: включён при нормальном outbound (можно выключить env=0). */
    TELEGRAM_TRANSPORT_PROBE_ENABLED: envBool('TELEGRAM_TRANSPORT_PROBE_ENABLED', true),
    TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS: envInt('TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS', 60_000),
    TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS: envInt('TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS', 300_000),
    TELEGRAM_TRANSPORT_PROBE_INITIAL_DELAY_MS: envInt('TELEGRAM_TRANSPORT_PROBE_INITIAL_DELAY_MS', 8_000),
    /** Сколько мс доверять успешному probe для preflight при «пассивном» degraded. */
    TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS: envInt('TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS', 120_000),
    /** Минимум между авто-resume PAUSED_TRANSPORT (глобально). */
    BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS: envInt('BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS', 120_000),
    /** Cooldown на повторный auto-resume одной и той же кампании. */
    BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS: envInt('BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS', 180_000),
    /** Период фонового sweep PAUSED_TRANSPORT (если probe временно выключен / между успехами). */
    BROADCAST_PAUSED_TRANSPORT_SWEEP_MS: envInt('BROADCAST_PAUSED_TRANSPORT_SWEEP_MS', 45_000),

    ADMIN_PRIMARY_TELEGRAM_ID: RESOLVED_ADMIN_PRIMARY_TELEGRAM_ID,
    ADMIN_OWNER_TG_ID: RESOLVED_ADMIN_PRIMARY_TELEGRAM_ID,
    ADMIN_INITIAL_TG_IDS_LIST,
    ADMIN_PRIMARY_USERNAME: env('ADMIN_PRIMARY_USERNAME', 'arhi_pov'),
    ADMIN_PRIMARY_FIRST_NAME: env('ADMIN_PRIMARY_FIRST_NAME', 'Даня'),
    ADMIN_PRIMARY_LAST_NAME: env('ADMIN_PRIMARY_LAST_NAME', 'Архипов'),

    // Доступ к Mini App админке (initData): union(CSV ADMIN_TELEGRAM_IDS, DEFAULT_ADMIN_TELEGRAM_IDS)
    ADMIN_TELEGRAM_IDS: mergeAdminTelegramIdsWithDefaults('ADMIN_TELEGRAM_IDS', DEFAULT_ADMIN_TELEGRAM_IDS),
    /**
     * Отдельный CSV (без union с дефолтами). В admin-auth объединяется с ADMIN_TELEGRAM_IDS для проверки initData.
     * В broadcast-service используется только этот список как allowlist триггера рассылки из темы:
     * пустой массив = разрешён любой участник форума (см. isAdmin в broadcast-service).
     */
    TELEGRAM_ADMIN_IDS: envList('TELEGRAM_ADMIN_IDS', []),

    /** HMAC-ключ для stateless signed URL открытия /admin-embed (рекомендуется 32+ символа в production). */
    F21_ADMIN_OPEN_SECRET: env('F21_ADMIN_OPEN_SECRET', ''),

    ADMIN_INITDATA_MAX_AGE_SEC: envInt('ADMIN_INITDATA_MAX_AGE_SEC', 86400),
    /** Для setWebhook с secret_token; пусто = подпись заголовка не требуется (только для dev). В production задайте длинный случайный secret. */
    TELEGRAM_WEBHOOK_SECRET: env('TELEGRAM_WEBHOOK_SECRET', ''),
    /** Полный standalone UI по /admin и связанные сценарии. */
    ADMIN_UI_ENABLED: envBool('ADMIN_UI_ENABLED', true),
    /**
     * Встроенная админка в Mini App: /admin-embed + /admin-assets.
     * Отделено от ADMIN_UI_ENABLED: при ADMIN_UI_ENABLED=false часто отключают только внешний /admin,
     * но iframe и handoff должны продолжать отдавать admin HTML, иначе срабатывает SPA fallback (двойной storefront).
     */
    ADMIN_MINIAPP_EMBED_ENABLED: envBool('ADMIN_MINIAPP_EMBED_ENABLED', true),

    /** @type {(telegramId: string | number) => 'env' | 'default' | 'none'} */
    classifyAdminTelegramMatchSource: createAdminTelegramMatchClassifier(
        DEFAULT_ADMIN_TELEGRAM_IDS,
        RESOLVED_ADMIN_PRIMARY_TELEGRAM_ID
    )
};