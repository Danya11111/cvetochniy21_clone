const db = require('./db');
const { formatBroadcastSendDurationLabelRu } = require('./broadcast-duration-format');
const {
    orderAmountKopecksFromRow,
    orderPaidRevenueKopecksFromRow,
    orderUnpaidExposureKopecksFromRow,
    rubThresholdToKopecks,
    kopecksToWholeRub,
    formatKopecksRu,
    sqlOrderPaidRevenueKopecks
} = require('./money');
const { isOrderPaidForOps, deriveOrderAdminPresentation, buildOrdersListWhereClause, isLegacyInactiveRawStatus } = require('./order-status');
const { computeThreadWaitingForStaff } = require('./support-waiting');

const SQL_ORDER_REVENUE_KOPEKS_O = sqlOrderPaidRevenueKopecks('o');
const SQL_ORDER_REVENUE_KOPEKS_OX = sqlOrderPaidRevenueKopecks('ox');

/** Общий SELECT для списка/карточки треда поддержки (JOIN клиента и метрик). */
const SUPPORT_THREAD_LIST_FROM = `
            SELECT st.*,
                   u.first_name,
                   u.last_name,
                   u.username,
                   u.topic_id,
                   t.chat_id AS topic_chat_id,
                   t.message_thread_id AS topic_thread_id,
                   (
                     SELECT MAX(sm.created_at)
                     FROM support_messages sm
                     WHERE sm.thread_id = st.id
                   ) AS last_message_at,
                   COALESCE(
                     st.last_message_direction,
                     (
                       SELECT sm.direction
                       FROM support_messages sm
                       WHERE sm.thread_id = st.id
                       ORDER BY sm.id DESC
                       LIMIT 1
                     )
                   ) AS last_message_direction,
                   (
                     SELECT sm.status
                     FROM support_messages sm
                     WHERE sm.thread_id = st.id
                     ORDER BY sm.id DESC
                     LIMIT 1
                   ) AS last_message_status,
                   COALESCE(
                     st.last_client_message_at,
                     (
                       SELECT MAX(sm.created_at)
                       FROM support_messages sm
                       WHERE sm.thread_id = st.id
                         AND sm.direction = 'CLIENT_TO_TOPIC'
                     )
                   ) AS last_client_message_at,
                   COALESCE(oc.client_orders_count, 0) AS client_orders_count,
                   COALESCE(oc.client_total_revenue, 0) AS client_total_revenue,
                   oc.client_last_order_at,
                   oc.latest_order_id,
                   COALESCE(sc.client_open_threads, 0) AS client_open_threads,
                   COALESCE(sc.client_total_threads, 0) AS client_total_threads
            FROM support_threads st
            LEFT JOIN users u ON u.telegram_id = st.telegram_user_id
            LEFT JOIN telegram_topics t ON t.telegram_user_id = st.telegram_user_id AND t.is_active = 1
            LEFT JOIN (
                SELECT o.telegram_id,
                       COUNT(*) AS client_orders_count,
                       MAX(o.created_at) AS client_last_order_at,
                       MAX(o.id) AS latest_order_id,
                       COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_O})), 0) AS client_total_revenue
                FROM orders o
                GROUP BY o.telegram_id
            ) oc ON oc.telegram_id = st.telegram_user_id
            LEFT JOIN (
                SELECT sx.telegram_user_id,
                       SUM(CASE WHEN UPPER(COALESCE(sx.status, '')) IN ('OPEN', 'PENDING') THEN 1 ELSE 0 END) AS client_open_threads,
                       COUNT(*) AS client_total_threads
                FROM support_threads sx
                GROUP BY sx.telegram_user_id
            ) sc ON sc.telegram_user_id = st.telegram_user_id
`;

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function toInt(v, fallback = 50, max = 500) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(max, Math.floor(n)));
}

function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function parseDateSafe(value) {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return null;
    return new Date(ts);
}

function toIsoDay(value) {
    return String(value || '').slice(0, 10);
}

function isDayEqual(value, dayIso) {
    return toIsoDay(value) === dayIso;
}

function parseItemsCount(itemsJson) {
    try {
        const parsed = JSON.parse(String(itemsJson || '[]'));
        if (Array.isArray(parsed)) return parsed.length;
    } catch (_) {}
    return 0;
}

