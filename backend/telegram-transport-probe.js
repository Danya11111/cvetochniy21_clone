/**
 * Активный probe Bot API (getMe) по тому же пути, что и приложение.
 * Состояние расписания: telegram-transport-health (nextProbeDueAt).
 */

const transportHealth = require('./telegram-transport-health');

/**
 * @param {{ consecutiveFailures: number, baseIntervalMs: number, backoffMaxMs: number }} p
 * @returns {number}
 */
function computeNextProbeDelayMs(p) {
    const base = Math.max(5_000, Number(p.baseIntervalMs) || 60_000);
    const maxB = Math.max(base, Number(p.backoffMaxMs) || 300_000);
    const f = Math.max(0, Math.min(8, Number(p.consecutiveFailures) || 0));
    const exp = Math.min(maxB, base * Math.pow(2, f));
    return Math.round(exp);
}

/**
 * @param {object} opts
 * @param {{ getMe: () => Promise<{ ok?: boolean, errorCode?: string }> }} opts.telegramClient
 * @param {Console} [opts.logger]
 * @param {boolean} opts.probeEnabled
 * @param {() => { outboundEnabled: boolean, httpClientPresent: boolean, proxyConfigured?: boolean, transportMode?: string }} opts.getTransportContext
 * @param {number} opts.baseIntervalMs
 * @param {number} opts.backoffMaxMs
 * @param {number} opts.initialDelayMs
 * @param {() => Promise<unknown>} [opts.onAfterSuccessfulProbe]
 */
function startTelegramTransportProbe(opts) {
    const logger = opts.logger || console;
    let timer = null;
    let stopped = false;

    function clearTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function scheduleNext(delayMs) {
        const d = Math.max(1_000, Number(delayMs) || 60_000);
        transportHealth.setTransportProbeNextDueAtMs(Date.now() + d);
        clearTimer();
        if (stopped) return;
        timer = setTimeout(tick, d);
        timer.unref?.();
    }

    async function tick() {
        if (stopped) return;
        const getCtx = typeof opts.getTransportContext === 'function' ? opts.getTransportContext : () => ({});
        const { outboundEnabled, httpClientPresent, proxyConfigured, transportMode } = getCtx() || {};

        try {
            if (!opts.probeEnabled) {
                transportHealth.recordTransportProbeSkipped('PROBE_DISABLED');
                logger.log?.('[TelegramTransportProbe] scheduled', { skipped: true, reason: 'PROBE_DISABLED' });
                scheduleNext(opts.baseIntervalMs || 60_000);
                return;
            }
            if (!outboundEnabled || !httpClientPresent) {
                transportHealth.recordTransportProbeSkipped(!outboundEnabled ? 'OUTBOUND_DISABLED' : 'NO_HTTP_CLIENT');
                logger.log?.('[TelegramTransportProbe] scheduled', {
                    skipped: true,
                    reason: !outboundEnabled ? 'OUTBOUND_DISABLED' : 'NO_HTTP_CLIENT'
                });
                scheduleNext(opts.baseIntervalMs || 60_000);
                return;
            }

            const ctx = {
                outboundEnabled: Boolean(outboundEnabled),
                httpClientPresent: Boolean(httpClientPresent),
                proxyConfigured: Boolean(proxyConfigured),
                transportMode: String(transportMode || 'unknown')
            };
            const snapBefore = transportHealth.getTelegramTransportHealthSnapshot(ctx);
            const wasDegraded = Boolean(snapBefore.degraded);

            logger.log?.('[TelegramTransportProbe] scheduled', {
                method: 'getMe',
                wasDegraded,
                nextProbeDueAt:
                    transportHealth.getTransportProbeInternalState().nextProbeDueAtMs != null
                        ? new Date(
                              transportHealth.getTransportProbeInternalState().nextProbeDueAtMs
                          ).toISOString()
                        : null
            });

            const r = await opts.telegramClient.getMe();
            const ok = Boolean(r && r.ok);
            const code = String((r && r.errorCode) || '');

            transportHealth.recordTransportProbeResult({ ok, errorCode: ok ? '' : code, method: 'getMe' });

            if (ok) {
                logger.log?.('[TelegramTransportProbe] success', { method: 'getMe' });
                if (wasDegraded) {
                    logger.log?.('[TelegramTransport] recovered_by_probe', {
                        method: 'getMe',
                        tag: 'TELEGRAM_TRANSPORT_PROBE_RECOVERY'
                    });
                }
                if (typeof opts.onAfterSuccessfulProbe === 'function') {
                    try {
                        await opts.onAfterSuccessfulProbe();
                    } catch (e) {
                        logger.warn?.('[TelegramTransportProbe] onAfterSuccessfulProbe_failed', {
                            message: e.message || String(e)
                        });
                    }
                }
            } else {
                logger.warn?.('[TelegramTransportProbe] failed', {
                    method: 'getMe',
                    errorCode: code || 'UNKNOWN',
                    tag: 'TELEGRAM_TRANSPORT_PROBE_FAIL'
                });
            }

            const st = transportHealth.getTransportProbeInternalState();
            const delay = computeNextProbeDelayMs({
                consecutiveFailures: st.consecutiveProbeFailures,
                baseIntervalMs: opts.baseIntervalMs,
                backoffMaxMs: opts.backoffMaxMs
            });
            scheduleNext(delay);
        } catch (e) {
            logger.warn?.('[TelegramTransportProbe] tick_exception', { message: e.message || String(e) });
            transportHealth.recordTransportProbeResult({
                ok: false,
                errorCode: 'PROBE_EXCEPTION',
                method: 'getMe'
            });
            const st = transportHealth.getTransportProbeInternalState();
            scheduleNext(
                computeNextProbeDelayMs({
                    consecutiveFailures: st.consecutiveProbeFailures,
                    baseIntervalMs: opts.baseIntervalMs,
                    backoffMaxMs: opts.backoffMaxMs
                })
            );
        }
    }

    const firstDelay = Math.max(2_000, Number(opts.initialDelayMs) || 8_000);
    transportHealth.setTransportProbeNextDueAtMs(Date.now() + firstDelay);
    clearTimer();
    timer = setTimeout(tick, firstDelay);
    timer.unref?.();

    return {
        stop() {
            stopped = true;
            clearTimer();
            transportHealth.setTransportProbeNextDueAtMs(null);
        }
    };
}

module.exports = {
    computeNextProbeDelayMs,
    startTelegramTransportProbe
};
