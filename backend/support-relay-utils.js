'use strict';

/**
 * Односторонний fingerprint chat_id для логов без раскрытия полного значения (не криптостойкий).
 */
function redactTelegramChatIdForLog(chatId) {
    const raw = String(chatId ?? '');
    const d = [...raw.replace(/\s+/g, '')].reduce((acc, ch) => (acc + ch.charCodeAt(0)) | 0, 0);
    return `tg_chat_${String(Math.abs(d)).slice(0, 12)}`;
}

/**
 * Извлекает «главную» версию медиа (максимальный width+height у photo[]).
 */
function pickLargestPhotoMeta(photos) {
    const arr = Array.isArray(photos) ? photos : [];
    let best = null;
    let bestScore = -1;
    for (const p of arr) {
        if (!p || p.file_unique_id === undefined || p.file_id === undefined) continue;
        const w = Number(p.width || 0);
        const h = Number(p.height || 0);
        const score = w + h;
        if (score > bestScore) {
            bestScore = score;
            best = {
                width: Number.isFinite(w) ? w : null,
                height: Number.isFinite(h) ? h : null,
                file_id: String(p.file_id),
                file_unique_id: String(p.file_unique_id)
            };
        }
    }
    return best;
}

/**
 * Классификация для подписей/лога (англ ключи для стабильности в БД).
 * @returns {'text'|'photo'|'video'|'document'|'voice'|'audio'|'sticker'|'animation'|'video_note'|'location'|'contact'|'unsupported'}
 */
function supportMessageKindFromUpdateMessage(m) {
    const msg = m || {};
    if (msg.photo && msg.photo.length) return 'photo';
    if (msg.video) return 'video';
    if (msg.document) return 'document';
    if (msg.voice) return 'voice';
    if (msg.audio) return 'audio';
    if (msg.sticker) return 'sticker';
    if (msg.animation) return 'animation';
    if (msg.video_note) return 'video_note';
    if (msg.location) return 'location';
    if (msg.contact) return 'contact';
    if (msg.text !== undefined || msg.caption !== undefined) return 'text';
    return 'unsupported';
}

function forwardOriginBrief(m) {
    const fo = m?.forward_origin;
    if (!fo || typeof fo !== 'object') return null;
    /* Bot API Bot API v6+: forward_origin typed */
    const t = String(fo.type || '');
    if (t === 'user') return { type: 'user', sender_user_id: fo.sender_user?.id != null ? Number(fo.sender_user.id) : null };
    if (t === 'hidden_user') return { type: 'hidden_user' };
    if (t === 'chat') return {
        type: 'chat',
        chat_id: fo.sender_chat?.id != null ? String(fo.sender_chat.id) : null,
        chat_type: fo.sender_chat?.type ? String(fo.sender_chat.type) : null
    };
    if (t === 'channel') return {
        type: 'channel',
        chat_id: fo.chat?.id != null ? String(fo.chat.id) : null
    };
    return { type: t || 'unknown' };
}

/**
 * Без «сырой» истории сообщения: только нужные признаки для разборов incident / audit.
 * @param {number} updateId
 * @param {Record<string, unknown>} msg — update.message или edited_message
 */
function buildSupportRelayPayload(meta) {
    const { updateId, message } = meta || {};
    const m = message || {};
    const kind = supportMessageKindFromUpdateMessage(m);
    const caption = m.caption != null ? String(m.caption).slice(0, 4096) : null;
    const text = m.text != null ? String(m.text).slice(0, 4096) : null;

    const rt = m.reply_to_message || null;
    const replyTo =
        rt && rt.message_id != null
            ? {
                  message_id: Number(rt.message_id),
                  reply_to_kind: rt.photo && rt.photo.length ? 'photo' : supportMessageKindFromUpdateMessage(rt),
                  reply_to_photo_file_unique_id:
                      rt.photo && rt.photo.length
                          ? pickLargestPhotoMeta(rt.photo)?.file_unique_id ?? null
                          : null
              }
            : null;

    const forwardFrom =
        forwardOriginBrief(m) ||
        /* legacy-forward fields */
        (m.forward_from || m.forward_from_chat || m.forward_date != null
            ? {
                  type: 'legacy',
                  legacy_forward_date: m.forward_date != null ? Number(m.forward_date) : null
              }
            : null);

    /** @type {Record<string, unknown>} */
    const media = {};

    const ph = pickLargestPhotoMeta(m.photo || []);
    if (ph?.file_unique_id) {
        media.photo_largest_file_unique_id = ph.file_unique_id;
        media.photo_largest_file_id_sha = null; /* не сохраняем file_id как ПДн-рискный токен; используется только live copyMessage из чата клиента */
    }
    if (m.video?.file_unique_id) {
        media.video_file_unique_id = String(m.video.file_unique_id);
    }
    if (m.document?.file_unique_id) {
        media.document_file_unique_id = String(m.document.file_unique_id);
        media.mime_type = m.document.mime_type ? String(m.document.mime_type).slice(0, 240) : null;
    }
    if (m.voice?.file_unique_id) media.voice_file_unique_id = String(m.voice.file_unique_id);
    if (m.audio?.file_unique_id) media.audio_file_unique_id = String(m.audio.file_unique_id);
    if (m.sticker?.file_unique_id) media.sticker_file_unique_id = String(m.sticker.file_unique_id);
    if (m.animation?.file_unique_id) media.animation_file_unique_id = String(m.animation.file_unique_id);
    if (m.video_note?.file_unique_id) media.video_note_file_unique_id = String(m.video_note.file_unique_id);

    return {
        schema: 'support_relay_payload_v2',
        update_id: updateId != null ? Number(updateId) : null,
        message_id_in_private: m.message_id != null ? Number(m.message_id) : null,
        date: m.date != null ? Number(m.date) : null,
        content_kind: kind,
        text_preview: kind === 'text' ? text : null,
        caption_preview: caption,
        reply_to: replyTo,
        forward_origin: forwardFrom || null,
        media,
        /* Явное правило анти-подмены: копировать всегда message_id этого объекта из чата отправителя, не reply_to_* */
        copy_rule: 'from_private_chat:message.message_id(no_reply_substitution)'
    };
}

/** Короткая аннотация к relay для менеджеров для media/reply/forward. */
function buildSupportRelayManagerHintLines({ payload }) {
    const kind = payload?.content_kind ? String(payload.content_kind) : 'сообщение';
    const sid = payload?.message_id_in_private != null ? Number(payload.message_id_in_private) : null;
    const lines = [];
    lines.push(`Сообщение клиента · ${kind}${sid !== null ? ` · ID: ${sid}` : ''}`);

    const fo = payload?.forward_origin || null;
    if (fo) lines.push(`Клиент переслал сообщение (origin: ${String(fo.type || 'unknown').slice(0, 120)})`);

    const rt = payload?.reply_to || null;
    if (rt && rt.message_id != null) {
        lines.push(
            `Клиент ответил на сообщение #${Number(rt.message_id)} (${String(rt.reply_to_kind || '').slice(0, 120)})`
        );
    }

    return lines;
}

module.exports = {
    redactTelegramChatIdForLog,
    pickLargestPhotoMeta,
    supportMessageKindFromUpdateMessage,
    buildSupportRelayPayload,
    buildSupportRelayManagerHintLines
};
