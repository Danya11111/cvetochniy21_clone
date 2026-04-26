const {
    EVENT_PUBLISHER_ENABLED,
    EVENT_OUTBOX_ENABLED,
    TELEGRAM_TOPICS_ENABLED,
    ORDERS_TOPIC_NOTIFICATIONS_ENABLED
} = require('./config');
const { EVENT_TYPES } = require('./events');
const { createOutboxRepository } = require('./outbox-repository');

function buildMeta(eventType, ctx = {}) {
    return {
        eventType,
        orderId: ctx.order_id || null,
        telegramId: ctx.telegram_id || null
    };
}

function createEventPublisher({ logger = console } = {}) {
    const outboxRepository = createOutboxRepository({ logger });

    async function publish(eventType, ctx = {}) {
        const meta = buildMeta(eventType, ctx);
        const flags = {
            EVENT_PUBLISHER_ENABLED,
            EVENT_OUTBOX_ENABLED,
            TELEGRAM_TOPICS_ENABLED,
            ORDERS_TOPIC_NOTIFICATIONS_ENABLED
        };

        logger.log('[EventPublisher] dispatch', { ...meta, flags });

        if (!EVENT_PUBLISHER_ENABLED) {
            logger.log('[EventPublisher] disabled, controlled no-op', meta);
            return { ok: true, skipped: true };
        }

        const results = [];

        const shouldQueueTopicsEvent =
            TELEGRAM_TOPICS_ENABLED &&
            EVENT_OUTBOX_ENABLED &&
            ORDERS_TOPIC_NOTIFICATIONS_ENABLED &&
            (eventType === EVENT_TYPES.CHECKOUT_STARTED || eventType === EVENT_TYPES.ORDER_PAID);

        if (shouldQueueTopicsEvent) {
            if (!ctx.order_id) {
                logger.error('[EventPublisher:OUTBOX] skip queue, order_id is empty', meta);
                results.push({ ok: false, target: 'outbox', error: 'NO_ORDER_ID' });
            } else {
            const dedupeKey =
                eventType === EVENT_TYPES.CHECKOUT_STARTED
                    ? `order:${ctx.order_id}:checkout_started`
                    : `order:${ctx.order_id}:paid`;
            const queued = await outboxRepository.enqueue({
                eventType,
                entityType: 'order',
                entityId: String(ctx.order_id || ''),
                payload: ctx,
                routingKey: 'orders',
                dedupeKey
            });
            logger.log('[EventPublisher:OUTBOX] queued', {
                ...meta,
                dedupeKey,
                duplicate: !!queued.duplicate
            });
            results.push({ ok: true, target: 'outbox', duplicate: !!queued.duplicate });
            }
        }

        if (!results.length) {
            logger.log('[EventPublisher] no targets enabled, controlled no-op', meta);
            return { ok: true, skipped: true };
        }

        const ok = results.every(r => r && r.ok);
        return { ok, results };
    }

    async function publishCheckoutStarted(ctx = {}) {
        return publish(EVENT_TYPES.CHECKOUT_STARTED, ctx);
    }

    async function publishOrderPaid(ctx = {}) {
        return publish(EVENT_TYPES.ORDER_PAID, ctx);
    }

    return {
        publish,
        publishCheckoutStarted,
        publishOrderPaid
    };
}

module.exports = {
    createEventPublisher
};

