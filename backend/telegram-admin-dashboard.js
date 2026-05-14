'use strict';

const { fetchDashboardMetrics, isAdminTelegramId } = require('./admin-dashboard-service');

/** Не пересекаются с start_welcome_consent, manager_help_request, broadcast_delete:* */
const CB = {
    D_TODAY: 'adm:d:today',
    D_7D: 'adm:d:7d',
    NAV_DASH: 'adm:nav:dash',
    NAV_PROMO: 'adm:nav:promo'
};

function formatRub(n) {
    const v = Number(n) || 0;
    return `${v.toLocaleString('ru-RU')} ₽`;
}

/** Плоский текст, без parse_mode (устойчивость). */
function buildDashboardText(metrics) {
    const { range } = metrics;
    const periodLabel = range.periodKey === 'today' ? 'Сегодня' : '7 дней';
    const lines = [];
    lines.push('ДАШБОРД');
    lines.push('');
    lines.push(`Период: ${periodLabel}`);
    lines.push(`${range.labelFrom} — ${range.labelTo}`);
    lines.push('');
    lines.push('ВЫРУЧКА');
    lines.push(formatRub(metrics.revenueRub));
    lines.push('');
    lines.push(`Заказов: ${metrics.ordersTotal}`);
    lines.push(`Ср. чек: ${paidOrdersFmt(metrics)}`);
    lines.push(`Новые клиенты: ${metrics.newClients}`);
    lines.push(`Клиентов всего: ${metrics.clientsTotal}`);
    lines.push('');
    lines.push('Клиенты и заказы');
    lines.push(`CR: ${pctFmt(metrics.crPct)}%`);
    lines.push(`Повторные заказы: ${pctFmt(metrics.repeatSharePct)}%`);
    lines.push(`Средний LTV: ${formatRub(metrics.avgLtvRub)}`);
    lines.push('');
    lines.push('Сервис и качество');
    lines.push(...speedLines(metrics));
    lines.push('Брошенные корзины: нет данных');
    lines.push('');
    lines.push('Аналитика');
    lines.push('Топ товаров:');
    lines.push(...topProductLines(metrics.topProducts));
    lines.push('');
    lines.push('Источники заказов:');
    lines.push('нет данных');

    return lines.join('\n');
}

function paidOrdersFmt(m) {
    if (m.paidOrders <= 0) return '0 ₽';
    return formatRub(m.avgCheckRub);
}

function pctFmt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.round(n * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
    return rounded.toFixed(1);
}

function speedLines(metrics) {
    const m = metrics.avgResponseMinutes;
    if (m == null || !Number.isFinite(m)) {
        return ['Скорость ответа: нет данных'];
    }
    if (m > 12) {
        return [`🔴 Скорость ответа: ${m} мин — выше нормы`];
    }
    return [`Скорость ответа: ${m} мин`];
}

function topProductLines(topProducts) {
    if (!topProducts.length) {
        return ['нет данных'];
    }
    const out = [];
    topProducts.slice(0, 3).forEach((entry, idx) => {
        if (Array.isArray(entry)) {
            const [name, qty] = entry;
            out.push(`${idx + 1}. ${name} — ${qty} шт`);
            return;
        }
        const name = String((entry && entry.name) || '').trim() || 'Товар';
        const qty = Math.round(Number((entry && (entry.qty != null ? entry.qty : entry.quantity)) || 0));
        out.push(`${idx + 1}. ${name} — ${qty} шт`);
    });
    return out;
}

/** @param {'today'|'7d'} periodKey @param {'dash'|'promo'} view */
function buildDashboardKeyboard(periodKey, view) {
    const rowPeriod = [
        { text: periodKey === 'today' ? 'Сегодня ✓' : 'Сегодня', callback_data: CB.D_TODAY },
        { text: periodKey === '7d' ? '7 дней ✓' : '7 дней', callback_data: CB.D_7D }
    ];
    const dashBtnCallback = view === 'dash' ? (periodKey === '7d' ? CB.D_7D : CB.D_TODAY) : CB.NAV_DASH;
    const rowNav = [
        {
            text: view === 'dash' ? 'Дашборд ✓' : 'Дашборд',
            callback_data: dashBtnCallback
        },
        { text: view === 'promo' ? 'Продвижение ✓' : 'Продвижение', callback_data: CB.NAV_PROMO }
    ];
    if (view === 'promo') {
        return { inline_keyboard: [rowNav] };
    }
    return { inline_keyboard: [rowPeriod, rowNav] };
}

