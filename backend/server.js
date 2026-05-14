const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { initPaymentForOrder, handleNotification } = require('./tbank');
const { syncOrderToMoySkladOnCheckout } = require('./checkout-moysklad-order');
const { resolveCheckoutUnpaidOrderForReuse } = require('./checkout-order-reuse');
const {
    syncProductsFromMoySklad,
    sendOrderToMoySklad,
    syncOrderStatusesFromMoySkladForUser,
    getRawStockReportPage,
    downloadImageByUuid,
    fetchImageBuffer,
    scanStaleMsOrderLinks
} = require('./moysklad');
const config = require('./config');
const {
    createTelegramBotApiAxios,
    describeProxyUrlForLogs,
    resolveTelegramTransportMeta
} = require('./telegram-axios-client');
const telegramTransportMeta = resolveTelegramTransportMeta(config.TELEGRAM_PROXY_URL);
/** Единственный axios-инстанс для Bot API (SOCKS через createTelegramBotApiAxios). В server.js нет прямых .post к Telegram — только передача сюда в createTelegramClient. */
const telegramBotApiHttp = createTelegramBotApiAxios({
    proxyUrl: config.TELEGRAM_PROXY_URL,
    logger: console
});
const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_FORUM_GROUP_ID,
    TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
    OUTBOX_WORKER_ENABLED,
    OUTBOX_WORKER_INTERVAL_MS,
    TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_BROADCAST_TOPIC_CHAT_ID,
    TELEGRAM_BROADCAST_TOPIC_THREAD_ID,
    TELEGRAM_SUPPORT_NOTIFY_CHAT_ID,
    TELEGRAM_SUPPORT_NOTIFY_THREAD_ID,
    TELEGRAM_ORDERS_NOTIFY_CHAT_ID,
    TELEGRAM_ORDERS_NOTIFY_THREAD_ID,
    BROADCAST_TOPIC_TEST_MODE,
    BROADCAST_TOPIC_TEST_TELEGRAM_IDS,
    BROADCAST_TOPIC_TEST_LABEL,
    BROADCAST_DELIVERY_INTERVAL_MS,
    BROADCAST_GLOBAL_MESSAGES_PER_SEC,
    BROADCAST_WORKER_CONCURRENCY,
    BROADCAST_PER_CHAT_MIN_INTERVAL_MS,
    BROADCAST_RETRY_WAVE_POLL_MS,
    BROADCAST_DELIVERY_WAVE_BATCH_SIZE,
    BROADCAST_MAX_COPY_ATTEMPTS,
    BROADCAST_TRANSPORT_BREAKER_COPY_STREAK,
    TELEGRAM_TRANSPORT_PROBE_ENABLED,
    TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS,
    TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS,
    TELEGRAM_TRANSPORT_PROBE_INITIAL_DELAY_MS,
    TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS,
    BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS,
    BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS,
    BROADCAST_PAUSED_TRANSPORT_SWEEP_MS,
    BROADCASTS_ENABLED,
    TELEGRAM_ADMIN_IDS,
    ADMIN_UI_ENABLED,
    ADMIN_MINIAPP_EMBED_ENABLED
} = config;
const { createEventPublisher } = require('./event-publisher');
const { createTelegramClient } = require('./telegram-client');
const { createTelegramRoutingService } = require('./telegram-routing-service');
const { createOutboxRepository } = require('./outbox-repository');
const { createOutboxWorker } = require('./outbox-worker');
const { createOrderTopicNotificationService } = require('./order-topic-notification-service');
const { createSupportService } = require('./support-service');
const { createBroadcastService } = require('./broadcast-service');
const telegramTransportHealth = require('./telegram-transport-health');
const { startTelegramTransportProbe } = require('./telegram-transport-probe');
const { createTelegramUpdateHandler } = require('./telegram-update-handler');
const { createTelegramAdminDashboard } = require('./telegram-admin-dashboard');
const interactiveLatency = require('./telegram-interactive-metrics');
const { createAdminAuth } = require('./admin-auth');
const { createAdminRepository } = require('./admin-repository');
const { createRuntimeFlagsService } = require('./runtime-flags-service');
const { createAdminRouter } = require('./admin-routes');
const { signAdminOpenToken, verifyAdminOpenToken } = require('./admin-open-token');
const { buildTelegramBotCapabilitiesSnapshot } = require('./telegram-bot-capabilities');
const { createPromotionService } = require('./promotion-service');
const { createAdminUsersService } = require('./admin-users-service');

const crypto = require('crypto');

const eventPublisher = createEventPublisher();
const telegramClient = createTelegramClient({
    botToken: TELEGRAM_BOT_TOKEN,
    outboundHttpEnabled: TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
    http: telegramBotApiHttp,
    transportMode: telegramTransportMeta.mode,
    proxyEndpointForLogs: telegramTransportMeta.proxyEndpointForLogs,
    logger: console
});
const telegramRuntimeBotProfile = { username: null };

const promotionService = createPromotionService({
    db,
    config,
    runtimeBotProfile: telegramRuntimeBotProfile
});

const telegramRoutingService = createTelegramRoutingService({
    telegramClient,
    forumGroupId: TELEGRAM_FORUM_GROUP_ID,
    logger: console
});
const outboxRepository = createOutboxRepository({ logger: console });
const orderTopicNotificationService = createOrderTopicNotificationService({
    telegramClient,
    routingService: telegramRoutingService,
    ordersNotifyChatId: TELEGRAM_ORDERS_NOTIFY_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
    ordersNotifyThreadId: Number(TELEGRAM_ORDERS_NOTIFY_THREAD_ID || 0),
    logger: console
});
const supportService = createSupportService({
    telegramClient,
    routingService: telegramRoutingService,
    supportNotifyChatId: TELEGRAM_SUPPORT_NOTIFY_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
    supportNotifyThreadId: Number(TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0),
    logger: console,
    managerHelpCooldownMs: config.MANAGER_HELP_COOLDOWN_MS,
    telegramOutboundBotHttpEnabled: config.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED
});
const broadcastService = createBroadcastService({
    telegramClient,
    broadcastTopicChatId: TELEGRAM_BROADCAST_TOPIC_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
    broadcastTopicThreadId: Number(TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0),
    adminIds: TELEGRAM_ADMIN_IDS || [],
    topicTestModeEnabled: BROADCAST_TOPIC_TEST_MODE,
    topicTestTelegramIds: BROADCAST_TOPIC_TEST_TELEGRAM_IDS || [],
    topicTestLabel: BROADCAST_TOPIC_TEST_LABEL || '',
    deliveryIntervalMs: BROADCAST_DELIVERY_INTERVAL_MS,
    globalMessagesPerSec: BROADCAST_GLOBAL_MESSAGES_PER_SEC,
    workerConcurrency: BROADCAST_WORKER_CONCURRENCY,
    perChatMinIntervalMs: BROADCAST_PER_CHAT_MIN_INTERVAL_MS,
    retryWavePollMs: BROADCAST_RETRY_WAVE_POLL_MS,
    deliveryWaveBatchSize: BROADCAST_DELIVERY_WAVE_BATCH_SIZE,
    maxCopyAttempts: BROADCAST_MAX_COPY_ATTEMPTS,
    transportBreakerCopyStreak: BROADCAST_TRANSPORT_BREAKER_COPY_STREAK,
    getTransportPreflightContext: () => ({
        outboundEnabled: TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
        httpClientPresent: !!telegramBotApiHttp,
        proxyConfigured: telegramTransportMeta.mode === 'proxied',
        transportMode: telegramTransportMeta.mode
    }),
    probePreflightTrustMs: TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS,
    pausedTransportAutoResumeMinIntervalMs: BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS,
    pausedTransportPerCampaignCooldownMs: BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS,
    pausedTransportSweepMs: BROADCAST_PAUSED_TRANSPORT_SWEEP_MS,
    broadcastsEnabled: BROADCASTS_ENABLED,
    logger: console
});
const outboxWorker = createOutboxWorker({
    outboxRepository,
    orderTopicNotificationService,
    logger: console
});
const telegramAdminDashboard = createTelegramAdminDashboard({
    config,
    telegramClient,
    logger: console
});
const runtimeFlagsService = createRuntimeFlagsService({ config });
const telegramUpdateHandler = createTelegramUpdateHandler({
    supportService,
    broadcastService,
    telegramClient,
    telegramAdminDashboard,
    promotionService,
    runtimeFlagsService,
    config,
    runtimeBotProfile: telegramRuntimeBotProfile,
    logger: console
});

let telegramBotCapabilitiesSnapshot = null;

async function bootstrapTelegramBotCapabilities() {
    try {
        const raw = await telegramClient.getMe();
        telegramBotCapabilitiesSnapshot = buildTelegramBotCapabilitiesSnapshot(raw);
        const s = telegramBotCapabilitiesSnapshot;
        if (s.ok && s.username) {
            telegramRuntimeBotProfile.username = s.username;
        }
        if (s.ok && s.canReadAllGroupMessages === false) {
            console.warn(
                '[TelegramBotCapabilities] can_read_all_group_messages=false — у бота, вероятно, включён Group Privacy в @BotFather. Обычные сообщения менеджеров из супергруппы/тем могут не попадать в webhook; relay тема→клиент не заработает без отключения privacy и прав администратора. См. docs/production-telegram-support-relay-ru.md'
            );
        } else if (s.ok) {
            console.log('[TelegramBotCapabilities] getMe ok', {
                botUserId: s.botUserId,
                username: s.username,
                canReadAllGroupMessages: s.canReadAllGroupMessages
            });
            if (s.username && !String(config.TELEGRAM_BOT_USERNAME || '').trim()) {
                console.log('[Startup] manager_button_username_from_getMe', { username: s.username });
            }
        } else {
            console.warn('[TelegramBotCapabilities] getMe не выполнен', {
                errorCode: s.errorCode,
                message: s.message
            });
        }
    } catch (e) {
        console.error('[TelegramBotCapabilities] bootstrap error:', e.message || e);
        telegramBotCapabilitiesSnapshot = buildTelegramBotCapabilitiesSnapshot({
            ok: false,
            errorCode: 'BOOTSTRAP_EXCEPTION',
            message: String(e.message || e)
        });
    }
}

async function markTelegramUpdateProcessed(updateId) {
    const uid = Number(updateId);
    if (!Number.isFinite(uid)) return { ok: false, error: 'BAD_UPDATE_ID' };
    try {
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES (?, ?)',
                [uid, new Date().toISOString()],
                (err) => (err ? reject(err) : resolve())
            );
        });
        return { ok: true, duplicate: false };
    } catch (e) {
        if (String(e.message || '').toLowerCase().includes('unique constraint failed')) {
            return { ok: true, duplicate: true };
        }
        return { ok: false, error: e.message || 'UPDATE_TRACK_FAILED' };
    }
}
const adminUsersService = createAdminUsersService(config, { logger: console });
const adminAuth = createAdminAuth({ config, adminUsersService, logger: console });
const adminRepository = createAdminRepository();
const adminRouter = createAdminRouter({
    auth: adminAuth,
    adminRepository,
    adminUsersService,
    runtimeFlagsService,
    broadcastService,
    promotionService,
    telegramClient,
    config,
    scanStaleMsOrderLinks
});

