const {
    buildSupportTopicIncomingFields,
    shouldAllowGroupMessageDespiteFromBot,
    isMessageInSupportNotifyTopic,
    TELEGRAM_ANONYMOUS_ADMIN_USER_ID
} = require('./support-topic-reply-log');
const { extractBotCommand } = require('./telegram-command-parse');
const { upsertTelegramUserFromMessage } = require('./telegram-user-profile-sync');
const { runStartOnboarding, handleStartWelcomeConsentCallback } = require('./telegram-start-onboarding');
const { resolveConsentCallbackContext } = require('./consent-callback-context');
const { MANAGER_HELP_CALLBACK_DATA } = require('./manager-help-constants');
const { MAX_PROMOTION_KEYWORD_LEN } = require('./promotion-service');
const interactiveLatency = require('./telegram-interactive-metrics');

function createTelegramUpdateHandler({
    supportService,
    broadcastService,
    telegramClient,
    telegramAdminDashboard,
    promotionService,
    runtimeFlagsService = null,
    config,
    runtimeBotProfile = { username: null },
    logger = console
}) {
    const {
        BROADCASTS_ENABLED,
        BROADCAST_DELETE_ENABLED,
        SUPPORT_RELAY_ENABLED,
        CLIENT_TOPIC_REPLY_ENABLED,
        TELEGRAM_SUPPORT_NOTIFY_CHAT_ID,
        TELEGRAM_SUPPORT_NOTIFY_THREAD_ID,
        TELEGRAM_FORUM_GROUP_ID
    } = config;

    const effectiveSupportNotifyChatId = TELEGRAM_SUPPORT_NOTIFY_CHAT_ID || TELEGRAM_FORUM_GROUP_ID;

    /** Эффективный флаг: env/config + переопределение из runtime_flags (как в админке). */
    async function resolveEffectiveSupportRelayEnabled() {
        if (!runtimeFlagsService || typeof runtimeFlagsService.getAll !== 'function') {
            return !!SUPPORT_RELAY_ENABLED;
        }
        try {
            const flags = await runtimeFlagsService.getAll();
            if (flags && typeof flags.SUPPORT_RELAY_ENABLED === 'boolean') {
                return flags.SUPPORT_RELAY_ENABLED;
            }
        } catch (e) {
            logger.warn('[SupportFlow] runtime_flags_read_failed', { message: e?.message || String(e) });
        }
        return !!SUPPORT_RELAY_ENABLED;
    }

    async function handleCallbackQuery(callbackQuery) {
        if (!callbackQuery) return;
        const cbStarted = Date.now();
        const data = String(callbackQuery.data || '').trim();
        const fromId = String(callbackQuery.from?.id || '');

        logger.log('[TelegramCallback] inbound', {
            data: data.slice(0, 64),
            hasMessage: !!callbackQuery.message,
            fromId: fromId || null
        });

        let welcomeCb;
        try {
            welcomeCb = await handleStartWelcomeConsentCallback({
                telegramClient,
                config,
                runtimeBotProfile,
                logger,
                callbackQuery
            });
        } catch (e) {
            logger.error('[TelegramCallback] welcome_consent_error', { message: e.message || String(e) });
            await telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: 'Не удалось обработать нажатие. Попробуйте /start ещё раз.',
                showAlert: true
            });
            interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
            return;
        }
        if (welcomeCb?.handled) {
            interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
            return;
        }

        if (data.startsWith('adm:')) {
            await telegramAdminDashboard.handleAdminCallbackQuery(callbackQuery);
            interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
            return;
        }

        if (data === MANAGER_HELP_CALLBACK_DATA) {
            const { chatId, chatType, chatResolveSource } = resolveConsentCallbackContext(callbackQuery);

            logger.log('[TelegramCallback] manager_help_request_inbound', {
                chatResolveSource,
                chatType,
                hasMessage: !!callbackQuery.message,
                chatId: chatId != null ? String(chatId) : null,
                fromId: fromId || null
            });

            if (chatType !== 'private' || chatId == null) {
                await telegramClient.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: 'Доступно только в личном чате с ботом',
                    showAlert: false
                });
                interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
                return;
            }

            const ack = await telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: ''
            });
            logger.log('[ManagerHelp] callback_ack_ok', {
                ok: !!ack?.ok,
                errorCode: ack?.errorCode || null,
                callbackQueryId: String(callbackQuery?.id || '')
            });

            logger.log('[SupportFlow] manager_help_request_start', {
                chatId: String(chatId),
                fromId: fromId || null
            });

            setImmediate(() => {
                Promise.resolve(supportService.handleManagerHelpRequest({ callbackQuery, chatId }))
                    .then((r) => {
                        if (r?.ok === false) {
                            logger.warn('[SupportFlow] manager_help_request_error', {
                                fromId: fromId || null,
                                errorCode: r?.errorCode || 'UNKNOWN'
                            });
                        } else if (r?.duplicateSuppressed) {
                            logger.log('[SupportFlow] manager_help_request_ok', {
                                fromId: fromId || null,
                                duplicateSuppressed: true,
                                reason: r?.reason || null
                            });
                        } else {
                            logger.log('[SupportFlow] manager_help_request_ok', {
                                fromId: fromId || null,
                                threadExisted: r?.threadExisted === true
                            });
                        }
                    })
                    .catch((e) => {
                        logger.error('[SupportFlow] manager_help_request_error', { message: e?.message || String(e) });
                        logger.error('[ManagerHelp] async_error', { message: e?.message || String(e) });
                    });
            });

            interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
            return;
        }

        if (data.startsWith('broadcast_delete:')) {
            if (!BROADCAST_DELETE_ENABLED) {
                await telegramClient.answerCallbackQuery({
                    callbackQueryId: callbackQuery.id,
                    text: 'Удаление рассылки отключено флагом',
                    showAlert: false
                });
                interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
                return;
            }
            const campaignId = Number(data.split(':')[1] || 0);
            const result = await broadcastService.deleteCampaignMessages(campaignId, fromId);
            await telegramClient.answerCallbackQuery({
                callbackQueryId: callbackQuery.id,
                text: result.ok ? 'Удаление запущено/выполнено' : `Ошибка: ${result.error || 'FAILED'}`,
                showAlert: !result.ok
            });
            interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
            return;
        }

        await telegramClient.answerCallbackQuery({
            callbackQueryId: callbackQuery.id,
            text: ''
        });
        logger.log('[TelegramCallback] unknown_callback_ack', { data: data.slice(0, 64) });
        interactiveLatency.record('callback_query_total_ms', Date.now() - cbStarted);
    }

    function buildCommandParseInput(msg) {
        const t = msg?.text;
        if (t != null && String(t) !== '') return msg;
        const c = msg?.caption;
        if (c != null && String(c) !== '') {
            return { text: msg.caption, entities: msg.caption_entities || [] };
        }
        return msg;
    }

    async function handleMessage(message, updateMeta = {}) {
        if (!message) return;
        const chatType = String(message.chat?.type || '');
        const chatId = String(message.chat?.id ?? '');
        const threadId = Number(message.message_thread_id || 0);
        const incomingFields = buildSupportTopicIncomingFields(message);
        const fromIsBot = !!message.from?.is_bot;
        const allowDespiteBot = shouldAllowGroupMessageDespiteFromBot(message);

        if (fromIsBot && !allowDespiteBot) {
            if (chatType === 'supergroup' || chatType === 'group') {
                logger.log('[SupportTopicReply] skipped', {
                    reason: 'from_is_bot',
                    ...incomingFields
                });
            }
            return;
        }

        if (fromIsBot && allowDespiteBot) {
            logger.log('[SupportTopicReply] anonymous admin / sender_chat: not applying from_is_bot skip', {
                ...incomingFields,
                anonymousAdminIdMatch: Number(message.from?.id) === TELEGRAM_ANONYMOUS_ADMIN_USER_ID
            });
        }

        const botCmd = extractBotCommand(buildCommandParseInput(message));
        if (botCmd) {
            const userId = String(message.from?.id || '') || null;
            logger.log('[TelegramCommand] incoming', {
                command: botCmd.command,
                payloadPresent: !!botCmd.payload,
                chatType,
                userId
            });
            logger.log('[TelegramCommand] skipped support relay', { command: botCmd.command, chatType });

            if (chatType === 'private') {
                try {
                    if (botCmd.command === 'start') {
                        const startT0 = Date.now();
                        await upsertTelegramUserFromMessage(message);
                        if (promotionService?.recordSourceClickFromStart && botCmd.payload) {
                            try {
                                await promotionService.recordSourceClickFromStart(message, botCmd.payload);
                            } catch (e) {
                                logger.warn('[Promotion] record_start_click_failed', {
                                    message: e?.message || String(e)
                                });
                            }
                        }
                        await runStartOnboarding({
                            telegramClient,
                            config,
                            logger,
                            chatId: message.chat.id,
                            botCmd
                        });
                        interactiveLatency.record('start_command_total_ms', Date.now() - startT0);
                    } else if (botCmd.command === 'admin') {
                        await telegramAdminDashboard.handleAdminCommandMessage(message);
                    }
                    logger.log('[TelegramCommand] handled', {
                        command: botCmd.command,
                        payloadPresent: !!botCmd.payload
                    });
                } catch (e) {
                    logger.error('[TelegramCommand] handler error', {
                        command: botCmd.command,
                        error: e.message || String(e)
                    });
                }
            } else {
                logger.log('[TelegramCommand] handled', {
                    command: botCmd.command,
                    note: 'no_supergroup_or_group_relay_for_commands'
                });
            }
            return;
        }

        const threadIdPositive = threadId > 0;

        if (chatType === 'supergroup' || chatType === 'group') {
            const isBroadcastCandidate =
                BROADCASTS_ENABLED && broadcastService.isBroadcastTopicMessage(message);
            let branch = 'group_other';
            if (isBroadcastCandidate) {
                branch = 'broadcast';
            } else if (CLIENT_TOPIC_REPLY_ENABLED && threadIdPositive) {
                branch = 'client_topic_reply';
            } else if (CLIENT_TOPIC_REPLY_ENABLED && !threadIdPositive) {
                branch = 'group_no_thread_id';
            }
            const broadcastDbg = broadcastService.getBroadcastTopicRoutingDebug
                ? broadcastService.getBroadcastTopicRoutingDebug()
                : { expectedChatId: '', expectedThreadId: 0 };
            logger.log('[TelegramUpdate] forum routing', {
                ...incomingFields,
                hasMessage: !!updateMeta.hasMessage,
                hasEditedMessage: !!updateMeta.hasEditedMessage,
                branch,
                broadcastMatch: !!isBroadcastCandidate,
                clientTopicReplyEnabled: !!CLIENT_TOPIC_REPLY_ENABLED,
                expectedBroadcastChatId: broadcastDbg.expectedChatId,
                expectedBroadcastThreadId: broadcastDbg.expectedThreadId
            });

            if (
                BROADCASTS_ENABLED &&
                broadcastDbg.expectedThreadId > 0 &&
                chatId === broadcastDbg.expectedChatId &&
                threadId > 0 &&
                threadId !== broadcastDbg.expectedThreadId
            ) {
                logger.log('[TelegramUpdate] сообщение в другой теме того же чата (не broadcast topic)', {
                    actualThreadId: threadId,
                    expectedBroadcastThreadId: broadcastDbg.expectedThreadId
                });
            }

            if (branch === 'group_no_thread_id' && CLIENT_TOPIC_REPLY_ENABLED) {
                logger.log('[SupportTopicReply] skipped', {
                    reason: 'no_message_thread_id',
                    hint: 'Нужна тема форума с message_thread_id > 0',
                    ...incomingFields
                });
            }

            if (isBroadcastCandidate) {
                const r = await broadcastService.startCampaignFromTopicMessage(message);
                logger.log('[BroadcastFlow] topic trigger handled', {
                    ok: !!r?.ok,
                    error: r?.error || null,
                    campaignId: r?.campaignId || null,
                    duplicate: !!r?.duplicate,
                    testModeSkipped: !!r?.testModeSkipped,
                    topicTestMode: !!r?.topicTestMode,
                    scheduledAsync: !!r?.scheduledAsync,
                    recipientsTargeted: r?.recipientsTargeted ?? null,
                    jobNotScheduledReason: r?.jobNotScheduledReason || null,
                    transportPreflightReason: r?.transportPreflightReason || null
                });
                return;
            }

            if (CLIENT_TOPIC_REPLY_ENABLED && threadIdPositive) {
                const inSupportNotifyTopic = isMessageInSupportNotifyTopic({
                    chatId,
                    messageThreadId: threadId,
                    supportNotifyChatId: effectiveSupportNotifyChatId,
                    supportNotifyThreadId: TELEGRAM_SUPPORT_NOTIFY_THREAD_ID
                });
                if (inSupportNotifyTopic) {
                    logger.log('[SupportTopicReply] skipped', {
                        reason: 'support_notify_topic',
                        hint: 'Ответ клиенту нужно писать в персональной теме клиента в форуме (перейти по ссылке из уведомления), а не в теме уведомлений поддержки.',
                        ...incomingFields
                    });
                    return;
                }

                logger.log('[SupportTopicReply] incoming', {
                    updateKind: updateMeta.hasEditedMessage ? 'edited_message' : 'message',
                    ...incomingFields
                });
                const mgr = await supportService.handleManagerMessage(message);
                logger.log('[SupportTopicReply] relay result', {
                    ok: mgr?.ok !== false,
                    duplicate: !!mgr?.duplicate,
                    error: mgr?.error || null,
                    errorCode: mgr?.errorCode || null
                });
                if (mgr && mgr.ok === false && mgr.error === 'CLIENT_TOPIC_NOT_MAPPED') {
                    logger.log(
                        '[TelegramUpdate] сообщение в теме форума не сопоставлено с клиентом (операционные темы заказов/рассылки обрабатываются отдельно)'
                    );
                }
                return;
            }
        }

        if (chatType === 'private') {
            const fromIdDbg = String(message.from?.id || '') || null;
            const textProbe = message.text != null ? String(message.text).trim() : '';
            logger.log('[SupportFlow] private_message_received', {
                messageId: Number(message.message_id) || null,
                fromId: fromIdDbg,
                hasText: !!(textProbe && textProbe.length),
                textLen: textProbe.length
            });

            let promotionKeywordMatched = false;
            let promotionKeywordOutcome = 'skipped_probe';
            if (!promotionService?.handleKeywordReply) {
                promotionKeywordOutcome = 'no_promo_service';
            } else if (!textProbe) {
                promotionKeywordOutcome = 'no_text';
            } else if (textProbe.startsWith('/')) {
                promotionKeywordOutcome = 'slash_commands_use_command_flow';
            } else if (textProbe.length > MAX_PROMOTION_KEYWORD_LEN) {
                promotionKeywordOutcome = 'too_long_for_keyword_gate';
            } else {
                try {
                    promotionKeywordMatched = await promotionService.handleKeywordReply(
                        telegramClient,
                        message,
                        logger
                    );
                    promotionKeywordOutcome = promotionKeywordMatched
                        ? 'matched_or_duplicate_recorded'
                        : 'checked_not_matched';
                } catch (e) {
                    logger.warn('[Promotion] keyword_reply_failed', { message: e?.message || String(e) });
                    promotionKeywordOutcome = 'promo_threw_continue_support';
                }
            }
            logger.log('[SupportFlow] promotion_keyword_checked', {
                matched: promotionKeywordMatched,
                reason: promotionKeywordOutcome
            });

            const relayOn = await resolveEffectiveSupportRelayEnabled();
            if (!relayOn) {
                logger.warn('[SupportFlow] relay_skipped', {
                    reason: 'SUPPORT_RELAY_DISABLED_EFFECTIVE',
                    configEnvRelay: !!SUPPORT_RELAY_ENABLED,
                    runtimeFlagsAttached: !!(runtimeFlagsService && typeof runtimeFlagsService.getAll === 'function')
                });
                return;
            }

            logger.log('[SupportFlow] handle_client_message_start', {
                messageId: Number(message.message_id) || null,
                fromId: fromIdDbg
            });
            try {
                const relayResult = await supportService.handleClientMessage(message, {
                    updateId: updateMeta.updateId != null ? Number(updateMeta.updateId) : null
                });
                if (!relayResult || relayResult.ok === false) {
                    logger.warn('[SupportFlow] handle_client_message_error', {
                        error: relayResult?.error || 'RELAY_REJECTED',
                        fromId: fromIdDbg
                    });
                } else {
                    logger.log('[SupportFlow] handle_client_message_ok', {
                        duplicate: !!relayResult.duplicate,
                        fromId: fromIdDbg
                    });
                }
            } catch (e) {
                logger.error('[SupportFlow] handle_client_message_error', { message: e?.message || String(e) });
            }
            return;
        }
    }

    async function handleUpdate(update) {
        try {
            if (update?.callback_query) {
                logger.log('[TelegramUpdate] routing=callback_query', {
                    updateId: Number(update.update_id) || null
                });
                await handleCallbackQuery(update.callback_query);
                return { ok: true };
            }
            const message = update?.message || update?.edited_message;
            if (message) {
                const ct = String(message.chat?.type || '');
                if (ct === 'supergroup' || ct === 'group') {
                    logger.log('[TelegramUpdate] inbound group message (raw)', {
                        updateId: Number(update.update_id) || null,
                        updateKind: update?.message ? 'message' : 'edited_message',
                        ...buildSupportTopicIncomingFields(message)
                    });
                }
                await handleMessage(message, {
                    hasMessage: !!update?.message,
                    hasEditedMessage: !!update?.edited_message,
                    updateId: update?.update_id != null ? Number(update.update_id) : null
                });
                return { ok: true };
            }
            return { ok: true, ignored: true };
        } catch (e) {
            logger.error('[TelegramUpdate] failed', { error: e.message || e });
            return { ok: false, error: e.message || 'UPDATE_FAILED' };
        }
    }

    return {
        handleUpdate
    };
}

module.exports = {
    createTelegramUpdateHandler
};

