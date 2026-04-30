'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { sqlOrderPaidRevenueKopecks } = require('./money');

const START_PREFIX = 'src_';
const MAX_TITLE_LEN = 120;
const MAX_CODE_LEN = 64;
const MAX_BROADCAST_BODY = 4096;
const MAX_KEYWORD_LEN = 64;
const MAX_BASE64_PAYLOAD = 700000;

/** @typedef {{ db: import('sqlite3').Database }} Deps */

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function dbRun(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function RunCb(err) {
            if (err) return reject(err);
            resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function getBotUsername(config, runtimeBotProfile) {
    const envU = String(config.TELEGRAM_BOT_USERNAME || '')
        .trim()
        .replace(/^@/, '');
    if (envU) return envU;
    const rt = runtimeBotProfile && String(runtimeBotProfile.username || '').trim().replace(/^@/, '');
    return rt || '';
}

function safeTrackingCode(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, MAX_CODE_LEN);
}

function slugFromTitle(title) {
    const t = String(title || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 48);
    if (t.length >= 2) return t;
    return `src_${Date.now()}`;
}

function normalizeKeyword(k) {
    return String(k || '')
        .trim()
        .toLowerCase()
        .slice(0, MAX_KEYWORD_LEN);
}

function buildStartPayload(code) {
    return `${START_PREFIX}${code}`;
}

/**
 * @param {{ db: import('sqlite3').Database, config: object, runtimeBotProfile?: { username?: string | null }}} opts
 */
function createPromotionService({ db, config, runtimeBotProfile = null }) {
    const uploadRoot = path.join(__dirname, 'data', 'promotion-uploads');

    function ensureUploadRoot() {
        try {
            fs.mkdirSync(uploadRoot, { recursive: true });
        } catch (_) {}
    }

    function buildTrackingUrl(code) {
        const bot = getBotUsername(config, runtimeBotProfile);
        if (!bot) {
            const err = new Error('TELEGRAM_BOT_USERNAME_REQUIRED');
            err.code = 'TELEGRAM_BOT_USERNAME_REQUIRED';
            throw err;
        }
        return `https://t.me/${bot}?start=${encodeURIComponent(buildStartPayload(code))}`;
    }

    /**
     * @param {string} payload raw /start deep link payload
     */
    function parseSourceCodeFromStartPayload(payload) {
        const p = String(payload || '').trim();
        if (!p.toLowerCase().startsWith(START_PREFIX)) return null;
        const rest = p.slice(START_PREFIX.length).trim();
        const code = safeTrackingCode(rest);
        return code || null;
    }

    async function ensureUniqueCode(baseCode) {
        let c = baseCode;
        let n = 0;
        while (n < 50) {
            const row = await dbGet(db, 'SELECT id FROM promotion_sources WHERE code = ?', [c]);
            if (!row) return c;
            n += 1;
            c = `${baseCode}_${n}`;
            if (c.length > MAX_CODE_LEN) c = `${baseCode.slice(0, Math.max(1, MAX_CODE_LEN - 4))}_${n}`;
        }
        throw new Error('CODE_GENERATION_FAILED');
    }

    async function recordSourceClickFromStart(message, startPayload) {
        const code = parseSourceCodeFromStartPayload(startPayload);
        if (!code) return { recorded: false };

        const src = await dbGet(
            db,
            'SELECT id, code FROM promotion_sources WHERE code = ? AND COALESCE(is_active,1) = 1',
            [code]
        );
        if (!src) {
            return { recorded: false, unknownCode: code };
        }

        const tid = String(message.from?.id || '').trim();
        if (!tid) return { recorded: false };

        const username = message.from?.username ? String(message.from.username) : null;
        const fullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').trim() || null;
        const now = new Date().toISOString();

        await dbRun(
            db,
            `INSERT INTO promotion_source_clicks (source_id, source_code, telegram_id, username, full_name, clicked_at, raw_payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [src.id, src.code, tid, username, fullName, now, String(startPayload || '').slice(0, 512)]
        );

        await dbRun(
            db,
            `UPDATE users SET
                first_source_code = COALESCE(first_source_code, ?),
                last_source_code = ?
             WHERE telegram_id = ?`,
            [code, code, tid]
        );

        return { recorded: true, code };
    }

    /**
     * Если сообщение совпало с активным кодовым словом — пишет отклик в БД и возвращает true
     * (чтобы downstream не отправлял текст в поддержку). Сообщения пользователю не отправляет.
     * @returns {Promise<boolean>}
     */
    async function handleKeywordReply(_telegramClient, message, logger = console) {
        const chatType = String(message.chat?.type || '');
        if (chatType !== 'private') return false;
        const text = message.text != null ? String(message.text).trim() : '';
        if (!text || text.startsWith('/') || text.length > MAX_KEYWORD_LEN + 20) return false;

        const kw = normalizeKeyword(text);
        if (!kw || kw.length < 2) return false;

        /** Не перехватываем технические строки */
        if (/^(start_welcome_consent|manager_help_request|adm:)/i.test(text)) return false;

        const row = await dbGet(
            db,
            `SELECT * FROM promotion_broadcasts
             WHERE status = 'active' AND keyword = ?
             ORDER BY id DESC LIMIT 1`,
            [kw]
        );
        if (!row) return false;

        const tid = String(message.from?.id || '').trim();
        if (!tid) return false;

        const existing = await dbGet(
            db,
            'SELECT id FROM promotion_broadcast_responses WHERE broadcast_id = ? AND telegram_id = ?',
            [row.id, tid]
        );

        const username = message.from?.username ? String(message.from.username) : null;
        const fullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').trim() || null;
        const now = new Date().toISOString();

        if (existing) {
            return true;
        }

        try {
            await dbRun(
                db,
                `INSERT INTO promotion_broadcast_responses (broadcast_id, keyword, telegram_id, username, full_name, message_text, responded_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.keyword, tid, username, fullName, text.slice(0, 512), now]
            );
        } catch (e) {
            const msg = String(e && e.message);
            if (msg.includes('UNIQUE') || msg.toLowerCase().includes('constraint')) {
                return true;
            }
            throw e;
        }

        logger.log('[Promotion] keyword_response_recorded', { broadcastId: row.id, keyword: row.keyword, tid });
        return true;
    }

    async function listSources() {
        const rows = await dbAll(
            db,
            `SELECT s.*,
                (SELECT COUNT(*) FROM promotion_source_clicks c WHERE c.source_id = s.id) AS clicks_count,
                (SELECT COUNT(DISTINCT telegram_id) FROM promotion_source_clicks c WHERE c.source_id = s.id) AS unique_users_count
             FROM promotion_sources s
             WHERE COALESCE(s.is_active, 1) = 1
             ORDER BY s.created_at DESC`
        );
        const revExpr = sqlOrderPaidRevenueKopecks('o');
        const out = [];
        for (const r of rows) {
            const code = String(r.code || '');
            const paidAgg = await dbGet(
                db,
                `SELECT
                    COUNT(*) AS paid_orders,
                    COALESCE(SUM((${revExpr})), 0) AS revenue_k
                 FROM orders o
                 WHERE o.source_code = ?`,
                [code]
            );
            let url = '';
            try {
                url = buildTrackingUrl(code);
            } catch (_) {
                url = '';
            }
            out.push({
                id: r.id,
                code,
                title: r.title,
                created_at: r.created_at,
                created_by_telegram_id: r.created_by_telegram_id,
                is_active: Number(r.is_active) !== 0,
                clicks_count: Number(r.clicks_count || 0),
                unique_users_count: Number(r.unique_users_count || 0),
                paid_orders_count: Math.round(Number(paidAgg?.paid_orders || 0)),
                paid_revenue_kopecks: Math.round(Number(paidAgg?.revenue_k || 0)),
                tracking_url: url
            });
        }
        return out;
    }

    async function getSourceDetail(code) {
        const c = safeTrackingCode(code);
        if (!c) return null;
        const s = await dbGet(
            db,
            'SELECT * FROM promotion_sources WHERE code = ? AND COALESCE(is_active, 1) = 1',
            [c]
        );
        if (!s) return null;

        const clicks = await dbGet(
            db,
            'SELECT COUNT(*) AS c FROM promotion_source_clicks WHERE source_id = ?',
            [s.id]
        );
        const uniq = await dbGet(
            db,
            'SELECT COUNT(DISTINCT telegram_id) AS c FROM promotion_source_clicks WHERE source_id = ?',
            [s.id]
        );
        const revExpr = sqlOrderPaidRevenueKopecks('o');
        const ord = await dbGet(
            db,
            `SELECT
                COUNT(*) AS created_orders,
                SUM(CASE WHEN (${revExpr}) > 0 THEN 1 ELSE 0 END) AS paid_orders,
                COALESCE(SUM((${revExpr})), 0) AS revenue_k
             FROM orders o
             WHERE o.source_code = ?`,
            [c]
        );

        let tracking_url = '';
        try {
            tracking_url = buildTrackingUrl(c);
        } catch (_) {}

        return {
            ...s,
            clicks_count: Number(clicks?.c || 0),
            unique_users_count: Number(uniq?.c || 0),
            created_orders_count: Math.round(Number(ord?.created_orders || 0)),
            paid_orders_count: Math.round(Number(ord?.paid_orders || 0)),
            paid_revenue_kopecks: Math.round(Number(ord?.revenue_k || 0)),
            tracking_url
        };
    }

    async function createSource({ title, code: codeInput, createdByTgId }) {
        const t = String(title || '').trim().slice(0, MAX_TITLE_LEN);
        if (!t) {
            const e = new Error('TITLE_REQUIRED');
            e.code = 'TITLE_REQUIRED';
            throw e;
        }
        let base = codeInput != null && String(codeInput).trim() ? safeTrackingCode(codeInput) : slugFromTitle(t);
        if (!base) base = `src_${Date.now()}`;
        const code = await ensureUniqueCode(base);
        const now = new Date().toISOString();
        const cid = String(createdByTgId || '').trim() || null;
        await dbRun(
            db,
            `INSERT INTO promotion_sources (code, title, created_at, created_by_telegram_id, is_active)
             VALUES (?, ?, ?, ?, 1)`,
            [code, t, now, cid]
        );
        let tracking_url = '';
        try {
            tracking_url = buildTrackingUrl(code);
        } catch (e) {
            /* ok */
        }
        return { code, title: t, created_at: now, tracking_url };
    }

    /**
     * Скрывает источник из админки (soft delete через is_active=0).
     * Клики и заказы с source_code остаются в БД; новые переходы по ссылке не пишутся.
     */
    async function deactivateSource(codeRaw) {
        const c = safeTrackingCode(codeRaw);
        if (!c) {
            const err = new Error('NOT_FOUND');
            err.code = 'NOT_FOUND';
            throw err;
        }
        const row = await dbGet(
            db,
            'SELECT id, COALESCE(is_active, 1) AS a FROM promotion_sources WHERE code = ?',
            [c]
        );
        if (!row) {
            const err = new Error('NOT_FOUND');
            err.code = 'NOT_FOUND';
            throw err;
        }
        if (Number(row.a) === 0) return { code: c };
        await dbRun(db, `UPDATE promotion_sources SET is_active = 0 WHERE code = ? AND COALESCE(is_active, 1) = 1`, [c]);
        return { code: c };
    }

    async function listBroadcasts(limit = 30) {
        const lim = Math.min(100, Math.max(1, Number(limit) || 30));
        return dbAll(
            db,
            `SELECT b.*,
                (SELECT COUNT(*) FROM promotion_broadcast_responses r WHERE r.broadcast_id = b.id) AS response_count
             FROM promotion_broadcasts b
             ORDER BY b.created_at DESC
             LIMIT ?`,
            [lim]
        );
    }

    async function getBroadcast(id) {
        const row = await dbGet(db, 'SELECT * FROM promotion_broadcasts WHERE id = ?', [Number(id)]);
        if (!row) return null;
        const cnt = await dbGet(
            db,
            'SELECT COUNT(*) AS c FROM promotion_broadcast_responses WHERE broadcast_id = ?',
            [row.id]
        );
        return { ...row, response_count: Number(cnt?.c || 0) };
    }

    function saveImageBase64(dataUrlOrB64) {
        const raw = String(dataUrlOrB64 || '').trim();
        if (!raw) return null;
        if (raw.length > MAX_BASE64_PAYLOAD) {
            const e = new Error('IMAGE_TOO_LARGE');
            e.code = 'IMAGE_TOO_LARGE';
            throw e;
        }
        let b64 = raw;
        let ext = 'jpg';
        const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(raw);
        if (m) {
            ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
            b64 = m[2];
        }
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 600 * 1024) {
            const e = new Error('IMAGE_TOO_LARGE');
            e.code = 'IMAGE_TOO_LARGE';
            throw e;
        }
        if (buf.length < 32) {
            const e = new Error('IMAGE_INVALID');
            e.code = 'IMAGE_INVALID';
            throw e;
        }
        ensureUploadRoot();
        const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
        const rel = path.join('data', 'promotion-uploads', name);
        const full = path.join(__dirname, rel);
        fs.writeFileSync(full, buf);
        return rel.replace(/\\/g, '/');
    }

    async function createBroadcast({ title, bodyText, keyword, imageUrl, imageBase64, createdByTgId }) {
        const body = String(bodyText || '').trim().slice(0, MAX_BROADCAST_BODY);
        if (!body) {
            const e = new Error('BODY_REQUIRED');
            e.code = 'BODY_REQUIRED';
            throw e;
        }
        const kw = normalizeKeyword(keyword);
        if (!kw || kw.length < 2) {
            const e = new Error('KEYWORD_REQUIRED');
            e.code = 'KEYWORD_REQUIRED';
            throw e;
        }

        const dup = await dbGet(db, 'SELECT id FROM promotion_broadcasts WHERE keyword = ?', [kw]);
        if (dup) {
            const e = new Error('KEYWORD_DUPLICATE');
            e.code = 'KEYWORD_DUPLICATE';
            throw e;
        }

        let image_storage_path = null;
        let image_url = imageUrl != null ? String(imageUrl).trim().slice(0, 2000) : '';
        if (!image_url && imageBase64) {
            image_storage_path = saveImageBase64(imageBase64);
        } else if (image_url) {
            /* внешний URL */
        } else {
            image_url = null;
        }

        const now = new Date().toISOString();
        const ttl = title != null ? String(title).trim().slice(0, MAX_TITLE_LEN) : null;
        const cid = String(createdByTgId || '').trim() || null;

        const r = await dbRun(
            db,
            `INSERT INTO promotion_broadcasts (title, body_text, image_url, image_storage_path, keyword, status, created_at, created_by_telegram_id)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
            [ttl || null, body, image_url || null, image_storage_path, kw, now, cid]
        );
        return { id: r.lastID, keyword: kw, created_at: now, placement_status: 'draft' };
    }

    async function setPromotionBroadcastPlaced(rowId, payload) {
        const rid = Number(rowId);
        const now = payload.placedAt || new Date().toISOString();
        await dbRun(
            db,
            `UPDATE promotion_broadcasts SET
                placement_status = 'placed',
                placed_at = ?,
                placed_message_id = ?,
                placed_chat_id = ?,
                placed_thread_id = ?,
                placed_campaign_id = ?,
                place_error = NULL
             WHERE id = ?`,
            [
                now,
                Number(payload.placedMessageId) > 0 ? Number(payload.placedMessageId) : null,
                String(payload.placedChatId || '').trim(),
                Number(payload.placedThreadId || 0) > 0 ? Number(payload.placedThreadId || 0) : null,
                Number(payload.placedCampaignId || 0) > 0 ? Number(payload.placedCampaignId || 0) : null,
                rid
            ]
        );
    }

    async function setPromotionBroadcastPlaceFailed(rowId, errMsg) {
        await dbRun(
            db,
            `UPDATE promotion_broadcasts SET placement_status = 'place_failed', place_error = ? WHERE id = ?`,
            [String(errMsg || 'PLACE_FAILED').slice(0, 500), Number(rowId)]
        );
    }

    function resolveImageFullPath(storagePath) {
        if (!storagePath) return null;
        const rel = String(storagePath).replace(/^\//, '');
        return path.join(__dirname, rel);
    }

    return {
        START_PREFIX,
        getBotUsername: () => getBotUsername(config, runtimeBotProfile),
        buildTrackingUrl,
        parseSourceCodeFromStartPayload,
        recordSourceClickFromStart,
        handleKeywordReply,
        listSources,
        getSourceDetail,
        createSource,
        deactivateSource,
        listBroadcasts,
        getBroadcast,
        createBroadcast,
        resolveImageFullPath,
        setPromotionBroadcastPlaced,
        setPromotionBroadcastPlaceFailed
    };
}

module.exports = {
    createPromotionService,
    START_PREFIX: 'src_'
};