function getAdminOpenSecret() {
    const s = String(config.F21_ADMIN_OPEN_SECRET || process.env.F21_ADMIN_OPEN_SECRET || '').trim();
    if (s.length >= 32) return s;
    const derived = crypto
        .createHash('sha256')
        .update(String(config.TELEGRAM_BOT_TOKEN || '') + '|f21.admin.open.v1')
        .digest('hex');
    console.warn(
        '[AdminOpenToken] F21_ADMIN_OPEN_SECRET unset or short — using derived key (set F21_ADMIN_OPEN_SECRET 32+ chars in production)'
    );
    return derived;
}

function sanitizeReturnToForAdmin(v) {
    const s = String(v || '').trim();
    if (!s.startsWith('/') || s.startsWith('//')) return '/?tab=profile';
    return s.slice(0, 512);
}

async function bootstrapOperationalTopics() {
    try {
        const mappings = [
            {
                key: 'orders_notify',
                chatId: TELEGRAM_ORDERS_NOTIFY_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
                threadId: Number(TELEGRAM_ORDERS_NOTIFY_THREAD_ID || 0),
                title: 'Orders notifications'
            },
            {
                key: 'support_notify',
                chatId: TELEGRAM_SUPPORT_NOTIFY_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
                threadId: Number(TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0),
                title: 'Support notifications'
            },
            {
                key: 'broadcast_notify',
                chatId: TELEGRAM_BROADCAST_TOPIC_CHAT_ID || TELEGRAM_FORUM_GROUP_ID,
                threadId: Number(TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0),
                title: 'Broadcast operations'
            }
        ];
        for (const m of mappings) {
            if (!m.chatId || !(m.threadId > 0)) continue;
            await telegramRoutingService.upsertTopic({
                topicKey: m.key,
                chatId: m.chatId,
                messageThreadId: m.threadId,
                title: m.title
            });
        }
    } catch (e) {
        console.error('[TopicsBootstrap] error:', e.message || e);
    }
}


// ===== Telegram follow-up after "Go to payment" (debounced) =====

const CHECKOUT_FOLLOWUP_DELAY_MS = 5 * 60 * 1000; // 5 минут
const PICKUP_ADDRESS_TEXT = 'улица Пирогова, 1, корп. 2';

// telegramId -> { timer, orderId }
const pendingCheckoutFollowups = new Map();

async function getOrCreateUserTopicId({ telegramId, firstName, lastName }) {
    const tid = String(telegramId || '').trim();
    if (!tid) return 0;

    const forumGroupId = TELEGRAM_FORUM_GROUP_ID;
    if (!forumGroupId) {
        console.warn('[TG] TELEGRAM_FORUM_GROUP_ID is empty');
        return 0;
    }
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[TG] TELEGRAM_BOT_TOKEN is empty');
        return 0;
    }

    // 1) пробуем взять topic_id из БД
    const userRow = await new Promise((resolve, reject) => {
        db.get(
            'SELECT topic_id, first_name, last_name FROM users WHERE telegram_id = ?',
            [tid],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    const existingTopicId = Number(userRow?.topic_id || 0);
    if (existingTopicId > 0) return existingTopicId;

    if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
        console.warn('[TG] createForumTopic skipped: TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=false');
        return 0;
    }

    // 2) создаём топик
    const fn = String(firstName || userRow?.first_name || '').trim();
    const ln = String(lastName || userRow?.last_name || '').trim();
    const titleBase = `${fn} ${ln}`.trim() || 'Client';
    const title = `${titleBase} (#${tid})`.slice(0, 128); // Telegram limit

    try {
        const created = await telegramClient.createForumTopic({
            chatId: forumGroupId,
            name: title
        });

        if (!created.ok) {
            console.error('[TG] createForumTopic failed:', created);
            return 0;
        }

        const topicId = Number(created.data?.message_thread_id || 0);
        if (!(topicId > 0)) {
            console.error('[TG] createForumTopic returned empty message_thread_id:', created);
            return 0;
        }

        // 3) сохраняем в БД
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE users SET topic_id = ? WHERE telegram_id = ?',
                [topicId, tid],
                (err) => (err ? reject(err) : resolve())
            );
        });

        console.log('[TG] topic created & saved:', { tid, topicId, title });
        return topicId;

    } catch (e) {
        console.error('[TG] createForumTopic error:', e.response?.data || e.message);
        return 0;
    }
}


async function sendTelegramBotMessage(chatId, text, opts = {}) {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[TG] TELEGRAM_BOT_TOKEN is not set, skip sending message');
        return { ok: false, error: 'NO_TOKEN' };
    }
    if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
        return { ok: true, skipped: true };
    }

    try {
        const sent = await telegramClient.sendMessage({
            chatId,
            text: String(text || ''),
            parseMode: opts.parse_mode,
            replyMarkup: opts.reply_markup
        });

        if (!sent.ok) {
            console.warn('[TG] sendMessage failed:', sent);
            return { ok: false, error: sent.errorCode || 'TG_API_ERROR', details: sent };
        }

        return { ok: true };
    } catch (e) {
        console.error('[TG] sendMessage error:', e.response?.data || e.message);
        return { ok: false, error: 'REQUEST_FAILED', details: e.response?.data || e.message };
    }
}

async function sendTelegramForumMessage(groupChatId, messageThreadId, text) {
    if (!TELEGRAM_BOT_TOKEN) return { ok: false, error: 'NO_TOKEN' };
    if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) return { ok: true, skipped: true };
    try {
        const tid = Number(messageThreadId);
        const sent = await telegramClient.sendMessage({
            chatId: groupChatId,
            messageThreadId: Number.isFinite(tid) && tid > 0 ? tid : undefined,
            text: String(text || '')
        });

        return { ok: !!sent.ok };
    } catch (e) {
        console.error('[TG] forum sendMessage error:', e.response?.data || e.message);
        return { ok: false };
    }
}


/**
 * Ставит/переставляет таймер follow-up сообщения.
 * ВАЖНО: если пользователь жмёт "перейти к оплате" повторно, старый таймер отменяется.
 */
function scheduleCheckoutFollowup({ telegramId, orderId }) {
    const key = String(telegramId || '').trim();
    const oid = Number(orderId);

    if (!key || !Number.isFinite(oid) || oid <= 0) return;

    // 1) отменяем предыдущий таймер для этого пользователя
    const prev = pendingCheckoutFollowups.get(key);
    if (prev?.timer) {
        clearTimeout(prev.timer);
    }

    // 2) ставим новый
    const timer = setTimeout(async () => {
        try {
            // Когда таймер сработал — удаляем запись (чтобы не висела в памяти)
            pendingCheckoutFollowups.delete(key);

            // Берём актуальный заказ и пользователя
            const orderRow = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT id, telegram_id, address, status FROM orders WHERE id = ?',
                    [oid],
                    (err, row) => (err ? reject(err) : resolve(row))
                );
            });

            if (!orderRow) return;

            // Если уже оплатил — не шлём
            const status = String(orderRow.status || '').toUpperCase();
            if (status === 'PAID') return;

            const userRow = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT first_name FROM users WHERE telegram_id = ?',
                    [key],
                    (err, row) => (err ? reject(err) : resolve(row))
                );
            });

            const firstName = String(userRow?.first_name || '').trim();
            const safeName = firstName || 'Здравствуйте';

            const addr = String(orderRow.address || '').trim();
            const isPickup = addr.toLowerCase() === 'самовывоз';

            let text = '';
            if (isPickup) {
                text =
                    `${safeName}! Мы заметили, что у Вас оформлен заказ. ` +
                    `Подскажите, когда планируете забрать его по адресу: ${PICKUP_ADDRESS_TEXT}? ☺️`;
            } else {
                text =
                    `${safeName}` +
                    `! Увидели, что у Вас заказ оформлен, подскажите верный ли адрес: ${addr}? ☺️`;
            }

            await sendTelegramBotMessage(key, text);
        } catch (e) {
            console.error('[TG] follow-up timer error:', e.message || e);
        }
    }, CHECKOUT_FOLLOWUP_DELAY_MS);

    pendingCheckoutFollowups.set(key, { timer, orderId: oid });
}


function ensureCheckoutHashColumn() {
    // SQLite: IF NOT EXISTS для ADD COLUMN нет, поэтому просто ловим ошибку
    db.run('ALTER TABLE orders ADD COLUMN checkout_hash TEXT', err => {
        if (err) {
            // "duplicate column name" — это нормально, значит колонка уже есть
            if (!String(err.message || '').toLowerCase().includes('duplicate column')) {
                console.error('[DB] ensureCheckoutHashColumn error:', err.message);
            }
        } else {
            console.log('[DB] orders.checkout_hash added');
        }
    });
}

ensureCheckoutHashColumn();

function ensureOrdersColumns() {
    db.run('ALTER TABLE orders ADD COLUMN checkout_hash TEXT', err => {
        if (err && !String(err.message || '').toLowerCase().includes('duplicate column')) {
            console.error('[DB] add checkout_hash error:', err.message);
        }
    });

    db.run('ALTER TABLE orders ADD COLUMN ms_sync_hash TEXT', err => {
        if (err && !String(err.message || '').toLowerCase().includes('duplicate column')) {
            console.error('[DB] add ms_sync_hash error:', err.message);
        }
    });
}

ensureOrdersColumns();



const app = express();
const PORT = process.env.PORT || 3000;
/** За nginx оставьте 127.0.0.1; по умолчанию 0.0.0.0 (как раньше). */
const LISTEN_HOST = String(process.env.LISTEN_HOST || '0.0.0.0').trim() || '0.0.0.0';

const repoRoot = path.join(__dirname, '..');
const frontendPath = path.join(repoRoot, 'frontend');
const adminPath = path.join(frontendPath, 'admin');
const { resolveFrontendBuildId, injectHtmlBuildStamp: stampHtmlWithBuild } = require('./frontend-build-id');
const F21_FRONTEND_RESOLUTION = resolveFrontendBuildId({ repoRoot, frontendPath, logger: console });
const FRONTEND_BUILD_ID = F21_FRONTEND_RESOLUTION.build;
const FRONTEND_BUILD_SOURCE = F21_FRONTEND_RESOLUTION.source;

function injectHtmlBuildStamp(html, surface) {
    return stampHtmlWithBuild(html, FRONTEND_BUILD_ID, {
        logger: console,
        surface: surface || 'unspecified'
    });
}

