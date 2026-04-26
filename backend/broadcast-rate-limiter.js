function sleep(ms) {
    const n = Math.max(0, Number(ms) || 0);
    return new Promise((r) => setTimeout(r, n));
}

/**
 * Глобальный token bucket + не чаще 1 сообщения в чат за perChatMinIntervalMs (Telegram per-chat).
 * @param {{ globalMessagesPerSec: number, perChatMinIntervalMs?: number, logger?: Console }} opts
 */
function createBroadcastRateLimiter({ globalMessagesPerSec, perChatMinIntervalMs = 1000, logger = console }) {
    const rate = Math.max(0.1, Number(globalMessagesPerSec) || 18);
    const perChatMs = Math.max(0, Number(perChatMinIntervalMs) || 0);
    const capacity = Math.max(rate * 3, rate);
    let tokens = capacity;
    let lastRefill = Date.now();
    const lastChatSend = new Map();

    function refill() {
        const now = Date.now();
        const elapsed = (now - lastRefill) / 1000;
        lastRefill = now;
        tokens = Math.min(capacity, tokens + elapsed * rate);
    }

    /**
     * Ждёт per-chat интервал и глобальный токен перед одним copyMessage.
     * @param {string|number} chatId
     */
    async function acquireForChat(chatId) {
        const cid = String(chatId);
        if (perChatMs > 0) {
            const prev = lastChatSend.get(cid) || 0;
            const wait = Math.max(0, perChatMs - (Date.now() - prev));
            if (wait > 0) {
                logger.log?.('[BroadcastRateLimiter] per_chat_spacing_wait', {
                    chatId: cid,
                    waitMs: Math.round(wait),
                    perChatMinIntervalMs: perChatMs
                });
                await sleep(wait);
            }
        }
        // Token bucket: не блокируем всю очередь при 429 у другого чата — только этот await.
        while (true) {
            refill();
            if (tokens >= 1) {
                tokens -= 1;
                lastChatSend.set(cid, Date.now());
                return;
            }
            const need = 1 - tokens;
            const waitMs = Math.min(2500, Math.max(5, (need / rate) * 1000));
            logger.log?.('[BroadcastRateLimiter] global_token_bucket_wait', {
                waitMs: Math.round(waitMs),
                tokensApprox: Number(tokens.toFixed(3)),
                globalMessagesPerSec: rate
            });
            await sleep(waitMs);
        }
    }

    function snapshot() {
        refill();
        return {
            globalMessagesPerSec: rate,
            perChatMinIntervalMs: perChatMs,
            tokensApprox: Number(tokens.toFixed(3)),
            capacityApprox: Number(capacity.toFixed(1))
        };
    }

    return { acquireForChat, snapshot };
}

module.exports = {
    createBroadcastRateLimiter,
    sleep
};
