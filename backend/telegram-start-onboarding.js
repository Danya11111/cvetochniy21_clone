/**
 * Welcome /start в private: согласие → бонусы/каталог → (таймеры) менеджер + канал.
 * Не создаёт темы поддержки и не дублирует support relay (команда обрабатывается до handleClientMessage).
 */

const fs = require('fs');
const path = require('path');
const { resolveConsentCallbackContext } = require('./consent-callback-context');
const { buildManagerHelpReplyMarkup, MANAGER_HELP_CALLBACK_DATA } = require('./manager-help-constants');

const STEPS = {
    CONSENT_DOC: 'consent_doc',
    BONUS_PHOTO: 'bonus_photo',
    MANAGER_HELP: 'manager_help',
    CHANNEL_SUB: 'channel_sub'
};

/** callback_data (≤64 символов Bot API) */
const START_WELCOME_CONSENT_CB = 'start_welcome_consent';

const pendingStartPayloadByChat = new Map();
const onboardingTimersByChat = new Map();
const consentCallbackInFlight = new Set();

async function answerCallbackQueryLogged(telegramClient, logger, cq, payload) {
    const r = await telegramClient.answerCallbackQuery(payload);
    if (!r?.ok) {
        logger.warn('[TelegramCommand] answerCallbackQuery_failed', {
            callbackQueryId: String(cq?.id || ''),
            errorCode: r?.errorCode || null,
            message: r?.message ? String(r.message).slice(0, 200) : null
        });
    }
    return r;
}

function clearOnboardingTimers(chatId) {
    const key = String(chatId);
    const t = onboardingTimersByChat.get(key);
    if (!t) return;
    clearTimeout(t.step3);
    clearTimeout(t.step4);
    onboardingTimersByChat.delete(key);
}

function resolveMiniAppBase(config) {
    const raw = String(config.MINI_APP_URL || config.BASE_URL || '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
        return u.toString().replace(/\/$/, '');
    } catch (_) {
        return '';
    }
}

function resolveWelcomePhotoUrl(config) {
    const explicit = String(config.TELEGRAM_START_WELCOME_IMAGE_URL || '').trim();
    if (explicit) return explicit;
    const base = resolveMiniAppBase(config);
    if (!base) return '';
    return `${base}/images/cvet_21_logo_1.jpg`;
}

/**
 * Локальный файл бонус-картинки и URL для fallback (если multipart/URL не сработали — text-only).
 * @returns {{ resolvedLocalPath: string, hasLocalFile: boolean, urlFallback: string }}
 */
function resolveBonusPhotoAssets(config) {
    const rawPath = String(config.TELEGRAM_START_WELCOME_IMAGE_PATH || '').trim();
    const resolvedLocalPath = rawPath ? path.resolve(rawPath) : '';
    const hasLocalFile = !!(resolvedLocalPath && fs.existsSync(resolvedLocalPath));
    const urlFallback = resolveWelcomePhotoUrl(config);
    return { resolvedLocalPath, hasLocalFile, urlFallback: urlFallback || '' };
}

/**
 * @returns {{ url: string, source: 'TELEGRAM_CONSENT_DOCUMENT_URL' | 'BASE_URL_PLUS_TELEGRAM_CONSENT_PUBLIC_PATH' }}
 */
function resolveConsentDocumentUrl(config) {
    const explicit = String(config.TELEGRAM_CONSENT_DOCUMENT_URL || '').trim();
    if (explicit) {
        return { url: explicit, source: 'TELEGRAM_CONSENT_DOCUMENT_URL' };
    }
    const base = String(config.BASE_URL || '')
        .trim()
        .replace(/\/$/, '');
    if (!base) {
        return { url: '', source: 'BASE_URL_PLUS_TELEGRAM_CONSENT_PUBLIC_PATH' };
    }
    const suffix = String(config.TELEGRAM_CONSENT_PUBLIC_PATH || '/public/cvetochny21-consent.pdf').trim();
    const pathPart = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return { url: `${base}${pathPart}`, source: 'BASE_URL_PLUS_TELEGRAM_CONSENT_PUBLIC_PATH' };
}

/**
 * HEAD/GET (Range) без загрузки всего тела: final URL, status, Content-Type для сравнения с тем, что видит Telegram.
 * @param {string} targetUrl
 * @param {Console} logger
 */