async function applyBonusesAfterPaid(orderId) {
    // 1) грузим заказ
    const order = await new Promise((resolve, reject) => {
        db.get(
            'SELECT telegram_id, total_paid, bonuses_used, bonus_processed FROM orders WHERE id = ?',
            [orderId],
            (err, row) => (err ? reject(err) : resolve(row))
        );
    });

    if (!order) return;
    if (order.bonus_processed) return; // идемпотентность

    const telegramId = order.telegram_id;
    const paidK = Number(order.total_paid || 0);
    const usedK = Number(order.bonuses_used || 0);

    // 5% от оплаченной суммы, начисляем в рублях (целое)
    const earnedK = Math.floor(paidK * 0.05);
    const earnedRub = Math.floor(earnedK / 100);

    const usedRub = Math.floor(usedK / 100);

    // 2) обновляем баланс пользователя
    await new Promise((resolve, reject) => {
        db.run(
            'UPDATE users SET bonus_balance = bonus_balance - ? + ? WHERE telegram_id = ?',
            [usedRub, earnedRub, telegramId],
            err => (err ? reject(err) : resolve())
        );
    });

    // 3) отмечаем заказ как обработанный по бонусам
    await new Promise((resolve, reject) => {
        db.run(
            'UPDATE orders SET bonus_earned = ?, bonus_processed = 1 WHERE id = ?',
            [earnedK, orderId],
            err => (err ? reject(err) : resolve())
        );
    });
}


