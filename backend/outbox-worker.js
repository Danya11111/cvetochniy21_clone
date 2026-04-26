const { EVENT_TYPES } = require('./events');
const { isRetryableTelegramError } = require('./reliability-utils');

function parsePayload(raw) {
    try {
        return JSON.parse(raw || '{}');
    } catch (_) {
        return {};
    }
}

function createOutboxWorker({
    outboxRepository,
    orderTopicNotificationService,
    logger = console
}) {
    let isRunning = false;

    async function processRow(row) {
        const payload = parsePayload(row.payload_json);

        if (row.event_type === EVENT_TYPES.CHECKOUT_STARTED) {
            return orderTopicNotificationService.notifyOrderInTopics({
                orderId: payload.order_id,
                telegramUserId: payload.telegram_id
            });
        }
        if (row.event_type === EVENT_TYPES.ORDER_PAID) {
            return orderTopicNotificationService.notifyOrderPaid({
                orderId: payload.order_id,
                telegramUserId: payload.telegram_id
            });
        }

        logger.log('[OutboxWorker] unsupported event, mark sent', {
            id: row.id,
            eventType: row.event_type
        });
        return { ok: true, skipped: true };
    }

    async function tick() {
        if (isRunning) return;
        isRunning = true;
        try {
            const batch = await outboxRepository.pullBatch(30);
            logger.log('[OutboxWorker] batch pulled', { count: batch.length });
            for (const row of batch) {
                const rowMeta = {
                    outboxId: row.id,
                    eventType: row.event_type,
                    entityType: row.entity_type,
                    entityId: row.entity_id,
                    attempts: Number(row.attempts || 0),
                    dedupeKey: row.dedupe_key || null
                };
                try {
                    const result = await processRow(row);
                    if (result && result.ok) {
                        await outboxRepository.markSent(row.id);
                        logger.log('[OutboxWorker] sent', rowMeta);
                    } else {
                        const retryable = isRetryableTelegramError(result?.errorCode);
                        if (retryable) {
                            await outboxRepository.markRetry(row.id, {
                                attempts: row.attempts,
                                errorMessage: result?.error || result?.message || 'PROCESS_FAILED',
                                retryAfterSec: result?.retryAfterSec
                            });
                            logger.warn('[OutboxWorker] scheduled retry', {
                                ...rowMeta,
                                errorCode: result?.errorCode || null,
                                error: result?.error || result?.message || 'PROCESS_FAILED'
                            });
                        } else {
                            await outboxRepository.markFailed(row.id, result?.error || result?.message || 'PROCESS_FAILED');
                            logger.error('[OutboxWorker] marked failed', {
                                ...rowMeta,
                                errorCode: result?.errorCode || null,
                                error: result?.error || result?.message || 'PROCESS_FAILED'
                            });
                        }
                    }
                } catch (e) {
                    const attempts = Number(row.attempts || 0);
                    if (attempts >= 5) {
                        await outboxRepository.markFailed(row.id, e.message || 'OUTBOX_FATAL');
                        logger.error('[OutboxWorker] failed terminal', {
                            ...rowMeta,
                            error: e.message || 'OUTBOX_FATAL'
                        });
                    } else {
                        await outboxRepository.markRetry(row.id, {
                            attempts,
                            errorMessage: e.message || 'OUTBOX_RETRY'
                        });
                        logger.warn('[OutboxWorker] retry after exception', {
                            ...rowMeta,
                            error: e.message || 'OUTBOX_RETRY'
                        });
                    }
                }
            }
        } catch (e) {
            logger.error('[OutboxWorker] tick error', { error: e.message || e });
        } finally {
            isRunning = false;
        }
    }

    return {
        tick
    };
}

module.exports = {
    createOutboxWorker
};