function enrichOrderRow(row, now = new Date()) {
    const todayIso = now.toISOString().slice(0, 10);
    const tomorrowIso = new Date(now.getTime() + (24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

    const totalPaid = toNumber(row.total_paid);
    const statusRaw = String(row.status || '').trim();
    const statusUpper = statusRaw.toUpperCase();
    const isPaid = isOrderPaidForOps(row);
    const statusUi = deriveOrderAdminPresentation(row);
    const amountK = orderAmountKopecksFromRow(row);
    const isLargeOrder = amountK >= rubThresholdToKopecks(7000);
    const createdAt = parseDateSafe(row.created_at);
    const createdAgoHours = createdAt ? ((now.getTime() - createdAt.getTime()) / (60 * 60 * 1000)) : 0;

    const deliveryDate = String(row.delivery_date || '').trim();
    const deliveryTime = String(row.delivery_time || '').trim();
    let deliveryBucket = 'unspecified';
    if (deliveryDate) {
        if (deliveryDate === todayIso) deliveryBucket = 'today';
        else if (deliveryDate === tomorrowIso) deliveryBucket = 'tomorrow';
        else deliveryBucket = 'later';
    }
    const isUrgent = deliveryBucket === 'today' || (deliveryBucket === 'tomorrow' && deliveryTime && String(deliveryTime) <= '12:00');

    const clientOrdersCount = Math.max(0, Math.round(toNumber(row.client_orders_count)));
    const isRepeatClient = clientOrdersCount >= 2;
    const isNewClient = clientOrdersCount <= 1;
    const clientLtv = Math.round(toNumber(row.client_lifetime_value));

    const riskReasons = [];
    if (!isPaid) riskReasons.push('Оплата еще не подтверждена');
    if (!isPaid && isUrgent) riskReasons.push('Доставка скоро, нужно ускорить обработку');
    if (!isPaid && isLargeOrder) riskReasons.push('Крупная сумма пока не зафиксирована');
    if (!isPaid && createdAgoHours >= 12) riskReasons.push('Заказ долго без движения');
    if (isLegacyInactiveRawStatus(statusRaw)) riskReasons.push('Архивный статус в данных — действий по отмене/возврату через приложение нет');
    if (!isPaid && isRepeatClient) riskReasons.push('Повторный клиент ждет подтверждения');
    if (statusUpper === 'PAYMENT_FAILED') riskReasons.push('Оплата не прошла — клиент может повторить попытку');
    const msFail = String(row.moysklad_sync_status || '').trim().toLowerCase();
    if (msFail === 'moysklad_failed') {
        const hint = String(row.moysklad_sync_error || '').trim();
        riskReasons.push(hint ? `МойСклад: ${hint.slice(0, 120)}` : 'Синхронизация с МойСклад не выполнена');
    }

    let attentionLevel = 'normal';
    if ((!isPaid && isUrgent) || (!isPaid && isLargeOrder)) {
        attentionLevel = 'critical';
    } else if (riskReasons.length > 0) {
        attentionLevel = 'important';
    }
    const attentionLabel = attentionLevel === 'critical'
        ? 'Срочно'
        : (attentionLevel === 'important' ? 'Важно' : 'В норме');
    const attentionReason = riskReasons[0] || 'Заказ обрабатывается в штатном режиме';
    const isProblematic = attentionLevel !== 'normal';

    const subtitleParts = [];
    subtitleParts.push(isRepeatClient ? 'Повторный клиент' : 'Новый клиент');
    subtitleParts.push(isPaid ? 'Оплата подтверждена' : 'Ожидаем оплату');
    if (deliveryBucket === 'today') subtitleParts.push('Доставка сегодня');
    if (deliveryBucket === 'tomorrow') subtitleParts.push('Доставка завтра');
    if (isLargeOrder) subtitleParts.push('Высокий чек');

    const topicLink = (String(row.topic_chat_id || '').startsWith('-100') && row.topic_thread_id)
        ? `https://t.me/c/${String(row.topic_chat_id).slice(4)}/${Number(row.topic_thread_id)}`
        : '';

    const safe = { ...row };
    delete safe.total;
    delete safe.total_paid;
    delete safe.total_before_bonus;
    delete safe.bonuses_used;
    delete safe.status;

    return {
        ...safe,
        status_code: statusUi.status_code,
        status_label: statusUi.status_label,
        status_tone: statusUi.status_tone,
        amount_kopecks: amountK,
        is_paid: isPaid,
        is_unpaid: !isPaid,
        is_large_order: isLargeOrder,
        is_repeat_client: isRepeatClient,
        is_new_client: isNewClient,
        client_orders_count: clientOrdersCount,
        client_lifetime_value_stub: clientLtv,
        items_count: parseItemsCount(row.items_json),
        delivery_bucket: deliveryBucket,
        is_urgent: isUrgent,
        attention_level: attentionLevel,
        attention_label: attentionLabel,
        attention_reason: attentionReason,
        is_problematic: isProblematic,
        order_subtitle: subtitleParts.join(' • '),
        topic_link: topicLink
    };
}

function formatClientName(row) {
    const fullName = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    if (fullName) return fullName;
    if (row.username) return `@${row.username}`;
    return String(row.telegram_id || 'Клиент');
}

function daysSince(value, now = new Date()) {
    if (!value) return null;
    const ts = Date.parse(String(value));
    if (!Number.isFinite(ts)) return null;
    const diff = Math.max(0, now.getTime() - ts);
    return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function clientSubtitle(row, now = new Date()) {
    const totalOrders = Number(row.total_orders || 0);
    const daysFromOrder = row.days_since_last_order;
    if (row.is_vip_client && row.is_sleeping_client) return 'VIP-клиент • давно не покупал';
    if (row.is_vip_client) return `VIP-клиент • ${totalOrders} ${totalOrders === 1 ? 'заказ' : 'заказов'}`;
    if (row.is_new_client) {
        if (daysFromOrder !== null && daysFromOrder >= 14) return 'Новый клиент • стоит удержать повтором';
        return 'Новый клиент • потенциал для второго заказа';
    }
    if (row.is_repeat_client && row.is_sleeping_client) return 'Покупал повторно • стоит вернуть';
    if (row.is_repeat_client && row.is_high_value_client) return 'Высокий средний чек • активен';
    if (row.is_repeat_client) {
        if (daysFromOrder !== null) return `${totalOrders} заказа • последний ${daysFromOrder} дн. назад`;
        return `${totalOrders} заказа • повторный клиент`;
    }
    if (row.is_sleeping_client) return 'Давно не покупал • стоит вернуть';
    if (row.is_high_value_client) return 'Высокий средний чек • клиент ценен';
    return 'Клиент в базе • есть потенциал роста';
}

function enrichClientRow(row, now = new Date()) {
    const totalOrders = Math.max(0, Math.round(toNumber(row.total_orders)));
    const totalRevenueK = Math.round(toNumber(row.total_revenue));
    const avgOrderValueK = totalOrders > 0 ? Math.round(totalRevenueK / totalOrders) : 0;
    const daysSinceLastOrder = daysSince(row.last_order_at, now);
    const hasTopic = Boolean(row.message_thread_id);
    const hasSupportActivity = Number(row.support_total_threads || 0) > 0;
    const hasRecentBroadcastActivity = Number(row.recent_broadcast_count || 0) > 0;

    const isRepeatClient = totalOrders >= 2;
    const isNewClient = totalOrders === 1 && (daysSinceLastOrder === null || daysSinceLastOrder <= 21);
    const isSleepingClient = totalOrders > 0 && daysSinceLastOrder !== null && daysSinceLastOrder >= 30;
    const isHighValueClient = avgOrderValueK >= rubThresholdToKopecks(7000) || totalRevenueK >= rubThresholdToKopecks(25000);
    const isVipClient = totalRevenueK >= rubThresholdToKopecks(45000) || totalOrders >= 6 || (isRepeatClient && avgOrderValueK >= rubThresholdToKopecks(9000));
    const isRecentlyActive = totalOrders > 0 && daysSinceLastOrder !== null && daysSinceLastOrder <= 14;

    let attentionLevel = 'normal';
    let attentionReason = '';
    if (isVipClient && isSleepingClient) {
        attentionLevel = 'high';
        attentionReason = 'VIP-клиент давно не покупал';
    } else if (totalOrders === 1 && daysSinceLastOrder !== null && daysSinceLastOrder >= 14) {
        attentionLevel = 'medium';
        attentionReason = 'Новый клиент без повторного заказа';
    } else if (hasSupportActivity && Number(row.support_open_threads || 0) > 0) {
        attentionLevel = 'medium';
        attentionReason = 'Есть активный диалог поддержки';
    } else if (isRepeatClient && daysSinceLastOrder !== null && daysSinceLastOrder >= 45) {
        attentionLevel = 'medium';
        attentionReason = 'Повторный клиент теряет активность';
    }

    const isRecoverCandidate = (
        (isRepeatClient && isSleepingClient) ||
        (isVipClient && daysSinceLastOrder !== null && daysSinceLastOrder >= 21) ||
        (totalOrders === 1 && daysSinceLastOrder !== null && daysSinceLastOrder >= 14)
    );

    let clientSegment = 'active';
    if (attentionLevel !== 'normal') clientSegment = 'attention';
    else if (isVipClient) clientSegment = 'vip';
    else if (isSleepingClient) clientSegment = 'sleeping';
    else if (isNewClient) clientSegment = 'new';
    else if (isRepeatClient) clientSegment = 'repeat';
    else if (isHighValueClient) clientSegment = 'high-value';

    return {
        ...row,
        full_name: formatClientName(row),
        total_orders: totalOrders,
        total_revenue: totalRevenueK,
        avg_order_value: avgOrderValueK,
        last_order_at: row.last_order_at || null,
        days_since_last_order: daysSinceLastOrder,
        is_new_client: isNewClient,
        is_repeat_client: isRepeatClient,
        is_vip_client: isVipClient,
        is_sleeping_client: isSleepingClient,
        is_high_value_client: isHighValueClient,
        is_recently_active: isRecentlyActive,
        has_support_activity: hasSupportActivity,
        has_recent_broadcast_activity: hasRecentBroadcastActivity,
        has_topic: hasTopic,
        is_recover_candidate: isRecoverCandidate,
        client_segment: clientSegment,
        attention_level: attentionLevel,
        attention_reason: attentionReason,
        customer_subtitle: clientSubtitle({
            ...row,
            is_vip_client: isVipClient,
            is_sleeping_client: isSleepingClient,
            is_new_client: isNewClient,
            is_repeat_client: isRepeatClient,
            is_high_value_client: isHighValueClient,
            total_orders: totalOrders,
            days_since_last_order: daysSinceLastOrder
        }, now)
    };
}

function deriveClientTiers(client) {
    const valueTier = client.is_vip_client
        ? 'vip'
        : (client.is_high_value_client ? 'high' : 'standard');

    let retentionStage = 'active';
    if (client.is_new_client) retentionStage = 'new';
    else if (client.is_sleeping_client && client.is_vip_client) retentionStage = 'at_risk';
    else if (client.is_sleeping_client) retentionStage = 'sleeping';
    else if (client.is_repeat_client && Number(client.days_since_last_order || 0) <= 14) retentionStage = 'loyal';
    else if (client.is_repeat_client) retentionStage = 'active';

    let actionPriority = 'normal';
    if ((client.is_vip_client && client.is_sleeping_client) || Number(client.support_open_threads || 0) > 0) {
        actionPriority = 'critical';
    } else if (client.is_recover_candidate || client.attention_level !== 'normal') {
        actionPriority = 'important';
    }

    return { valueTier, retentionStage, actionPriority };
}

function recommendedActionsForClient(client) {
    const telegramId = String(client.telegram_id || '');
    const actions = [];

    if (client.is_vip_client && client.is_sleeping_client) {
        actions.push({
            id: 'return_vip',
            title: 'Стоит вернуть клиента',
            message: 'VIP-клиент давно не покупал. Нужен персональный контакт и повод вернуться.',
            priority: 'critical',
            ctaLabel: 'Открыть тему',
            action: { screen: 'clients', filters: { clientFilter: 'return' } }
        });
    } else if (client.is_new_client && Number(client.days_since_last_order || 0) >= 10) {
        actions.push({
            id: 'convert_second_order',
            title: 'Довести до второго заказа',
            message: 'Новый клиент без повтора. Сейчас лучший момент закрепить привычку покупки.',
            priority: 'important',
            ctaLabel: 'К заказам клиента',
            action: { screen: 'orders', filters: { orderFilter: 'all', orderClientTelegramId: telegramId } }
        });
    } else if (client.is_repeat_client && !client.is_sleeping_client) {
        actions.push({
            id: 'upsell_repeat',
            title: 'Есть шанс на повторную продажу',
            message: 'Клиент уже покупает повторно. Можно усилить выручку персональным предложением.',
            priority: 'normal',
            ctaLabel: 'Открыть заказы',
            action: { screen: 'orders', filters: { orderFilter: 'repeat', orderClientTelegramId: telegramId } }
        });
    }

    if (Number(client.support_open_threads || 0) > 0) {
        actions.push({
            id: 'support_open',
            title: 'Есть активный запрос в поддержке',
            message: 'Незакрытый диалог влияет на повторную покупку и лояльность.',
            priority: 'critical',
            ctaLabel: 'Открыть поддержку',
            action: { screen: 'support', filters: { supportFilter: 'all', supportClientTelegramId: telegramId } }
        });
    }

    if (client.has_topic) {
        actions.push({
            id: 'topic_contact',
            title: 'Прямой канал связи готов',
            message: 'Можно быстро написать клиенту в тему и запустить retention-сценарий.',
            priority: 'normal',
            ctaLabel: 'Открыть тему',
            action: { screen: 'clients', filters: { clientFilter: client.client_segment || 'all' } }
        });
    }

    actions.push({
        id: 'marketing_touch',
        title: 'Подготовить персональный touch',
        message: 'Проверьте релевантный сегмент и сформируйте персональное предложение.',
        priority: client.is_recover_candidate ? 'important' : 'normal',
        ctaLabel: 'К рассылкам',
        action: { screen: 'broadcasts', filters: { broadcastsFilter: '' } }
    });

    return actions.slice(0, 5);
}

function enrichBroadcastCampaign(row) {
    const deliveredCount = Math.max(0, Math.round(toNumber(row.delivered_count)));
    const failedCount = Math.max(0, Math.round(toNumber(row.failed_count)));
    const blockedCount = Math.max(0, Math.round(toNumber(row.blocked_count)));
    const totalRecipients = Math.max(0, Math.round(toNumber(row.total_recipients)));
    const lostReachCount = Math.max(0, failedCount + blockedCount);
    const deletedCount = Math.max(0, Math.round(toNumber(row.delete_for_all_count)));

    const rawDeliveryMs = row.delivery_duration_ms;
    const deliveryDurationMs =
        rawDeliveryMs != null && rawDeliveryMs !== '' && Number.isFinite(Number(rawDeliveryMs))
            ? Math.max(0, Math.round(Number(rawDeliveryMs)))
            : null;
    const deliverySendDurationLabel =
        deliveryDurationMs != null ? formatBroadcastSendDurationLabelRu(deliveryDurationMs) : null;

    const pct = (value) => {
        if (totalRecipients <= 0) return 0;
        return Math.round((Math.max(0, value) / totalRecipients) * 1000) / 10;
    };
    const deliveredPct = pct(deliveredCount);
    const failedPct = pct(failedCount);
    const blockedPct = pct(blockedCount);
    const lostReachPct = pct(lostReachCount);

    const status = String(row.status || '').toUpperCase();
    let qualityScore = Math.round(deliveredPct - (failedPct * 1.2) - (blockedPct * 1.8));
    qualityScore = Math.max(0, Math.min(100, qualityScore));

    let campaignTier = 'neutral';
    if (status === 'RUNNING') campaignTier = 'running';
    else if (status === 'DELETED') campaignTier = 'deleted';
    else if (totalRecipients > 0 && deliveredPct >= 92 && failedPct <= 5 && blockedPct <= 3) campaignTier = 'successful';
    else if (totalRecipients > 0 && (failedPct >= 12 || blockedPct >= 8 || lostReachPct >= 20)) campaignTier = 'problematic';
    else if (totalRecipients > 0 && deliveredPct >= 88 && failedPct <= 7 && blockedPct <= 5) campaignTier = 'repeatable';
    else if (status === 'DONE') campaignTier = 'completed';

    const isProblematic = campaignTier === 'problematic' || failedCount >= 30 || blockedCount >= 20;
    const isRepeatableCandidate = campaignTier === 'repeatable' || campaignTier === 'successful';
    const isHighReach = totalRecipients >= 150;

    let health = 'stable';
    if (status === 'RUNNING') health = 'running';
    else if (isProblematic) health = 'problematic';
    else if (isRepeatableCandidate) health = 'healthy';

    let attentionLevel = 'watch';
    let attentionReason = 'Кампания в рабочем диапазоне';
    if (status === 'RUNNING') {
        attentionLevel = 'watch';
        attentionReason = 'Кампания еще выполняется, метрики могут измениться';
    } else if (lostReachPct >= 30 || blockedPct >= 15) {
        attentionLevel = 'critical';
        attentionReason = 'Сильный потерянный охват и высокий риск блокировок';
    } else if (isProblematic) {
        attentionLevel = 'important';
        attentionReason = 'Есть заметные проблемы доставки, стоит проверить сегмент';
    } else if (isRepeatableCandidate) {
        attentionLevel = 'normal';
        attentionReason = 'Хорошее качество доставки, кампанию можно повторить';
    }

    let subtitle = 'Кампания в рабочем диапазоне';
    if (status === 'RUNNING') subtitle = 'Кампания идет сейчас, дождитесь финальных метрик';
    else if (isProblematic) subtitle = 'Проблемы с доставкой, нужна проверка';
    else if (blockedPct >= 6) subtitle = 'Много блокировок, стоит пересмотреть сегмент';
    else if (isRepeatableCandidate) subtitle = 'Хороший охват, кампанию можно повторить';
    else if (deliveredPct >= 80) subtitle = 'Нормальный охват, есть потенциал улучшения';

    let estimatedOutcomeLabel = 'Нейтральный результат';
    if (campaignTier === 'successful') estimatedOutcomeLabel = 'Сильная кампания';
    else if (campaignTier === 'repeatable') estimatedOutcomeLabel = 'Перспективно для повтора';
    else if (campaignTier === 'problematic') estimatedOutcomeLabel = 'Требует исправлений';
    else if (campaignTier === 'running') estimatedOutcomeLabel = 'Идёт выполнение';

    return {
        ...row,
        delivered_count: deliveredCount,
        failed_count: failedCount,
        blocked_count: blockedCount,
        total_recipients: totalRecipients,
        delivered_pct: deliveredPct,
        failed_pct: failedPct,
        blocked_pct: blockedPct,
        lost_reach_count: lostReachCount,
        lost_reach_pct: lostReachPct,
        campaign_health: health,
        campaign_tier: campaignTier,
        is_problematic: isProblematic,
        is_repeatable_candidate: isRepeatableCandidate,
        is_high_reach: isHighReach,
        campaign_subtitle: subtitle,
        campaign_attention_level: attentionLevel,
        campaign_attention_reason: attentionReason,
        campaign_quality_score: qualityScore,
        estimated_outcome_label: estimatedOutcomeLabel,
        delete_for_all_count: deletedCount,
        delivery_send_started_at: row.delivery_send_started_at || null,
        delivery_send_finished_at: row.delivery_send_finished_at || null,
        delivery_duration_ms: deliveryDurationMs,
        delivery_send_duration_label: deliverySendDurationLabel
    };
}

function deriveBroadcastRepeatability(campaign) {
    const deliveredPct = toNumber(campaign.delivered_pct);
    const blockedPct = toNumber(campaign.blocked_pct);
    const failedPct = toNumber(campaign.failed_pct);
    const lostReachPct = toNumber(campaign.lost_reach_pct);
    const status = String(campaign.status || '').toUpperCase();

    if (status === 'RUNNING') {
        return {
            repeatability_status: 'improve_and_repeat',
            repeatability_reason: 'Кампания еще идет, финальный verdict появится после завершения.',
            repeatability_label: 'Можно доработать и повторить'
        };
    }

    if (deliveredPct >= 90 && blockedPct <= 4 && failedPct <= 8 && lostReachPct <= 10) {
        return {
            repeatability_status: 'repeat',
            repeatability_reason: 'Стабильная доставляемость и низкие риски по блокировкам.',
            repeatability_label: 'Стоит повторить'
        };
    }

    if (lostReachPct >= 24 || blockedPct >= 10 || failedPct >= 16) {
        return {
            repeatability_status: 'do_not_repeat',
            repeatability_reason: 'Высокий потерянный охват и риск выгорания сегмента.',
            repeatability_label: 'Лучше не повторять в текущем виде'
        };
    }

    return {
        repeatability_status: 'improve_and_repeat',
        repeatability_reason: 'Есть умеренные риски, лучше доработать сегмент и повторить.',
        repeatability_label: 'Можно доработать и повторить'
    };
}

function deriveBroadcastQualityInsights(campaign, repeatability) {
    const insights = [];
    const deliveredPct = toNumber(campaign.delivered_pct);
    const blockedPct = toNumber(campaign.blocked_pct);
    const failedPct = toNumber(campaign.failed_pct);
    const lostReachPct = toNumber(campaign.lost_reach_pct);
    const totalRecipients = Math.round(toNumber(campaign.total_recipients));

    if (deliveredPct >= 90) {
        insights.push({
            tone: 'ok',
            priority: 'high',
            title: 'Кампания сохранила хороший охват',
            message: `Доставлено ${deliveredPct}% от сегмента (${Math.round(toNumber(campaign.delivered_count))} из ${totalRecipients}).`
        });
    }

    if (lostReachPct >= 15) {
        insights.push({
            tone: lostReachPct >= 24 ? 'alert' : 'warn',
            priority: lostReachPct >= 24 ? 'high' : 'medium',
            title: 'Потерянный охват выше нормы',
            message: `Потеряно ${Math.round(toNumber(campaign.lost_reach_count))} касаний (${lostReachPct}% аудитории).`,
            cta: {
                label: 'Открыть ошибки',
                action: { screen: 'broadcast_detail', filters: {}, campaignId: Number(campaign.id) }
            }
        });
    }

    if (blockedPct >= 6) {
        insights.push({
            tone: blockedPct >= 10 ? 'alert' : 'warn',
            priority: blockedPct >= 10 ? 'high' : 'medium',
            title: 'Блокировки выше обычного',
            message: `Блокировки ${blockedPct}% — сегмент может выгорать и терять контакт.`
        });
    }

    if (failedPct >= 10) {
        insights.push({
            tone: 'warn',
            priority: 'medium',
            title: 'Ошибки доставки заметны',
            message: `Ошибки ${failedPct}% — стоит проверить качество аудитории и канал доставки.`
        });
    }

    if (repeatability.repeatability_status === 'repeat') {
        insights.push({
            tone: 'ok',
            priority: 'high',
            title: 'Кампанию можно использовать как основу',
            message: 'Подходит для повторного запуска на похожем сегменте без сильных рисков.'
        });
    } else if (repeatability.repeatability_status === 'do_not_repeat') {
        insights.push({
            tone: 'alert',
            priority: 'high',
            title: 'Перед повтором нужен пересмотр',
            message: 'Текущая версия кампании может ухудшить качество канала при повторе.'
        });
    } else {
        insights.push({
            tone: 'info',
            priority: 'medium',
            title: 'Повтор возможен после доработки',
            message: 'Лучше обновить сегмент и исправить слабые зоны, затем запускать снова.'
        });
    }

    return insights.slice(0, 6).map((item, idx) => ({ id: `qi_${idx + 1}`, ...item }));
}

function buildBroadcastErrorSummary(deliveries = [], totalRecipients = 0) {
    const problematic = deliveries.filter((item) => {
        const status = String(item.status || '').toUpperCase();
        return status === 'FAILED' || status === 'FAILED_PERMANENT' || status === 'BLOCKED';
    });
    const byType = {};
    problematic.forEach((item) => {
        const status = String(item.status || '').toUpperCase();
        const code = String(item.error_code || '').trim().toUpperCase();
        const key = code || status || 'UNKNOWN';
        byType[key] = (byType[key] || 0) + 1;
    });
    const denominator = Math.max(1, Math.round(toNumber(totalRecipients)));
    const topErrorTypes = Object.entries(byType)
        .map(([key, count]) => ({
            key,
            label: key === 'BLOCKED' ? 'Блокировка получателем' : key,
            count,
            pct: Math.round((Number(count || 0) / denominator) * 1000) / 10
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);

    const lastProblem = problematic[0] || null;
    const lastErrorSummary = lastProblem
        ? `${String(lastProblem.status || 'FAILED')} · ${String(lastProblem.error_message || lastProblem.error_code || 'без описания').slice(0, 140)}`
        : '';

    return {
        has_errors: problematic.length > 0,
        total_problematic: problematic.length,
        last_error_summary: lastErrorSummary,
        top_error_types: topErrorTypes
    };
}

function deriveBroadcastNextActions(campaign, repeatability, errorSummary) {
    const actions = [];
    const campaignId = Number(campaign.id);
    const lostReachPct = toNumber(campaign.lost_reach_pct);
    const blockedPct = toNumber(campaign.blocked_pct);

    if (repeatability.repeatability_status === 'repeat') {
        actions.push({
            id: 'repeat_similar_segment',
            title: 'Повторить на похожий сегмент',
            message: 'Кампания показала стабильное качество канала и подходит для повторного запуска.',
            priority: 'high',
            ctaLabel: 'Использовать как основу',
            action: { screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' }, campaignId }
        });
    } else if (repeatability.repeatability_status === 'improve_and_repeat') {
        actions.push({
            id: 'improve_before_repeat',
            title: 'Доработать и повторить',
            message: 'Сначала снизьте ошибки и блокировки, после этого используйте кампанию как основу.',
            priority: 'medium',
            ctaLabel: 'Открыть сегмент',
            action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' }, campaignId }
        });
    } else {
        actions.push({
            id: 'pause_and_resegment',
            title: 'Не повторять без пересмотра сегмента',
            message: 'Сначала исправьте причины недоохвата, чтобы не ухудшить качество канала.',
            priority: 'high',
            ctaLabel: 'Открыть проблемные',
            action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' }, campaignId }
        });
    }

    if (blockedPct >= 6) {
        actions.push({
            id: 'check_blocked_reasons',
            title: 'Проверить причины блокировок',
            message: 'Повышенные блокировки могут указывать на выгорание или слабую релевантность сегмента.',
            priority: 'high',
            ctaLabel: 'Открыть блокировки',
            action: { screen: 'broadcasts', filters: { broadcastsFilter: 'blocked' }, campaignId }
        });
    }

    if (errorSummary.has_errors || lostReachPct >= 12) {
        actions.push({
            id: 'inspect_problem_recipients',
            title: 'Посмотреть проблемных получателей',
            message: 'Разберите ошибки доставки и недошедшие сообщения до следующего запуска.',
            priority: 'medium',
            ctaLabel: 'Открыть ошибки',
            action: { screen: 'broadcast_detail', filters: {}, campaignId }
        });
    }

    actions.push({
        id: 'delete_for_all_if_needed',
        title: 'Удалить у всех при необходимости',
        message: 'Если контент устарел или ошибочен, можно запустить delete-for-all по доставленным сообщениям.',
        priority: 'low',
        ctaLabel: 'Удалить у всех',
        action: { screen: 'broadcast_detail', filters: {}, campaignId }
    });

    return actions.slice(0, 5);
}

function deriveBroadcastDuration(createdAt, completedAt, updatedAt) {
    const start = parseDateSafe(createdAt);
    const end = parseDateSafe(completedAt || updatedAt);
    if (!start || !end) return { duration_minutes: null, duration_label: '—' };
    const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / (60 * 1000)));
    if (minutes < 1) return { duration_minutes: 0, duration_label: '< 1 мин' };
    if (minutes < 60) return { duration_minutes: minutes, duration_label: `${minutes} мин` };
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return {
        duration_minutes: minutes,
        duration_label: restMinutes ? `${hours} ч ${restMinutes} мин` : `${hours} ч`
    };
}

function supportToneFromLevel(level) {
    if (level === 'critical') return 'critical';
    if (level === 'important') return 'important';
    return 'normal';
}

function deriveSupportAttention(meta) {
    const waitingMinutes = Math.max(0, Math.round(toNumber(meta.waiting_minutes)));
    const isWaiting = Boolean(meta.is_waiting_response);
    const isVip = Boolean(meta.is_vip_client);
    const isNew = Boolean(meta.is_new_client);
    const isRepeat = Boolean(meta.is_repeat_client);
    const hasRecentOrder = Boolean(meta.has_recent_order);
    const isOpen = Boolean(meta.is_open_thread);

    let score = 0;
    if (isWaiting) score += 35;
    if (isWaiting && waitingMinutes >= 20) score += 15;
    if (isWaiting && waitingMinutes >= 60) score += 20;
    if (isWaiting && waitingMinutes >= 180) score += 15;
    if (isVip) score += 25;
    if (isNew) score += 15;
    if (isRepeat) score += 10;
    if (hasRecentOrder) score += 15;
    if (isOpen) score += 5;

    let level = 'normal';
    let reason = 'Диалог под контролем';
    if (
        (isVip && isWaiting) ||
        (isNew && isWaiting && waitingMinutes >= 30) ||
        (hasRecentOrder && isWaiting && waitingMinutes >= 45) ||
        (isWaiting && waitingMinutes >= 180)
    ) {
        level = 'critical';
        reason = isVip && isWaiting
            ? 'VIP-клиент ждет ответа'
            : (isNew && isWaiting && waitingMinutes >= 30
                ? 'Новый клиент долго ждет ответа'
                : (hasRecentOrder && isWaiting && waitingMinutes >= 45
                    ? 'Клиент с недавним заказом без реакции поддержки'
                    : 'Диалог ждет реакции слишком долго'));
    } else if (isWaiting && waitingMinutes >= 20) {
        level = 'important';
        reason = isRepeat
            ? 'Повторный клиент без ответа'
            : 'Клиент ждет ответа дольше нормы';
    } else if (isWaiting) {
        level = 'important';
        reason = 'Есть ожидание ответа клиента';
    }

    return {
        support_attention_level: level,
        support_attention_reason: reason,
        support_priority_score: Math.max(0, Math.min(100, score)),
        is_critical: level === 'critical'
    };
}

function enrichSupportThreadRow(row, now = new Date()) {
    const clientSnapshot = enrichClientRow({
        telegram_id: row.telegram_user_id,
        first_name: row.first_name,
        last_name: row.last_name,
        username: row.username,
        topic_id: row.topic_id,
        chat_id: row.topic_chat_id,
        message_thread_id: row.topic_thread_id || row.message_thread_id,
        total_orders: row.client_orders_count || 0,
        total_revenue: row.client_total_revenue || 0,
        last_order_at: row.client_last_order_at || null,
        support_open_threads: row.client_open_threads || 0,
        support_total_threads: row.client_total_threads || 0,
        support_last_activity_at: row.last_message_at || row.updated_at || row.created_at,
        recent_broadcast_count: 0
    }, now);

    const status = String(row.status || '').toUpperCase();
    const isOpenThread = ['OPEN', 'PENDING'].includes(status);
    const isWaitingResponse = computeThreadWaitingForStaff(row);
    const waitingSinceBase = isWaitingResponse
        ? (row.last_client_message_at || row.created_at || row.updated_at || null)
        : null;
    const waitingMinutes = waitingSinceBase
        ? Math.max(0, Math.round((now.getTime() - Date.parse(String(waitingSinceBase))) / (60 * 1000)))
        : 0;

    const hasRecentOrder = clientSnapshot.days_since_last_order !== null && clientSnapshot.days_since_last_order <= 14;
    const hasOrders = Number(clientSnapshot.total_orders || 0) > 0;
    const attention = deriveSupportAttention({
        waiting_minutes: waitingMinutes,
        is_waiting_response: isWaitingResponse,
        is_vip_client: clientSnapshot.is_vip_client,
        is_new_client: clientSnapshot.is_new_client,
        is_repeat_client: clientSnapshot.is_repeat_client,
        has_recent_order: hasRecentOrder,
        is_open_thread: isOpenThread
    });

    let subtitle = 'Диалог в рабочем режиме';
    if (attention.support_attention_level === 'critical') {
        subtitle = `${clientSnapshot.is_vip_client ? 'VIP-клиент' : 'Клиент'} ждет ответа ${waitingMinutes} мин`;
    } else if (clientSnapshot.is_new_client) {
        subtitle = 'Новый клиент обратился впервые';
    } else if (hasRecentOrder && isWaitingResponse) {
        subtitle = 'Есть недавний заказ и открытый вопрос';
    } else if (clientSnapshot.is_repeat_client && isWaitingResponse) {
        subtitle = 'Повторный клиент без реакции поддержки';
    } else if (isWaitingResponse) {
        subtitle = `Клиент ждет ответа ${waitingMinutes} мин`;
    }

    const topicThreadId = row.message_thread_id || row.topic_thread_id || null;
    const topicChatId = row.topic_chat_id || null;
    const topicLink = (String(topicChatId || '').startsWith('-100') && topicThreadId)
        ? `https://t.me/c/${String(topicChatId).slice(4)}/${Number(topicThreadId)}`
        : '';

    return {
        ...row,
        client_name: clientSnapshot.full_name,
        client_username: clientSnapshot.username || row.username || '',
        client_total_revenue: Number(clientSnapshot.total_revenue || 0),
        client_orders_count: Number(clientSnapshot.total_orders || 0),
        has_recent_order: hasRecentOrder,
        latest_order_id: row.latest_order_id ? Number(row.latest_order_id) : null,
        is_vip_client: Boolean(clientSnapshot.is_vip_client),
        is_new_client: Boolean(clientSnapshot.is_new_client),
        is_repeat_client: Boolean(clientSnapshot.is_repeat_client),
        is_sleeping_client: Boolean(clientSnapshot.is_sleeping_client),
        waiting_minutes: waitingMinutes,
        is_waiting_response: isWaitingResponse,
        is_open_thread: isOpenThread,
        support_subtitle: subtitle,
        topic_chat_id: topicChatId,
        topic_thread_id: topicThreadId,
        topic_link: topicLink,
        ...attention,
        support_tone: supportToneFromLevel(attention.support_attention_level),
        has_orders: hasOrders
    };
}

function createAdminRepository() {
    async function logAction({ adminId, action, entityType = null, entityId = null, details = {} }) {
        await run(
            `
            INSERT INTO admin_action_logs (admin_id, action, entity_type, entity_id, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
                String(adminId || ''),
                String(action || ''),
                entityType,
                entityId ? String(entityId) : null,
                JSON.stringify(details || {}),
                new Date().toISOString()
            ]
        );
    }

    async function getDashboard() {
        const [
            usersRow,
            ordersRow,
            broadcastsRow,
            blockedRow,
            outboxRow,
            supportRow
        ] = await Promise.all([
            get('SELECT COUNT(*) AS c FROM users'),
            get('SELECT COUNT(*) AS c FROM orders'),
            get("SELECT COUNT(*) AS c FROM broadcast_campaigns WHERE status = 'DONE'"),
            get("SELECT COUNT(*) AS c FROM broadcast_deliveries WHERE status = 'BLOCKED'"),
            get("SELECT SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END) AS retrying FROM event_outbox"),
            get("SELECT COUNT(*) AS c FROM support_threads WHERE status IN ('OPEN','PENDING')")
        ]);

        const recent = await all(
            `
            SELECT id, admin_id, action, entity_type, entity_id, created_at
            FROM admin_action_logs
            ORDER BY id DESC
            LIMIT 15
            `
        );

        return {
            activeUsers: Number(usersRow?.c || 0),
            totalOrders: Number(ordersRow?.c || 0),
            successfulBroadcasts: Number(broadcastsRow?.c || 0),
            blockedUsers: Number(blockedRow?.c || 0),
            outboxFailed: Number(outboxRow?.failed || 0),
            outboxRetrying: Number(outboxRow?.retrying || 0),
            supportActiveThreads: Number(supportRow?.c || 0),
            recentEvents: recent
        };
    }

    async function getMobileSummary() {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const elapsedTodayMs = Math.max(1, now.getTime() - todayStart.getTime());

        const yesterdayStart = new Date(todayStart.getTime() - (24 * 60 * 60 * 1000));
        const yesterdaySameTimeEnd = new Date(yesterdayStart.getTime() + elapsedTodayMs);
        const weekAgoSameDayStart = new Date(todayStart.getTime() - (7 * 24 * 60 * 60 * 1000));
        const weekAgoSameDayEnd = new Date(weekAgoSameDayStart.getTime() + elapsedTodayMs);
        const sevenDaysStart = new Date(todayStart.getTime() - (7 * 24 * 60 * 60 * 1000));
        const monthStart = new Date(todayStart.getTime() - (30 * 24 * 60 * 60 * 1000));

        const nowIso = now.toISOString();
        const todayStartIso = todayStart.toISOString();
        const yesterdayStartIso = yesterdayStart.toISOString();
        const yesterdaySameTimeEndIso = yesterdaySameTimeEnd.toISOString();
        const weekAgoSameDayStartIso = weekAgoSameDayStart.toISOString();
        const weekAgoSameDayEndIso = weekAgoSameDayEnd.toISOString();
        const sevenDaysStartIso = sevenDaysStart.toISOString();
        const monthStartIso = monthStart.toISOString();

        const [orders30d, ordersBeforeToday, supportStats, outboxState, broadcastProblemsToday, latestCampaign, inactiveClients] = await Promise.all([
            all(
                `
                SELECT id, telegram_id, total, total_paid, status, created_at
                FROM orders
                WHERE created_at >= ? AND created_at < ?
                ORDER BY created_at ASC
                `,
                [monthStartIso, nowIso]
            ),
            all(
                `
                SELECT telegram_id, created_at
                FROM orders
                WHERE created_at < ?
                `,
                [todayStartIso]
            ),
            get(
                `
                SELECT
                    SUM(CASE WHEN UPPER(TRIM(COALESCE(status, ''))) IN ('OPEN', 'PENDING') THEN 1 ELSE 0 END) AS active_threads,
                    SUM(
                        CASE WHEN UPPER(TRIM(COALESCE(status, ''))) IN ('OPEN', 'PENDING')
                                  AND COALESCE(waiting_for_staff, 0) = 1
                             THEN 1 ELSE 0 END
                    ) AS waiting_without_response,
                    AVG(
                        CASE WHEN first_response_at IS NOT NULL AND TRIM(first_response_at) <> ''
                             THEN (julianday(first_response_at) - julianday(created_at)) * 24 * 60
                             ELSE NULL END
                    ) AS avg_first_response_minutes
                FROM support_threads
                `,
                []
            ),
            get(
                `
                SELECT
                    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END) AS retrying
                FROM event_outbox
                `
            ),
            get(
                `
                SELECT COUNT(*) AS c
                FROM broadcast_deliveries
                WHERE status IN ('BLOCKED', 'FAILED', 'FAILED_PERMANENT')
                  AND COALESCE(updated_at, created_at, '') >= ?
                `,
                [todayStartIso]
            ),
            get(
                `
                SELECT *
                FROM broadcast_campaigns
                ORDER BY id DESC
                LIMIT 1
                `
            ),
            get(
                `
                SELECT COUNT(*) AS c
                FROM users u
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM orders o
                    WHERE o.telegram_id = u.telegram_id
                      AND o.created_at >= ?
                )
                `,
                [monthStartIso]
            )
        ]);

        const latestCampaignId = Number(latestCampaign?.id || 0);
        const [latestCampaignStats, recentCampaignStats] = await Promise.all([
            latestCampaignId > 0
                ? get(
                    `
                    SELECT
                        SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
                        SUM(CASE WHEN status IN ('FAILED','FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
                        COUNT(*) AS total
                    FROM broadcast_deliveries
                    WHERE campaign_id = ?
                    `,
                    [latestCampaignId]
                )
                : Promise.resolve({ delivered: 0, failed: 0, blocked: 0, total: 0 }),
            all(
                `
                SELECT
                    bc.id AS campaign_id,
                    SUM(CASE WHEN bd.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
                    SUM(CASE WHEN bd.status IN ('FAILED','FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN bd.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
                    COUNT(bd.id) AS total
                FROM broadcast_campaigns bc
                LEFT JOIN broadcast_deliveries bd ON bd.campaign_id = bc.id
                WHERE bc.created_at >= ?
                GROUP BY bc.id
                ORDER BY bc.id DESC
                LIMIT 10
                `,
                [monthStartIso]
            )
        ]);

        const historyIds = new Set(ordersBeforeToday.map((row) => String(row.telegram_id || '')));
        const toTs = (v) => {
            const ts = Date.parse(String(v || ''));
            return Number.isFinite(ts) ? ts : 0;
        };
        const inRange = (ts, start, end) => ts >= start.getTime() && ts < end.getTime();
        const orderRevenue = (row) => orderPaidRevenueKopecksFromRow(row);

        const calcMetrics = (rows, start, end) => {
            const selected = rows.filter((row) => inRange(toTs(row.created_at), start, end));
            const paidOrders = selected.filter((row) => orderRevenue(row) > 0);
            const revenue = paidOrders.reduce((acc, row) => acc + orderRevenue(row), 0);
            const unpaidOrders = selected.filter((row) => orderRevenue(row) <= 0);
            const unpaidAmount = unpaidOrders.reduce((acc, row) => acc + orderUnpaidExposureKopecksFromRow(row), 0);
            const repeatOrders = selected.filter((row) => historyIds.has(String(row.telegram_id || ''))).length;
            const repeatClientsSet = new Set(
                selected
                    .filter((row) => historyIds.has(String(row.telegram_id || '')))
                    .map((row) => String(row.telegram_id || ''))
            );
            const conversion = selected.length > 0 ? (paidOrders.length / selected.length) * 100 : 0;
            return {
                ordersCount: selected.length,
                paidOrdersCount: paidOrders.length,
                unpaidOrdersCount: unpaidOrders.length,
                revenue,
                avgCheck: paidOrders.length > 0 ? (revenue / paidOrders.length) : 0,
                conversionPct: conversion,
                repeatOrdersCount: repeatOrders,
                repeatClientsCount: repeatClientsSet.size,
                unpaidAmount
            };
        };

        const todayMetrics = calcMetrics(orders30d, todayStart, now);
        const yesterdayMetrics = calcMetrics(orders30d, yesterdayStart, yesterdaySameTimeEnd);
        const weekAgoSameDayMetrics = calcMetrics(orders30d, weekAgoSameDayStart, weekAgoSameDayEnd);
        const sevenDayMetrics = calcMetrics(orders30d, sevenDaysStart, now);
        const thirtyDayMetrics = calcMetrics(orders30d, monthStart, now);
        const sevenDayAvgMetrics = {
            revenue: sevenDayMetrics.revenue / 7,
            orders: sevenDayMetrics.ordersCount / 7,
            avgCheck: sevenDayMetrics.avgCheck,
            repeatOrders: sevenDayMetrics.repeatOrdersCount / 7
        };

        const chartMap = new Map();
        for (let i = 6; i >= 0; i -= 1) {
            const day = new Date(todayStart.getTime() - (i * 24 * 60 * 60 * 1000));
            const key = day.toISOString().slice(0, 10);
            chartMap.set(key, { day: key, revenue: 0, orders: 0, avgCheck: 0, paidOrders: 0 });
        }
        for (const row of orders30d) {
            const key = String(row.created_at || '').slice(0, 10);
            if (!chartMap.has(key)) continue;
            const current = chartMap.get(key);
            current.orders += 1;
            const rev = orderRevenue(row);
            if (rev > 0) {
                current.revenue += rev;
                current.paidOrders += 1;
            }
        }
        const chart7d = Array.from(chartMap.values()).map((row) => ({
            day: row.day,
            revenue: Math.round(row.revenue),
            orders: row.orders,
            avgCheck: row.paidOrders > 0 ? Math.round(row.revenue / row.paidOrders) : 0
        }));

        const pct = (current, previous) => {
            const c = toNumber(current);
            const p = toNumber(previous);
            if (p === 0 && c === 0) return 0;
            if (p === 0) return 100;
            return ((c - p) / p) * 100;
        };
        const toRound = (value) => Math.round(toNumber(value));
        const toPct = (value) => Math.round(toNumber(value) * 10) / 10;

        const latestDelivered = toNumber(latestCampaignStats?.delivered);
        const latestFailed = toNumber(latestCampaignStats?.failed);
        const latestBlocked = toNumber(latestCampaignStats?.blocked);
        const latestTotal = toNumber(latestCampaignStats?.total);
        const latestErrorRate = latestTotal > 0 ? ((latestFailed + latestBlocked) / latestTotal) * 100 : 0;

        const recentCampaignRate = (() => {
            if (!Array.isArray(recentCampaignStats) || recentCampaignStats.length === 0) return 0;
            const rates = recentCampaignStats
                .map((row) => {
                    const total = toNumber(row.total);
                    if (total <= 0) return null;
                    const bad = toNumber(row.failed) + toNumber(row.blocked);
                    return (bad / total) * 100;
                })
                .filter((v) => Number.isFinite(v));
            if (!rates.length) return 0;
            return rates.reduce((acc, v) => acc + v, 0) / rates.length;
        })();

        const unpaidCount = todayMetrics.unpaidOrdersCount;
        const unpaidAmountK = toRound(todayMetrics.unpaidAmount);
        const waitingSupportCount = toNumber(supportStats?.waiting_without_response);
        const activeSupportCount = toNumber(supportStats?.active_threads);
        const avgFirstResponseMinutes = toRound(supportStats?.avg_first_response_minutes);
        const broadcastProblemsCount = toNumber(broadcastProblemsToday?.c);
        const outboxFailed = toNumber(outboxState?.failed);
        const outboxRetrying = toNumber(outboxState?.retrying);
        const sleepingClientsCount = toNumber(inactiveClients?.c);

        const repeatTrend = toPct(pct(todayMetrics.repeatOrdersCount, weekAgoSameDayMetrics.repeatOrdersCount));
        const attention = [
            {
                id: 'orders_unpaid',
                title: 'Неоплаченные заказы замораживают выручку',
                summary: `${unpaidCount} заказов ждут оплату. Это ${formatKopecksRu(unpaidAmountK)} потенциальной выручки.`,
                impactLabel: `${formatKopecksRu(unpaidAmountK)} под риском`,
                priority: unpaidAmountK >= rubThresholdToKopecks(15000) ? 'critical' : (unpaidAmountK > 0 ? 'important' : 'watch'),
                ctaLabel: 'Проверить заказы',
                action: { screen: 'orders', filters: { orderFilter: 'unpaid' } }
            },
            {
                id: 'support_waiting',
                title: 'Клиенты ждут ответа дольше обычного',
                summary: `${waitingSupportCount} открытых диалогов: последнее сообщение от клиента, ждём ответа сотрудника.`,
                impactLabel: `${waitingSupportCount} клиентов в ожидании`,
                priority: waitingSupportCount >= 3 ? 'critical' : (waitingSupportCount > 0 ? 'important' : 'watch'),
                ctaLabel: 'Открыть поддержку',
                action: { screen: 'support', filters: { supportFilter: 'waiting' } }
            },
            {
                id: 'broadcast_failures',
                title: 'Часть рассылок теряет охват',
                summary: `${broadcastProblemsCount} клиентов не получили сообщения сегодня.`,
                impactLabel: `${broadcastProblemsCount} недоставок`,
                priority: broadcastProblemsCount >= 10 ? 'important' : (broadcastProblemsCount > 0 ? 'watch' : 'watch'),
                ctaLabel: 'Проверить рассылки',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'RUNNING' } }
            },
            {
                id: 'repeat_drop',
                title: 'Повторные продажи требуют внимания',
                summary: `Динамика повторов: ${repeatTrend > 0 ? '+' : ''}${repeatTrend}% к прошлой неделе.`,
                impactLabel: `${todayMetrics.repeatOrdersCount} повторных заказов`,
                priority: repeatTrend < -15 ? 'important' : 'watch',
                ctaLabel: 'Посмотреть клиентов',
                action: { screen: 'clients', filters: { clientFilter: 'sleeping' } }
            }
        ];

        const losses = [
            {
                id: 'unpaid_revenue',
                title: 'Незавершенные оплаты',
                amount: unpaidAmountK,
                count: unpaidCount,
                money_minor: true,
                message: 'Заказы уже оформлены, но деньги еще не получены.',
                action: { screen: 'orders', filters: { orderFilter: 'unpaid' } }
            },
            {
                id: 'broadcast_reach',
                title: 'Недоохват рассылок',
                amount: broadcastProblemsCount,
                count: broadcastProblemsCount,
                unit: 'клиентов',
                message: 'Часть аудитории не получила кампанию.',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'RUNNING' } }
            },
            {
                id: 'support_wait',
                title: 'Риск потери клиента в поддержке',
                amount: waitingSupportCount,
                count: waitingSupportCount,
                unit: 'обращений',
                message: 'Клиенты ждут ответ, пока решение не двигается.',
                action: { screen: 'support', filters: { supportFilter: 'waiting' } }
            }
        ];

        const growthPoints = [
            {
                id: 'repeat_growth',
                title: 'Повторные продажи',
                valueLabel: `${todayMetrics.repeatOrdersCount} заказов`,
                summary: repeatTrend >= 0
                    ? `Рост ${repeatTrend}% к прошлой неделе. Удержание работает.`
                    : `${Math.abs(repeatTrend)}% ниже прошлой недели. Есть потенциал реактивации.`,
                actionLabel: 'Открыть клиентов',
                action: { screen: 'clients', filters: { clientFilter: 'sleeping' } }
            },
            {
                id: 'sleeping_clients',
                title: 'Спящие клиенты',
                valueLabel: `${sleepingClientsCount} клиентов`,
                summary: 'Клиенты без заказов 30 дней. Хорошая база для реактивации.',
                actionLabel: 'Показать клиентов',
                action: { screen: 'clients', filters: { clientFilter: 'sleeping' } }
            },
            {
                id: 'campaign_quality',
                title: 'Качество последней рассылки',
                valueLabel: latestTotal > 0 ? `${toRound(100 - latestErrorRate)}% доставок` : 'Недостаточно данных',
                summary: latestTotal > 0
                    ? `Ошибка доставки ${toPct(latestErrorRate)}% (в среднем ${toPct(recentCampaignRate)}%).`
                    : 'Запустите кампанию, чтобы оценить качество доставки.',
                actionLabel: 'Открыть рассылки',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: '' } }
            }
        ];

        const comparison = {
            toYesterday: {
                revenueDeltaPct: toPct(pct(todayMetrics.revenue, yesterdayMetrics.revenue)),
                ordersDeltaPct: toPct(pct(todayMetrics.ordersCount, yesterdayMetrics.ordersCount)),
                avgCheckDeltaPct: toPct(pct(todayMetrics.avgCheck, yesterdayMetrics.avgCheck)),
                paidOrdersDeltaPct: toPct(pct(todayMetrics.paidOrdersCount, yesterdayMetrics.paidOrdersCount))
            },
            to7dAverage: {
                revenueDeltaPct: toPct(pct(todayMetrics.revenue, sevenDayAvgMetrics.revenue)),
                ordersDeltaPct: toPct(pct(todayMetrics.ordersCount, sevenDayAvgMetrics.orders)),
                avgCheckDeltaPct: toPct(pct(todayMetrics.avgCheck, sevenDayAvgMetrics.avgCheck)),
                repeatDeltaPct: toPct(pct(todayMetrics.repeatOrdersCount, sevenDayAvgMetrics.repeatOrders))
            },
            toSameWeekday: {
                revenueDeltaPct: toPct(pct(todayMetrics.revenue, weekAgoSameDayMetrics.revenue)),
                ordersDeltaPct: toPct(pct(todayMetrics.ordersCount, weekAgoSameDayMetrics.ordersCount)),
                avgCheckDeltaPct: toPct(pct(todayMetrics.avgCheck, weekAgoSameDayMetrics.avgCheck)),
                repeatDeltaPct: toPct(pct(todayMetrics.repeatOrdersCount, weekAgoSameDayMetrics.repeatOrdersCount))
            }
        };

        let insight = {
            title: 'День идет ровно',
            message: 'Ключевые метрики в рабочем диапазоне. Сфокусируйтесь на повторных продажах и скорости ответа.',
            tone: 'info',
            ruleId: 'stable_day'
        };
        if (unpaidAmountK >= rubThresholdToKopecks(15000)) {
            insight = {
                title: 'Сначала верните деньги в кассу',
                message: `Неоплаченные заказы уже заморозили ${formatKopecksRu(unpaidAmountK)}. Проверка оплат даст быстрый эффект сегодня.`,
                tone: 'alert',
                ruleId: 'unpaid_high'
            };
        } else if (waitingSupportCount >= 3) {
            insight = {
                title: 'Риск потери клиентов в поддержке',
                message: `${waitingSupportCount} обращений без ответа. Быстрые ответы сейчас важнее новых задач.`,
                tone: 'warn',
                ruleId: 'support_waiting'
            };
        } else if (comparison.toYesterday.revenueDeltaPct >= 15) {
            insight = {
                title: 'Выручка заметно выше вчера',
                message: `Рост ${comparison.toYesterday.revenueDeltaPct}%. Зафиксируйте, какие действия дали этот результат.`,
                tone: 'ok',
                ruleId: 'revenue_growth'
            };
        } else if (comparison.toYesterday.avgCheckDeltaPct < -10 && comparison.toYesterday.ordersDeltaPct > 10) {
            insight = {
                title: 'Заказов больше, но чек просел',
                message: 'Объем компенсирует снижение среднего чека. Можно усилить апселл в текущих заказах.',
                tone: 'warn',
                ruleId: 'avg_check_drop_compensated'
            };
        } else if (latestTotal > 0 && latestErrorRate < recentCampaignRate * 0.75) {
            insight = {
                title: 'Последняя рассылка сработала лучше обычного',
                message: `Ошибка доставки ${toPct(latestErrorRate)}% против среднего ${toPct(recentCampaignRate)}%.`,
                tone: 'ok',
                ruleId: 'campaign_quality_up'
            };
        }

        return {
            generatedAt: nowIso,
            money: {
                revenueToday: toRound(todayMetrics.revenue),
                revenue7d: toRound(sevenDayMetrics.revenue),
                revenue30d: toRound(thirtyDayMetrics.revenue)
            },
            orders: {
                totalToday: todayMetrics.ordersCount,
                paidToday: todayMetrics.paidOrdersCount,
                unpaidToday: todayMetrics.unpaidOrdersCount,
                conversionTodayPct: toPct(todayMetrics.conversionPct)
            },
            support: {
                activeThreads: activeSupportCount,
                waitingWithoutResponse: waitingSupportCount,
                avgFirstResponseMinutes7d: avgFirstResponseMinutes
            },
            broadcasts: {
                latestCampaign: latestCampaign ? {
                    id: latestCampaignId,
                    status: String(latestCampaign.status || ''),
                    delivered: latestDelivered,
                    failed: latestFailed,
                    blocked: latestBlocked,
                    total: latestTotal,
                    errorRatePct: toPct(latestErrorRate)
                } : null
            },
            hero: {
                revenueToday: toRound(todayMetrics.revenue),
                paidOrdersToday: todayMetrics.paidOrdersCount,
                totalOrdersToday: todayMetrics.ordersCount,
                avgCheckToday: toRound(todayMetrics.avgCheck),
                paymentConversionTodayPct: toPct(todayMetrics.conversionPct),
                repeatOrdersToday: todayMetrics.repeatOrdersCount,
                repeatClientsToday: todayMetrics.repeatClientsCount,
                quickSense: todayMetrics.revenue >= yesterdayMetrics.revenue
                    ? 'День идет лучше вчера'
                    : 'Темп ниже вчера, нужен фокус на проблемных зонах'
            },
            comparison,
            attention,
            losses: {
                totalFrozenRevenue: unpaidAmountK,
                items: losses
            },
            growthPoints,
            quickActions: [
                { id: 'open_actions', label: 'Центр действий', action: { screen: 'actions', filters: {} } },
                { id: 'open_orders', label: 'Открыть заказы', action: { screen: 'orders', filters: { orderFilter: 'today' } } },
                { id: 'open_clients', label: 'Открыть клиентов', action: { screen: 'clients', filters: { clientFilter: 'all' } } },
                { id: 'open_clients_sleeping', label: 'Спящие клиенты', action: { screen: 'clients', filters: { clientFilter: 'sleeping' } } },
                { id: 'open_clients_vip', label: 'VIP клиенты', action: { screen: 'clients', filters: { clientFilter: 'vip' } } },
                { id: 'open_clients_repeat', label: 'Повторные клиенты', action: { screen: 'clients', filters: { clientFilter: 'repeat' } } },
                { id: 'open_clients_high_value', label: 'Высокий чек', action: { screen: 'clients', filters: { clientFilter: 'high-value' } } },
                { id: 'open_clients_attention', label: 'Требуют внимания', action: { screen: 'clients', filters: { clientFilter: 'attention' } } },
                { id: 'open_clients_recent', label: 'Недавно активные', action: { screen: 'clients', filters: { clientFilter: 'recent' } } },
                { id: 'open_broadcasts', label: 'Открыть рассылки', action: { screen: 'broadcasts', filters: { broadcastsFilter: '' } } },
                { id: 'open_support', label: 'Открыть поддержку', action: { screen: 'support', filters: { supportFilter: 'waiting' } } },
                { id: 'open_analytics', label: 'Посмотреть аналитику', action: { screen: 'analytics', filters: {} } }
            ],
            insight,
            charts: {
                revenue7d: chart7d.map((row) => ({ day: row.day, value: row.revenue })),
                orders7d: chart7d.map((row) => ({ day: row.day, value: row.orders })),
                avgCheck7d: chart7d.map((row) => ({ day: row.day, value: row.avgCheck }))
            }
        };
    }

    async function getAnalyticsSummary({ period = '7d' } = {}) {
        const periodMap = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
        const days = periodMap[String(period || '').toLowerCase()] || 7;
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const currentStart = new Date(todayStart.getTime() - ((days - 1) * 24 * 60 * 60 * 1000));
        const prevStart = new Date(currentStart.getTime() - (days * 24 * 60 * 60 * 1000));
        const prevEnd = new Date(currentStart.getTime());
        const nowIso = now.toISOString();
        const currentStartIso = currentStart.toISOString();
        const prevStartIso = prevStart.toISOString();
        const prevEndIso = prevEnd.toISOString();

        const [ordersRows, supportRows, broadcastsRows, clientsRows] = await Promise.all([
            all(
                `
                SELECT id, telegram_id, total, total_paid, status, created_at
                FROM orders
                WHERE created_at >= ? AND created_at <= ?
                ORDER BY created_at ASC
                `,
                [prevStartIso, nowIso]
            ),
            all(
                `
                SELECT id, telegram_user_id, status, created_at, updated_at, first_response_at,
                       COALESCE(waiting_for_staff, 0) AS waiting_for_staff,
                       last_message_direction
                FROM support_threads
                WHERE COALESCE(updated_at, created_at, '') >= ?
                `,
                [prevStartIso]
            ),
            all(
                `
                SELECT bc.id, bc.status, bc.created_at,
                       COALESCE(stats.delivered_count, 0) AS delivered_count,
                       COALESCE(stats.failed_count, 0) AS failed_count,
                       COALESCE(stats.blocked_count, 0) AS blocked_count,
                       COALESCE(stats.total_recipients, 0) AS total_recipients
                FROM broadcast_campaigns bc
                LEFT JOIN (
                    SELECT bd.campaign_id,
                           SUM(CASE WHEN bd.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered_count,
                           SUM(CASE WHEN bd.status IN ('FAILED','FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed_count,
                           SUM(CASE WHEN bd.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count,
                           COUNT(*) AS total_recipients
                    FROM broadcast_deliveries bd
                    GROUP BY bd.campaign_id
                ) stats ON stats.campaign_id = bc.id
                WHERE bc.created_at >= ? AND bc.created_at <= ?
                ORDER BY bc.created_at ASC
                `,
                [prevStartIso, nowIso]
            ),
            all(
                `
                SELECT u.telegram_id,
                       COALESCE(oc.total_orders, 0) AS total_orders,
                       COALESCE(oc.total_revenue, 0) AS total_revenue,
                       oc.last_order_at
                FROM users u
                LEFT JOIN (
                    SELECT o.telegram_id,
                           COUNT(*) AS total_orders,
                           MAX(o.created_at) AS last_order_at,
                           COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_O})), 0) AS total_revenue
                    FROM orders o
                    GROUP BY o.telegram_id
                ) oc ON oc.telegram_id = u.telegram_id
                `
            )
        ]);

        const toTs = (v) => {
            const ts = Date.parse(String(v || ''));
            return Number.isFinite(ts) ? ts : 0;
        };
        const inRange = (value, start, end) => {
            const ts = toTs(value);
            return ts >= start.getTime() && ts < end.getTime();
        };
        const orderRevenue = (row) => orderPaidRevenueKopecksFromRow(row);
        const pct = (current, previous) => {
            const c = toNumber(current);
            const p = toNumber(previous);
            if (p === 0 && c === 0) return 0;
            if (p === 0) return 100;
            return ((c - p) / p) * 100;
        };
        const deltaPack = (current, previous, interpretationPositive = true) => {
            const amount = Math.round(toNumber(current) - toNumber(previous));
            const percent = Math.round(pct(current, previous) * 10) / 10;
            const isUp = amount >= 0;
            let interpretation = 'Без заметных изменений';
            if (amount !== 0) {
                if (interpretationPositive) interpretation = isUp ? 'Позитивный сдвиг' : 'Негативный сдвиг';
                else interpretation = isUp ? 'Риск роста показателя' : 'Позитивное снижение риска';
            }
            return { current: Math.round(toNumber(current)), previous: Math.round(toNumber(previous)), delta: amount, deltaPct: percent, interpretation };
        };

        const currentOrders = ordersRows.filter((row) => inRange(row.created_at, currentStart, now));
        const prevOrders = ordersRows.filter((row) => inRange(row.created_at, prevStart, prevEnd));
        const calcRepeatOrdersInRange = (start, end) => {
            const seen = new Map();
            const ordered = [...ordersRows].sort((a, b) => toTs(a.created_at) - toTs(b.created_at));
            let repeat = 0;
            for (const row of ordered) {
                const id = String(row.telegram_id || '');
                const hadBefore = (seen.get(id) || 0) > 0;
                if (inRange(row.created_at, start, end) && hadBefore) repeat += 1;
                seen.set(id, (seen.get(id) || 0) + 1);
            }
            return repeat;
        };
        const repeatCurrent = calcRepeatOrdersInRange(currentStart, now);
        const repeatPrev = calcRepeatOrdersInRange(prevStart, prevEnd);
        const summarizeOrders = (rows) => {
            const paidRows = rows.filter((row) => orderRevenue(row) > 0);
            const revenue = paidRows.reduce((acc, row) => acc + orderRevenue(row), 0);
            const unpaidRows = rows.filter((row) => orderRevenue(row) <= 0);
            const uniqueClients = new Set(rows.map((row) => String(row.telegram_id || ''))).size;
            return {
                orders: rows.length,
                paid: paidRows.length,
                unpaid: unpaidRows.length,
                revenue: Math.round(revenue),
                avgCheck: paidRows.length ? Math.round(revenue / paidRows.length) : 0,
                conversionPct: rows.length ? Math.round(((paidRows.length / rows.length) * 100) * 10) / 10 : 0,
                repeatOrders: 0,
                uniqueClients
            };
        };
        const orderCurrent = summarizeOrders(currentOrders);
        const orderPrev = summarizeOrders(prevOrders);
        orderCurrent.repeatOrders = repeatCurrent;
        orderPrev.repeatOrders = repeatPrev;

        const currentSupport = supportRows.filter((row) => inRange(row.updated_at || row.created_at, currentStart, now));
        const prevSupport = supportRows.filter((row) => inRange(row.updated_at || row.created_at, prevStart, prevEnd));
        const summarizeSupport = (rows) => {
            const active = rows.filter((row) => ['OPEN', 'PENDING'].includes(String(row.status || '').toUpperCase())).length;
            const waiting = rows.filter(
                (row) =>
                    ['OPEN', 'PENDING'].includes(String(row.status || '').toUpperCase()) &&
                    Number(row.waiting_for_staff || 0) === 1
            ).length;
            const avgFirstResponse = (() => {
                const values = rows
                    .map((row) => {
                        if (!row.first_response_at || !row.created_at) return null;
                        const mins = (toTs(row.first_response_at) - toTs(row.created_at)) / (60 * 1000);
                        return Number.isFinite(mins) && mins >= 0 ? mins : null;
                    })
                    .filter((x) => x !== null);
                if (!values.length) return 0;
                return Math.round(values.reduce((acc, x) => acc + x, 0) / values.length);
            })();
            return { active, waiting, avgFirstResponse };
        };
        const supportCurrent = summarizeSupport(currentSupport);
        const supportPrev = summarizeSupport(prevSupport);

        const currentBroadcasts = broadcastsRows.filter((row) => inRange(row.created_at, currentStart, now)).map((row) => enrichBroadcastCampaign(row));
        const prevBroadcasts = broadcastsRows.filter((row) => inRange(row.created_at, prevStart, prevEnd)).map((row) => enrichBroadcastCampaign(row));
        const summarizeBroadcasts = (rows) => ({
            campaigns: rows.length,
            delivered: rows.reduce((acc, row) => acc + toNumber(row.delivered_count), 0),
            failed: rows.reduce((acc, row) => acc + toNumber(row.failed_count), 0),
            blocked: rows.reduce((acc, row) => acc + toNumber(row.blocked_count), 0),
            lostReach: rows.reduce((acc, row) => acc + toNumber(row.lost_reach_count), 0),
            successful: rows.filter((row) => row.campaign_tier === 'successful').length,
            problematic: rows.filter((row) => row.is_problematic).length,
            repeatable: rows.filter((row) => row.is_repeatable_candidate).length
        });
        const broadcastCurrent = summarizeBroadcasts(currentBroadcasts);
        const broadcastPrev = summarizeBroadcasts(prevBroadcasts);

        const enrichedClients = clientsRows.map((row) => enrichClientRow({
            telegram_id: row.telegram_id,
            total_orders: row.total_orders,
            total_revenue: row.total_revenue,
            last_order_at: row.last_order_at,
            support_open_threads: 0,
            support_total_threads: 0,
            recent_broadcast_count: 0
        }));
        const clientStats = {
            total: enrichedClients.length,
            newClients: enrichedClients.filter((row) => row.is_new_client).length,
            repeatClients: enrichedClients.filter((row) => row.is_repeat_client).length,
            vipClients: enrichedClients.filter((row) => row.is_vip_client).length,
            highValueClients: enrichedClients.filter((row) => row.is_high_value_client).length,
            sleepingClients: enrichedClients.filter((row) => row.is_sleeping_client).length
        };

        const chartMap = new Map();
        for (let i = days - 1; i >= 0; i -= 1) {
            const day = new Date(todayStart.getTime() - (i * 24 * 60 * 60 * 1000));
            const key = day.toISOString().slice(0, 10);
            chartMap.set(key, { day: key, revenue: 0, orders: 0, paid: 0 });
        }
        for (const row of currentOrders) {
            const key = String(row.created_at || '').slice(0, 10);
            if (!chartMap.has(key)) continue;
            const current = chartMap.get(key);
            current.orders += 1;
            const rev = orderRevenue(row);
            if (rev > 0) {
                current.revenue += rev;
                current.paid += 1;
            }
        }
        const chartRows = Array.from(chartMap.values()).map((row) => ({
            day: row.day,
            revenue: Math.round(row.revenue),
            orders: row.orders,
            avgCheck: row.paid > 0 ? Math.round(row.revenue / row.paid) : 0
        }));

        const comparisons = {
            revenue: deltaPack(orderCurrent.revenue, orderPrev.revenue, true),
            orders: deltaPack(orderCurrent.orders, orderPrev.orders, true),
            avgCheck: deltaPack(orderCurrent.avgCheck, orderPrev.avgCheck, true),
            repeatOrders: deltaPack(orderCurrent.repeatOrders, orderPrev.repeatOrders, true),
            lostReach: deltaPack(broadcastCurrent.lostReach, broadcastPrev.lostReach, false),
            supportWaiting: deltaPack(supportCurrent.waiting, supportPrev.waiting, false)
        };

        const growthSignals = [];
        const riskSignals = [];
        if (comparisons.revenue.delta > 0) growthSignals.push({ title: 'Выручка растет', valueLabel: `${comparisons.revenue.delta > 0 ? '+' : ''}${comparisons.revenue.deltaPct}%`, action: { screen: 'orders', filters: { orderFilter: 'paid' } } });
        if (comparisons.repeatOrders.delta > 0) growthSignals.push({ title: 'Повторные продажи усилились', valueLabel: `${comparisons.repeatOrders.delta > 0 ? '+' : ''}${comparisons.repeatOrders.deltaPct}%`, action: { screen: 'clients', filters: { clientFilter: 'repeat' } } });
        if (broadcastCurrent.repeatable > 0) growthSignals.push({ title: 'Есть кампании для повтора', valueLabel: `${broadcastCurrent.repeatable} кампаний`, action: { screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' } } });
        if (clientStats.highValueClients > 0) growthSignals.push({ title: 'Сильный high-value сегмент', valueLabel: `${clientStats.highValueClients} клиентов`, action: { screen: 'clients', filters: { clientFilter: 'high-value' } } });

        if (comparisons.revenue.delta < 0) riskSignals.push({ title: 'Просадка выручки', valueLabel: `${comparisons.revenue.deltaPct}%`, action: { screen: 'orders', filters: { orderFilter: 'problematic' } } });
        if (comparisons.avgCheck.delta < 0) riskSignals.push({ title: 'Средний чек просел', valueLabel: `${comparisons.avgCheck.deltaPct}%`, action: { screen: 'orders', filters: { orderFilter: 'large' } } });
        if (orderCurrent.unpaid > 0) riskSignals.push({ title: 'Неоплаченные заказы замораживают деньги', valueLabel: `${orderCurrent.unpaid} заказов`, action: { screen: 'orders', filters: { orderFilter: 'unpaid' } } });
        if (broadcastCurrent.problematic > 0 || comparisons.lostReach.delta > 0) riskSignals.push({ title: 'Рассылки теряют охват', valueLabel: `${broadcastCurrent.lostReach} потерянных`, action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' } } });
        if (supportCurrent.waiting > 0) riskSignals.push({ title: 'Поддержка отвечает медленнее', valueLabel: `${supportCurrent.waiting} в ожидании`, action: { screen: 'support', filters: { supportFilter: 'waiting' } } });

        const insights = [];
        if (comparisons.revenue.delta > 0 && comparisons.orders.delta <= 0) {
            insights.push({
                tone: 'ok',
                title: 'Выручка растет быстрее числа заказов',
                message: 'Средний чек усилился: бизнес зарабатывает больше с одного заказа.',
                priority: 'important',
                action: { screen: 'orders', filters: { orderFilter: 'large' } }
            });
        }
        if (comparisons.orders.delta > 0 && comparisons.avgCheck.delta < 0) {
            insights.push({
                tone: 'warn',
                title: 'Заказов больше, но средний чек ниже',
                message: 'Есть рост объема, но маржинальность может проседать.',
                priority: 'important',
                action: { screen: 'orders', filters: { orderFilter: 'today' } }
            });
        }
        if (comparisons.repeatOrders.delta > 0) {
            insights.push({
                tone: 'ok',
                title: 'Повторные продажи дают рост',
                message: 'Retention-сегмент усиливает выручку периода.',
                priority: 'normal',
                action: { screen: 'clients', filters: { clientFilter: 'repeat' } }
            });
        }
        if (comparisons.lostReach.delta > 0) {
            insights.push({
                tone: 'alert',
                title: 'Охват рассылок ухудшился',
                message: 'Потерянный охват растет, стоит пересмотреть качество сегментов и доставку.',
                priority: 'critical',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' } }
            });
        }
        if (comparisons.supportWaiting.delta > 0) {
            insights.push({
                tone: 'warn',
                title: 'Сервисное давление в поддержке растет',
                message: 'Клиентов в ожидании ответа стало больше обычного.',
                priority: 'important',
                action: { screen: 'support', filters: { supportFilter: 'waiting' } }
            });
        }
        if (!insights.length) {
            insights.push({
                tone: 'info',
                title: 'Период без резких отклонений',
                message: 'Метрики в нейтральной зоне. Можно сфокусироваться на усилении повторных продаж.',
                priority: 'normal',
                action: { screen: 'clients', filters: { clientFilter: 'repeat' } }
            });
        }

        return {
            generatedAt: nowIso,
            period: { key: days === 1 ? 'today' : `${days}d`, days, from: currentStartIso, to: nowIso },
            totals: {
                revenue: orderCurrent.revenue,
                orders: orderCurrent.orders,
                avgCheck: orderCurrent.avgCheck,
                repeatOrders: orderCurrent.repeatOrders,
                paidOrders: orderCurrent.paid,
                unpaidOrders: orderCurrent.unpaid,
                conversionPct: orderCurrent.conversionPct,
                uniqueClients: orderCurrent.uniqueClients
            },
            sections: {
                money: {
                    revenue: orderCurrent.revenue,
                    revenuePrev: orderPrev.revenue,
                    trend: chartRows.map((x) => ({ day: x.day, value: x.revenue }))
                },
                orders: {
                    total: orderCurrent.orders,
                    paid: orderCurrent.paid,
                    unpaid: orderCurrent.unpaid,
                    conversionPct: orderCurrent.conversionPct
                },
                clients: {
                    new: clientStats.newClients,
                    repeat: clientStats.repeatClients,
                    vip: clientStats.vipClients,
                    highValue: clientStats.highValueClients,
                    sleeping: clientStats.sleepingClients,
                    repeatSharePct: orderCurrent.orders ? Math.round((orderCurrent.repeatOrders / orderCurrent.orders) * 1000) / 10 : 0
                },
                broadcasts: broadcastCurrent,
                support: supportCurrent
            },
            comparisons,
            charts: {
                revenueByDay: chartRows.map((x) => ({ day: x.day, value: x.revenue })),
                ordersByDay: chartRows.map((x) => ({ day: x.day, value: x.orders })),
                avgCheckByDay: chartRows.map((x) => ({ day: x.day, value: x.avgCheck }))
            },
            growthSignals: growthSignals.slice(0, 4),
            riskSignals: riskSignals.slice(0, 5),
            insights: insights.slice(0, 6),
            actionTargets: {
                unpaidOrders: { screen: 'orders', filters: { orderFilter: 'unpaid' } },
                sleepingClients: { screen: 'clients', filters: { clientFilter: 'sleeping' } },
                problematicBroadcasts: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' } },
                waitingSupport: { screen: 'support', filters: { supportFilter: 'waiting' } }
            }
        };
    }

    async function getActionsSummary() {
        const [ordersSummary, clientsSummary, broadcastsSummary, supportSummary, analyticsSummary] = await Promise.all([
            getOrdersSummary(),
            getClientsSummary(),
            getBroadcastsSummary(),
            getSupportSummary(),
            getAnalyticsSummary({ period: '7d' })
        ]);

        const nowIso = new Date().toISOString();
        const actions = [];
        const quickWins = [];

        const addAction = ({
            id,
            category,
            priority,
            title,
            message,
            businessImpactLabel,
            impactValue = null,
            ctaLabel,
            targetScreen,
            targetFilters = {},
            sourceSignal,
            freshness = 'fresh',
            expiresAt = null
        }) => {
            actions.push({
                id,
                category,
                priority,
                title,
                message,
                business_impact_label: businessImpactLabel,
                impact_value: impactValue,
                cta_label: ctaLabel,
                target_screen: targetScreen,
                target_filters: targetFilters,
                source_signal: sourceSignal,
                freshness,
                expires_at: expiresAt
            });
        };
        const addQuickWin = ({ id, title, message, ctaLabel, targetScreen, targetFilters = {}, sourceSignal }) => {
            quickWins.push({
                id,
                title,
                message,
                cta_label: ctaLabel,
                target_screen: targetScreen,
                target_filters: targetFilters,
                source_signal: sourceSignal
            });
        };

        const orderTotals = ordersSummary.totals || {};
        const frozenRevenue = Number(ordersSummary.frozenRevenue || 0);
        const highValueUnpaid = Number((ordersSummary.orderSignals && ordersSummary.orderSignals.highValueUnpaid) || 0);
        const clientTotals = clientsSummary.totals || {};
        const clientSegments = clientsSummary.segments || {};
        const supportTotals = supportSummary.totals || {};
        const supportLossRisk = supportSummary.lossRisk || {};
        const broadcastTotals = broadcastsSummary.totals || {};
        const broadcastSegments = broadcastsSummary.segments || {};
        const broadcastLostReach = broadcastsSummary.lostReach || {};
        const analyticsComparisons = analyticsSummary.comparisons || {};
        const analyticsSections = analyticsSummary.sections || {};

        if (frozenRevenue >= rubThresholdToKopecks(5000)) {
            addAction({
                id: 'unpaid_revenue_recovery',
                category: 'revenue',
                priority: frozenRevenue >= rubThresholdToKopecks(15000) ? 'critical' : 'high',
                title: 'Верните замороженную выручку',
                message: `Неоплаченные заказы заморозили ${formatKopecksRu(frozenRevenue)}. Без реакции деньги останутся в риске.`,
                businessImpactLabel: 'Деньги под риском',
                impactValue: kopecksToWholeRub(frozenRevenue),
                ctaLabel: 'Открыть неоплаченные',
                targetScreen: 'orders',
                targetFilters: { orderFilter: 'unpaid' },
                sourceSignal: 'orders.unpaid_frozen_revenue'
            });
        }

        if (highValueUnpaid > 0) {
            addAction({
                id: 'unpaid_large_checks',
                category: 'revenue',
                priority: highValueUnpaid >= 2 ? 'high' : 'medium',
                title: 'Под риском крупные чеки',
                message: `${highValueUnpaid} крупных заказа без оплаты. Это риск потери высокой маржи.`,
                businessImpactLabel: 'Крупные заказы в риске',
                impactValue: highValueUnpaid,
                ctaLabel: 'Открыть крупные',
                targetScreen: 'orders',
                targetFilters: { orderFilter: 'large' },
                sourceSignal: 'orders.high_value_unpaid'
            });
        }

        if (Number(clientSegments.vipSleeping || 0) > 0) {
            addAction({
                id: 'vip_sleeping_return',
                category: 'retention',
                priority: 'critical',
                title: 'Верните VIP-клиентов',
                message: `${clientSegments.vipSleeping} VIP-клиентов давно не покупали. Потеря этого сегмента бьет по выручке.`,
                businessImpactLabel: 'Риск потери VIP LTV',
                impactValue: Number(clientSegments.vipSleeping || 0),
                ctaLabel: 'Открыть VIP',
                targetScreen: 'clients',
                targetFilters: { clientFilter: 'vip' },
                sourceSignal: 'clients.vip_sleeping'
            });
        }

        if (Number(clientSegments.newWithoutRepeat || 0) > 0) {
            addAction({
                id: 'new_without_repeat_convert',
                category: 'growth',
                priority: Number(clientSegments.newWithoutRepeat || 0) >= 5 ? 'high' : 'medium',
                title: 'Доведите новых до повторной покупки',
                message: `${clientSegments.newWithoutRepeat} новых клиентов без второго заказа. Сейчас решается будущая возвращаемость.`,
                businessImpactLabel: 'Рост повторных продаж',
                impactValue: Number(clientSegments.newWithoutRepeat || 0),
                ctaLabel: 'Открыть новых',
                targetScreen: 'clients',
                targetFilters: { clientFilter: 'new' },
                sourceSignal: 'clients.new_without_repeat'
            });
        }

        if (Number(clientTotals.returnable || 0) > 0) {
            addAction({
                id: 'return_candidates_focus',
                category: 'retention',
                priority: Number(clientTotals.returnable || 0) >= 8 ? 'high' : 'medium',
                title: 'Есть клиенты для реактивации',
                message: `${clientTotals.returnable} клиентов попадают в сегмент реактивации. Это быстрая точка восстановления выручки.`,
                businessImpactLabel: 'Потенциал реактивации',
                impactValue: Number(clientTotals.returnable || 0),
                ctaLabel: 'Открыть сегмент',
                targetScreen: 'clients',
                targetFilters: { clientFilter: 'return' },
                sourceSignal: 'clients.returnable'
            });
        }

        if (Number(supportTotals.waiting || 0) > 0) {
            addAction({
                id: 'support_waiting_clients',
                category: 'support',
                priority: Number(supportTotals.waiting || 0) >= 4 ? 'high' : 'medium',
                title: 'Клиенты ждут ответа поддержки',
                message: `${supportTotals.waiting} диалогов ждут реакции. Без ответа растет риск потери доверия и повторных заказов.`,
                businessImpactLabel: 'Риск оттока через сервис',
                impactValue: Number(supportTotals.waiting || 0),
                ctaLabel: 'Открыть ожидание',
                targetScreen: 'support',
                targetFilters: { supportFilter: 'waiting' },
                sourceSignal: 'support.waiting'
            });
        }

        if (Number(supportTotals.critical || 0) > 0) {
            addAction({
                id: 'support_critical_dialogs',
                category: 'support',
                priority: 'critical',
                title: 'Сначала разберите критичные обращения',
                message: `${supportTotals.critical} диалогов имеют критичный приоритет. Здесь нельзя откладывать реакцию.`,
                businessImpactLabel: 'Срочный сервисный риск',
                impactValue: Number(supportTotals.critical || 0),
                ctaLabel: 'Открыть критичные',
                targetScreen: 'support',
                targetFilters: { supportFilter: 'critical' },
                sourceSignal: 'support.critical'
            });
        }

        if (Number(supportLossRisk.vipWaiting || 0) > 0) {
            addAction({
                id: 'support_vip_waiting',
                category: 'retention',
                priority: 'critical',
                title: 'VIP-клиенты ждут ответа',
                message: `${supportLossRisk.vipWaiting} VIP-клиентов в поддержке без реакции. Это прямой риск потери ценных клиентов.`,
                businessImpactLabel: 'VIP-risk в сервисе',
                impactValue: Number(supportLossRisk.vipWaiting || 0),
                ctaLabel: 'Открыть VIP-диалоги',
                targetScreen: 'support',
                targetFilters: { supportFilter: 'vip' },
                sourceSignal: 'support.vip_waiting'
            });
        }

        if (Number(supportLossRisk.newWaiting || 0) > 0) {
            addAction({
                id: 'support_new_waiting',
                category: 'retention',
                priority: Number(supportLossRisk.newWaiting || 0) >= 3 ? 'high' : 'medium',
                title: 'Новые клиенты без быстрой реакции',
                message: `${supportLossRisk.newWaiting} новых клиентов ждут ответа. Первый сервисный опыт критичен для удержания.`,
                businessImpactLabel: 'Риск потери новых',
                impactValue: Number(supportLossRisk.newWaiting || 0),
                ctaLabel: 'Открыть новых',
                targetScreen: 'support',
                targetFilters: { supportFilter: 'new' },
                sourceSignal: 'support.new_waiting'
            });
        }

        if (Number(broadcastTotals.problematicCampaigns || 0) > 0) {
            addAction({
                id: 'problematic_broadcasts',
                category: 'marketing',
                priority: Number(broadcastTotals.problematicCampaigns || 0) >= 3 ? 'high' : 'medium',
                title: 'Проверьте проблемные рассылки',
                message: `${broadcastTotals.problematicCampaigns} кампаний с проблемами доставки. Маркетинг теряет полезный охват.`,
                businessImpactLabel: 'Потеря эффективности канала',
                impactValue: Number(broadcastTotals.problematicCampaigns || 0),
                ctaLabel: 'Открыть кампании',
                targetScreen: 'broadcasts',
                targetFilters: { broadcastsFilter: 'problematic' },
                sourceSignal: 'broadcasts.problematic'
            });
        }

        if (Number(broadcastLostReach.totalLostReach || 0) > 0) {
            addAction({
                id: 'broadcast_lost_reach',
                category: 'marketing',
                priority: Number(broadcastLostReach.totalLostReach || 0) >= 20 ? 'high' : 'medium',
                title: 'Последняя рассылочная волна потеряла охват',
                message: `Недоохвачено ${broadcastLostReach.totalLostReach} получателей (блокировки: ${broadcastLostReach.blockedMessages}, ошибки: ${broadcastLostReach.failedMessages}).`,
                businessImpactLabel: 'Потерянный охват',
                impactValue: Number(broadcastLostReach.totalLostReach || 0),
                ctaLabel: 'Разобрать охват',
                targetScreen: 'broadcasts',
                targetFilters: { broadcastsFilter: 'failed' },
                sourceSignal: 'broadcasts.lost_reach'
            });
        }

        if (Number(broadcastSegments.repeatableCampaigns || 0) > 0) {
            addAction({
                id: 'repeatable_broadcasts',
                category: 'growth',
                priority: 'medium',
                title: 'Есть кампании, которые стоит повторить',
                message: `${broadcastSegments.repeatableCampaigns} кампаний с хорошим качеством доставки. Можно быстро усилить рост.`,
                businessImpactLabel: 'Быстрый рост через повтор',
                impactValue: Number(broadcastSegments.repeatableCampaigns || 0),
                ctaLabel: 'Открыть repeatable',
                targetScreen: 'broadcasts',
                targetFilters: { broadcastsFilter: 'repeatable' },
                sourceSignal: 'broadcasts.repeatable'
            });
        }

        if (Number((analyticsComparisons.avgCheck && analyticsComparisons.avgCheck.delta) || 0) < 0) {
            addAction({
                id: 'avg_check_drop',
                category: 'operations',
                priority: 'high',
                title: 'Средний чек просел',
                message: `Средний чек снизился на ${analyticsComparisons.avgCheck.deltaPct}%. Стоит проверить структуру текущих заказов.`,
                businessImpactLabel: 'Риск просадки маржи',
                impactValue: Number(analyticsComparisons.avgCheck.delta || 0),
                ctaLabel: 'Открыть заказы',
                targetScreen: 'orders',
                targetFilters: { orderFilter: 'today' },
                sourceSignal: 'analytics.avg_check_delta'
            });
        }

        if (Number((analyticsComparisons.supportWaiting && analyticsComparisons.supportWaiting.delta) || 0) > 0) {
            addAction({
                id: 'support_waiting_growth',
                category: 'support',
                priority: 'high',
                title: 'Поддержка отвечает медленнее прошлого периода',
                message: `Клиентов в ожидании стало больше на ${analyticsComparisons.supportWaiting.delta}. Нужна быстрая разгрузка очереди.`,
                businessImpactLabel: 'Сервисное давление',
                impactValue: Number(analyticsComparisons.supportWaiting.delta || 0),
                ctaLabel: 'Открыть поддержку',
                targetScreen: 'support',
                targetFilters: { supportFilter: 'waiting' },
                sourceSignal: 'analytics.support_waiting_delta'
            });
        }

        if (Number((analyticsComparisons.repeatOrders && analyticsComparisons.repeatOrders.delta) || 0) > 0) {
            addAction({
                id: 'repeat_sales_growth',
                category: 'growth',
                priority: 'medium',
                title: 'Повторные продажи усиливаются',
                message: `Повторные заказы выросли на ${analyticsComparisons.repeatOrders.deltaPct}%. Сегмент стоит масштабировать.`,
                businessImpactLabel: 'Рост через retention',
                impactValue: Number(analyticsComparisons.repeatOrders.delta || 0),
                ctaLabel: 'Открыть повторных клиентов',
                targetScreen: 'clients',
                targetFilters: { clientFilter: 'repeat' },
                sourceSignal: 'analytics.repeat_orders_delta'
            });
        }

        if (Number((analyticsComparisons.revenue && analyticsComparisons.revenue.delta) || 0) < 0) {
            addAction({
                id: 'revenue_drop_alert',
                category: 'revenue',
                priority: 'critical',
                title: 'Выручка ниже прошлого периода',
                message: `Выручка просела на ${analyticsComparisons.revenue.deltaPct}%. Нужен фокус на быстрых восстановительных действиях.`,
                businessImpactLabel: 'Просадка выручки',
                impactValue: Number(analyticsComparisons.revenue.delta || 0),
                ctaLabel: 'Открыть аналитику',
                targetScreen: 'analytics',
                targetFilters: { analyticsPeriod: '7d' },
                sourceSignal: 'analytics.revenue_delta'
            });
        }

        addQuickWin({
            id: 'quick_repeatable_campaigns',
            title: 'Повторить сильную кампанию',
            message: 'Откройте repeatable-рассылки и возьмите лучшую как основу.',
            ctaLabel: 'Открыть',
            targetScreen: 'broadcasts',
            targetFilters: { broadcastsFilter: 'repeatable' },
            sourceSignal: 'quick.broadcasts.repeatable'
        });
        addQuickWin({
            id: 'quick_sleeping_clients',
            title: 'Посмотреть спящих клиентов',
            message: 'Быстрый шанс поднять выручку через реактивацию клиентской базы.',
            ctaLabel: 'Открыть',
            targetScreen: 'clients',
            targetFilters: { clientFilter: 'sleeping' },
            sourceSignal: 'quick.clients.sleeping'
        });
        addQuickWin({
            id: 'quick_new_without_repeat',
            title: 'Новые без повтора',
            message: 'Укрепите retention у новых клиентов одним точным действием.',
            ctaLabel: 'Открыть',
            targetScreen: 'clients',
            targetFilters: { clientFilter: 'new' },
            sourceSignal: 'quick.clients.new'
        });
        addQuickWin({
            id: 'quick_large_orders',
            title: 'Крупные чеки сегодня',
            message: 'Проверьте high-check заказы и не дайте им зависнуть.',
            ctaLabel: 'Открыть',
            targetScreen: 'orders',
            targetFilters: { orderFilter: 'large' },
            sourceSignal: 'quick.orders.large'
        });
        addQuickWin({
            id: 'quick_support_waiting',
            title: 'Поддержка без ответа',
            message: 'Закройте самые уязвимые диалоги за пару быстрых шагов.',
            ctaLabel: 'Открыть',
            targetScreen: 'support',
            targetFilters: { supportFilter: 'waiting' },
            sourceSignal: 'quick.support.waiting'
        });

        const priorityWeight = { critical: 4, high: 3, medium: 2, low: 1 };
        const topActions = [...actions]
            .sort((a, b) => {
                const byPriority = (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0);
                if (byPriority !== 0) return byPriority;
                return toNumber(b.impact_value) - toNumber(a.impact_value);
            })
            .slice(0, 5);

        const groupedActions = actions.reduce((acc, action) => {
            const key = action.category || 'operations';
            if (!acc[key]) acc[key] = [];
            acc[key].push(action);
            return acc;
        }, {});
        Object.keys(groupedActions).forEach((key) => {
            groupedActions[key] = groupedActions[key]
                .sort((a, b) => (priorityWeight[b.priority] || 0) - (priorityWeight[a.priority] || 0))
                .slice(0, 6);
        });

        const briefLines = [];
        if (frozenRevenue > 0) {
            briefLines.push(`Главный денежный фокус: вернуть ${formatKopecksRu(frozenRevenue)} из неоплаченных заказов.`);
        }
        if (Number(clientSegments.vipSleeping || 0) > 0) {
            briefLines.push(`${clientSegments.vipSleeping} VIP-клиентов в риске потери, стоит вернуть их первыми.`);
        }
        if (Number(supportTotals.waiting || 0) > 0) {
            briefLines.push(`В поддержке ${supportTotals.waiting} диалогов в ожидании ответа — сервис влияет на удержание.`);
        }
        if (Number(broadcastSegments.repeatableCampaigns || 0) > 0) {
            briefLines.push(`Есть ${broadcastSegments.repeatableCampaigns} сильных кампаний, которые можно быстро повторить для роста.`);
        }
        if (!briefLines.length) {
            briefLines.push('Критичных сигналов сейчас нет: ключевые процессы под контролем.');
            briefLines.push('Можно сфокусироваться на росте повторных продаж и усилении лучших сегментов.');
        }
        const executiveBrief = {
            title: 'Главное на сегодня',
            lines: briefLines.slice(0, 4),
            message: briefLines.slice(0, 2).join(' ')
        };

        return {
            generatedAt: nowIso,
            freshness: {
                generated_at: nowIso,
                status: 'fresh'
            },
            topActions,
            groupedActions,
            executiveBrief,
            quickWins: quickWins.slice(0, 6),
            neutralState: topActions.length === 0 ? {
                title: 'Критичных действий сейчас нет',
                message: 'Главные процессы под контролем. Можно сосредоточиться на росте и реактивации клиентов.'
            } : null
        };
    }

    async function getPlaybooksSummary() {
        const [clientsSummary, ordersSummary, broadcastsSummary, supportSummary] = await Promise.all([
            getClientsSummary(),
            getOrdersSummary(),
            getBroadcastsSummary(),
            getSupportSummary()
        ]);

        const clientsTotals = clientsSummary.totals || {};
        const clientsSegments = clientsSummary.segments || {};
        const ordersTotals = ordersSummary.totals || {};
        const ordersSignals = ordersSummary.orderSignals || {};
        const broadcastsSegments = broadcastsSummary.segments || {};
        const broadcastsTotals = broadcastsSummary.totals || {};
        const supportTotals = supportSummary.totals || {};
        const supportRisk = supportSummary.lossRisk || {};

        const playbooks = [
            {
                id: 'vip_return',
                type: 'retention',
                title: 'Вернуть VIP-клиентов',
                message: 'Сфокусируйтесь на ценных клиентах в риске ухода и начните персональную реактивацию.',
                category: 'retention',
                priority: clientsTotals.returnable > 0 ? 'high' : 'medium',
                business_goal: 'Сохранить LTV и повторные заказы',
                suggested_target: 'clients',
                prefilled_filters: { clientFilter: 'vip_sleeping' },
                prefilled_context: { reason: 'vip_return', segment: 'vip_sleeping' },
                cta_label: 'Запустить сценарий',
                estimate_label: `${Number(clientsSegments.vipSleeping || 0)} клиентов под риском`
            },
            {
                id: 'second_order_push',
                type: 'client_followup',
                title: 'Довести новых до второго заказа',
                message: 'Откройте новых клиентов без повторов и отработайте follow-up в приоритетном порядке.',
                category: 'growth',
                priority: Number(clientsSegments.newWithoutRepeat || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Рост repeat rate',
                suggested_target: 'clients',
                prefilled_filters: { clientFilter: 'new_without_repeat' },
                prefilled_context: { reason: 'second_order_push' },
                cta_label: 'Открыть сегмент',
                estimate_label: `${Number(clientsSegments.newWithoutRepeat || 0)} клиентов без повтора`
            },
            {
                id: 'frozen_revenue_recovery',
                type: 'revenue_recovery',
                title: 'Вернуть замороженную выручку',
                message: 'Начните с крупных неоплаченных заказов и срочных доставок.',
                category: 'revenue',
                priority: Number(ordersTotals.unpaid || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Вернуть выручку в оплату',
                suggested_target: 'orders',
                prefilled_filters: { orderFilter: 'large_unpaid' },
                prefilled_context: { reason: 'frozen_revenue' },
                cta_label: 'Открыть заказы',
                estimate_label: `${Number(ordersTotals.unpaid || 0)} неоплаченных · ${Number(ordersSignals.highValueUnpaid || 0)} крупных`
            },
            {
                id: 'support_waiting_recovery',
                type: 'support_recovery',
                title: 'Разобрать клиентов без ответа',
                message: 'Приоритизируйте критичные диалоги и ускорьте первый ответ.',
                category: 'support',
                priority: Number(supportTotals.critical || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Снизить риск потери после обращения',
                suggested_target: 'support',
                prefilled_filters: { supportFilter: 'critical' },
                prefilled_context: { reason: 'support_waiting' },
                cta_label: 'Открыть поддержку',
                estimate_label: `${Number(supportTotals.waiting || 0)} ждут ответа · ${Number(supportRisk.waitingTooLong || 0)} в риске`
            },
            {
                id: 'repeat_strong_campaign',
                type: 'campaign_reuse',
                title: 'Повторить сильную рассылку',
                message: 'Используйте лучшие кампании как основу следующего запуска.',
                category: 'growth',
                priority: Number(broadcastsSegments.repeatableCampaigns || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Ускорить рост без лишнего риска',
                suggested_target: 'broadcasts',
                prefilled_filters: { broadcastsFilter: 'repeatable' },
                prefilled_context: { reason: 'campaign_reuse' },
                cta_label: 'Открыть кандидатов',
                estimate_label: `${Number(broadcastsSegments.repeatableCampaigns || 0)} кампаний для повтора`
            },
            {
                id: 'lost_reach_reduction',
                type: 'growth',
                title: 'Снизить потерянный охват',
                message: 'Разберите проблемные кампании и устраните причины недоохвата.',
                category: 'growth',
                priority: Number(broadcastsTotals.problematicCampaigns || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Сохранить качество канала',
                suggested_target: 'broadcasts',
                prefilled_filters: { broadcastsFilter: 'problematic' },
                prefilled_context: { reason: 'lost_reach_reduction' },
                cta_label: 'Разобрать кампании',
                estimate_label: `${Number(broadcastsTotals.lostReachCount || 0)} потерянных касаний`
            },
            {
                id: 'high_value_recover',
                type: 'retention',
                title: 'Вернуть ценных клиентов с высоким чеком',
                message: 'Сконцентрируйтесь на high-value клиентах в паузе покупок.',
                category: 'retention',
                priority: Number(clientsTotals.sleeping || 0) > 0 ? 'high' : 'medium',
                business_goal: 'Вернуть выручку через high-value сегмент',
                suggested_target: 'clients',
                prefilled_filters: { clientFilter: 'highvalue_sleeping' },
                prefilled_context: { reason: 'high_value_recover' },
                cta_label: 'Открыть сегмент',
                estimate_label: `${Number(clientsSegments.highValueSleeping || 0)} клиентов high-value в паузе`
            },
            {
                id: 'post_support_retention',
                type: 'support_recovery',
                title: 'Удержать клиента после обращения',
                message: 'Сразу обработайте VIP и новых клиентов с активностью в поддержке.',
                category: 'retention',
                priority: Number(supportTotals.vip || 0) > 0 ? 'important' : 'medium',
                business_goal: 'Снизить churn после сервисного контакта',
                suggested_target: 'support',
                prefilled_filters: { supportFilter: 'vip_waiting' },
                prefilled_context: { reason: 'post_support_retention' },
                cta_label: 'Открыть приоритет',
                estimate_label: `${Number(supportRisk.vipWaiting || 0)} VIP ждут ответа`
            }
        ];

        return {
            generatedAt: new Date().toISOString(),
            playbooks
        };
    }

    async function listBroadcasts({ limit = 100, status = '' } = {}) {
        const args = [];
        let where = '';
        if (status) {
            where = 'WHERE status = ?';
            args.push(String(status));
        }
        args.push(toInt(limit, 100));
        const rows = await all(
            `
            SELECT bc.*,
                   COALESCE(stats.delivered_count, 0) AS delivered_count,
                   COALESCE(stats.failed_count, 0) AS failed_count,
                   COALESCE(stats.blocked_count, 0) AS blocked_count,
                   COALESCE(stats.total_recipients, 0) AS total_recipients,
                   COALESCE(stats.delete_for_all_count, 0) AS delete_for_all_count,
                   stats.last_delivery_at
            FROM broadcast_campaigns
            bc
            LEFT JOIN (
                SELECT bd.campaign_id,
                       SUM(CASE WHEN bd.status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered_count,
                       SUM(CASE WHEN bd.status IN ('FAILED','FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed_count,
                       SUM(CASE WHEN bd.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count,
                       SUM(CASE WHEN bd.delete_status = 'DELETED' THEN 1 ELSE 0 END) AS delete_for_all_count,
                       COUNT(*) AS total_recipients,
                       MAX(COALESCE(bd.updated_at, bd.created_at)) AS last_delivery_at
                FROM broadcast_deliveries bd
                GROUP BY bd.campaign_id
            ) stats ON stats.campaign_id = bc.id
            ${where}
            ORDER BY bc.id DESC
            LIMIT ?
            `,
            args
        );
        return rows.map((row) => enrichBroadcastCampaign(row));
    }

    async function getBroadcastsSummary() {
        const rows = await listBroadcasts({ limit: 400 });
        const totalCampaigns = rows.length;
        const successfulCampaigns = rows.filter((row) => row.campaign_tier === 'successful').length;
        const problematicCampaigns = rows.filter((row) => row.is_problematic).length;
        const runningCampaigns = rows.filter((row) => String(row.status || '').toUpperCase() === 'RUNNING').length;
        const deliveredMessages = rows.reduce((acc, row) => acc + toNumber(row.delivered_count), 0);
        const failedMessages = rows.reduce((acc, row) => acc + toNumber(row.failed_count), 0);
        const blockedMessages = rows.reduce((acc, row) => acc + toNumber(row.blocked_count), 0);
        const lostReachCount = rows.reduce((acc, row) => acc + toNumber(row.lost_reach_count), 0);
        const repeatableCampaigns = rows.filter((row) => row.is_repeatable_candidate).length;
        const highReachCampaigns = rows.filter((row) => row.is_high_reach).length;
        const deletedCampaigns = rows.filter((row) => String(row.status || '').toUpperCase() === 'DELETED').length;
        const doneCampaigns = rows.filter((row) => String(row.status || '').toUpperCase() === 'DONE').length;

        const bestCampaign = rows
            .filter((row) => row.total_recipients > 0)
            .sort((a, b) => {
                const scoreDiff = toNumber(b.campaign_quality_score) - toNumber(a.campaign_quality_score);
                if (scoreDiff !== 0) return scoreDiff;
                return toNumber(b.delivered_count) - toNumber(a.delivered_count);
            })[0] || null;

        const topLostReach = rows
            .filter((row) => row.lost_reach_count > 0)
            .sort((a, b) => toNumber(b.lost_reach_count) - toNumber(a.lost_reach_count))
            .slice(0, 3)
            .map((row) => ({
                campaignId: Number(row.id),
                title: `Кампания #${row.id}`,
                lostReach: Number(row.lost_reach_count || 0),
                blocked: Number(row.blocked_count || 0),
                failed: Number(row.failed_count || 0),
                subtitle: row.campaign_subtitle
            }));

        const highlights = [
            {
                id: 'problematic',
                title: 'Проблемные кампании',
                valueLabel: `${problematicCampaigns} кампаний`,
                description: problematicCampaigns > 0
                    ? 'Есть кампании с повышенными ошибками или блокировками.'
                    : 'Сейчас проблемных кампаний не обнаружено.',
                tone: problematicCampaigns > 0 ? 'warn' : 'ok',
                actionLabel: 'Открыть проблемные',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'problematic' } }
            },
            {
                id: 'lost_reach',
                title: 'Потерянный охват',
                valueLabel: `${lostReachCount} получателей`,
                description: `Блокировок: ${blockedMessages} · Ошибок: ${failedMessages}.`,
                tone: lostReachCount > 0 ? 'alert' : 'ok',
                actionLabel: 'К кампаниям с ошибками',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'failed' } }
            },
            {
                id: 'repeatable',
                title: 'Кампании, которые стоит повторить',
                valueLabel: `${repeatableCampaigns} кампаний`,
                description: 'Сильное качество доставки и низкий уровень риска.',
                tone: repeatableCampaigns > 0 ? 'info' : 'watch',
                actionLabel: 'Открыть кандидатов',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: 'repeatable' } }
            },
            {
                id: 'best',
                title: 'Лучшая кампания периода',
                valueLabel: bestCampaign ? `#${bestCampaign.id} · score ${bestCampaign.campaign_quality_score}` : 'Недостаточно данных',
                description: bestCampaign
                    ? `${bestCampaign.delivered_count} доставлено · ${bestCampaign.lost_reach_count} потерянный охват`
                    : 'Запустите кампании, чтобы сравнить результативность.',
                tone: bestCampaign ? 'ok' : 'watch',
                actionLabel: bestCampaign ? 'Открыть лучшую' : 'Открыть список',
                action: { screen: 'broadcasts', filters: { broadcastsFilter: bestCampaign ? 'successful' : 'all' } }
            }
        ];

        return {
            generatedAt: new Date().toISOString(),
            totals: {
                totalCampaigns,
                successfulCampaigns,
                problematicCampaigns,
                runningCampaigns,
                deliveredMessages,
                lostReachCount,
                blockedMessages
            },
            segments: {
                repeatableCampaigns,
                highReachCampaigns,
                failedCampaigns: rows.filter((row) => row.failed_count > 0).length,
                blockedCampaigns: rows.filter((row) => row.blocked_count > 0).length,
                doneCampaigns,
                deletedCampaigns
            },
            lostReach: {
                totalLostReach: lostReachCount,
                blockedMessages,
                failedMessages,
                topCampaigns: topLostReach
            },
            bestCampaign: bestCampaign ? {
                id: Number(bestCampaign.id),
                campaign_quality_score: Number(bestCampaign.campaign_quality_score || 0),
                delivered_count: Number(bestCampaign.delivered_count || 0),
                lost_reach_count: Number(bestCampaign.lost_reach_count || 0),
                campaign_subtitle: bestCampaign.campaign_subtitle
            } : null,
            highlights
        };
    }

    async function getBroadcast(id) {
        const campaign = await get('SELECT * FROM broadcast_campaigns WHERE id = ?', [Number(id)]);
        if (!campaign) return null;
        const deliveries = await all(
            `
            SELECT *
            FROM broadcast_deliveries
            WHERE campaign_id = ?
            ORDER BY id DESC
            `,
            [Number(id)]
        );
        const stats = await get(
            `
            SELECT
                SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked,
                SUM(CASE WHEN status IN ('FAILED','FAILED_PERMANENT') THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN delete_status = 'DELETED' THEN 1 ELSE 0 END) AS deleted
            FROM broadcast_deliveries
            WHERE campaign_id = ?
            `,
            [Number(id)]
        );
        const enrichedCampaign = enrichBroadcastCampaign({
            ...campaign,
            delivered_count: Number(stats?.delivered || 0),
            failed_count: Number(stats?.failed || 0),
            blocked_count: Number(stats?.blocked || 0),
            total_recipients: Number(deliveries.length || 0),
            delete_for_all_count: Number(stats?.deleted || 0)
        });
        const repeatability = deriveBroadcastRepeatability(enrichedCampaign);
        const errorSummary = buildBroadcastErrorSummary(deliveries, enrichedCampaign.total_recipients);
        const qualityInsights = deriveBroadcastQualityInsights(enrichedCampaign, repeatability);
        const nextActions = deriveBroadcastNextActions(enrichedCampaign, repeatability, errorSummary);
        const duration = deriveBroadcastDuration(
            enrichedCampaign.created_at,
            enrichedCampaign.completed_at,
            enrichedCampaign.updated_at
        );

        const lostReachCount = Math.round(toNumber(enrichedCampaign.lost_reach_count));
        const lostReachPct = toNumber(enrichedCampaign.lost_reach_pct);
        const failedCount = Math.round(toNumber(enrichedCampaign.failed_count));
        const blockedCount = Math.round(toNumber(enrichedCampaign.blocked_count));
        const deliveredCount = Math.round(toNumber(enrichedCampaign.delivered_count));
        const totalRecipients = Math.round(toNumber(enrichedCampaign.total_recipients));
        const deleteForAllCount = Math.round(toNumber(enrichedCampaign.delete_for_all_count));

        const subtitle = enrichedCampaign.campaign_subtitle
            || (repeatability.repeatability_status === 'repeat'
                ? 'Хорошая доставляемость, кампанию можно повторить.'
                : (repeatability.repeatability_status === 'do_not_repeat'
                    ? 'Высокий потерянный охват, нужен пересмотр сегмента.'
                    : 'Кампания в рабочем диапазоне, есть зоны для улучшения.'));

        return {
            campaign: {
                ...enrichedCampaign,
                subtitle,
                campaign_summary_text: `${subtitle} ${repeatability.repeatability_reason}`,
                repeatability_status: repeatability.repeatability_status,
                repeatability_reason: repeatability.repeatability_reason,
                repeatability_label: repeatability.repeatability_label
            },
            stats: {
                delivered: deliveredCount,
                failed: failedCount,
                blocked: blockedCount,
                deleted: deleteForAllCount
            },
            delivery_quality: {
                delivered_pct: toNumber(enrichedCampaign.delivered_pct),
                failed_pct: toNumber(enrichedCampaign.failed_pct),
                blocked_pct: toNumber(enrichedCampaign.blocked_pct),
                quality_score: toNumber(enrichedCampaign.campaign_quality_score),
                campaign_health: enrichedCampaign.campaign_health,
                campaign_tier: enrichedCampaign.campaign_tier
            },
            recipient_breakdown: {
                total_recipients: totalRecipients,
                delivered_count: deliveredCount,
                failed_count: failedCount,
                blocked_count: blockedCount,
                lost_reach_count: lostReachCount,
                delete_for_all_count: deleteForAllCount
            },
            lost_reach: {
                lost_reach_count: lostReachCount,
                lost_reach_pct: lostReachPct,
                failed_count: failedCount,
                blocked_count: blockedCount,
                summary_text: lostReachCount > 0
                    ? `Потеряно ${lostReachCount} касаний: ошибки ${failedCount}, блокировки ${blockedCount}.`
                    : 'Потерянный охват не зафиксирован.'
            },
            error_summary: errorSummary,
            quality_insights: qualityInsights,
            next_actions: nextActions,
            details: {
                completed_at: enrichedCampaign.completed_at || null,
                duration_minutes: duration.duration_minutes,
                duration_label: duration.duration_label,
                /** Окно фактической отправки всем получателям (первый copyMessage → последний). */
                send_duration:
                    enrichedCampaign.delivery_duration_ms != null
                        ? {
                              duration_ms: enrichedCampaign.delivery_duration_ms,
                              duration_label: enrichedCampaign.delivery_send_duration_label,
                              started_at: enrichedCampaign.delivery_send_started_at || null,
                              finished_at: enrichedCampaign.delivery_send_finished_at || null
                          }
                        : null,
                delete_for_all_count: deleteForAllCount,
                source_preview: {
                    source_chat_id: enrichedCampaign.source_chat_id || '',
                    source_message_id: Number(enrichedCampaign.source_message_id || 0),
                    source_thread_id: enrichedCampaign.source_thread_id ? Number(enrichedCampaign.source_thread_id) : null
                }
            },
            deliveries
        };
    }

    async function listSupportThreads({ limit = 100 } = {}) {
        const rows = await all(
            `${SUPPORT_THREAD_LIST_FROM}
            ORDER BY st.id DESC
            LIMIT ?
            `,
            [toInt(limit, 100)]
        );
        return rows.map((row) => enrichSupportThreadRow(row));
    }

    async function getSupportSummary() {
        const rows = await listSupportThreads({ limit: 400 });
        const total = rows.length;
        const active = rows.filter((row) => row.is_open_thread).length;
        const waiting = rows.filter((row) => row.is_waiting_response).length;
        const critical = rows.filter((row) => row.is_critical).length;
        const vip = rows.filter((row) => row.is_vip_client).length;
        const newClients = rows.filter((row) => row.is_new_client).length;
        const repeat = rows.filter((row) => row.is_repeat_client).length;
        const withOrders = rows.filter((row) => row.has_orders).length;
        const attention = rows.filter((row) => row.support_attention_level !== 'normal').length;
        const closed = rows.filter((row) => !row.is_open_thread).length;
        const waitingRisk = rows.filter((row) => row.is_waiting_response && toNumber(row.waiting_minutes) >= 30).length;
        const vipWaiting = rows.filter((row) => row.is_vip_client && row.is_waiting_response).length;
        const newWaiting = rows.filter((row) => row.is_new_client && row.is_waiting_response).length;

        const waitingTimes = rows
            .filter((row) => row.is_waiting_response)
            .map((row) => toNumber(row.waiting_minutes))
            .filter((n) => Number.isFinite(n) && n >= 0);
        const avgWaitingMinutes = waitingTimes.length
            ? Math.round(waitingTimes.reduce((acc, n) => acc + n, 0) / waitingTimes.length)
            : 0;

        const responseTimes = rows
            .map((row) => {
                if (!row.first_response_at || !row.created_at) return null;
                const diff = (Date.parse(String(row.first_response_at)) - Date.parse(String(row.created_at))) / (60 * 1000);
                return Number.isFinite(diff) && diff >= 0 ? diff : null;
            })
            .filter((n) => n !== null);
        const avgFirstResponseMinutes = responseTimes.length
            ? Math.round(responseTimes.reduce((acc, n) => acc + n, 0) / responseTimes.length)
            : 0;

        const topRiskDialogs = rows
            .filter((row) => row.support_attention_level !== 'normal')
            .sort((a, b) => toNumber(b.support_priority_score) - toNumber(a.support_priority_score))
            .slice(0, 4)
            .map((row) => ({
                threadId: Number(row.id),
                client: row.client_name || String(row.telegram_user_id || 'Клиент'),
                waitingMinutes: Number(row.waiting_minutes || 0),
                attentionLevel: row.support_attention_level,
                reason: row.support_attention_reason
            }));

        const highlights = [
            {
                id: 'waiting',
                title: 'Диалоги без ответа',
                valueLabel: `${waiting} диалогов`,
                description: waiting > 0 ? 'Клиенты ждут реакции поддержки.' : 'Сейчас безответных диалогов нет.',
                tone: waiting > 0 ? 'warn' : 'ok',
                actionLabel: 'Открыть ожидание',
                action: { screen: 'support', filters: { supportFilter: 'waiting' } }
            },
            {
                id: 'vip_risk',
                title: 'VIP в риске потери',
                valueLabel: `${vipWaiting} клиентов`,
                description: vipWaiting > 0 ? 'VIP-клиенты ждут ответа и требуют приоритета.' : 'VIP-клиенты под контролем.',
                tone: vipWaiting > 0 ? 'alert' : 'ok',
                actionLabel: 'Открыть VIP',
                action: { screen: 'support', filters: { supportFilter: 'vip' } }
            },
            {
                id: 'new_clients',
                title: 'Новые клиенты в поддержке',
                valueLabel: `${newClients} клиентов`,
                description: 'Первый опыт поддержки влияет на повторные продажи.',
                tone: newWaiting > 0 ? 'warn' : 'info',
                actionLabel: 'Открыть новых',
                action: { screen: 'support', filters: { supportFilter: 'new' } }
            },
            {
                id: 'critical',
                title: 'Критичные диалоги',
                valueLabel: `${critical} диалогов`,
                description: critical > 0 ? 'Нужна немедленная реакция.' : 'Критичных диалогов нет.',
                tone: critical > 0 ? 'alert' : 'ok',
                actionLabel: 'Открыть критичные',
                action: { screen: 'support', filters: { supportFilter: 'critical' } }
            }
        ];

        return {
            generatedAt: new Date().toISOString(),
            totals: {
                total,
                active,
                waiting,
                critical,
                vip,
                newClients,
                avgFirstResponseMinutes,
                avgWaitingMinutes
            },
            segments: {
                repeat,
                withOrders,
                attention,
                closed,
                waitingRisk
            },
            lossRisk: {
                waitingTooLong: waitingRisk,
                vipWaiting,
                newWaiting,
                topRiskDialogs
            },
            highlights
        };
    }

    async function getSupportThread(id) {
        const row = await get(
            `${SUPPORT_THREAD_LIST_FROM}
            WHERE st.id = ?
            `,
            [Number(id)]
        );
        if (!row) return null;
        const messages = await all(
            `
            SELECT *
            FROM support_messages
            WHERE thread_id = ?
            ORDER BY id DESC
            LIMIT 200
            `,
            [Number(id)]
        );
        return { thread: enrichSupportThreadRow(row), messages };
    }

    async function listOrders({ limit = 100, status = '', status_code = '' } = {}) {
        const { clause, args: filterArgs } = buildOrdersListWhereClause({ status_code, status });
        const lim = toInt(limit, 100);
        const rows = await all(
            `
            SELECT o.*, u.username, u.first_name, u.last_name, u.topic_id,
                   t.chat_id AS topic_chat_id,
                   t.message_thread_id AS topic_thread_id,
                   t.topic_key,
                   (
                     SELECT COUNT(*)
                     FROM orders ox
                     WHERE ox.telegram_id = o.telegram_id
                   ) AS client_orders_count,
                   (
                     SELECT COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_OX})), 0)
                     FROM orders ox
                     WHERE ox.telegram_id = o.telegram_id
                   ) AS client_lifetime_value
            FROM orders o
            LEFT JOIN users u ON u.telegram_id = o.telegram_id
            LEFT JOIN telegram_topics t ON t.telegram_user_id = o.telegram_id AND t.is_active = 1
            ${clause}
            ORDER BY o.id DESC
            LIMIT ?
            `,
            [...filterArgs, lim]
        );
        return rows.map((row) => enrichOrderRow(row));
    }

    async function getOrdersSummary() {
        const rows = await listOrders({ limit: 300 });
        const total = rows.length;
        const paid = rows.filter((row) => row.is_paid).length;
        const unpaid = rows.filter((row) => row.is_unpaid).length;
        const urgent = rows.filter((row) => row.is_urgent).length;
        const problematic = rows.filter((row) => row.is_problematic).length;
        const repeat = rows.filter((row) => row.is_repeat_client).length;
        const large = rows.filter((row) => row.is_large_order).length;
        const today = rows.filter((row) => row.delivery_bucket === 'today').length;
        const tomorrow = rows.filter((row) => row.delivery_bucket === 'tomorrow').length;
        const noAttention = rows.filter((row) => row.attention_level === 'normal').length;
        const frozenRevenue = Math.round(
            rows
                .filter((row) => row.is_unpaid)
                .reduce((acc, row) => acc + orderUnpaidExposureKopecksFromRow(row), 0)
        );

        const highlights = rows
            .filter((row) => row.is_problematic)
            .sort((a, b) => {
                const weight = (lvl) => (lvl === 'critical' ? 3 : (lvl === 'important' ? 2 : 1));
                const diff = weight(b.attention_level) - weight(a.attention_level);
                if (diff !== 0) return diff;
                return toNumber(b.amount_kopecks) - toNumber(a.amount_kopecks);
            })
            .slice(0, 3)
            .map((row) => ({
                orderId: Number(row.id),
                title: `Заказ #${row.id}`,
                client: `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.full_name || String(row.telegram_id || ''),
                amount: Math.round(toNumber(row.amount_kopecks || 0)),
                attentionLevel: row.attention_level,
                attentionLabel: row.attention_label,
                reason: row.attention_reason
            }));

        const todayOrders = rows.filter((row) => isDayEqual(row.created_at, new Date().toISOString().slice(0, 10)));
        const repeatToday = todayOrders.filter((row) => row.is_repeat_client).length;

        return {
            totals: { total, paid, unpaid, urgent, problematic, repeat, large, today, tomorrow, noAttention },
            frozenRevenue,
            orderSignals: {
                deliveryToday: today,
                repeatToday,
                highValueUnpaid: rows.filter((row) => row.is_unpaid && row.is_large_order).length
            },
            highlights
        };
    }

    async function getOrder(id) {
        const order = await get(
            `
            SELECT o.*, u.username, u.first_name, u.last_name, u.topic_id,
                   t.chat_id AS topic_chat_id,
                   t.message_thread_id AS topic_thread_id,
                   t.topic_key,
                   (
                     SELECT COUNT(*)
                     FROM orders ox
                     WHERE ox.telegram_id = o.telegram_id
                   ) AS client_orders_count,
                   (
                     SELECT COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_OX})), 0)
                     FROM orders ox
                     WHERE ox.telegram_id = o.telegram_id
                   ) AS client_lifetime_value
            FROM orders o
            LEFT JOIN users u ON u.telegram_id = o.telegram_id
            LEFT JOIN telegram_topics t ON t.telegram_user_id = o.telegram_id AND t.is_active = 1
            WHERE o.id = ?
            `,
            [Number(id)]
        );
        if (!order) return null;
        const payments = await all('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', [Number(id)]);
        const outbox = await all(
            `
            SELECT *
            FROM event_outbox
            WHERE entity_type = 'order' AND entity_id = ?
            ORDER BY id DESC
            `,
            [String(id)]
        );
        return { order: enrichOrderRow(order), payments, outbox };
    }

    async function listClients({ limit = 100, q = '' } = {}) {
        const like = `%${String(q || '').trim()}%`;
        const recentBroadcastBorderIso = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
        const rows = await all(
            `
            SELECT u.telegram_id, u.first_name, u.last_name, u.username, u.topic_id,
                   t.chat_id, t.message_thread_id, t.topic_key,
                   COALESCE(oc.total_orders, 0) AS total_orders,
                   COALESCE(oc.total_revenue, 0) AS total_revenue,
                   oc.last_order_at,
                   oc.last_paid_order_at,
                   COALESCE(bc.blocked_count, 0) AS blocked_count,
                   COALESCE(sc.support_open_threads, 0) AS support_open_threads,
                   COALESCE(sc.support_total_threads, 0) AS support_total_threads,
                   sc.support_last_activity_at,
                   COALESCE(br.recent_broadcast_count, 0) AS recent_broadcast_count,
                   br.last_broadcast_activity_at
            FROM users u
            LEFT JOIN telegram_topics t ON t.telegram_user_id = u.telegram_id AND t.is_active = 1
            LEFT JOIN (
                SELECT o.telegram_id,
                       COUNT(*) AS total_orders,
                       MAX(o.created_at) AS last_order_at,
                       MAX(CASE
                               WHEN UPPER(TRIM(COALESCE(o.status, ''))) IN ('PAID', 'COMPLETED', 'DELIVERED')
                               THEN o.created_at
                               ELSE NULL
                           END) AS last_paid_order_at,
                       COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_O})), 0) AS total_revenue
                FROM orders o
                GROUP BY o.telegram_id
            ) oc ON oc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT bd.recipient_telegram_id AS telegram_id,
                       SUM(CASE WHEN bd.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count
                FROM broadcast_deliveries bd
                GROUP BY bd.recipient_telegram_id
            ) bc ON bc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT st.telegram_user_id AS telegram_id,
                       SUM(CASE WHEN UPPER(COALESCE(st.status, '')) IN ('OPEN', 'PENDING') THEN 1 ELSE 0 END) AS support_open_threads,
                       COUNT(*) AS support_total_threads,
                       MAX(COALESCE(st.updated_at, st.created_at, st.first_response_at)) AS support_last_activity_at
                FROM support_threads st
                GROUP BY st.telegram_user_id
            ) sc ON sc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT bd.recipient_telegram_id AS telegram_id,
                       SUM(CASE WHEN COALESCE(bd.updated_at, bd.created_at, '') >= ? THEN 1 ELSE 0 END) AS recent_broadcast_count,
                       MAX(COALESCE(bd.updated_at, bd.created_at)) AS last_broadcast_activity_at
                FROM broadcast_deliveries bd
                GROUP BY bd.recipient_telegram_id
            ) br ON br.telegram_id = u.telegram_id
            WHERE (? = '%%' OR u.telegram_id LIKE ? OR u.username LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)
            ORDER BY COALESCE(oc.total_revenue, 0) DESC, COALESCE(oc.last_order_at, '') DESC, u.telegram_id DESC
            LIMIT ?
            `,
            [recentBroadcastBorderIso, like, like, like, like, like, toInt(limit, 100, 2000)]
        );
        return rows.map((row) => enrichClientRow(row));
    }

    async function getClientsSummary() {
        const rows = await listClients({ limit: 2000, q: '' });
        const total = rows.length;
        const countBy = (predicate) => rows.filter(predicate).length;

        const totals = {
            all: total,
            new: countBy((c) => c.is_new_client),
            repeat: countBy((c) => c.is_repeat_client),
            vip: countBy((c) => c.is_vip_client),
            sleeping: countBy((c) => c.is_sleeping_client),
            returnable: countBy((c) => c.is_recover_candidate)
        };

        const segments = {
            highValue: countBy((c) => c.is_high_value_client),
            highValueSleeping: countBy((c) => c.is_high_value_client && c.is_sleeping_client),
            recent: countBy((c) => c.is_recently_active),
            attention: countBy((c) => c.attention_level !== 'normal'),
            support: countBy((c) => c.has_support_activity),
            topic: countBy((c) => c.has_topic),
            withRecentBroadcastActivity: countBy((c) => c.has_recent_broadcast_activity),
            vipSleeping: countBy((c) => c.is_vip_client && c.is_sleeping_client),
            newWithoutRepeat: countBy((c) => c.total_orders === 1 && !c.is_repeat_client),
            active: countBy((c) => c.total_orders > 0 && !c.is_sleeping_client)
        };

        const highlights = [
            {
                id: 'sleeping',
                title: 'Спящие клиенты',
                valueLabel: `${totals.sleeping} клиентов`,
                description: 'Покупали раньше, но давно не возвращались.',
                tone: totals.sleeping > 0 ? 'warn' : 'ok',
                actionLabel: 'Открыть сегмент',
                action: { screen: 'clients', filters: { clientFilter: 'sleeping' } }
            },
            {
                id: 'vip_sleeping',
                title: 'VIP, которых важно вернуть',
                valueLabel: `${segments.vipSleeping} клиентов`,
                description: 'Сильные по выручке клиенты без недавних покупок.',
                tone: segments.vipSleeping > 0 ? 'alert' : 'info',
                actionLabel: 'Показать VIP',
                action: { screen: 'clients', filters: { clientFilter: 'vip' } }
            },
            {
                id: 'new_without_repeat',
                title: 'Новые без второго заказа',
                valueLabel: `${segments.newWithoutRepeat} клиентов`,
                description: 'Клиенты, которых стоит удержать повторной покупкой.',
                tone: segments.newWithoutRepeat > 0 ? 'warn' : 'ok',
                actionLabel: 'Открыть новых',
                action: { screen: 'clients', filters: { clientFilter: 'new' } }
            },
            {
                id: 'returnable',
                title: 'Клиенты, которых можно вернуть',
                valueLabel: `${totals.returnable} клиентов`,
                description: 'Повторные, VIP-спящие и новые без повтора.',
                tone: totals.returnable > 0 ? 'info' : 'ok',
                actionLabel: 'Стоит вернуть',
                action: { screen: 'clients', filters: { clientFilter: 'return' } }
            }
        ];

        return {
            generatedAt: new Date().toISOString(),
            totals,
            segments,
            highlights
        };
    }

    async function getClient(telegramId) {
        const clientId = String(telegramId || '').trim();
        if (!clientId) return null;
        const recentBroadcastBorderIso = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();

        const row = await get(
            `
            SELECT u.telegram_id, u.first_name, u.last_name, u.username, u.topic_id,
                   t.chat_id, t.message_thread_id, t.topic_key,
                   COALESCE(oc.total_orders, 0) AS total_orders,
                   COALESCE(oc.total_revenue, 0) AS total_revenue,
                   oc.last_order_at,
                   oc.last_paid_order_at,
                   COALESCE(bc.blocked_count, 0) AS blocked_count,
                   COALESCE(sc.support_open_threads, 0) AS support_open_threads,
                   COALESCE(sc.support_total_threads, 0) AS support_total_threads,
                   sc.support_last_activity_at,
                   COALESCE(br.recent_broadcast_count, 0) AS recent_broadcast_count,
                   br.last_broadcast_activity_at
            FROM users u
            LEFT JOIN telegram_topics t ON t.telegram_user_id = u.telegram_id AND t.is_active = 1
            LEFT JOIN (
                SELECT o.telegram_id,
                       COUNT(*) AS total_orders,
                       MAX(o.created_at) AS last_order_at,
                       MAX(CASE
                               WHEN UPPER(TRIM(COALESCE(o.status, ''))) IN ('PAID', 'COMPLETED', 'DELIVERED')
                               THEN o.created_at
                               ELSE NULL
                           END) AS last_paid_order_at,
                       COALESCE(SUM((${SQL_ORDER_REVENUE_KOPEKS_O})), 0) AS total_revenue
                FROM orders o
                GROUP BY o.telegram_id
            ) oc ON oc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT bd.recipient_telegram_id AS telegram_id,
                       SUM(CASE WHEN bd.status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count
                FROM broadcast_deliveries bd
                GROUP BY bd.recipient_telegram_id
            ) bc ON bc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT st.telegram_user_id AS telegram_id,
                       SUM(CASE WHEN UPPER(COALESCE(st.status, '')) IN ('OPEN', 'PENDING') THEN 1 ELSE 0 END) AS support_open_threads,
                       COUNT(*) AS support_total_threads,
                       MAX(COALESCE(st.updated_at, st.created_at, st.first_response_at)) AS support_last_activity_at
                FROM support_threads st
                GROUP BY st.telegram_user_id
            ) sc ON sc.telegram_id = u.telegram_id
            LEFT JOIN (
                SELECT bd.recipient_telegram_id AS telegram_id,
                       SUM(CASE WHEN COALESCE(bd.updated_at, bd.created_at, '') >= ? THEN 1 ELSE 0 END) AS recent_broadcast_count,
                       MAX(COALESCE(bd.updated_at, bd.created_at)) AS last_broadcast_activity_at
                FROM broadcast_deliveries bd
                GROUP BY bd.recipient_telegram_id
            ) br ON br.telegram_id = u.telegram_id
            WHERE u.telegram_id = ?
            LIMIT 1
            `,
            [recentBroadcastBorderIso, clientId]
        );
        if (!row) return null;

        const enriched = enrichClientRow(row);
        const [orderBounds, topics, lastOrdersRaw, supportThreads, supportMessages, broadcastRows, broadcastErrors] = await Promise.all([
            get(
                `
                SELECT MIN(created_at) AS first_order_at, MAX(created_at) AS last_order_at
                FROM orders
                WHERE telegram_id = ?
                `,
                [clientId]
            ),
            all('SELECT * FROM telegram_topics WHERE telegram_user_id = ? ORDER BY id DESC LIMIT 20', [clientId]),
            all(
                `
                SELECT id, telegram_id, status, ms_state_name, total, total_paid, created_at, delivery_date, delivery_time
                FROM orders
                WHERE telegram_id = ?
                ORDER BY id DESC
                LIMIT 10
                `,
                [clientId]
            ),
            all(
                `
                SELECT *
                FROM support_threads
                WHERE telegram_user_id = ?
                ORDER BY id DESC
                LIMIT 10
                `,
                [clientId]
            ),
            all(
                `
                SELECT sm.*
                FROM support_messages sm
                INNER JOIN support_threads st ON st.id = sm.thread_id
                WHERE st.telegram_user_id = ?
                ORDER BY sm.id DESC
                LIMIT 12
                `,
                [clientId]
            ),
            all(
                `
                SELECT bd.id, bd.status, bd.created_at, bd.updated_at, bd.error_code, bd.error_message, bd.campaign_id
                FROM broadcast_deliveries bd
                WHERE bd.recipient_telegram_id = ?
                ORDER BY bd.id DESC
                LIMIT 15
                `,
                [clientId]
            ),
            all(
                `
                SELECT *
                FROM broadcast_deliveries
                WHERE recipient_telegram_id = ? AND status IN ('BLOCKED','FAILED','FAILED_PERMANENT')
                ORDER BY id DESC
                LIMIT 50
                `,
                [clientId]
            )
        ]);

        const repeatOrdersCount = Math.max(0, Number(enriched.total_orders || 0) - 1);
        const firstOrderAt = orderBounds?.first_order_at || null;
        const lastOrderAt = enriched.last_order_at || orderBounds?.last_order_at || null;
        const { valueTier, retentionStage, actionPriority } = deriveClientTiers(enriched);
        const storySubtitle = `${enriched.is_vip_client ? 'VIP-клиент' : (enriched.is_new_client ? 'Новый клиент' : (enriched.is_repeat_client ? 'Повторный клиент' : 'Клиент'))} • ${enriched.total_orders} заказов • последний ${enriched.days_since_last_order === null ? 'без заказов' : `${enriched.days_since_last_order} дн. назад`}`;

        const lastOrders = lastOrdersRaw.map((order) => {
            const isPaid = isOrderPaidForOps(order);
            const amountK = orderAmountKopecksFromRow(order);
            const st = deriveOrderAdminPresentation(order);
            return {
                id: Number(order.id),
                status_code: st.status_code,
                status_label: st.status_label,
                status_tone: st.status_tone,
                amount: amountK,
                created_at: order.created_at || null,
                delivery_date: order.delivery_date || null,
                delivery_time: order.delivery_time || null,
                is_paid: isPaid,
                subtitle: `${isPaid ? 'Оплачен' : 'Ожидает оплату'} • ${formatKopecksRu(amountK)}`
            };
        });

        const supportSummary = {
            has_active_support: Number(enriched.support_open_threads || 0) > 0,
            open_threads: Number(enriched.support_open_threads || 0),
            total_threads: Number(enriched.support_total_threads || 0),
            messages_count: Number(supportMessages.length || 0),
            last_activity_at: enriched.support_last_activity_at || null
        };

        const events = [];
        for (const order of lastOrders) {
            events.push({
                type: 'order',
                at: order.created_at,
                title: `Заказ #${order.id}`,
                message: `${order.is_paid ? 'Оплачен' : 'Ожидает оплату'} • ${formatKopecksRu(order.amount)}`
            });
        }
        for (const thread of supportThreads.slice(0, 4)) {
            const at = thread.last_client_message_at || thread.updated_at || thread.created_at;
            const waiting = computeThreadWaitingForStaff(thread);
            events.push({
                type: 'support',
                at,
                title: `Поддержка #${thread.id}`,
                message: `${String(thread.status || 'OPEN')} • ${waiting ? 'ждёт ответа сотрудника' : 'не ждёт ответа'}`
            });
        }
        for (const delivery of broadcastRows.slice(0, 4)) {
            events.push({
                type: 'broadcast',
                at: delivery.updated_at || delivery.created_at,
                title: `Рассылка #${delivery.campaign_id || delivery.id}`,
                message: `${String(delivery.status || 'UNKNOWN')}${delivery.error_message ? ` • ${String(delivery.error_message).slice(0, 48)}` : ''}`
            });
        }
        const recentEvents = events
            .filter((evt) => evt.at)
            .sort((a, b) => Date.parse(String(b.at || '')) - Date.parse(String(a.at || '')))
            .slice(0, 10);

        const recommendedActions = recommendedActionsForClient(enriched);

        return {
            profile: {
                ...enriched,
                first_order_at: firstOrderAt,
                last_order_at: lastOrderAt,
                repeat_orders_count: repeatOrdersCount,
                value_tier: valueTier,
                retention_stage: retentionStage,
                action_priority: actionPriority,
                client_story_subtitle: storySubtitle
            },
            recommended_actions: recommendedActions,
            last_orders: lastOrders,
            support_summary: supportSummary,
            recent_events: recentEvents,
            support_threads: supportThreads.slice(0, 6).map((thread) => ({
                id: Number(thread.id),
                status: String(thread.status || ''),
                waiting_for_staff: Number(thread.waiting_for_staff || 0),
                is_waiting_response: computeThreadWaitingForStaff(thread),
                created_at: thread.created_at || null,
                updated_at: thread.updated_at || null,
                first_response_at: thread.first_response_at || null,
                last_client_message_at: thread.last_client_message_at || null,
                message_thread_id: thread.message_thread_id || null
            })),
            support_messages: supportMessages.slice(0, 8).map((msg) => ({
                id: Number(msg.id),
                thread_id: Number(msg.thread_id),
                direction: String(msg.direction || ''),
                status: String(msg.status || ''),
                created_at: msg.created_at || null
            })),
            topics,
            user: {
                telegram_id: enriched.telegram_id,
                first_name: enriched.first_name,
                last_name: enriched.last_name,
                username: enriched.username
            },
            orders: lastOrdersRaw.map((order) => {
                const st = deriveOrderAdminPresentation(order);
                return {
                    id: Number(order.id),
                    amount_kopecks: orderAmountKopecksFromRow(order),
                    status_code: st.status_code,
                    status_label: st.status_label,
                    is_paid: isOrderPaidForOps(order),
                    created_at: order.created_at || null,
                    delivery_date: order.delivery_date || null,
                    delivery_time: order.delivery_time || null,
                    ms_state_name: order.ms_state_name || null
                };
            }),
            support: supportThreads[0] || null,
            broadcastErrors
        };
    }

    async function listTopics({ limit = 200 } = {}) {
        return all('SELECT * FROM telegram_topics ORDER BY id DESC LIMIT ?', [toInt(limit, 200)]);
    }

    async function listOutbox({ limit = 200, status = '' } = {}) {
        const args = [];
        let where = '';
        if (status) {
            where = 'WHERE status = ?';
            args.push(String(status));
        }
        args.push(toInt(limit, 200));
        return all(
            `
            SELECT *
            FROM event_outbox
            ${where}
            ORDER BY id DESC
            LIMIT ?
            `,
            args
        );
    }

    async function reprocessOutboxById(id) {
        const row = await get('SELECT * FROM event_outbox WHERE id = ?', [Number(id)]);
        if (!row) return null;
        await run(
            `
            UPDATE event_outbox
            SET status = 'NEW', next_retry_at = ?, last_error = NULL
            WHERE id = ?
            `,
            [new Date().toISOString(), Number(id)]
        );
        return get('SELECT * FROM event_outbox WHERE id = ?', [Number(id)]);
    }

    async function getOperationalHealth() {
        const outbox = await get(
            `
            SELECT
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'RETRYING' THEN 1 ELSE 0 END) AS retrying,
                SUM(CASE WHEN status = 'NEW' THEN 1 ELSE 0 END) AS pending
            FROM event_outbox
            `
        );
        const orphanDeliveries = await get(
            `
            SELECT COUNT(*) AS c
            FROM broadcast_deliveries bd
            LEFT JOIN broadcast_campaigns bc ON bc.id = bd.campaign_id
            WHERE bc.id IS NULL
            `
        );
        const orphanSupportMessages = await get(
            `
            SELECT COUNT(*) AS c
            FROM support_messages sm
            LEFT JOIN support_threads st ON st.id = sm.thread_id
            WHERE st.id IS NULL
            `
        );
        return {
            outbox,
            dataIntegrity: {
                orphanBroadcastDeliveries: Number(orphanDeliveries?.c || 0),
                orphanSupportMessages: Number(orphanSupportMessages?.c || 0)
            }
        };
    }

    async function listAuditLog({ limit = 200 } = {}) {
        return all(
            `
            SELECT *
            FROM admin_action_logs
            ORDER BY id DESC
            LIMIT ?
            `,
            [toInt(limit, 200)]
        );
    }

    return {
        logAction,
        getDashboard,
        getMobileSummary,
        getAnalyticsSummary,
        getActionsSummary,
        getPlaybooksSummary,
        listBroadcasts,
        getBroadcastsSummary,
        getBroadcast,
        listSupportThreads,
        getSupportSummary,
        getSupportThread,
        listOrders,
        getOrdersSummary,
        getOrder,
        listClients,
        getClientsSummary,
        getClient,
        listTopics,
        listOutbox,
        listAuditLog,
        reprocessOutboxById,
        getOperationalHealth
    };
}

module.exports = {
    createAdminRepository
};