// Middleware
app.use(cors());
app.use(express.json({ limit: '1536kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

const ADMIN_CLIENT_LOG_STEPS = new Set(['admin_mount_ok']);

/** Телеметрия шагов открытия админки из WebView (без секретов, для journalctl). */
app.post('/api/admin/client-log', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const step = String(body.step || '').trim();
    if (!ADMIN_CLIENT_LOG_STEPS.has(step)) {
        return res.status(400).json({ ok: false, error: 'BAD_STEP' });
    }
    const safe = {
        build: (() => {
            const b = String(body.build || '').trim().slice(0, 64);
            return b || 'client_build_missing';
        })(),
        path: String(body.path || '').slice(0, 120) || null,
        detail: String(body.detail || '').slice(0, 200) || null,
        iframeDebug: body.iframeDebug === true,
        ua: String(req.headers['user-agent'] || '').slice(0, 180)
    };
    console.log(`[AdminClient] ${step}`, safe);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
});

/**
 * ВАЖНО: /api/health/ops должен быть зарегистрирован до express.static и до SPA fallback.
 * Иначе при любой ошибке порядка маршрутов или отсутствии хендлера GET /api/* попадает в app.get('*')
 * и клиент получает index.html Mini App вместо JSON (симптом на проде: curl /api/health/ops → HTML).
 */
app.get('/api/health/ops', async (req, res) => {
    const C = config;
    const managerHelpOpsSnapshot = require('./manager-help-ops').getManagerHelpOpsSnapshot();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    let broadcastLifecyclePayload = null;
    try {
        if (typeof broadcastService.getBroadcastLifecycleDiagnostics === 'function') {
            const raw = broadcastService.getBroadcastLifecycleDiagnostics();
            broadcastLifecyclePayload =
                raw && typeof raw.then === 'function' ? await raw : raw;
        }
    } catch (e) {
        broadcastLifecyclePayload = { error: 'BROADCAST_LIFECYCLE_DIAGNOSTICS_FAILED' };
    }
    let broadcastOpsPayload = null;
    try {
        if (typeof broadcastService.getBroadcastOpsDiagnostics === 'function') {
            const raw = broadcastService.getBroadcastOpsDiagnostics();
            broadcastOpsPayload = raw && typeof raw.then === 'function' ? await raw : raw;
        }
    } catch (e) {
        broadcastOpsPayload = { error: 'BROADCAST_OPS_DIAGNOSTICS_FAILED' };
    }
    res.json({
        ok: true,
        time: new Date().toISOString(),
        serverModule: 'backend/server.js',
        flags: {
            TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED: C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
            TELEGRAM_TOPICS_ENABLED: C.TELEGRAM_TOPICS_ENABLED,
            EVENT_OUTBOX_ENABLED: C.EVENT_OUTBOX_ENABLED,
            OUTBOX_WORKER_ENABLED: C.OUTBOX_WORKER_ENABLED,
            ORDERS_TOPIC_NOTIFICATIONS_ENABLED: C.ORDERS_TOPIC_NOTIFICATIONS_ENABLED,
            BROADCASTS_ENABLED: C.BROADCASTS_ENABLED,
            SUPPORT_RELAY_ENABLED: C.SUPPORT_RELAY_ENABLED,
            CLIENT_TOPIC_REPLY_ENABLED: C.CLIENT_TOPIC_REPLY_ENABLED,
            ADMIN_UI_ENABLED: C.ADMIN_UI_ENABLED,
            ADMIN_MINIAPP_EMBED_ENABLED: C.ADMIN_MINIAPP_EMBED_ENABLED,
            EVENT_PUBLISHER_ENABLED: C.EVENT_PUBLISHER_ENABLED,
            BROADCAST_TOPIC_TEST_MODE: C.BROADCAST_TOPIC_TEST_MODE,
            BROADCAST_DELIVERY_INTERVAL_MS: C.BROADCAST_DELIVERY_INTERVAL_MS,
            BROADCAST_GLOBAL_MESSAGES_PER_SEC: C.BROADCAST_GLOBAL_MESSAGES_PER_SEC,
            BROADCAST_WORKER_CONCURRENCY: C.BROADCAST_WORKER_CONCURRENCY,
            BROADCAST_PER_CHAT_MIN_INTERVAL_MS: C.BROADCAST_PER_CHAT_MIN_INTERVAL_MS,
            BROADCAST_RETRY_WAVE_POLL_MS: C.BROADCAST_RETRY_WAVE_POLL_MS,
            BROADCAST_DELIVERY_WAVE_BATCH_SIZE: C.BROADCAST_DELIVERY_WAVE_BATCH_SIZE,
            BROADCAST_MAX_COPY_ATTEMPTS: C.BROADCAST_MAX_COPY_ATTEMPTS,
            BROADCAST_TRANSPORT_BREAKER_COPY_STREAK: C.BROADCAST_TRANSPORT_BREAKER_COPY_STREAK,
            TELEGRAM_TRANSPORT_PROBE_ENABLED: C.TELEGRAM_TRANSPORT_PROBE_ENABLED,
            TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS: C.TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS,
            TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS: C.TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS,
            TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS: C.TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS,
            BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS: C.BROADCAST_PAUSED_AUTO_RESUME_MIN_INTERVAL_MS,
            BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS: C.BROADCAST_PAUSED_AUTO_RESUME_PER_CAMPAIGN_MS,
            BROADCAST_PAUSED_TRANSPORT_SWEEP_MS: C.BROADCAST_PAUSED_TRANSPORT_SWEEP_MS
        },
        threadsConfigured: {
            broadcast: Number(C.TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0) > 0,
            orders: Number(C.TELEGRAM_ORDERS_NOTIFY_THREAD_ID || 0) > 0,
            support: Number(C.TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0) > 0
        },
        telegramBotApiProxy: describeProxyUrlForLogs(C.TELEGRAM_PROXY_URL),
        telegramTransport: {
            outboundEnabled: C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
            mode: telegramTransportMeta.mode,
            proxyEndpointForLogs: telegramTransportMeta.proxyEndpointForLogs,
            client: 'createTelegramBotApiAxios'
        },
        ...(() => {
            const telegramBotApiTransportHealth = telegramTransportHealth.getTelegramTransportHealthSnapshot({
                outboundEnabled: C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
                httpClientPresent: !!telegramBotApiHttp,
                proxyConfigured: telegramTransportMeta.mode === 'proxied',
                transportMode: telegramTransportMeta.mode
            });
            const transportProbe = telegramTransportHealth.getTransportProbeSnapshot({
                enabled: Boolean(C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED && C.TELEGRAM_TRANSPORT_PROBE_ENABLED),
                method: 'getMe',
                intervalMs: C.TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS,
                backoffMaxMs: C.TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS,
                preflightTrustMs: C.TELEGRAM_TRANSPORT_PROBE_PREFLIGHT_TRUST_MS
            });
            return {
                telegramBotApiTransportHealth,
                telegramTransportHealth: telegramBotApiTransportHealth,
                transportProbe
            };
        })(),
        adminOpen: 'form_post_admin_launch_303',
        broadcastWorker: typeof broadcastService.getWorkerSnapshot === 'function' ? broadcastService.getWorkerSnapshot() : null,
        broadcastDeliveryMetrics:
            typeof broadcastService.getBroadcastDeliveryMetrics === 'function'
                ? broadcastService.getBroadcastDeliveryMetrics()
                : null,
        broadcastOps: broadcastOpsPayload,
        broadcastLastRun: await (async () => {
            try {
                if (typeof broadcastService.getBroadcastLastRunDiagnostics !== 'function') return null;
                const raw = broadcastService.getBroadcastLastRunDiagnostics();
                return raw && typeof raw.then === 'function' ? await raw : raw;
            } catch (e) {
                return { error: 'BROADCAST_LAST_RUN_DIAGNOSTICS_FAILED' };
            }
        })(),
        broadcastLifecycle: broadcastLifecyclePayload,
        interactiveLatency: interactiveLatency.getInteractiveLatencySnapshot(),
        broadcastInteractiveStarvationHints: {
            webhookUsesAsyncDispatch: true,
            note: 'Telegram updates ACK immediately; heavy work runs via setImmediate to reduce /start vs broadcast coupling'
        },
        broadcastZeroDeliveryHints: {
            outboundBotHttpDisabled: !C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
            broadcastsDisabled: !C.BROADCASTS_ENABLED,
            broadcastTopicThreadConfigured: Number(C.TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0) > 0,
            topicTestModeEnabled: C.BROADCAST_TOPIC_TEST_MODE,
            topicTestRecipientEnvCount: Array.isArray(C.BROADCAST_TOPIC_TEST_TELEGRAM_IDS)
                ? C.BROADCAST_TOPIC_TEST_TELEGRAM_IDS.length
                : 0,
            copyMessageRequiresOutbound: true
        },
        telegramBotCapabilities: telegramBotCapabilitiesSnapshot,
        storefrontBuild: FRONTEND_BUILD_ID,
        storefrontBuildSource: FRONTEND_BUILD_SOURCE,
        lastManagerHelpRequestAt: managerHelpOpsSnapshot.lastManagerHelpRequestAt,
        lastManagerHelpNotifyAt: managerHelpOpsSnapshot.lastManagerHelpNotifyAt,
        managerHelpDuplicateSuppressCount: managerHelpOpsSnapshot.managerHelpDuplicateSuppressCount,
        managerHelpLastError: managerHelpOpsSnapshot.managerHelpLastError
    });
});

/** Публичный PDF для sendDocument (Telegram скачивает по HTTPS). Путь URL = BASE_URL + TELEGRAM_CONSENT_PUBLIC_PATH. */
const consentPublicPath = String(config.TELEGRAM_CONSENT_PUBLIC_PATH || '/public/cvetochny21-consent.pdf');
app.get(consentPublicPath, (req, res) => {
    const resolved = path.resolve(String(config.TELEGRAM_CONSENT_PDF_PATH || ''));
    if (!resolved || !fs.existsSync(resolved)) {
        console.warn('[PublicConsent] consent PDF not found on disk', { resolved: resolved || null });
        return res.status(404).type('text/plain; charset=utf-8').send('Consent PDF not available');
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/pdf');
    res.sendFile(resolved);
});

function sendAdminIndexHtml(res, initDataRaw) {
    try {
        const htmlPath = path.join(adminPath, 'index.html');
        let html = injectHtmlBuildStamp(fs.readFileSync(htmlPath, 'utf8'), 'admin');
        const inject = `<script>window.__F21_EMBEDDED_INIT_DATA=${JSON.stringify(String(initDataRaw || ''))};</script>`;
        if (!html.includes('</head>')) {
            console.error('[AdminUI] admin/index.html: отсутствует </head>');
            return res.status(500).send('Admin UI misconfigured');
        }
        html = html.replace('</head>', `${inject}\n</head>`);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Vary', 'Accept-Encoding');
        const injLen = String(initDataRaw || '').length;
        console.log('[AdminUI] sendAdminIndexHtml', {
            path: 'frontend/admin/index.html',
            surface: 'admin',
            injectedInitDataLen: injLen,
            build: FRONTEND_BUILD_ID,
            source: FRONTEND_BUILD_SOURCE
        });
        res.send(html);
    } catch (e) {
        console.error('[AdminUI] sendAdminIndexHtml:', e.message || e);
        res.status(500).send('Admin UI error');
    }
}

function logStartupWiring() {
    const C = config;
    const flags = {
        TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED: C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
        TELEGRAM_TOPICS_ENABLED: C.TELEGRAM_TOPICS_ENABLED,
        EVENT_OUTBOX_ENABLED: C.EVENT_OUTBOX_ENABLED,
        OUTBOX_WORKER_ENABLED: C.OUTBOX_WORKER_ENABLED,
        ORDERS_TOPIC_NOTIFICATIONS_ENABLED: C.ORDERS_TOPIC_NOTIFICATIONS_ENABLED,
        BROADCASTS_ENABLED: C.BROADCASTS_ENABLED,
        SUPPORT_RELAY_ENABLED: C.SUPPORT_RELAY_ENABLED,
        CLIENT_TOPIC_REPLY_ENABLED: C.CLIENT_TOPIC_REPLY_ENABLED,
        ADMIN_UI_ENABLED: C.ADMIN_UI_ENABLED,
        ADMIN_MINIAPP_EMBED_ENABLED: C.ADMIN_MINIAPP_EMBED_ENABLED,
        EVENT_PUBLISHER_ENABLED: C.EVENT_PUBLISHER_ENABLED,
        BROADCAST_TOPIC_TEST_MODE: C.BROADCAST_TOPIC_TEST_MODE
    };
    const threads = {
        broadcastTopicId: Number(C.TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0),
        ordersTopicId: Number(C.TELEGRAM_ORDERS_NOTIFY_THREAD_ID || 0),
        supportTopicId: Number(C.TELEGRAM_SUPPORT_NOTIFY_THREAD_ID || 0)
    };
    console.log('[Startup] Telegram Bot API HTTP path:', describeProxyUrlForLogs(C.TELEGRAM_PROXY_URL));
    console.log('[Startup] F21 operational wiring (effective flags + thread ids, без секретов):', JSON.stringify({ flags, threads }, null, 0));
    console.log(
        '[Startup] routes: GET /api/health/ops, POST /admin-launch, GET /admin-embed до express.static; SPA fallback не отдаёт HTML для /api/*'
    );
    console.log('[Startup] F21 frontend build', JSON.stringify({ build: FRONTEND_BUILD_ID, source: FRONTEND_BUILD_SOURCE }));
    if (C.BROADCASTS_ENABLED && !(threads.broadcastTopicId > 0)) {
        console.warn(
            '[Startup] BROADCASTS_ENABLED=true, но TELEGRAM_BROADCAST_TOPIC_THREAD_ID=0 — сообщения в теме рассылки не матчятся (см. isBroadcastTopicMessage).'
        );
    }
    if (C.ORDERS_TOPIC_NOTIFICATIONS_ENABLED && !(threads.ordersTopicId > 0)) {
        console.warn(
            '[Startup] ORDERS_TOPIC_NOTIFICATIONS_ENABLED=true, но TELEGRAM_ORDERS_NOTIFY_THREAD_ID=0 — уведомления в тему заказов не отправляются.'
        );
    }
    if (C.SUPPORT_RELAY_ENABLED && !(threads.supportTopicId > 0)) {
        console.warn(
            '[Startup] SUPPORT_RELAY_ENABLED=true, но TELEGRAM_SUPPORT_NOTIFY_THREAD_ID=0 — уведомления в тему поддержки не отправляются.'
        );
    }
    if (!C.TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
        console.warn(
            '[Startup] TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=false — исходящие HTTPS к api.telegram.org отключены (уведомления/топики/рассылки через бота не уходят). Проверка подписи Web App initData остаётся локальной.'
        );
    }
    if (!C.ADMIN_UI_ENABLED && !C.ADMIN_MINIAPP_EMBED_ENABLED) {
        console.warn(
            '[Startup] ADMIN_UI_ENABLED=false и ADMIN_MINIAPP_EMBED_ENABLED=false — GET /admin-embed отдаёт 503 (не SPA).'
        );
    }
    const botUser = String(C.TELEGRAM_BOT_USERNAME || '').trim();
    if (!botUser) {
        console.warn(
            '[Startup] TELEGRAM_BOT_USERNAME пуст в env — опционально для ссылок; кнопка «Позвать менеджера» в welcome использует callback (manager_help_request), не t.me URL.'
        );
    }
}

function logAdminEmbedHit(req, res, next) {
    const hasH = !!String(req.query?.h || '').trim();
    const hasReturnTo = !!String(req.query?.returnTo || '').trim();
    console.log('[AdminEmbed] request', {
        hasToken: hasH,
        hasReturnTo,
        path: String(req.path || '')
    });
    next();
}

/** GET /admin-embed и GET /admin: только stateless signed ?h= (без cookie, без in-memory handoff). */
async function ensureAdminEmbedAccess(req, res, next) {
    const h = String(req.query?.h || '').trim();
    if (!h) {
        const hasReturnTo = !!String(req.query?.returnTo || '').trim();
        console.log('[AdminEmbed] invalid_direct_open_without_token', {
            path: String(req.path || ''),
            referer: String(req.headers.referer || req.headers.referrer || ''),
            'user-agent': String(req.headers['user-agent'] || ''),
            hasReturnTo
        });
        console.log('[AdminEmbed] token_invalid', { reason: 'missing_h' });
        return res.status(403).type('text/plain; charset=utf-8').send('Admin access: missing token');
    }
    const secret = getAdminOpenSecret();
    const v = verifyAdminOpenToken(h, secret);
    if (!v.ok) {
        console.log('[AdminEmbed] token_invalid', { reason: v.reason || 'verify_failed' });
        return res.status(403).type('text/plain; charset=utf-8').send('Admin access denied or expired');
    }
    try {
        const resolved = await adminAuth.resolveFromInitDataRaw(v.initDataRaw);
        if (!resolved.ok) {
            console.log('[AdminEmbed] token_invalid', { reason: 'initdata_or_role' });
            return res.status(403).type('text/plain; charset=utf-8').send('Admin access denied');
        }
        console.log('[AdminEmbed] token_valid', {
            telegramId: resolved.principal.telegramId,
            tokenTtlSec: v.tokenTtlSec,
            buildId: FRONTEND_BUILD_ID
        });
        req.admin = resolved.principal;
        req.f21AdminInitDataRaw = resolved.initDataRaw;
        return next();
    } catch (e) {
        console.error('[AdminEmbed] token_resolve_failed', { message: e.message || String(e) });
        return res.status(500).type('text/plain; charset=utf-8').send('Admin access error');
    }
}

app.use((req, res, next) => {
    const p = String(req.path || '');
    if (p === '/admin/index.html' || p === '/admin/login' || (p.startsWith('/admin/') && p !== '/admin')) {
        return res.status(403).send('Доступ запрещен');
    }
    next();
});

if (ADMIN_UI_ENABLED || ADMIN_MINIAPP_EMBED_ENABLED) {
    app.get(`/admin-assets/app.${FRONTEND_BUILD_ID}.js`, (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('application/javascript; charset=utf-8');
        console.log('[AdminAssets] served', { file: 'app.js', path: `app.${FRONTEND_BUILD_ID}.js`, build: FRONTEND_BUILD_ID });
        res.sendFile(path.join(adminPath, 'app.js'));
    });
    app.get(`/admin-assets/styles.${FRONTEND_BUILD_ID}.css`, (req, res) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.type('text/css; charset=utf-8');
        console.log('[AdminAssets] served', { file: 'styles.css', path: `styles.${FRONTEND_BUILD_ID}.css`, build: FRONTEND_BUILD_ID });
        res.sendFile(path.join(adminPath, 'styles.css'));
    });
    app.use(
        '/admin-assets',
        express.static(adminPath, {
            fallthrough: true,
            setHeaders(res, filePath) {
                const base = path.basename(String(filePath || ''));
                if (base === 'app.js' || base === 'styles.css') {
                    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                    res.setHeader('Pragma', 'no-cache');
                }
            }
        })
    );
    app.use('/admin-assets', (req, res) => {
        const rel = String(req.path || '').replace(/^\/+/, '') || '(empty)';
        console.warn('[AdminAssets] miss_or_wrong_type', { url: req.originalUrl || req.url, path: req.path, rel });
        res.status(404).type('text/plain; charset=utf-8').send('Admin asset not found');
    });
    app.get('/admin-embed', logAdminEmbedHit, ensureAdminEmbedAccess, (req, res) => {
        console.log('[AdminUI] branch=serving_embedded_html route=GET_/admin-embed');
        sendAdminIndexHtml(res, req.f21AdminInitDataRaw);
    });
} else {
    app.get('/admin-embed', (req, res) => {
        console.warn('[AdminEmbed] branch=flags_disabled_both ADMIN_UI and ADMIN_MINIAPP_EMBED off');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.status(503).type('text/plain; charset=utf-8').send(
            'Встроенная админка отключена: задайте ADMIN_MINIAPP_EMBED_ENABLED=1 и/или ADMIN_UI_ENABLED=1.'
        );
    });
}

if (ADMIN_UI_ENABLED) {
    app.get('/admin', logAdminEmbedHit, ensureAdminEmbedAccess, (req, res) => {
        console.log('[AdminUI] branch=serving_standalone_html route=GET_/admin');
        sendAdminIndexHtml(res, req.f21AdminInitDataRaw);
    });
}

function sendStorefrontIndexHtml(req, res) {
    try {
        const fp = path.join(frontendPath, 'index.html');
        let html = injectHtmlBuildStamp(fs.readFileSync(fp, 'utf8'), 'storefront');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Vary', '*');
        res.type('text/html; charset=utf-8');
        console.log('[StorefrontHTML] served', {
            build: FRONTEND_BUILD_ID,
            source: FRONTEND_BUILD_SOURCE,
            surface: 'storefront',
            path: String(req.path || '/')
        });
        res.send(html);
    } catch (e) {
        console.error('[StorefrontHTML] error', e.message || e);
        res.status(500).type('text/plain; charset=utf-8').send('Storefront unavailable');
    }
}

app.get(`/app.${FRONTEND_BUILD_ID}.js`, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/javascript; charset=utf-8');
    console.log('[StorefrontAssets] served', { file: 'app.js', path: `app.${FRONTEND_BUILD_ID}.js`, build: FRONTEND_BUILD_ID });
    res.sendFile(path.join(frontendPath, 'app.js'));
});
app.get(`/styles.${FRONTEND_BUILD_ID}.css`, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('text/css; charset=utf-8');
    console.log('[StorefrontAssets] served', { file: 'styles.css', path: `styles.${FRONTEND_BUILD_ID}.css`, build: FRONTEND_BUILD_ID });
    res.sendFile(path.join(frontendPath, 'styles.css'));
});

