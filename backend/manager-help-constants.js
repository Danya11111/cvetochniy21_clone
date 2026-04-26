'use strict';

/** Bot API: callback_data ≤ 64 bytes */
const MANAGER_HELP_CALLBACK_DATA = 'manager_help_request';

const MANAGER_HELP_BUTTON_TEXT = 'Позвать менеджера👩🏼‍💻';

function buildManagerHelpReplyMarkup() {
    return {
        inline_keyboard: [[{ text: MANAGER_HELP_BUTTON_TEXT, callback_data: MANAGER_HELP_CALLBACK_DATA }]]
    };
}

module.exports = {
    MANAGER_HELP_CALLBACK_DATA,
    MANAGER_HELP_BUTTON_TEXT,
    buildManagerHelpReplyMarkup
};