function buildPromoStubText() {
    return ['ПРОДВИЖЕНИЕ', '', 'Раздел «Продвижение» будет добавлен следующим этапом.'].join('\n');
}

function isMessageNotModifiedError(res) {
    const msg = String(res?.message || '').toLowerCase();
    return msg.includes('not modified');
}

function createTelegramAdminDashboard({ config, telegramClient, logger = console }) {
    async function sendAccessDenied(chatId) {
        const text = 'Нет доступа';
        const r = await telegramClient.sendMessage({ chatId, text });
        if (!r.ok) {
            logger.warn('[AdminDash] send_access_denied_failed', { chatId, errorCode: r.errorCode || null });
        }
    }

    async function renderDashboard(chatId, periodKey) {
        const metrics = await fetchDashboardMetrics(periodKey);
        const text = buildDashboardText(metrics);
        const replyMarkup = buildDashboardKeyboard(periodKey, 'dash');
        return telegramClient.sendMessage({ chatId, text, replyMarkup });
    }

    /** @returns {Promise<void>} */
    async function handleAdminCommandMessage(message) {
        const chatType = String(message.chat?.type || '');
        const chatId = message.chat?.id;
        const fromId = message.from?.id;

        if (chatType !== 'private' || chatId == null) {
            return;
        }

        if (!isAdminTelegramId(fromId, config)) {
            await sendAccessDenied(chatId);
            return;
        }

        const r = await renderDashboard(chatId, 'today');
        if (!r.ok) {
            logger.error('[AdminDash] render_dashboard_failed', {
                errorCode: r.errorCode,
                message: r.message || null
            });
        }
    }

    /** @returns {Promise<{ handled: boolean }>} */
    async function handleAdminCallbackQuery(callbackQuery) {
        const data = String(callbackQuery.data || '').trim();
        if (!data.startsWith('adm:')) {
            return { handled: false };
        }

        const fromId = callbackQuery.from?.id;
        const msg = callbackQuery.message;
        const chatId = msg?.chat?.id;
        const messageId = msg?.message_id;

        const ackDenied = () =>
            telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: 'Нет доступа',
                showAlert: false
            });

        const ackOk = () =>
            telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: ''
            });

        if (!isAdminTelegramId(fromId, config)) {
            await ackDenied();
            return { handled: true };
        }

        if (chatId == null || messageId == null) {
            await ackOk();
            return { handled: true };
        }

        const knownCb = new Set([CB.D_TODAY, CB.D_7D, CB.NAV_DASH, CB.NAV_PROMO]);
        if (!knownCb.has(data)) {
            await ackOk();
            return { handled: true };
        }

        try {
            if (data === CB.NAV_PROMO) {
                const text = buildPromoStubText();
                const replyMarkup = buildDashboardKeyboard('today', 'promo');
                const rEdit = await telegramClient.editMessageText({
                    chatId,
                    messageId,
                    text,
                    replyMarkup
                });
                if (!rEdit.ok && !isMessageNotModifiedError(rEdit)) {
                    logger.warn('[AdminDash] edit_promo_failed', {
                        errorCode: rEdit.errorCode,
                        message: rEdit.message || null
                    });
                }
                await ackOk();
                return { handled: true };
            }

            /** @type {'today'|'7d'} */
            let periodKey = 'today';
            if (data === CB.D_7D) {
                periodKey = '7d';
            } else if (data === CB.D_TODAY || data === CB.NAV_DASH) {
                periodKey = 'today';
            }

            const metrics = await fetchDashboardMetrics(periodKey);
            const text = buildDashboardText(metrics);
            const replyMarkup = buildDashboardKeyboard(periodKey, 'dash');
            const rEdit = await telegramClient.editMessageText({
                chatId,
                messageId,
                text,
                replyMarkup
            });
            if (!rEdit.ok && !isMessageNotModifiedError(rEdit)) {
                logger.warn('[AdminDash] edit_dash_failed', {
                    errorCode: rEdit.errorCode,
                    message: rEdit.message || null
                });
            }

            await ackOk();
            return { handled: true };
        } catch (e) {
            logger.error('[AdminDash] callback_error', { error: e?.message || String(e) });
            await telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: 'Ошибка',
                showAlert: true
            });
            return { handled: true };
        }
    }

    return {
        CB,
        handleAdminCommandMessage,
        handleAdminCallbackQuery,
        buildDashboardText,
        buildDashboardKeyboard
    };
}

module.exports = {
    CB,
    createTelegramAdminDashboard,
    buildDashboardText,
    buildDashboardKeyboard,
    buildPromoStubText
};