app.get(['/', '/index.html'], sendStorefrontIndexHtml);

app.use(
    express.static(frontendPath, {
        setHeaders(res, filePath) {
            const base = path.basename(String(filePath || ''));
            if (base === 'index.html') {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            }
            if (base === 'app.js' || base === 'styles.css') {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
                res.setHeader('Pragma', 'no-cache');
            }
        }
    })
);

app.get('/api/admin/access', async (req, res) => {
    try {
        const resolved = await adminAuth.resolveAdminFromRequest(req);
        if (!resolved.ok) {
            return res.status(403).json({ ok: true, allowed: false });
        }
        return res.json({
            ok: true,
            allowed: true,
            admin: {
                telegramId: resolved.principal.telegramId,
                adminId: resolved.principal.adminId
            }
        });
    } catch (e) {
        console.error('[AdminAccess] probe_failed', { message: e.message || String(e) });
        return res.status(500).json({ ok: false, allowed: false, error: 'ACCESS_PROBE_FAILED' });
    }
});

app.use('/api/admin', adminRouter);

/**
 * Document navigation: HTML form POST → 303 → GET /admin-embed?h=…
 * (без fetch/handoff JSON; витрина не зависит от XHR.)
 */
app.post('/admin-launch', async (req, res) => {
    console.log('[AdminLaunch] request', {
        contentType: String(req.headers['content-type'] || '').slice(0, 48),
        hasTgField: !!(req.body && (req.body.tgWebAppData || req.body.initData)),
        hasReturnTo: !!(req.body && req.body.returnTo)
    });
    if (!ADMIN_UI_ENABLED && !ADMIN_MINIAPP_EMBED_ENABLED) {
        return res.status(503).type('text/plain; charset=utf-8').send('Admin UI disabled');
    }
    const initData = String((req.body && (req.body.tgWebAppData || req.body.initData)) || '').trim();
    const fakeReq = { headers: { 'x-telegram-init-data': initData }, query: {}, path: '/admin-launch' };
    try {
        const resolved = await adminAuth.resolveAdminFromRequest(fakeReq);
        if (!resolved.ok || !resolved.initDataRaw) {
            console.warn('[AdminLaunch] denied', { error: resolved.error || 'FORBIDDEN' });
            return res.status(403).type('text/plain; charset=utf-8').send('Access denied');
        }
        const tid = String(resolved.principal.telegramId || '');
        console.log('[AdminLaunch] verified_admin', { telegramId: tid });
        const tokenTtlSec = 90;
        const secret = getAdminOpenSecret();
        const signed = signAdminOpenToken(resolved.initDataRaw, tid, secret, tokenTtlSec);
        const returnTo = sanitizeReturnToForAdmin(req.body && req.body.returnTo);
        const loc = `/admin-embed?h=${encodeURIComponent(signed)}&returnTo=${encodeURIComponent(returnTo)}`;
        console.log('[AdminLaunch] redirect_to_embed', {
            tokenTtlSec,
            buildId: FRONTEND_BUILD_ID,
            returnToLen: returnTo.length,
            path: '/admin-embed'
        });
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        return res.redirect(303, loc);
    } catch (e) {
        console.error('[AdminLaunch] error', { message: e.message || String(e) });
        return res.status(500).type('text/plain; charset=utf-8').send('Access error');
    }
});

// === API ===

