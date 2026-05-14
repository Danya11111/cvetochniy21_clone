const crypto = require('crypto');
const { ALL_ADMIN_PERMISSIONS } = require('./admin-permissions');

function normalizePermissions(perms) {
    if (!Array.isArray(perms)) return [];
    return perms.map(String).filter(Boolean);
}

function createAdminAuth({ config, adminUsersService, logger = console } = {}) {
    const classifyMatch = config.classifyAdminTelegramMatchSource;
    const maxAgeSec = Number(config.ADMIN_INITDATA_MAX_AGE_SEC || 86400);
    const botToken = String(config.TELEGRAM_BOT_TOKEN || '').trim();

    function timingSafeEqualHex(a, b) {
        const left = Buffer.from(String(a || ''), 'utf8');
        const right = Buffer.from(String(b || ''), 'utf8');
        if (left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    }

    function verifyInitData(initDataRaw) {
        const raw = String(initDataRaw || '').trim();
        if (!raw || !botToken) return { ok: false, error: 'NO_INIT_DATA' };
        const params = new URLSearchParams(raw);
        const hash = String(params.get('hash') || '').trim();
        if (!hash) return { ok: false, error: 'NO_HASH' };

        const pairs = [];
        for (const [key, value] of params.entries()) {
            if (key === 'hash') continue;
            pairs.push(`${key}=${value}`);
        }
        pairs.sort((a, b) => a.localeCompare(b));
        const dataCheckString = pairs.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (!timingSafeEqualHex(expectedHash, hash)) {
            return { ok: false, error: 'BAD_HASH' };
        }

        const authDate = Number(params.get('auth_date') || 0);
        if (Number.isFinite(authDate) && authDate > 0 && Number.isFinite(maxAgeSec) && maxAgeSec > 0) {
            const now = Math.floor(Date.now() / 1000);
            if (now - authDate > maxAgeSec) {
                return { ok: false, error: 'INIT_DATA_EXPIRED' };
            }
        }

        let user = null;
        try {
            const rawUser = String(params.get('user') || '').trim();
            user = rawUser ? JSON.parse(rawUser) : null;
        } catch (_) {
            return { ok: false, error: 'BAD_USER_JSON' };
        }
        const telegramId = String(user?.id || '').trim();
        if (!telegramId) return { ok: false, error: 'NO_TELEGRAM_ID' };
        return { ok: true, telegramId, user, initDataRaw: raw };
    }

    function principalFromVerified(verified) {
        const tid = String(verified.telegramId || '').trim();
        return {
            adminId: `tg:${tid}`,
            name: String(verified.user?.first_name || verified.user?.username || `Telegram ${tid}`),
            telegramId: tid,
            username: verified.user?.username ? String(verified.user.username) : null,
            permissions: normalizePermissions(ALL_ADMIN_PERMISSIONS),
            initDataRaw: verified.initDataRaw
        };
    }

    async function finalizeAllowedPrincipal(verified, { stage = 'resolve' } = {}) {
        if (!verified?.ok) {
            logger.warn('[AdminAccess] deny', {
                telegramId: null,
                matchedBy: 'none',
                stage,
                reason: verified?.error || 'VERIFY_FAILED'
            });
            return null;
        }
        const tid = String(verified.telegramId || '').trim();
        const allowedFn = adminUsersService && typeof adminUsersService.isAllowedTelegramId === 'function';
        const allowed = allowedFn ? await adminUsersService.isAllowedTelegramId(tid) : false;
        if (!allowed) {
            logger.warn('[AdminAccess] deny', { telegramId: tid, matchedBy: 'none', stage, reason: 'NOT_IN_ADMIN_DB' });
            return null;
        }
        const matchedBy = typeof classifyMatch === 'function' ? classifyMatch(tid) : 'db';
        const quietAllow = String(stage || '').includes('/api/admin/access');
        if (!quietAllow) {
            logger.log('[AdminAccess] allow', { telegramId: tid, matchedBy, stage });
        }
        return principalFromVerified(verified);
    }

    /** После проверки signed token (/admin-embed): initData корректен и пользователь в admin_users или владелец. */
    async function resolveFromInitDataRaw(initDataRaw) {
        const verified = verifyInitData(initDataRaw);
        const principal = await finalizeAllowedPrincipal(verified, { stage: 'embed_token' });
        if (!principal) {
            return { ok: false, error: verified?.error || 'ADMIN_UNAUTHORIZED' };
        }
        return { ok: true, principal, initDataRaw: principal.initDataRaw };
    }

    /** API: заголовок x-telegram-init-data или tgWebAppData в query */
    async function resolveAdminFromRequest(req) {
        const initDataRaw = String(req.headers['x-telegram-init-data'] || req.query.tgWebAppData || '').trim();
        const verified = verifyInitData(initDataRaw);
        const stage = String(req.path || req.url || 'api_admin').slice(0, 120);
        const stageLabel = `request:${stage}`;
        if (!verified?.ok) {
            logger.warn('[AdminAccess] deny', {
                telegramId: null,
                matchedBy: 'none',
                stage: stageLabel,
                reason: verified?.error || 'VERIFY_FAILED'
            });
            return { ok: false, error: verified.error || 'ADMIN_UNAUTHORIZED' };
        }
        const principal = await finalizeAllowedPrincipal(verified, { stage: stageLabel });
        if (!principal) {
            return { ok: false, error: 'ADMIN_UNAUTHORIZED' };
        }
        return { ok: true, principal, initDataRaw: principal.initDataRaw };
    }

    function requireAdmin(req, res, next) {
        resolveAdminFromRequest(req)
            .then((resolved) => {
                const principal = resolved.principal;
                if (!principal) {
                    return res.status(401).json({ ok: false, error: resolved.error || 'ADMIN_UNAUTHORIZED' });
                }
                req.admin = principal;
                next();
            })
            .catch((e) => {
                logger.error('[AdminAuth] requireAdmin failed:', e.message || e);
                res.status(500).json({ ok: false, error: 'ADMIN_AUTH_FAILED' });
            });
    }

    function requirePermission(permission) {
        return (req, res, next) => {
            const perms = req.admin?.permissions || [];
            if (!perms.includes(permission)) {
                logger.warn('[AdminAuth] permission denied', {
                    adminId: req.admin?.adminId || null,
                    permission
                });
                return res.status(403).json({ ok: false, error: 'ADMIN_FORBIDDEN', permission });
            }
            next();
        };
    }

    return {
        requireAdmin,
        requirePermission,
        resolveAdminFromRequest,
        resolveFromInitDataRaw,
        verifyInitData
    };
}

module.exports = {
    createAdminAuth
};