async function probeConsentDocumentUrl(targetUrl, logger = console) {
    if (!targetUrl) {
        logger.log('[TelegramCommand] consent_doc_url_probe', { skipped: true, reason: 'empty_url' });
        return { skipped: true };
    }
    const row = { targetUrl };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    try {
        let res = await fetch(targetUrl, { method: 'HEAD', redirect: 'follow', signal: ac.signal });
        if (res.status === 405 || res.status === 501) {
            clearTimeout(timer);
            const ac2 = new AbortController();
            const t2 = setTimeout(() => ac2.abort(), 12000);
            try {
                res = await fetch(targetUrl, {
                    method: 'GET',
                    headers: { Range: 'bytes=0-0' },
                    redirect: 'follow',
                    signal: ac2.signal
                });
            } finally {
                clearTimeout(t2);
            }
            row.probe = 'GET_RANGE';
        } else {
            row.probe = 'HEAD';
        }
        row.finalUrl = res.url;
        row.status = res.status;
        row.contentType = res.headers.get('content-type');
        row.contentLength = res.headers.get('content-length');
    } catch (e) {
        row.error = String(e?.message || e);
    } finally {
        clearTimeout(timer);
    }
    logger.log('[TelegramCommand] consent_doc_url_probe', row);
    return row;
}

function buildDisplayName(from) {
    const first = String(from?.first_name || '').trim();
    const last = String(from?.last_name || '').trim();
    if (first && last) return `${first} ${last}`;
    return first || last || 'друг';
}

function buildBonusCaption(from, deepPayload) {
    const nameLine = buildDisplayName(from);
    let text =
        `${nameLine},\n\n` +
        'Мы первые в Чебоксарах, кто сделал такой формат — быстро и удобно 🤍\n\n' +
        'Можете заказать цветы по кнопке снизу "Каталог"👇🏼';
    if (deepPayload) {
        text += `\n\nВы перешли по ссылке с параметром (deep-link). Параметр: ${deepPayload.slice(0, 256)}`;
    }
    return text;
}

/**
 * @param {object} opts
 * @param {object} opts.telegramClient
 * @param {object} opts.config
 * @param {Console} [opts.logger]
 * @param {number|string} opts.chatId
 * @param {{ payload?: string | null }} opts.botCmd
 */