// Удаление адреса
app.delete('/api/addresses/:addressId', (req, res) => {
    const { addressId } = req.params;
    const { telegramId } = req.body;

    if (!telegramId) {
        return res.status(400).json({ error: 'telegramId is required' });
    }

    db.run(
        'DELETE FROM addresses WHERE id = ? AND telegram_id = ?',
        [addressId, telegramId],
        function (err) {
            if (err) {
                console.error('Error deleting address:', err);
                return res.status(500).json({ error: 'DB error' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Address not found' });
            }
            res.json({ ok: true });
        }
    );
});


// Список товаров
app.get('/api/products', (req, res) => {
    db.all('SELECT * FROM products', (err, rows) => {
        if (err) {
            console.error('Error fetching products:', err);
            return res.status(500).json({ error: 'DB error' });
        }

        const products = rows.map(r => ({
            id: r.id,
            ms_id: r.ms_id,
            name: r.name,
            price: r.price,
            images: JSON.parse(r.images_json || '[]'),
            stock: r.stock ?? null,
            category: r.category || null,
            categoryPath: r.category_path || null
        }));

        res.json(products);
    });
});


// Инициализация / обновление пользователя
app.post('/api/user/init', (req, res) => {
    const { telegramId, firstName, lastName, username, photoUrl } = req.body;
    if (!telegramId) {
        return res.status(400).json({ error: 'telegramId is required' });
    }

    const nowUserIso = new Date().toISOString();

    db.get(
        'SELECT telegram_id FROM users WHERE telegram_id = ?',
        [telegramId],
        (err, row) => {
            if (err) {
                console.error('Error selecting user:', err);
                return res.status(500).json({ error: 'DB error' });
            }

            if (!row) {
                // Первый вход -> 500 бонусов
                db.run(
                    `
          INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, bonus_balance, first_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
                    [telegramId, firstName || '', lastName || '', username || '', photoUrl || '', 300, nowUserIso],
                    err2 => {
                        if (err2) {
                            console.error('Error inserting user:', err2);
                            return res.status(500).json({ error: 'DB error' });
                        }
                        return res.json({ ok: true, bonusBalance: 300 });
                    }
                );
            } else {
                // Не первый вход -> просто обновляем профиль, бонусы не трогаем
                db.run(
                    `
          UPDATE users SET
            first_name = ?,
            last_name = ?,
            username = ?,
            photo_url = ?,
            broadcast_suppressed_reason = NULL,
            broadcast_suppressed_at = NULL
          WHERE telegram_id = ?
          `,
                    [firstName || '', lastName || '', username || '', photoUrl || '', telegramId],
                    err2 => {
                        if (err2) {
                            console.error('Error updating user:', err2);
                            return res.status(500).json({ error: 'DB error' });
                        }
                        return res.json({ ok: true });
                    }
                );
            }
        }
    );
});


app.post('/api/user/bind-topic', async (req, res) => {
    try {
        const { telegramId, topicId } = req.body;
        const tid = String(telegramId || '').trim();
        const topic = Number(topicId);

        if (!tid || !Number.isFinite(topic) || topic <= 0) {
            return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
        }

        db.run(
            'UPDATE users SET topic_id = ? WHERE telegram_id = ?',
            [topic, tid],
            (err) => {
                if (err) return res.status(500).json({ ok: false, error: 'DB_ERROR' });
                res.json({ ok: true });
            }
        );
    } catch (e) {
        res.status(500).json({ ok: false, error: 'FAILED' });
    }
});



app.get('/api/bonuses/:telegramId', (req, res) => {
    const { telegramId } = req.params;

    db.get(
        'SELECT bonus_balance FROM users WHERE telegram_id = ?',
        [telegramId],
        (err, row) => {
            if (err) {
                console.error('Error fetching bonus balance:', err);
                return res.status(500).json({ ok: false, error: 'DB error' });
            }
            res.json({ ok: true, bonusBalance: row?.bonus_balance ?? 0 });
        }
    );
});


// Адреса пользователя
app.get('/api/addresses/:telegramId', (req, res) => {
  const { telegramId } = req.params;
  db.all(
    'SELECT * FROM addresses WHERE telegram_id = ?',
    [telegramId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching addresses:', err);
        return res.status(500).json({ error: 'DB error' });
      }
      res.json(rows);
    }
  );
});

app.post('/api/addresses/:telegramId', (req, res) => {
    const { telegramId } = req.params;
    const { label, address } = req.body;

    // Нормализуем адрес: убираем лишние пробелы, в начале/конце и внутри
    let normalized = (address || '').trim();
    normalized = normalized.replace(/\s+/g, ' ');

    if (!normalized) {
        return res.status(400).json({ error: 'address is required' });
    }

    // 1. Ищем уже существующий такой адрес для этого пользователя
    db.get(
        'SELECT * FROM addresses WHERE telegram_id = ? AND address = ?',
        [telegramId, normalized],
        (err, row) => {
            if (err) {
                console.error('Error fetching address:', err);
                return res.status(500).json({ error: 'DB error' });
            }

            if (row) {
                // Адрес уже есть — возвращаем его, НЕ создаём дубль
                return res.json(row);
            }

            // 2. Если такого ещё нет — вставляем новый
            db.run(
                'INSERT INTO addresses (telegram_id, label, address) VALUES (?, ?, ?)',
                [telegramId, label || '', normalized],
                function (err2) {
                    if (err2) {
                        console.error('Error inserting address:', err2);
                        return res.status(500).json({ error: 'DB error' });
                    }

                    db.get(
                        'SELECT * FROM addresses WHERE id = ?',
                        [this.lastID],
                        (err3, newRow) => {
                            if (err3) {
                                console.error('Error fetching new address:', err3);
                                return res.status(500).json({ error: 'DB error' });
                            }
                            res.json(newRow);
                        }
                    );
                }
            );
        }
    );
});


// Заказы пользователя
app.get('/api/orders/:telegramId', (req, res) => {
    const { telegramId } = req.params;
    db.all(
        'SELECT * FROM orders WHERE telegram_id = ? AND status != "PENDING_PAYMENT" ORDER BY created_at DESC',
        [telegramId],
        (err, rows) => {
            if (err) {
                console.error('Error fetching orders:', err);
                return res.status(500).json({ error: 'DB error' });
            }
            const orders = rows.map(r => ({
                id: r.id,
                telegramId: r.telegram_id,
                fullName: r.full_name,
                address: r.address,
                total: r.total,
                status: r.status,
                createdAt: r.created_at,
                msName: r.ms_name || null,
                items: JSON.parse(r.items_json || '[]')
            }));
            res.json(orders);
        }
    );
});


// Статус конкретного заказа
app.get('/api/orders/status/:orderId', (req, res) => {
    const { orderId } = req.params;

    db.get(
        'SELECT status, ms_id FROM orders WHERE id = ?',
        [orderId],
        (err, row) => {
            if (err) {
                console.error('Error fetching order status:', err);
                return res.status(500).json({ ok: false, error: 'DB error' });
            }
            if (!row) {
                return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
            }

            res.json({
                ok: true,
                status: row.status,
                msId: row.ms_id || null
            });
        }
    );
});



// Ручная синхронизация каталога с МойСклад
app.post('/api/moysklad/sync-products', async (req, res) => {
    try {
        await syncProductsFromMoySklad();
        res.json({ ok: true });
    } catch (err) {
        const details = err.response?.data || err.message || String(err);
        console.error('Sync products error:', details);

        res.status(500).json({
            error: 'Sync products error',
            details
        });
    }
});

app.post(
    '/api/moysklad/sync-order-statuses/:telegramId',
    async (req, res) => {
        try {
            await syncOrderStatusesFromMoySkladForUser(req.params.telegramId);
            res.json({ ok: true });
        } catch (err) {
            console.error('sync-order-statuses error:', err);
            res.status(500).json({
                error: 'sync-order-statuses error',
                details: err.response?.data || err.message
            });
        }
    }
);


app.post('/api/orders/sync-statuses', async (req, res) => {
    try {
        const { telegramId } = req.body;

        if (!telegramId) {
            return res
                .status(400)
                .json({ ok: false, error: 'NO_TELEGRAM_ID' });
        }

        // 1) Сначала подтягиваем статусы заказов из МойСклад
        await syncOrderStatusesFromMoySkladForUser(telegramId);

        // 2) Потом отдаем уже обновлённый список заказов
        db.all(
            'SELECT * FROM orders WHERE telegram_id = ? AND status != "PENDING_PAYMENT" ORDER BY created_at DESC',
            [telegramId],
            (err, rows) => {
                if (err) {
                    console.error('Error fetching orders:', err);
                    return res
                        .status(500)
                        .json({ ok: false, error: 'DB error' });
                }

                const orders = rows.map(r => ({
                    id: r.id,
                    telegramId: r.telegram_id,
                    fullName: r.full_name,
                    address: r.address,
                    total: r.total,
                    status: r.status,
                    createdAt: r.created_at,
                    msName: r.ms_name || null,
                    msId: r.ms_id || null,
                    items: JSON.parse(r.items_json || '[]')
                }));

                res.json({ ok: true, orders });
            }
        );
    } catch (e) {
        console.error('sync-statuses error:', e);
        res.status(500).json({
            ok: false,
            error: 'SYNC_FAILED',
            details: e.response?.data || e.message
        });
    }
});


// Оформление заказа: данные + оплата + отправка в МойСклад
app.post('/api/checkout', async (req, res) => {
    try {
        const crypto = require('crypto');

        const {
            telegramId,
            firstName,
            lastName,
            phone,

            receiverMode,
            recipientFullName,
            recipientPhone,
            floristComment,
            cardText,

            deliveryMethod,
            address,
            deliveryDate,
            deliveryTime,

            items,
            useBonuses,

            // NEW (у вас уже приходит с фронта)
            email,
            deliveryOption,
            deliveryFeeRub
        } = req.body;

        if (!telegramId || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ ok: false, error: 'BAD_REQUEST' });
        }

        let checkoutWarningCode = null;

        const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
        const normPhone = norm(phone);

        // метод оставляем как у вас (для показа блоков/логики)
        const normMethod = (deliveryMethod === 'pickup') ? 'pickup' : 'delivery';

        const normAddress = norm(address);
        const normDate = norm(deliveryDate);
        const normTime = norm(deliveryTime);

        const normFirstName = norm(firstName);
        const normLastName = norm(lastName);

        const fullName = `${normFirstName} ${normLastName}`.trim();

        // получатель/коммент/открытка (как у вас)
        const normReceiverMode = (receiverMode === 'other') ? 'other' : 'self';
        const normRecipientFullName = norm(recipientFullName);
        const normRecipientPhone = norm(recipientPhone);
        const normFloristComment = norm(floristComment);
        const normCardText = String(cardText || '').trim();

        // NEW: email / delivery option / delivery fee
        const normEmail = String(email || '').trim().toLowerCase();
        const normDeliveryOption = String(deliveryOption || '').trim();

        const feeRub = Number(deliveryFeeRub);
        const safeDeliveryFeeRub =
            Number.isFinite(feeRub) && feeRub >= 0 ? feeRub : 0;

        // товары (как у вас, с нормализацией)
        const normItems = (items || []).map(it => ({
            msId: String(it.msId || it.ms_id || ''),
            price: Number(it.price || 0),
            quantity: Number(it.quantity || 1)
        })).sort((a, b) => (a.msId || '').localeCompare(b.msId || ''));

        // ===== checkoutHash: ДОБАВИЛИ email + доставка =====
        const checkoutHash = crypto
            .createHash('sha256')
            .update(JSON.stringify({
                telegramId: String(telegramId),

                firstName: normFirstName,
                lastName: normLastName,
                phone: normPhone,

                receiverMode: normReceiverMode,
                recipientFullName: normRecipientFullName,
                recipientPhone: normRecipientPhone,
                floristComment: normFloristComment,
                cardText: normCardText,

                deliveryMethod: normMethod,
                address: normAddress,
                deliveryDate: normDate,
                deliveryTime: normTime,

                useBonuses: !!useBonuses,
                items: normItems,

                // NEW
                email: normEmail,
                deliveryOption: normDeliveryOption,
                deliveryFeeRub: safeDeliveryFeeRub
            }))
            .digest('hex');

        // ===== СУММА: товары + доставка (в копейках) — см. backend/MONEY_MODEL.md =====
        const itemsTotalK = normItems.reduce((sum, item) => {
            const priceK = Math.round(Number(item.price || 0) * 100);
            return sum + priceK * Number(item.quantity || 1);
        }, 0);

        const deliveryFeeK = Math.round(safeDeliveryFeeRub * 100);
        const totalBeforeK = itemsTotalK + deliveryFeeK; // <-- ВАЖНО: теперь включает доставку

        // бонусы пользователя
        const bonusBalanceRub = await new Promise((resolve, reject) => {
            db.get(
                'SELECT bonus_balance FROM users WHERE telegram_id = ?',
                [telegramId],
                (err, row) => (err ? reject(err) : resolve(row?.bonus_balance ?? 0))
            );
        });

        const bonusBalanceK = bonusBalanceRub * 100;

        // 30% от (товары + доставка)
        const maxRedeemK = Math.floor(totalBeforeK * 0.30);
        const redeemK = useBonuses ? Math.min(bonusBalanceK, maxRedeemK) : 0;

        const totalPaidK = Math.max(0, totalBeforeK - redeemK);
        const nowIso = new Date().toISOString();

        const promoSrcRow = await new Promise((resolve, reject) => {
            db.get(
                'SELECT last_source_code FROM users WHERE telegram_id = ?',
                [String(telegramId)],
                (err, row) => (err ? reject(err) : resolve(row))
            );
        });
        const orderSourceCodeRaw = promoSrcRow && promoSrcRow.last_source_code != null ? String(promoSrcRow.last_source_code).trim() : '';
        const orderSourceCodeForInsert = orderSourceCodeRaw.length ? orderSourceCodeRaw.slice(0, 80) : null;

        // 1) Берём последний pending/authorized заказ пользователя (reuse только если age < CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS)
        const rawUnpaidOrderRow = await new Promise((resolve, reject) => {
            db.get(
                `
                SELECT *
                FROM orders
                WHERE telegram_id = ?
                  AND status IN ('PENDING_PAYMENT','AUTHORIZED')
                ORDER BY created_at DESC
                LIMIT 1
                `,
                [telegramId],
                (err, row) => (err ? reject(err) : resolve(row))
            );
        });

        const reuseCtx = resolveCheckoutUnpaidOrderForReuse(
            rawUnpaidOrderRow,
            Date.now(),
            config.CHECKOUT_EXISTING_ORDER_REUSE_MAX_MS
        );
        let orderRow = reuseCtx.effectiveOrderRow;

        if (reuseCtx.decision === 'reuse') {
            console.log(
                '[Checkout] existing_order_reused',
                JSON.stringify({
                    previousOrderId: reuseCtx.previousOrderId,
                    previousOrderStatus: reuseCtx.previousOrderStatus,
                    previousOrderCreatedAt: reuseCtx.previousOrderCreatedAt,
                    ageMs: reuseCtx.ageMs,
                    reuseMaxMs: reuseCtx.reuseMaxMs
                })
            );
        } else if (reuseCtx.decision === 'expired') {
            console.log(
                '[Checkout] existing_order_reuse_expired',
                JSON.stringify({
                    previousOrderId: reuseCtx.previousOrderId,
                    previousOrderStatus: reuseCtx.previousOrderStatus,
                    previousOrderCreatedAt: reuseCtx.previousOrderCreatedAt,
                    ageMs: reuseCtx.ageMs,
                    reuseMaxMs: reuseCtx.reuseMaxMs
                })
            );
        }

        let createdNewOrder = false;
        let prevCheckoutHash = null;

        if (!orderRow) {
            const orderId = await new Promise((resolve, reject) => {
                db.run(
                    `
                        INSERT INTO orders (
                            telegram_id, full_name, phone, address,
                            total, status, items_json, created_at,
                            delivery_date, delivery_time,
                            total_before_bonus, bonuses_used, total_paid,
                            bonus_earned, bonus_processed,
                            checkout_hash, ms_sync_hash,

                            receiver_mode, recipient_full_name, recipient_phone,
                            florist_comment, card_text,

                            -- NEW
                            email, delivery_option, delivery_fee_rub,

                            source_code
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                    [
                        telegramId,
                        fullName,
                        normPhone,
                        normAddress,

                        totalPaidK / 100,
                        'PENDING_PAYMENT',
                        JSON.stringify(items),
                        nowIso,
                        normDate,
                        normTime,

                        totalBeforeK,
                        redeemK,
                        totalPaidK,

                        0,
                        0,

                        checkoutHash,
                        null,

                        normReceiverMode,
                        normRecipientFullName,
                        normRecipientPhone,
                        normFloristComment,
                        normCardText,

                        // NEW
                        normEmail,
                        normDeliveryOption,
                        Math.round(safeDeliveryFeeRub),

                        orderSourceCodeForInsert
                    ],
                    function (err) {
                        if (err) return reject(err);
                        resolve(this.lastID);
                    }
                );
            });

            orderRow = { id: orderId, ms_id: null, ms_sync_hash: null, checkout_hash: checkoutHash };
            createdNewOrder = true;
            if (reuseCtx.decision === 'expired') {
                console.log(
                    '[Checkout] new_order_created_for_expired_unpaid',
                    JSON.stringify({
                        previousOrderId: reuseCtx.previousOrderId,
                        previousOrderStatus: reuseCtx.previousOrderStatus,
                        previousOrderCreatedAt: reuseCtx.previousOrderCreatedAt,
                        ageMs: reuseCtx.ageMs,
                        reuseMaxMs: reuseCtx.reuseMaxMs,
                        newOrderId: orderId
                    })
                );
            }
        } else {
            prevCheckoutHash = String(orderRow.checkout_hash || '');

            await new Promise((resolve, reject) => {
                db.run(
                    `
                    UPDATE orders
                    SET full_name = ?,
                        phone = ?,
                        address = ?,
                        items_json = ?,
                        delivery_date = ?,
                        delivery_time = ?,
                        total = ?,
                        total_before_bonus = ?,
                        bonuses_used = ?,
                        total_paid = ?,
                        checkout_hash = ?,
                        created_at = ?,

                        receiver_mode = ?,
                        recipient_full_name = ?,
                        recipient_phone = ?,
                        florist_comment = ?,
                        card_text = ?,

                        -- NEW
                        email = ?,
                        delivery_option = ?,
                        delivery_fee_rub = ?,

                        source_code = COALESCE(source_code, ?)
                    WHERE id = ?
                    `,
                    [
                        fullName,
                        normPhone,
                        normAddress,
                        JSON.stringify(items),
                        normDate,
                        normTime,

                        totalPaidK / 100,
                        totalBeforeK,
                        redeemK,
                        totalPaidK,

                        checkoutHash,
                        nowIso,

                        normReceiverMode,
                        normRecipientFullName,
                        normRecipientPhone,
                        normFloristComment,
                        normCardText,

                        // NEW
                        normEmail,
                        normDeliveryOption,
                        Math.round(safeDeliveryFeeRub),

                        orderSourceCodeForInsert,

                        orderRow.id
                    ],
                    err => (err ? reject(err) : resolve())
                );
            });
        }

        // order объект, который уйдёт в T-Bank и МойСклад
        const order = {
            id: orderRow.id,
            telegramId,
            fullName,
            phone: normPhone,
            address: normAddress,
            items,
            deliveryMethod: normMethod,
            deliveryDate: normDate,
            deliveryTime: normTime,

            totalPaidK,
            totalBeforeK,
            bonusesUsedK: redeemK,

            receiverMode: normReceiverMode,
            recipientFullName: normRecipientFullName,
            recipientPhone: normRecipientPhone,
            floristComment: normFloristComment,
            cardText: normCardText,

            // NEW: для чека
            deliveryFeeRub: Math.round(safeDeliveryFeeRub),

            // NEW: если нужно дальше
            email: normEmail,
            deliveryOption: normDeliveryOption
        };

        // 2) Решаем, надо ли синхронизировать в МС
        const freshOrder = await new Promise((resolve, reject) => {
            db.get(
                'SELECT ms_id, ms_sync_hash, checkout_hash FROM orders WHERE id = ?',
                [order.id],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row || {});
                }
            );
        });

        const msSyncHash = String(freshOrder.ms_sync_hash || '');
        const needMsSync = (msSyncHash !== checkoutHash);

        if (needMsSync && !String(config.MOYSKLAD_TOKEN || '').trim()) {
            checkoutWarningCode = 'moysklad_degraded';
            const reason = 'MOYSKLAD_TOKEN_NOT_CONFIGURED';
            console.error(
                '[Checkout] moysklad_token_missing',
                JSON.stringify({ orderId: order.id, checkoutHash })
            );
            await new Promise((resolve, reject) => {
                db.run(
                    `UPDATE orders SET moysklad_sync_status = ?, moysklad_sync_error = ? WHERE id = ?`,
                    ['moysklad_failed', reason, order.id],
                    err => (err ? reject(err) : resolve())
                );
            });
        } else {
            if (
                needMsSync &&
                String(config.MOYSKLAD_TOKEN || '').trim()
            ) {
                await new Promise((resolve, reject) => {
                    db.run(
                        `UPDATE orders SET moysklad_sync_status = ?, moysklad_sync_error = NULL WHERE id = ?`,
                        ['moysklad_pending', order.id],
                        err => (err ? reject(err) : resolve())
                    );
                });
            }

            const msSyncResult = await syncOrderToMoySkladOnCheckout({
                needMsSync,
                order,
                checkoutHash,
                sendOrderToMoySklad
            });

            if (!msSyncResult.ok) {
                if (msSyncResult.error === 'checkout_failed_missing_ms_ids') {
                    return res.status(400).json({
                        ok: false,
                        error: 'checkout_failed_missing_ms_ids',
                        details: {
                            orderId: order.id,
                            checkoutHash,
                            needMsSync: true,
                            itemsCount: msSyncResult.itemsCount,
                            linesMissingMsId: msSyncResult.msMissingLines
                        }
                    });
                }

                const failReason =
                    (msSyncResult.cause && msSyncResult.cause.message) ||
                    String(msSyncResult.cause || 'MoySklad sync failed');
                console.error(
                    '[Checkout] moysklad_sync_nonfatal',
                    JSON.stringify({
                        orderId: order.id,
                        checkoutHash,
                        reason: failReason
                    })
                );
                checkoutWarningCode = 'moysklad_degraded';
                await new Promise((resolve, reject) => {
                    db.run(
                        `UPDATE orders SET moysklad_sync_status = ?, moysklad_sync_error = ? WHERE id = ?`,
                        ['moysklad_failed', String(failReason).slice(0, 900), order.id],
                        err => (err ? reject(err) : resolve())
                    );
                });
            } else if (msSyncResult.ok && !msSyncResult.skipped) {
                await new Promise((resolve, reject) => {
                    db.run(
                        'UPDATE orders SET ms_sync_hash = ?, moysklad_sync_status = ?, moysklad_sync_error = NULL WHERE id = ?',
                        [checkoutHash, 'moysklad_synced', order.id],
                        err => (err ? reject(err) : resolve())
                    );
                });
            } else if (msSyncResult.ok && msSyncResult.skipped) {
                // нет изменений корзины относительно последнего успешного sync — не дергаем МС
            }
        }

        // 3) Оплата: если изменения были — НЕ переиспользуем старую PaymentURL
        const changed = createdNewOrder ? true : (prevCheckoutHash !== checkoutHash);

        if (!changed) {
            const lastPayment = await new Promise((resolve, reject) => {
                db.get(
                    `
                        SELECT payment_id, status, raw_json
                        FROM payments
                        WHERE order_id = ?
                        ORDER BY created_at DESC
                            LIMIT 1
                    `,
                    [order.id],
                    (err, row) => (err ? reject(err) : resolve(row))
                );
            });

            if (lastPayment && (lastPayment.status === 'NEW' || lastPayment.status === 'AUTHORIZED')) {
                try {
                    const j = JSON.parse(lastPayment.raw_json || '{}');
                    const paymentUrl = j.PaymentURL || j.PaymentUrl || j.paymentUrl || null;
                    if (paymentUrl) {
                        scheduleCheckoutFollowup({ telegramId, orderId: order.id });
                        const okBody = {
                            ok: true,
                            orderId: order.id,
                            paymentId: lastPayment.payment_id,
                            paymentUrl
                        };
                        if (checkoutWarningCode) okBody.warning_code = checkoutWarningCode;
                        return res.json(okBody);
                    }
                } catch (_) {}
            }
        }

        const { paymentUrl, paymentId } = await initPaymentForOrder(order);

        scheduleCheckoutFollowup({ telegramId, orderId: order.id });

        // === (9) уведомление в топик: начал оформление ===
        // try {
        //     const forumGroupId = TELEGRAM_FORUM_GROUP_ID || null;
        //     if (forumGroupId) {
        //         const userRow = await new Promise((resolve, reject) => {
        //             db.get(
        //                 'SELECT first_name, last_name, topic_id FROM users WHERE telegram_id = ?',
        //                 [telegramId],
        //                 (err, row) => (err ? reject(err) : resolve(row))
        //             );
        //         });
        //
        //         const topicId = await getOrCreateUserTopicId({
        //             telegramId: String(telegramId),
        //             firstName: userRow?.first_name,
        //             lastName: userRow?.last_name
        //         });
        //
        //         if (topicId > 0) {
        //             const NAME =
        //                 `${String(userRow?.first_name || '').trim()} ${String(userRow?.last_name || '').trim()}`.trim() ||
        //                 'Клиент';
        //             const ID = String(telegramId);
        //
        //             await sendTelegramForumMessage(
        //                 forumGroupId,
        //                 topicId,
        //                 `Привет) 🟠\n\nКлиент ${NAME}, ${ID}, уже начал оформлять свой заказ 💐`
        //             );
        //         } else {
        //             // fallback: если топик не создался — можно писать в общий чат (по желанию)
        //             // await sendTelegramBotMessage(forumGroupId, `🟠 Клиент ${telegramId} начал оформлять заказ`);
        //             console.warn('[TG] topicId not available for start-checkout');
        //         }
        //     }
        // } catch (e) {
        //     console.error('[TG] start-checkout forum notify error:', e.response?.data || e.message || e);
        // }

        // === (9) Публикация checkout-события в event-контур ===
        await eventPublisher.publishCheckoutStarted({
            telegram_id: telegramId,
            first_name: firstName,
            last_name: lastName,
            order_id: order.id,
            payment_id: paymentId
        });

        const okBodyFinal = {
            ok: true,
            orderId: order.id,
            paymentUrl,
            paymentId
        };
        if (checkoutWarningCode) okBodyFinal.warning_code = checkoutWarningCode;
        return res.json(okBodyFinal);

    } catch (e) {
        console.error('Checkout error:', e);
        res.status(500).json({ ok: false, error: 'CHECKOUT_FAILED' });
    }
});


