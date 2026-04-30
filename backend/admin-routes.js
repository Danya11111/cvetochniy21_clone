const express = require('express');
const { ADMIN_PERMISSIONS, ALL_ADMIN_PERMISSIONS } = require('./admin-permissions');
const { getDashboardV2ApiPayload } = require('./admin-dashboard-service');

function createAdminRouter({
    auth,
    adminRepository,
    runtimeFlagsService,
    broadcastService,
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
                audit: true
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

    return router;
}

module.exports = {
    createAdminRouter
};