async function runStartOnboarding({ telegramClient, config, logger = console, chatId, botCmd }) {
    const { TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED } = config;

    const payload = String(botCmd?.payload || '').trim();
    pendingStartPayloadByChat.set(String(chatId), payload.length ? payload : null);
    clearOnboardingTimers(chatId);

    const { url: consentUrl, source: consentUrlSource } = resolveConsentDocumentUrl(config);
    const consentPdfPath = path.resolve(String(config.TELEGRAM_CONSENT_PDF_PATH || ''));
    const hasLocalConsentPdf = !!(consentPdfPath && fs.existsSync(consentPdfPath));

    logger.log('[TelegramCommand] consent_doc_url_resolved', {
        url: consentUrl || null,
        source: consentUrlSource,
        hasLocalPdf: hasLocalConsentPdf,
        consentPdfPath: consentPdfPath || null
    });

    if (consentUrl) {
        await probeConsentDocumentUrl(consentUrl, logger);
    } else {
        logger.log('[TelegramCommand] consent_doc_url_probe', { skipped: true, reason: 'no_public_url_only_local' });
    }

    if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
        logger.warn('[TelegramCommand] consent_sent skipped', {
            command: 'start',
            payloadPresent: !!payload,
            chatId: String(chatId),
            ok: false,
            errorCode: 'OUTBOUND_DISABLED'
        });
        logger.log('[TelegramCommand] response_sent', {
            command: 'start',
            chatId: String(chatId),
            payloadPresent: !!payload,
            ok: false,
            phase: 'consent',
            errorCode: 'OUTBOUND_DISABLED'
        });
        return { ok: false, errorCode: 'OUTBOUND_DISABLED' };
    }

    if (!consentUrl && !hasLocalConsentPdf) {
        logger.warn('[TelegramCommand] consent_sent skipped', {
            command: 'start',
            payloadPresent: !!payload,
            chatId: String(chatId),
            ok: false,
            errorCode: 'NO_CONSENT_DOCUMENT_URL'
        });
        logger.log('[TelegramCommand] response_sent', {
            command: 'start',
            chatId: String(chatId),
            payloadPresent: !!payload,
            ok: false,
            phase: 'consent',
            errorCode: 'NO_CONSENT_DOCUMENT_URL'
        });
        return { ok: false, errorCode: 'NO_CONSENT_DOCUMENT_URL' };
    }

    const consentCaption = 'Нажмите кнопку "Подтвердить", чтобы дать согласие и продолжить процесс.';
    const consentReplyMarkup = {
        inline_keyboard: [[{ text: 'Подтвердить', callback_data: START_WELCOME_CONSENT_CB }]]
    };

    try {
        let r = null;

        if (hasLocalConsentPdf) {
            logger.log('[TelegramCommand] consent_doc_send', {
                mode: 'multipart_local_pdf',
                file: consentPdfPath
            });
            r = await telegramClient.sendDocumentFromFile({
                chatId,
                filePath: consentPdfPath,
                caption: consentCaption,
                replyMarkup: consentReplyMarkup
            });
        }

        if (!r?.ok && consentUrl) {
            logger.log('[TelegramCommand] consent_doc_before_send_document', {
                documentUrl: consentUrl,
                source: consentUrlSource,
                afterLocalFail: !!(hasLocalConsentPdf && r && !r.ok)
            });
            r = await telegramClient.sendDocument({
                chatId,
                document: consentUrl,
                caption: consentCaption,
                replyMarkup: consentReplyMarkup
            });
        }
        if (r?.ok) {
            logger.log('[TelegramCommand] consent_sent', {
                chatId: String(chatId),
                payloadPresent: !!payload,
                ok: true
            });
            logger.log('[TelegramCommand] onboarding_step_sent', { step: STEPS.CONSENT_DOC, chatId: String(chatId), ok: true });
        } else {
            logger.warn('[TelegramCommand] onboarding_step_failed', {
                step: STEPS.CONSENT_DOC,
                chatId: String(chatId),
                errorCode: r?.errorCode || 'SEND_FAILED'
            });
            logger.warn('[TelegramCommand] consent_sent', {
                chatId: String(chatId),
                payloadPresent: !!payload,
                ok: false,
                errorCode: r?.errorCode || 'SEND_FAILED'
            });
        }

        logger.log('[TelegramCommand] response_sent', {
            command: 'start',
            chatId: String(chatId),
            payloadPresent: !!payload,
            ok: !!r?.ok,
            phase: 'consent',
            errorCode: r?.ok ? 'OK' : r?.errorCode || 'SEND_FAILED'
        });

        return { ok: !!r?.ok, errorCode: r?.ok ? 'OK' : r?.errorCode || 'SEND_FAILED' };
    } catch (e) {
        logger.warn('[TelegramCommand] onboarding_step_failed', {
            step: STEPS.CONSENT_DOC,
            chatId: String(chatId),
            errorCode: 'EXCEPTION',
            message: String(e?.message || e)
        });
        logger.log('[TelegramCommand] response_sent', {
            command: 'start',
            chatId: String(chatId),
            payloadPresent: !!payload,
            ok: false,
            phase: 'consent',
            errorCode: 'EXCEPTION'
        });
        return { ok: false, errorCode: 'EXCEPTION' };
    }
}

/**
 * Продолжение welcome после callback «Подтвердить».
 */