app.get('/api/tg/forum-test', async (req, res) => {
    const groupId = TELEGRAM_FORUM_GROUP_ID;
    const topicId = Number(req.query.topicId || 0);
    const r = await sendTelegramForumMessage(groupId, topicId, 'TEST');
    res.json({ groupId, topicId, result: r });
});

app.get('/api/tg/forum-create-test', async (req, res) => {
    if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
        return res.status(400).json({ ok: false, error: 'OUTBOUND_DISABLED', message: 'TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED=false' });
    }
    const forumGroupId = TELEGRAM_FORUM_GROUP_ID;
    try {
        const telegramId = String(req.query.telegramId || '0');
        const title = String(req.query.title || `Test #${telegramId}`).slice(0, 128);

        const r = await telegramClient.createForumTopic({
            chatId: forumGroupId,
            name: title
        });

        res.json({
            forumGroupId,
            ok: r.ok,
            result: r.ok ? { ok: true, result: r.data } : { ok: false, description: r.message, errorCode: r.errorCode }
        });
    } catch (e) {
        res.status(500).json({
            forumGroupId,
            error: e.response?.data || e.message
        });
    }
});


// Webhook, указанный как NotificationURL
app.post('/api/tbank/notify', express.json({ type: '*/*' }), async (req, res) => {
    console.log('[T-Bank Notify] incoming:', JSON.stringify(req.body, null, 2));
    try {
        // ВАЖНО: прокидываем все колбэки, иначе после оплаты не будет сообщений и действий
        await handleNotification(
            req.body,
            sendOrderToMoySklad,
            sendTelegramBotMessage,
            sendTelegramForumMessage,
            TELEGRAM_FORUM_GROUP_ID || null,
            async ({ telegram_id, order_id, ms_order, payment_id }) => {
                await eventPublisher.publishOrderPaid({
                    telegram_id,
                    order_id,
                    ms_order,
                    payment_id
                });
            }
        );


        // после handleNotification — бонусы
        const rawOrderId = String(req.body.OrderId || '');
        const localId = Number(rawOrderId.split('_')[0]);
        if (Number.isFinite(localId) && localId > 0 && req.body.Status === 'CONFIRMED') {
            await applyBonusesAfterPaid(localId);
        }

        res.json({ Success: true });
    } catch (e) {
        console.error('T-Bank notify error:', e);
        res.status(400).json({ Success: false, Message: e.message });
    }
});

