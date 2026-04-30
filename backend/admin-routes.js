const express = require('express');
const path = require('path');
const fs = require('fs');
const { ADMIN_PERMISSIONS, ALL_ADMIN_PERMISSIONS } = require('./admin-permissions');
const { getDashboardV2ApiPayload } = require('./admin-dashboard-service');

function createAdminRouter({
    auth,
    adminRepository,
    runtimeFlagsService,
    broadcastService,
    promotionService,
    telegramClient,
    config,
    scanStaleMsOrderLinks
}) {
    const router = express.Router();

    router.use(auth.requireAdmin);

    router.get('/config', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        res.json({
            ok: true,
            admin: {
                adminId: req.admin.adminId,
                name: req.admin.name,
                permissions: req.admin.permissions
            },
            modules: {
                dashboard: true,
                broadcasts: true,
                support: true,
                orders: true,
                clients: true,
                topics: true,
                outbox: true,
                flags: true,
                audit: true,
                promotion: !!promotionService
            },
            permissionsCatalog: ALL_ADMIN_PERMISSIONS
        });
    });

    router.get('/dashboard', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getDashboard();
        res.json({ ok: true, data });
    });

    router.get('/mobile-summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getMobileSummary();
        res.json({ ok: true, data });
    });

    router.get('/dashboard-v2', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const ymdRx = /^\d{4}-\d{2}-\d{2}$/;
        const qFrom = String(req.query.from ?? '').trim();
        const qTo = String(req.query.to ?? '').trim();
        try {
            if (qFrom && qTo && ymdRx.test(qFrom) && ymdRx.test(qTo)) {
                const data = await getDashboardV2ApiPayload({ fromYmd: qFrom, toYmd: qTo });
                return res.json({ ok: true, data });
            }
            const raw = String(req.query.period || 'today').toLowerCase();
            const periodKey = raw === '7d' ? '7d' : 'today';
            const data = await getDashboardV2ApiPayload({ periodKey });
            return res.json({ ok: true, data });
        } catch (e) {
            const msg = String((e && e.message) || e || '');
            if (msg === 'BAD_YMD' || msg === 'RANGE_INVERTED' || msg === 'RANGE_TOO_WIDE') {
                return res.status(400).json({
                    ok: false,
                    error: 'DASHBOARD_V2_BAD_RANGE',
                    detail: msg
                });
            }
            console.error('[Admin] dashboard-v2 failed:', msg);
            return res.status(500).json({ ok: false, error: 'DASHBOARD_V2_FAILED' });
        }
    });

    router.get('/analytics/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getAnalyticsSummary({ period: req.query.period });
        res.json({ ok: true, data });
    });

    router.get('/actions/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getActionsSummary();
        res.json({ ok: true, data });
    });

    router.get('/playbooks/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getPlaybooksSummary();
        res.json({ ok: true, data });
    });

    router.get('/broadcasts', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_BROADCASTS_VIEW), async (req, res) => {
        const data = await adminRepository.listBroadcasts({
            limit: req.query.limit,
            status: req.query.status
        });
        res.json({ ok: true, data });
    });

    router.get('/broadcasts/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_BROADCASTS_VIEW), async (req, res) => {
        const data = await adminRepository.getBroadcastsSummary();
        res.json({ ok: true, data });
    });

    router.get('/broadcasts/:id', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_BROADCASTS_VIEW), async (req, res) => {
        const data = await adminRepository.getBroadcast(req.params.id);
        if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        res.json({ ok: true, data });
    });

    router.post('/broadcasts/:id/delete-for-all', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_BROADCASTS_DELETE), async (req, res) => {
        const result = await broadcastService.deleteCampaignMessages(Number(req.params.id), req.admin.adminId);
        await adminRepository.logAction({
            adminId: req.admin.adminId,
            action: 'BROADCAST_DELETE_FOR_ALL',
            entityType: 'broadcast_campaign',
            entityId: String(req.params.id),
            details: { result }
        });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error || 'DELETE_FAILED' });
        res.json({ ok: true, result });
    });

    router.get('/support/threads', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_SUPPORT_VIEW), async (req, res) => {
        const data = await adminRepository.listSupportThreads({ limit: req.query.limit });
        res.json({ ok: true, data });
    });

    router.get('/support/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_SUPPORT_VIEW), async (req, res) => {
        const data = await adminRepository.getSupportSummary();
        res.json({ ok: true, data });
    });

    router.get('/support/threads/:id', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_SUPPORT_VIEW), async (req, res) => {
        const data = await adminRepository.getSupportThread(req.params.id);
        if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        res.json({ ok: true, data });
    });

    router.get('/orders', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_ORDERS_VIEW), async (req, res) => {
        const data = await adminRepository.listOrders({
            limit: req.query.limit,
            status: req.query.status,
            status_code: req.query.status_code
        });
        res.json({ ok: true, data });
    });

    router.get('/orders/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_ORDERS_VIEW), async (req, res) => {
        const data = await adminRepository.getOrdersSummary();
        res.json({ ok: true, data });
    });

    router.get('/orders/:id', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_ORDERS_VIEW), async (req, res) => {
        const data = await adminRepository.getOrder(req.params.id);
        if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        res.json({ ok: true, data });
    });

    router.get(
        '/moysklad/stale-order-link-scan',
        auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_ORDERS_VIEW),
        async (req, res) => {
            if (typeof scanStaleMsOrderLinks !== 'function') {
                return res.status(501).json({ ok: false, error: 'STALE_SCAN_NOT_CONFIGURED' });
            }
            try {
                const limit = req.query.limit;
                const data = await scanStaleMsOrderLinks({ limit });
                res.json({ ok: true, data });
            } catch (e) {
                console.error('[Admin] stale-order-link-scan failed:', e.response?.data || e.message || e);
                res.status(500).json({
                    ok: false,
                    error: 'STALE_SCAN_FAILED',
                    details: e.response?.data || e.message
                });
            }
        }
    );

    router.get('/clients', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_CLIENTS_VIEW), async (req, res) => {
        const data = await adminRepository.listClients({
            limit: req.query.limit,
            q: req.query.q
        });
        res.json({ ok: true, data });
    });

    router.get('/clients/summary', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_CLIENTS_VIEW), async (req, res) => {
        const data = await adminRepository.getClientsSummary();
        res.json({ ok: true, data });
    });

    router.get('/clients/:telegramId', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_CLIENTS_VIEW), async (req, res) => {
        const data = await adminRepository.getClient(req.params.telegramId);
        if (!data) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        res.json({ ok: true, data });
    });

    router.get('/topics', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_TOPICS_VIEW), async (req, res) => {
        const data = await adminRepository.listTopics({ limit: req.query.limit });
        res.json({ ok: true, data });
    });

    router.get('/outbox', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_OUTBOX_VIEW), async (req, res) => {
        const data = await adminRepository.listOutbox({
            limit: req.query.limit,
            status: req.query.status
        });
        res.json({ ok: true, data });
    });

    router.post('/outbox/:id/reprocess', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_OUTBOX_VIEW), async (req, res) => {
        const row = await adminRepository.reprocessOutboxById(req.params.id);
        if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
        await adminRepository.logAction({
            adminId: req.admin.adminId,
            action: 'OUTBOX_REPROCESS',
            entityType: 'event_outbox',
            entityId: String(req.params.id),
            details: { status: row.status }
        });
        res.json({ ok: true, data: row });
    });

    router.get('/health', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const data = await adminRepository.getOperationalHealth();
        res.json({ ok: true, data });
    });

    router.get('/feature-flags', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_DASHBOARD_VIEW), async (req, res) => {
        const flags = await runtimeFlagsService.getAll();
        res.json({ ok: true, data: flags, managedKeys: runtimeFlagsService.managedKeys });
    });

    router.patch('/feature-flags', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_FLAGS_MANAGE), async (req, res) => {
        const partial = req.body || {};
        const updated = await runtimeFlagsService.patch(partial, req.admin.adminId);
        await adminRepository.logAction({
            adminId: req.admin.adminId,
            action: 'FLAGS_PATCH',
            entityType: 'runtime_flags',
            details: { partial, updated }
        });
        res.json({
            ok: true,
            data: updated,
            note: 'Флаги сохранены в БД. Часть сервисов читает env при старте процесса, поэтому для полного применения может потребоваться перезапуск backend.'
        });
    });

    router.get('/audit-log', auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_AUDIT_VIEW), async (req, res) => {
        const data = await adminRepository.listAuditLog({ limit: req.query.limit });
        res.json({ ok: true, data });
    });

    function enrichBroadcastApiRow(row, { withLocalImage = false } = {}) {
        if (!row) return row;
        const out = {
            ...row,
            text: row.body_text,
            response_count: row.response_count != null ? Number(row.response_count) : undefined
        };
        delete out.body_text;
        if (!withLocalImage && row.image_storage_path) {
            out.has_uploaded_image = true;
            delete out.image_storage_path;
        }
        if (withLocalImage && row.image_storage_path) {
            const id = Number(row.id || 0);
            if (id > 0) out.local_image_url = `/api/admin/promotion/broadcasts/${id}/image`;
            delete out.image_storage_path;
        }
        return out;
    }

    if (promotionService) {
        router.get(
            '/promotion/sources',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const data = await promotionService.listSources();
                    let botConfigured = false;
                    try {
                        botConfigured = !!promotionService.getBotUsername();
                    } catch (_) {
                        botConfigured = false;
                    }
                    res.json({ ok: true, data: { bot_username_configured: botConfigured, sources: data } });
                } catch (e) {
                    console.error('[Admin] promotion sources list failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_SOURCES_FAILED' });
                }
            }
        );

        router.post(
            '/promotion/sources',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                const body = req.body || {};
                try {
                    const created = await promotionService.createSource({
                        title: body.title,
                        code: body.code,
                        createdByTgId: req.admin.telegramId
                    });
                    await adminRepository.logAction({
                        adminId: req.admin.adminId,
                        action: 'PROMOTION_SOURCE_CREATE',
                        entityType: 'promotion_source',
                        entityId: created.code,
                        details: { title: created.title }
                    });
                    res.json({ ok: true, data: created });
                } catch (e) {
                    const c = String(e.code || '');
                    if (c === 'TITLE_REQUIRED') return res.status(400).json({ ok: false, error: c });
                    if (c === 'TELEGRAM_BOT_USERNAME_REQUIRED') {
                        return res.status(503).json({
                            ok: false,
                            error: c,
                            message: 'Задайте TELEGRAM_BOT_USERNAME в окружении или дождитесь getMe.'
                        });
                    }
                    console.error('[Admin] promotion source create failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_SOURCE_CREATE_FAILED' });
                }
            }
        );

        router.get(
            '/promotion/sources/:code',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const row = await promotionService.getSourceDetail(req.params.code);
                    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
                    res.json({ ok: true, data: row });
                } catch (e) {
                    console.error('[Admin] promotion source detail failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_SOURCE_DETAIL_FAILED' });
                }
            }
        );

        router.delete(
            '/promotion/sources/:code',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const out = await promotionService.deactivateSource(req.params.code);
                    await adminRepository.logAction({
                        adminId: req.admin.adminId,
                        action: 'PROMOTION_SOURCE_DELETE',
                        entityType: 'promotion_source',
                        entityId: String(out.code || ''),
                        details: {}
                    });
                    res.json({ ok: true, data: out });
                } catch (e) {
                    const c = String(e.code || '');
                    if (c === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
                    console.error('[Admin] promotion source delete failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_SOURCE_DELETE_FAILED' });
                }
            }
        );

        router.get(
            '/promotion/broadcasts',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const lim = Number(req.query.limit || 40);
                    const rows = await promotionService.listBroadcasts(lim);
                    res.json({
                        ok: true,
                        data: rows.map((row) => enrichBroadcastApiRow(row, { withLocalImage: false }))
                    });
                } catch (e) {
                    console.error('[Admin] promotion broadcasts list failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_BROADCASTS_FAILED' });
                }
            }
        );

        router.post(
            '/promotion/broadcasts',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                const body = req.body || {};
                const bodyText = String(body.body_text || body.text || '').trim();
                try {
                    const created = await promotionService.createBroadcast({
                        title: null,
                        bodyText,
                        keyword: body.keyword,
                        imageUrl: undefined,
                        imageBase64: body.image_base64,
                        createdByTgId: req.admin.telegramId
                    });
                    await adminRepository.logAction({
                        adminId: req.admin.adminId,
                        action: 'PROMOTION_BROADCAST_CREATE',
                        entityType: 'promotion_broadcast',
                        entityId: String(created.id),
                        details: { keyword: created.keyword }
                    });
                    res.json({ ok: true, data: created });
                } catch (e) {
                    const c = String(e.code || '');
                    if (c === 'BODY_REQUIRED' || c === 'KEYWORD_REQUIRED') {
                        return res.status(400).json({ ok: false, error: c });
                    }
                    if (c === 'KEYWORD_DUPLICATE') {
                        return res.status(409).json({ ok: false, error: c, message: 'Такое кодовое слово уже занято.' });
                    }
                    if (c === 'IMAGE_TOO_LARGE' || c === 'IMAGE_INVALID') {
                        return res.status(400).json({ ok: false, error: c });
                    }
                    console.error('[Admin] promotion broadcast create failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_BROADCAST_CREATE_FAILED' });
                }
            }
        );

        /** Только текст рассылки (кодовое слово не показываем в Telegram). */
        function buildPromotionTopicMessageText(bodyText, { forPhotoCaption } = {}) {
            const max = forPhotoCaption ? 1024 : 4096;
            const b = String(bodyText || '').trim();
            if (!b.length) return '';
            if (b.length <= max) return b;
            return `${b.slice(0, Math.max(0, max - 1))}…`;
        }

        router.post(
            '/promotion/broadcasts/:id/place',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                const id = Number(req.params.id || 0);
                if (!(id > 0)) return res.status(400).json({ ok: false, error: 'BAD_ID' });

                try {
                    if (!config.BROADCASTS_ENABLED) {
                        return res.status(503).json({
                            ok: false,
                            error: 'BROADCASTS_DISABLED',
                            message: 'Рассылки отключены на сервере (BROADCASTS_ENABLED).'
                        });
                    }

                    const row = await promotionService.getBroadcast(id);
                    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

                    const psRow = String(row.placement_status || 'draft').toLowerCase();
                    if (psRow === 'placed') {
                        return res.status(409).json({
                            ok: false,
                            error: 'ALREADY_PLACED',
                            message: 'Рассылка уже размещена в теме.'
                        });
                    }

                    const bcChatRaw = config.TELEGRAM_BROADCAST_TOPIC_CHAT_ID || config.TELEGRAM_FORUM_GROUP_ID;
                    const bcChat = bcChatRaw != null ? String(bcChatRaw).trim() : '';
                    const bcThread = Number(config.TELEGRAM_BROADCAST_TOPIC_THREAD_ID || 0);

                    if (!telegramClient || typeof telegramClient.sendMessage !== 'function') {
                        return res.status(503).json({
                            ok: false,
                            error: 'TELEGRAM_CLIENT_UNAVAILABLE',
                            message: 'Клиент Telegram не инициализирован.'
                        });
                    }

                    if (!bcChat || !(bcThread > 0)) {
                        await promotionService.setPromotionBroadcastPlaceFailed(
                            id,
                            'BROADCAST_TOPIC_NOT_CONFIGURED — задайте TELEGRAM_BROADCAST_TOPIC_* или TELEGRAM_FORUM_GROUP_ID и thread.'
                        );
                        return res.status(503).json({
                            ok: false,
                            error: 'BROADCAST_TOPIC_NOT_CONFIGURED',
                            message:
                                'Тема рассылок не настроена. Укажите TELEGRAM_BROADCAST_TOPIC_CHAT_ID и TELEGRAM_BROADCAST_TOPIC_THREAD_ID (или алиасы BROADCAST_*_THREAD_ID) в окружении сервера.'
                        });
                    }

                    const caption = buildPromotionTopicMessageText(row.body_text, { forPhotoCaption: true });
                    const textOnly = buildPromotionTopicMessageText(row.body_text, { forPhotoCaption: false });

                    let sent = null;
                    if (row.image_storage_path) {
                        const fullPath = promotionService.resolveImageFullPath(row.image_storage_path);
                        if (!fullPath || !fs.existsSync(fullPath)) {
                            await promotionService.setPromotionBroadcastPlaceFailed(id, 'LOCAL_IMAGE_MISSING');
                            return res.status(500).json({ ok: false, error: 'LOCAL_IMAGE_MISSING' });
                        }
                        sent = await telegramClient.sendPhotoFromFile({
                            chatId: bcChat,
                            messageThreadId: bcThread,
                            filePath: fullPath,
                            caption
                        });
                    } else {
                        sent = await telegramClient.sendMessage({
                            chatId: bcChat,
                            messageThreadId: bcThread,
                            text: textOnly
                        });
                    }

                    const mid = Number(sent && sent.data && sent.data.message_id ? sent.data.message_id : 0);
                    if (!sent.ok || !(mid > 0)) {
                        const reason = `${sent.errorCode || 'TG_SEND'}: ${sent.message || 'SEND_FAILED'}`;
                        await promotionService.setPromotionBroadcastPlaceFailed(id, reason);
                        return res.status(502).json({
                            ok: false,
                            error: 'TELEGRAM_SEND_FAILED',
                            message: reason
                        });
                    }

                    const flow = await broadcastService.startCampaignFromMiniAppTopicPost(
                        String(req.admin.telegramId || '').trim(),
                        {
                            chatId: bcChat,
                            threadId: bcThread,
                            messageId: mid
                        }
                    );

                    const campaignIdNum = Number(flow && flow.campaignId ? flow.campaignId : 0);

                    if (!flow || !flow.ok) {
                        const reason = `${flow.error || 'CAMPAIGN_START_FAILED'}${
                            flow.transportPreflightReason ? `: ${flow.transportPreflightReason}` : ''
                        }`;
                        await promotionService.setPromotionBroadcastPlaceFailed(id, reason);
                        return res.status(502).json({
                            ok: false,
                            error: flow.error || 'CAMPAIGN_START_FAILED',
                            message: reason
                        });
                    }

                    await promotionService.setPromotionBroadcastPlaced(id, {
                        placedAt: new Date().toISOString(),
                        placedMessageId: mid,
                        placedChatId: bcChat,
                        placedThreadId: bcThread,
                        placedCampaignId: campaignIdNum
                    });

                    await adminRepository.logAction({
                        adminId: req.admin.adminId,
                        action: 'PROMOTION_BROADCAST_PLACE',
                        entityType: 'promotion_broadcast',
                        entityId: String(id),
                        details: {
                            campaign_id: campaignIdNum || null,
                            message_id: mid,
                            topic_test_mode: !!flow.topicTestMode
                        }
                    });

                    return res.json({
                        ok: true,
                        data: {
                            placement_status: 'placed',
                            placed_message_id: mid,
                            placed_campaign_id: campaignIdNum,
                            duplicate_campaign: !!flow.duplicate,
                            topic_test_mode: !!flow.topicTestMode,
                            test_mode_skipped: !!flow.testModeSkipped
                        }
                    });
                } catch (e) {
                    try {
                        await promotionService.setPromotionBroadcastPlaceFailed(
                            id,
                            String(e && e.message ? e.message : e).slice(0, 480)
                        );
                    } catch (_) {
                        /**/
                    }
                    console.error('[Admin] promotion broadcast place failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_BROADCAST_PLACE_FAILED' });
                }
            }
        );

        router.get(
            '/promotion/broadcasts/:id',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const row = await promotionService.getBroadcast(req.params.id);
                    if (!row) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
                    res.json({ ok: true, data: enrichBroadcastApiRow(row, { withLocalImage: true }) });
                } catch (e) {
                    console.error('[Admin] promotion broadcast detail failed:', e.message || e);
                    res.status(500).json({ ok: false, error: 'PROMOTION_BROADCAST_DETAIL_FAILED' });
                }
            }
        );

        router.get(
            '/promotion/broadcasts/:id/image',
            auth.requirePermission(ADMIN_PERMISSIONS.ADMIN_PROMOTION_MANAGE),
            async (req, res) => {
                try {
                    const row = await promotionService.getBroadcast(req.params.id);
                    if (!row || !row.image_storage_path) return res.status(404).end();
                    const full = promotionService.resolveImageFullPath(row.image_storage_path);
                    if (!full || !fs.existsSync(full)) return res.status(404).end();
                    const ext = path.extname(full).toLowerCase();
                    const type =
                        ext === '.png'
                            ? 'image/png'
                            : ext === '.webp'
                              ? 'image/webp'
                              : ext === '.jpg' || ext === '.jpeg'
                                ? 'image/jpeg'
                                : 'application/octet-stream';
                    res.setHeader('Content-Type', type);
                    res.setHeader('Cache-Control', 'private, max-age=3600');
                    fs.createReadStream(full).pipe(res);
                } catch (e) {
                    console.error('[Admin] promotion broadcast image failed:', e.message || e);
                    res.status(500).end();
                }
            }
        );
    }

    return router;
}

module.exports = {
    createAdminRouter
};