async function handleStartWelcomeConsentCallback({
    telegramClient,
    config,
    runtimeBotProfile = { username: null },
    logger = console,
    callbackQuery
}) {
    const cq = callbackQuery || {};
    const { data, chatId, chatType, chatResolveSource } = resolveConsentCallbackContext(callbackQuery);
    if (data !== START_WELCOME_CONSENT_CB) return { handled: false };

    const from = cq.from || {};
    const userId = String(from.id || '');

    logger.log('[TelegramCallback] welcome_consent_dispatch', {
        callbackData: data,
        chatResolveSource,
        chatType,
        hasMessage: !!cq.message,
        chatId: chatId != null ? String(chatId) : null
    });

    if (chatType !== 'private' || chatId == null) {
        logger.log('[TelegramCommand] consent_confirmed skipped', { reason: 'not_private_or_no_chat', chatType });
        await answerCallbackQueryLogged(
            telegramClient,
            logger,
            cq,
            {
                callbackQueryId: cq.id,
                text: 'Доступно только в личном чате с ботом',
                showAlert: false
            }
        );
        return { handled: true };
    }

    if (consentCallbackInFlight.has(userId)) {
        await answerCallbackQueryLogged(telegramClient, logger, cq, { callbackQueryId: cq.id, text: '' });
        return { handled: true };
    }
    consentCallbackInFlight.add(userId);

    const deepPayload = pendingStartPayloadByChat.get(String(chatId)) ?? null;
    pendingStartPayloadByChat.delete(String(chatId));

    try {
        await answerCallbackQueryLogged(telegramClient, logger, cq, { callbackQueryId: cq.id, text: '' });

        logger.log('[TelegramCommand] consent_confirmed', {
            chatId: String(chatId),
            userId,
            payloadPresent: !!deepPayload,
            chatResolveSource
        });

        const { TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED, TELEGRAM_CHANNEL_URL } = config;
        const delay3 = Number(config.TELEGRAM_ONBOARDING_MANAGER_DELAY_MS ?? 5000);
        const delay4 = Number(config.TELEGRAM_ONBOARDING_CHANNEL_DELAY_MS ?? 15000);

        if (!TELEGRAM_OUTBOUND_BOT_HTTP_ENABLED) {
            logger.warn('[TelegramCommand] onboarding_step_failed', {
                step: STEPS.BONUS_PHOTO,
                chatId: String(chatId),
                errorCode: 'OUTBOUND_DISABLED'
            });
            logger.log('[TelegramCommand] response_sent', {
                command: 'start',
                chatId: String(chatId),
                payloadPresent: !!deepPayload,
                ok: false,
                phase: 'after_consent',
                errorCode: 'OUTBOUND_DISABLED'
            });
            return { handled: true };
        }

        const webAppBase = resolveMiniAppBase(config);
        if (!webAppBase) {
            logger.warn('[TelegramCommand] onboarding_step_failed', {
                step: STEPS.BONUS_PHOTO,
                chatId: String(chatId),
                errorCode: 'NO_MINI_APP_URL'
            });
            logger.log('[TelegramCommand] response_sent', {
                command: 'start',
                chatId: String(chatId),
                payloadPresent: !!deepPayload,
                ok: false,
                phase: 'after_consent',
                errorCode: 'NO_MINI_APP_URL'
            });
            return { handled: true };
        }

        const catalogAppUrl = `${webAppBase}/?tab=shop`;
        const caption = buildBonusCaption(from, deepPayload);
        const catalogReplyMarkup = {
            inline_keyboard: [[{ text: 'Каталог', web_app: { url: catalogAppUrl } }]]
        };

        const { resolvedLocalPath, hasLocalFile, urlFallback } = resolveBonusPhotoAssets(config);
        logger.log('[TelegramCommand] bonus_photo_resolved', {
            chatId: String(chatId),
            localPath: resolvedLocalPath || null,
            hasLocalFile,
            urlFallback: urlFallback || null,
            explicitImageUrl: String(config.TELEGRAM_START_WELCOME_IMAGE_URL || '').trim() || null
        });

        clearOnboardingTimers(chatId);

        let bonusOk = false;

        if (hasLocalFile && resolvedLocalPath) {
            logger.log('[TelegramCommand] bonus_photo_send', {
                chatId: String(chatId),
                mode: 'multipart_local_photo',
                path: resolvedLocalPath
            });
            const pr = await telegramClient.sendPhotoFromFile({
                chatId,
                filePath: resolvedLocalPath,
                caption,
                replyMarkup: catalogReplyMarkup
            });
            if (pr?.ok) {
                bonusOk = true;
                logger.log('[TelegramCommand] onboarding_step_sent', { step: STEPS.BONUS_PHOTO, chatId: String(chatId), ok: true });
            } else {
                logger.warn('[TelegramCommand] bonus_photo_send', {
                    chatId: String(chatId),
                    mode: 'multipart_local_photo',
                    ok: false,
                    errorCode: pr?.errorCode || 'SEND_FAILED'
                });
            }
        }

        if (!bonusOk && urlFallback) {
            logger.log('[TelegramCommand] bonus_photo_send', { chatId: String(chatId), mode: 'url_fallback', url: urlFallback });
            const pr = await telegramClient.sendPhoto({
                chatId,
                photo: urlFallback,
                caption,
                replyMarkup: catalogReplyMarkup
            });
            if (pr?.ok) {
                bonusOk = true;
                logger.log('[TelegramCommand] onboarding_step_sent', { step: STEPS.BONUS_PHOTO, chatId: String(chatId), ok: true });
            } else {
                logger.warn('[TelegramCommand] bonus_photo_send', {
                    chatId: String(chatId),
                    mode: 'url_fallback',
                    ok: false,
                    errorCode: pr?.errorCode || 'SEND_FAILED'
                });
            }
        }

        if (!bonusOk) {
            logger.log('[TelegramCommand] bonus_photo_send', { chatId: String(chatId), mode: 'text_only_fallback' });
            const mr = await telegramClient.sendMessage({
                chatId,
                text: caption,
                replyMarkup: catalogReplyMarkup
            });
            if (mr?.ok) {
                logger.log('[TelegramCommand] onboarding_step_sent', {
                    step: STEPS.BONUS_PHOTO,
                    chatId: String(chatId),
                    ok: true,
                    note: 'text_only_fallback'
                });
            } else {
                logger.warn('[TelegramCommand] onboarding_step_failed', {
                    step: STEPS.BONUS_PHOTO,
                    chatId: String(chatId),
                    errorCode: mr?.errorCode || 'SEND_FAILED'
                });
            }
        }

        const channelUrl = String(TELEGRAM_CHANNEL_URL || 'https://t.me/cvetochniy21').trim();

        const step3Text =
            '💬 Или у Вас возникли вопросы или нужна помощь? Мы здесь, чтобы помочь Вам! Нажмите \u201cПозвать менеджера👩🏼\u200d💻\u201d';

        const step4Text =
            'Подписывайся на наш Telegram-канал, в нём ты сможешь первыми узнавать о новинках, специальных предложениях и акциях. 🎁️\n\n' +
            'Не упусти шанс получать эксклюзивные скидки и советы по уходу за цветами! 😉️\n\n' +
            '👉 Подписаться на канал';

        const t3 = setTimeout(async () => {
            try {
                const mgrMarkup = buildManagerHelpReplyMarkup();
                const sent = await telegramClient.sendMessage({
                    chatId,
                    text: step3Text,
                    replyMarkup: mgrMarkup
                });
                let pinnedOk = false;
                if (sent?.ok) {
                    logger.log('[TelegramCommand] onboarding_step_sent', { step: STEPS.MANAGER_HELP, chatId: String(chatId), ok: true });
                    const mid = Number(sent.data?.message_id || 0);
                    if (mid > 0) {
                        const pin = await telegramClient.pinChatMessage({ chatId, messageId: mid, disableNotification: true });
                        pinnedOk = !!pin?.ok;
                        if (pin?.ok) {
                            logger.log('[TelegramCommand] onboarding_step_sent', {
                                step: 'manager_message_pinned',
                                chatId: String(chatId),
                                ok: true
                            });
                        } else {
                            logger.warn('[TelegramCommand] onboarding_step_failed', {
                                step: 'manager_message_pin',
                                chatId: String(chatId),
                                errorCode: pin?.errorCode || 'PIN_FAILED'
                            });
                        }
                    }
                } else {
                    logger.warn('[TelegramCommand] onboarding_step_failed', {
                        step: STEPS.MANAGER_HELP,
                        chatId: String(chatId),
                        errorCode: sent?.errorCode || 'SEND_FAILED'
                    });
                }
                logger.log('[TelegramCommand] manager_help_onboarding_markup', {
                    chatId: String(chatId),
                    callbackData: MANAGER_HELP_CALLBACK_DATA,
                    pinned: pinnedOk
                });
            } catch (e) {
                logger.warn('[TelegramCommand] onboarding_step_failed', {
                    step: STEPS.MANAGER_HELP,
                    chatId: String(chatId),
                    errorCode: 'EXCEPTION',
                    message: String(e?.message || e)
                });
            }
        }, Math.max(0, delay3));

        const t4 = setTimeout(async () => {
            try {
                const r = await telegramClient.sendMessage({
                    chatId,
                    text: step4Text,
                    replyMarkup: channelUrl
                        ? {
                              inline_keyboard: [[{ text: '👉 Подписаться на канал', url: channelUrl }]]
                          }
                        : undefined
                });
                if (r?.ok) {
                    logger.log('[TelegramCommand] onboarding_step_sent', { step: STEPS.CHANNEL_SUB, chatId: String(chatId), ok: true });
                } else {
                    logger.warn('[TelegramCommand] onboarding_step_failed', {
                        step: STEPS.CHANNEL_SUB,
                        chatId: String(chatId),
                        errorCode: r?.errorCode || 'SEND_FAILED'
                    });
                }
            } catch (e) {
                logger.warn('[TelegramCommand] onboarding_step_failed', {
                    step: STEPS.CHANNEL_SUB,
                    chatId: String(chatId),
                    errorCode: 'EXCEPTION',
                    message: String(e?.message || e)
                });
            }
        }, Math.max(0, delay4));

        onboardingTimersByChat.set(String(chatId), { step3: t3, step4: t4 });

        logger.log('[TelegramCommand] response_sent', {
            command: 'start',
            chatId: String(chatId),
            payloadPresent: !!deepPayload,
            ok: true,
            phase: 'after_consent',
            scheduledStep3Ms: delay3,
            scheduledStep4Ms: delay4
        });

        return { handled: true };
    } finally {
        consentCallbackInFlight.delete(userId);
    }
}

module.exports = {
    runStartOnboarding,
    handleStartWelcomeConsentCallback,
    START_WELCOME_CONSENT_CB,
    STEPS,
    buildManagerHelpReplyMarkup,
    MANAGER_HELP_CALLBACK_DATA
};
