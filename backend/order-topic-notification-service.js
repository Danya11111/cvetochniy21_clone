const db = require('./db');
const { orderAmountKopecksFromRow, formatKopecksRu } = require('./money');

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function safe(v) {
    return String(v || '').trim();
}

function createOrderTopicNotificationService({
    telegramClient,
    routingService,
    ordersNotifyChatId,
    ordersNotifyThreadId,
    logger = console
}) {
    async function buildOrderSummary(orderId) {
        const row = await get(
            `
            SELECT id, telegram_id, full_name, phone, address, status, total, total_paid, delivery_date, delivery_time, items_json, ms_name
            FROM orders
            WHERE id = ?
            `,
            [Number(orderId)]
        );
        if (!row) return null;
        let items = [];
        try {
            items = JSON.parse(row.items_json || '[]');
        } catch (_) {
            items = [];
        }
        const lines = items
            .map(it => `- ${safe(it.name) || 'Товар'} x${Number(it.quantity || 1)}`)
            .join('\n');
        return {
            order: row,
            text:
                `🧾 Заказ #${safe(row.ms_name) || row.id}\n` +
                `👤 ${safe(row.full_name) || '-'} (${safe(row.telegram_id)})\n` +
                `📱 ${safe(row.phone) || '-'}\n` +
                `📍 ${safe(row.address) || '-'}\n` +
                `📅 ${safe(row.delivery_date) || '-'} ${safe(row.delivery_time) || ''}\n` +
                `💰 ${formatKopecksRu(orderAmountKopecksFromRow(row))}\n` +
                `📌 Статус: ${safe(row.status) || '-'}\n` +
                (lines ? `\nСостав:\n${lines}` : '')
        };
    }

    async function notifyOrderInTopics({ orderId, telegramUserId }) {
        const summary = await buildOrderSummary(orderId);
        if (!summary) return { ok: false, error: 'ORDER_NOT_FOUND' };

        const clientTopic = await routingService.ensureClientTopic({
            telegramUserId,
            firstName: safe(summary.order.full_name).split(' ')[0] || '',
            lastName: safe(summary.order.full_name).split(' ').slice(1).join(' ') || ''
        });

        const topicLink = clientTopic
            ? routingService.buildTopicLink(clientTopic.chat_id, clientTopic.message_thread_id)
            : '';

        const keyboard = topicLink
            ? {
                inline_keyboard: [
                    [{ text: 'Перейти в тему клиента', url: topicLink }]
                ]
            }
            : undefined;

        if (ordersNotifyChatId && ordersNotifyThreadId > 0) {
            const notifyText =
                `🆕 Новый заказ #${safe(summary.order.ms_name) || summary.order.id}\n` +
                `Клиент: ${safe(summary.order.full_name) || '-'} (${safe(summary.order.telegram_id)})\n` +
                `Сумма: ${formatKopecksRu(orderAmountKopecksFromRow(summary.order))}`;
            const sent = await telegramClient.sendMessage({
                chatId: ordersNotifyChatId,
                messageThreadId: Number(ordersNotifyThreadId),
                text: notifyText,
                replyMarkup: keyboard
            });
            logger.log('[OrderTopicNotify] orders notify topic', {
                orderId: Number(orderId),
                chatId: String(ordersNotifyChatId),
                threadId: Number(ordersNotifyThreadId),
                ok: !!sent?.ok,
                errorCode: sent?.ok ? null : sent?.errorCode || null
            });
        } else {
            logger.log('[OrderTopicNotify] skip (no chat/thread)', {
                orderId: Number(orderId),
                hasChat: !!ordersNotifyChatId,
                threadId: Number(ordersNotifyThreadId || 0)
            });
        }

        if (clientTopic) {
            await telegramClient.sendMessage({
                chatId: clientTopic.chat_id,
                messageThreadId: clientTopic.message_thread_id,
                text: summary.text
            });
        } else {
            logger.warn('[OrdersNotify] client topic unavailable', { orderId, telegramUserId });
        }

        return { ok: true };
    }

    async function notifyOrderPaid({ orderId, telegramUserId }) {
        const summary = await buildOrderSummary(orderId);
        if (!summary) return { ok: false, error: 'ORDER_NOT_FOUND' };
        const clientTopic = await routingService.ensureClientTopic({
            telegramUserId,
            firstName: safe(summary.order.full_name).split(' ')[0] || '',
            lastName: safe(summary.order.full_name).split(' ').slice(1).join(' ') || ''
        });
        if (clientTopic) {
            await telegramClient.sendMessage({
                chatId: clientTopic.chat_id,
                messageThreadId: clientTopic.message_thread_id,
                text: `✅ Оплата подтверждена по заказу #${safe(summary.order.ms_name) || summary.order.id}`
            });
        }
        return { ok: true };
    }

    return {
        notifyOrderInTopics,
        notifyOrderPaid
    };
}

module.exports = {
    createOrderTopicNotificationService
};

