'use strict';

/**
 * Канон «ждёт ответа сотрудника» для support_threads:
 * — открытый тред (OPEN / PENDING);
 * — последнее сообщение в диалоге от клиента (CLIENT_TO_TOPIC), т.е. «ход» клиента;
 * — после успешного ответа сотрудника (TOPIC_TO_CLIENT, SENT) флаг снимается в support-service.
 *
 * Source of truth в БД: support_threads.waiting_for_staff (0/1), обновляется при каждом сообщении.
 * Поля last_client_message_at, last_staff_reply_at, last_message_direction — денорм для UI и SLA
 * (создаются миграцией `backend/support-threads-schema.js` при старте БД).
 */

const CLIENT_MSG_DIRECTIONS = new Set(['CLIENT_TO_TOPIC', 'IN', 'INBOUND', 'USER', 'CLIENT']);
const STAFF_MSG_DIRECTIONS = new Set(['TOPIC_TO_CLIENT', 'OUT', 'OUTBOUND', 'STAFF', 'MANAGER']);

function isClientMessageDirection(direction) {
    return CLIENT_MSG_DIRECTIONS.has(String(direction || '').trim().toUpperCase());
}

function isStaffMessageDirection(direction) {
    return STAFF_MSG_DIRECTIONS.has(String(direction || '').trim().toUpperCase());
}

function isOpenSupportThreadStatus(status) {
    const s = String(status || '').trim().toUpperCase();
    return s === 'OPEN' || s === 'PENDING';
}

/**
 * @param {object} row — строка треда (после JOIN), с waiting_for_staff и last_message_direction.
 */
function computeThreadWaitingForStaff(row) {
    if (!isOpenSupportThreadStatus(row.status)) return false;
    const denorm = row.waiting_for_staff;
    if (denorm !== null && denorm !== undefined && String(denorm).trim() !== '') {
        const n = Number(denorm);
        if (Number.isFinite(n)) return n === 1;
    }
    const last = row.last_message_direction;
    if (!last) return false;
    if (isClientMessageDirection(last)) return true;
    if (isStaffMessageDirection(last)) return false;
    return false;
}

module.exports = {
    CLIENT_MSG_DIRECTIONS,
    STAFF_MSG_DIRECTIONS,
    isClientMessageDirection,
    isStaffMessageDirection,
    isOpenSupportThreadStatus,
    computeThreadWaitingForStaff
};
