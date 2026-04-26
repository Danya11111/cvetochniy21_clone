const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

/**
 * Stateless HMAC token: embeds verified Telegram initData for one GET /admin-embed?h=...
 * TTL enforced in payload (exp unix sec).
 */
function signAdminOpenToken(initDataRaw, telegramId, secret, ttlSec = 90) {
    const exp = Math.floor(Date.now() / 1000) + Number(ttlSec || 90);
    const payload = Buffer.from(
        JSON.stringify({
            v: 1,
            exp,
            tg: String(telegramId || ''),
            d: String(initDataRaw || '')
        }),
        'utf8'
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyAdminOpenToken(token, secret) {
    const raw = String(token || '').trim();
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return { ok: false, reason: 'format' };
    const payloadB64 = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expected = crypto.createHmac('sha256', String(secret || '')).update(payloadB64).digest('base64url');
    if (!timingSafeEqualStr(sig, expected)) return { ok: false, reason: 'bad_sig' };
    let data;
    try {
        data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch (_) {
        return { ok: false, reason: 'bad_payload' };
    }
    if (data.v !== 1) return { ok: false, reason: 'bad_ver' };
    const now = Math.floor(Date.now() / 1000);
    if (typeof data.exp !== 'number' || data.exp < now) return { ok: false, reason: 'expired' };
    const tokenTtlSec = Math.max(0, data.exp - now);
    return {
        ok: true,
        initDataRaw: String(data.d || ''),
        telegramId: String(data.tg || ''),
        tokenTtlSec
    };
}

module.exports = {
    signAdminOpenToken,
    verifyAdminOpenToken
};
