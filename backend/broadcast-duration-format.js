/**
 * Человекочитаемая длительность окна отправки рассылки (от первого copyMessage до последнего).
 * @param {number} durationMs
 * @returns {string}
 */
function formatBroadcastSendDurationLabelRu(durationMs) {
    const ms = Math.max(0, Math.round(Number(durationMs) || 0));
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) {
        return `${totalSec} сек`;
    }
    if (ms < 3600000) {
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min} мин ${sec} сек`;
    }
    const h = Math.floor(totalSec / 3600);
    const rem = totalSec % 3600;
    const min = Math.floor(rem / 60);
    const sec = rem % 60;
    return `${h} ч ${String(min).padStart(2, '0')} мин ${String(sec).padStart(2, '0')} сек`;
}

module.exports = {
    formatBroadcastSendDurationLabelRu
};