app.post('/api/telegram/webhook', express.json({ type: '*/*' }), async (req, res) => {
    const wallClockStart = Date.now();
    try {
        const expectedSecret = String(TELEGRAM_WEBHOOK_SECRET || '').trim();
        if (expectedSecret) {
            const gotSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
            if (gotSecret !== expectedSecret) {
                console.warn('[TelegramWebhook] 403: неверный или пустой secret token (проверьте setWebhook и TELEGRAM_WEBHOOK_SECRET)');
                return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
            }
        }

        const update = req.body || {};
        const updateId = Number(update.update_id);
        if (Number.isFinite(updateId)) {
            const mark = await markTelegramUpdateProcessed(updateId);
            if (!mark.ok) {
                return res.status(500).json({ ok: false, error: mark.error || 'UPDATE_TRACK_FAILED' });
            }
            if (mark.duplicate) {
                console.log('[TelegramWebhook] duplicate update_id (idempotent ok)', updateId);
                interactiveLatency.record('webhook_ack_duplicate_ms', Date.now() - wallClockStart);
                return res.json({ ok: true, duplicate: true });
            }
        }

        interactiveLatency.record('webhook_ack_before_dispatch_ms', Date.now() - wallClockStart);
        setImmediate(() => {
            const tAsync = Date.now();
            telegramUpdateHandler
                .handleUpdate(update)
                .then((result) => {
                    interactiveLatency.record('webhook_handle_update_async_ms', Date.now() - tAsync);
                    console.log('[TelegramWebhook] update обработан (async)', {
                        updateId: Number.isFinite(updateId) ? updateId : null,
                        ignored: !!result.ignored
                    });
                })
                .catch((e) => {
                    console.error('[TelegramWebhook] async handleUpdate error:', e.message || e);
                });
        });
        return res.json({ ok: true, async: true });
    } catch (e) {
        console.error('[TelegramWebhook] error:', e.message || e);
        return res.status(500).json({ ok: false, error: 'WEBHOOK_FAILED' });
    }
});



app.get('/api/moysklad/image/:uuid', async (req, res) => {
    try {
        const { uuid } = req.params;
        const img = await fetchImageBuffer(uuid);

        res.setHeader('Content-Type', img.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(img.data));
    } catch (e) {
        console.error('Image proxy error:', e.response?.status, e.response?.data || e.message);
        res.status(404).send('not found');
    }
});





// DEBUG: сырой ответ отчёта по остаткам из МойСклад
app.get('/api/moysklad/debug-stock', async (req, res) => {
    try {
        const data = await getRawStockReportPage(200); // сколько строк хочешь
        res.json(data); // просто отдаём весь json как есть
    } catch (err) {
        console.error('debug-stock error:', err.response?.data || err.message);
        res.status(500).json({
            error: 'debug-stock error',
            details: err.response?.data || err.message
        });
    }
});


// Отдаём index.html для клиентского SPA. Не покрывать /api/* — иначе неизвестные API отдадут HTML.
app.get('*', (req, res) => {
    const p = String(req.path || '');
    if (p.startsWith('/api/')) {
        return res.status(404).json({
            ok: false,
            error: 'API_NOT_FOUND',
            path: req.path,
            hint: 'Маршрут не зарегистрирован в backend/server.js или запрос к старому процессу без деплоя'
        });
    }
    if (
        p === '/admin-embed' ||
        p === '/admin' ||
        p === '/admin-launch' ||
        p.startsWith('/admin-assets') ||
        /^\/app\.[^/]+\.js$/.test(p) ||
        /^\/styles\.[^/]+\.css$/.test(p)
    ) {
        console.error('[AdminRouter] blocked_spa_fallback_for_admin', {
            path: p,
            hint: 'Маршруты /admin-embed, /admin, /admin-assets и versioned app/styles должны быть до app.get("*")'
        });
        return res.status(503).type('text/plain; charset=utf-8').send(
            'Admin or versioned asset route misconfigured (SPA fallback blocked). Check server route order.'
        );
    }
    try {
        const fp = path.join(frontendPath, 'index.html');
        const html = injectHtmlBuildStamp(fs.readFileSync(fp, 'utf8'), 'storefront_spa_fallback');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Vary', '*');
        res.type('text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        console.error('[SPA] storefront index error', e.message || e);
        res.status(500).type('text/plain; charset=utf-8').send('Storefront error');
    }
});

// Старт сервера (миграции SQLite до listen — см. db.awaitMigrations)
let server;

const SYNC_INTERVAL_MINUTES = 10; // как часто обновлять каталог

let isSyncingProducts = false;

async function runProductsSync() {
    if (isSyncingProducts) {
        console.log('[MoySklad] Sync is already running, skip');
        return;
    }
    isSyncingProducts = true;
    try {
        await syncProductsFromMoySklad();
    } catch (e) {
        console.error('[MoySklad] Scheduled sync error:',
            e.response?.status,
            JSON.stringify(e.response?.data, null, 2) || e.message
        );
    }finally {
        isSyncingProducts = false;
    }
}

let productSyncInterval = null;
let outboxInterval = null;
let transportProbeController = null;
let pausedTransportSweepInterval = null;

function shutdownGracefully(signal) {
    console.log(`[Shutdown] ${signal} received`);
    if (productSyncInterval) clearInterval(productSyncInterval);
    if (outboxInterval) clearInterval(outboxInterval);
    if (pausedTransportSweepInterval) clearInterval(pausedTransportSweepInterval);
    if (transportProbeController && typeof transportProbeController.stop === 'function') {
        transportProbeController.stop();
    }
    if (server) {
        server.close((err) => {
            if (err) console.error('[Shutdown] server.close:', err.message || err);
            process.exit(err ? 1 : 0);
        });
    } else {
        process.exit(0);
    }
    setTimeout(() => {
        console.error('[Shutdown] force exit after timeout');
        process.exit(1);
    }, 15000).unref();
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

(async function startServer() {
    try {
        await db.awaitMigrations;
    } catch (e) {
        console.error('[Fatal] database migrations failed', e && e.message ? e.message : e);
        process.exit(1);
    }

    try {
        await adminUsersService.bootstrapIfNeeded();
    } catch (e) {
        console.error('[Fatal] admin_users bootstrap failed', e && e.message ? e.message : e);
        process.exit(1);
    }

    server = app.listen(PORT, LISTEN_HOST, () => {
        console.log(`Server listening on ${LISTEN_HOST}:${PORT}`);
        logStartupWiring();
    });

    runProductsSync().catch(console.error);
    bootstrapOperationalTopics().catch(console.error);
    bootstrapTelegramBotCapabilities().catch(console.error);
    if (typeof broadcastService.enforceCampaignWallClockTimeouts === 'function') {
        try {
            await broadcastService.enforceCampaignWallClockTimeouts('startup');
        } catch (e) {
            console.error('[BroadcastWallClock] startup enforce failed:', e.message || e);
        }
    }
    if (typeof broadcastService.runStartupBroadcastRecovery === 'function') {
        try {
            await broadcastService.runStartupBroadcastRecovery();
        } catch (e) {
            console.error('[BroadcastRecovery] startup failed:', e.message || e);
        }
    }

    productSyncInterval = setInterval(runProductsSync, SYNC_INTERVAL_MINUTES * 60 * 1000);

    if (OUTBOX_WORKER_ENABLED) {
        console.log('[OutboxWorker] enabled', { intervalMs: OUTBOX_WORKER_INTERVAL_MS });
        outboxInterval = setInterval(() => {
            outboxWorker.tick().catch((e) => {
                console.error('[OutboxWorker] tick failed:', e.message || e);
            });
        }, Number(OUTBOX_WORKER_INTERVAL_MS || 5000));
    }

    if (TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED && typeof broadcastService.tryAutoResumePausedTransportCampaigns === 'function') {
        transportProbeController = startTelegramTransportProbe({
            telegramClient,
            logger: console,
            probeEnabled: TELEGRAM_TRANSPORT_PROBE_ENABLED,
            getTransportContext: () => ({
                outboundEnabled: TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED,
                httpClientPresent: !!telegramBotApiHttp,
                proxyConfigured: telegramTransportMeta.mode === 'proxied',
                transportMode: telegramTransportMeta.mode
            }),
            baseIntervalMs: TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS,
            backoffMaxMs: TELEGRAM_TRANSPORT_PROBE_BACKOFF_MAX_MS,
            initialDelayMs: TELEGRAM_TRANSPORT_PROBE_INITIAL_DELAY_MS,
            onAfterSuccessfulProbe: () => broadcastService.tryAutoResumePausedTransportCampaigns('probe_success')
        });
        console.log('[TelegramTransportProbe] controller_started', {
            probeEnabled: TELEGRAM_TRANSPORT_PROBE_ENABLED,
            intervalMs: TELEGRAM_TRANSPORT_PROBE_INTERVAL_MS
        });
    }

    if (BROADCASTS_ENABLED && typeof broadcastService.tryAutoResumePausedTransportCampaigns === 'function') {
        pausedTransportSweepInterval = setInterval(() => {
            const run = async () => {
                if (typeof broadcastService.enforceCampaignWallClockTimeouts === 'function') {
                    await broadcastService.enforceCampaignWallClockTimeouts('periodic_sweep');
                }
                await broadcastService.tryAutoResumePausedTransportCampaigns('periodic_sweep');
            };
            run().catch((e) => {
                console.error('[BroadcastRecovery] paused_transport_sweep_failed', e.message || e);
            });
        }, Number(BROADCAST_PAUSED_TRANSPORT_SWEEP_MS || 45_000));
        pausedTransportSweepInterval.unref?.();
    }
})();

