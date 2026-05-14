let tg = null;
let telegramUser = null;
let telegramId = null;
let adminEntryAllowed = false;
let lastClientContext = { tab: 'profile', profileTab: 'addresses' };

let products = [];
let cart = [];
let addresses = [];
let orders = [];

let ordersSyncTimer = null;

/** Runtime build id for logs (window + meta; must match server-injected index.html). */
function getF21StorefrontRuntimeBuild() {
    const fromWin = typeof window.__F21_BUILD__ !== 'undefined' ? String(window.__F21_BUILD__).trim() : '';
    let fromMeta = '';
    try {
        const meta = document.querySelector('meta[name="f21-storefront-build"]');
        fromMeta = meta ? String(meta.getAttribute('content') || '').trim() : '';
    } catch (_) {}
    const raw = fromWin || fromMeta;
    if (!raw || raw === '__F21_BUILD__') {
        console.warn('[StorefrontClient] missing_build', { fromWin, fromMeta, tag: 'missing_build' });
        return 'missing_build';
    }
    if (fromWin && fromMeta && fromWin !== fromMeta) {
        console.warn('[StorefrontClient] build_mismatch', { window: fromWin, meta: fromMeta });
    }
    return raw.slice(0, 64);
}

let useBonusesSelected = false;
let bonusBalance = 0;

let activeCategory = 'ВСЕ';

let checkoutDeliveryMethod = 'delivery'; // 'delivery' | 'pickup'
let selectedDeliveryInterval = '';       // "HH:MM - HH:MM"
let checkoutReceiverMode = 'self'; // 'self' | 'other'


let cartFloristComment = '';
let cartCardText = '';

let cartCardEnabled = false;      // только UI (открытка включена/выключена)
let cartNoteModalMode = null;     // 'card' | 'comment'

// ===== Delivery option state (cart) =====
// 'city400' | 'to10km490' | 'beyond10km' | 'pickup'
let selectedDeliveryOption = 'city400';

// бонусы: включено/выключено
//let useBonusesSelected = false;

// тексты из корзины (комментарий/открытка)
let floristComment = '';
let cardText = '';

// ===== Cart persistence (TTL) =====
const CART_STORAGE_KEY = 'f21_cart_blob_v1';
const CART_STORAGE_TTL_DAYS = 14; // <-- поставьте 7-30 как нужно
const CART_STORAGE_TTL_MS = CART_STORAGE_TTL_DAYS * 24 * 60 * 60 * 1000;

function isCurrentAdminUser() {
    return !!adminEntryAllowed;
}

function getActiveClientContext() {
    const tab = document.querySelector('.nav-btn.active')?.dataset?.tab || 'profile';
    const profileTab = document.querySelector('.profile-tab-btn.active')?.dataset?.profileTab || 'addresses';
    return { tab, profileTab };
}

function showOnlyTabContent(tabId) {
    const tabs = document.querySelectorAll('.tab-content');
    tabs.forEach((tab) => {
        tab.classList.toggle('active', tab.id === `tab-${tabId}`);
    });
}

function applyClientContext(context = {}) {
    const tab = String(context.tab || 'profile');
    const profileTab = String(context.profileTab || 'addresses');
    const allowedTabs = new Set(['shop', 'cart', 'profile', 'info']);
    const allowedProfileTabs = new Set(['addresses', 'orders', 'support']);
    const safeTab = allowedTabs.has(tab) ? tab : 'profile';
    const safeProfileTab = allowedProfileTabs.has(profileTab) ? profileTab : 'addresses';
    const navBtn = document.querySelector(`.nav-btn[data-tab="${safeTab}"]`);
    if (navBtn) navBtn.click();
    if (safeTab === 'profile') {
        const profileBtn = document.querySelector(`.profile-tab-btn[data-profile-tab="${safeProfileTab}"]`);
        if (profileBtn) profileBtn.click();
    }
}

/**
 * Админка: только POST /admin-launch → сервер 303 → GET embed с подписью (без fetch/XHR).
 */
function submitAdminLaunchForm() {
    const initData = String(tg?.initData || '').trim();
    if (!initData) {
        alert('Не удалось подтвердить Telegram-сессию. Откройте приложение внутри Telegram.');
        return;
    }
    lastClientContext = getActiveClientContext();
    try {
        sessionStorage.setItem('f21_storefront_return_context', JSON.stringify(lastClientContext));
    } catch (_) {}
    const tab = encodeURIComponent(String(lastClientContext.tab || 'profile'));
    const profileTab = encodeURIComponent(String(lastClientContext.profileTab || 'addresses'));
    const returnTo = `/?tab=${tab}&profileTab=${profileTab}`;

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/admin-launch';
    form.style.display = 'none';
    form.setAttribute('accept-charset', 'UTF-8');

    const inInit = document.createElement('input');
    inInit.type = 'hidden';
    inInit.name = 'tgWebAppData';
    inInit.value = initData;
    const inRet = document.createElement('input');
    inRet.type = 'hidden';
    inRet.name = 'returnTo';
    inRet.value = returnTo;

    form.appendChild(inInit);
    form.appendChild(inRet);
    document.body.appendChild(form);
    console.log('[AdminUI] form_submit', { action: '/admin-launch' });
    form.submit();
}

/** Клик «Админка» во витрине: только этот путь, без навигации по URL до POST. */
function handleStorefrontAdminOpenClick(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    console.log('[AdminUI] open_click');
    submitAdminLaunchForm();
}

async function detectAdminEntryAccess() {
    const initData = String(tg?.initData || '').trim();
    if (!initData) {
        adminEntryAllowed = false;
        return false;
    }
    try {
        const res = await fetch('/api/admin/access', {
            headers: { 'x-telegram-init-data': initData }
        });
        const data = await res.json().catch(() => ({}));
        adminEntryAllowed = !!(res.ok && data?.ok && data?.allowed);
        return adminEntryAllowed;
    } catch (_) {
        adminEntryAllowed = false;
        return false;
    }
}

function ensureAdminEntryButton() {
    const wrap = document.querySelector('.profile-buttons');
    if (!wrap) return;
    const existing = document.getElementById('profileAdminEntryBtn');
    if (!isCurrentAdminUser()) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'profileAdminEntryBtn';
    btn.className = 'profile-tab-btn';
    btn.textContent = 'Админка';
    btn.addEventListener('click', handleStorefrontAdminOpenClick, { capture: true });
    wrap.appendChild(btn);
}

function applyInitialRouteFromUrl() {
    try {
        const params = new URLSearchParams(location.search || '');
        const tab = String(params.get('tab') || '').trim();
        const profileTab = String(params.get('profileTab') || '').trim();
        const allowedTabs = new Set(['shop', 'cart', 'profile', 'info']);
        const allowedProfileTabs = new Set(['addresses', 'orders', 'support']);

        if (allowedTabs.has(tab)) {
            const navBtn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
            if (navBtn) navBtn.click();
        }

        if (tab === 'profile' && allowedProfileTabs.has(profileTab)) {
            const profileBtn = document.querySelector(`.profile-tab-btn[data-profile-tab="${profileTab}"]`);
            if (profileBtn) profileBtn.click();
        }

        if (tab || profileTab) {
            history.replaceState(null, '', location.pathname + (location.hash || ''));
        }
    } catch (_) {}
}


function setupKeyboardHideFixedBars() {
    const root = document.getElementById('app') || document.body;

    document.addEventListener('focusin', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
        root.classList.add('keyboard-open');
    });

    document.addEventListener('focusout', (e) => {
        // даём небольшой таймаут, чтобы при переходе фокуса между полями не мигало
        setTimeout(() => {
            const active = document.activeElement;
            const stillInput =
                active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
            if (!stillInput) root.classList.remove('keyboard-open');
        }, 50);
    });
}


function setupInputFocusScrollFix() {
    document.addEventListener('focusin', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;

        // Telegram/WebView может "дергать" скролл — стабилизируем
        setTimeout(() => {
            try {
                t.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch (_) {}
        }, 250);
    });
}

function setupKeyboardOverlayFix() {
    // Делает так, чтобы при фокусе поле аккуратно попадало в видимую область,
    // при этом layout не пытается "вверх-уехать".
    document.addEventListener('focusin', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;

        // маленькая задержка: клавиатура должна успеть открыться
        setTimeout(() => {
            try {
                t.scrollIntoView({ block: 'center', behavior: 'smooth' });
            } catch (_) {}
        }, 250);
    });
}


function loadCartState() {
    try {
        const raw = localStorage.getItem(CART_STORAGE_KEY);
        if (!raw) return null;

        const blob = JSON.parse(raw);
        if (!blob || typeof blob !== 'object') return null;

        if (blob.expiresAt && Date.now() > blob.expiresAt) {
            localStorage.removeItem(CART_STORAGE_KEY);
            return null;
        }

        return blob.data || null;
    } catch {
        return null;
    }
}

function saveCartState() {
    try {
        const data = {
            cart,
            selectedDeliveryOption,
            useBonusesSelected,
            floristComment,
            cardText
        };

        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({
            expiresAt: Date.now() + CART_STORAGE_TTL_MS,
            data
        }));
    } catch {
        // ignore
    }
}

function isPickupSelected(){
    return selectedDeliveryOption === 'pickup';
}

function getDeliveryFeeRub(){
    return computeCartPricing().deliveryFeeRub;
}


function computeCartPricing() {
    const itemsTotalRub = cart.reduce(
        (sum, c) => sum + (Number(c.price || 0) * Number(c.quantity || 0)),
        0
    );

    const deliveryFeeRub = selectedDeliveryOption === 'pickup' ? 0 : 350;

    return {
        itemsTotalRub,
        baseDeliveryFeeRub: deliveryFeeRub,
        deliveryFeeRub,
        redeemRub: 0,
        totalBeforeBonusRub: itemsTotalRub + deliveryFeeRub,
        payableRub: itemsTotalRub + deliveryFeeRub
    };
}


// function computeCartPricing() {
//     const itemsTotalRub = cart.reduce(
//         (sum, c) => sum + (Number(c.price || 0) * Number(c.quantity || 0)),
//         0
//     );
//
//     // базовая доставка по выбранной опции
//     const baseDeliveryFeeRub = (() => {
//         if (selectedDeliveryOption === 'pickup') return 0;
//         if (selectedDeliveryOption === 'city400') return 350;
//         if (selectedDeliveryOption === 'to10km490') return 600;
//         if (selectedDeliveryOption === 'beyond10km') return 0;
//         return 0;
//     })();
//
//     // бонусы считаем от (товары + доставка)
//     const totalBeforeBonusRub = itemsTotalRub + baseDeliveryFeeRub;
//     const maxRedeemRub = Math.floor(totalBeforeBonusRub * 0.30);
//     const redeemRub = useBonusesSelected ? Math.min(bonusBalance, maxRedeemRub) : 0;
//
//     // доставка больше НЕ зависит от суммы заказа
//     const deliveryFeeRub = baseDeliveryFeeRub;
//
//     // итог к оплате
//     const payableRub = Math.max(0, itemsTotalRub + deliveryFeeRub - redeemRub);
//
//     return {
//         itemsTotalRub,
//         baseDeliveryFeeRub,
//         deliveryFeeRub,
//         redeemRub,
//         totalBeforeBonusRub,  // товары + доставка (для зачёркнутой суммы)
//         payableRub
//     };
// }

function getDeliveryOptionUi(option){
    if (option === 'city400') {
        return {
            title: 'Доставка по Чебоксарам (ЮЗР, НЮР, ЦЕНТР, СЗР), Новому городу, Новочебоксарску, Кугеси, Лапсары.',
            price: '350 ₽'
        };
    }

    return {
        title: 'Самовывоз',
        price: '0 ₽'
    };
}

function renderDeliveryGrid(){
    const wrap = document.createElement('div');
    wrap.className = 'delivery-grid';
    wrap.id = 'deliveryGrid';

    const options = ['city400', 'pickup'];

    options.forEach(opt => {
        const ui = getDeliveryOptionUi(opt);

        const btn = document.createElement('div');
        btn.className = 'delivery-option' + (selectedDeliveryOption === opt ? ' active' : '');
        btn.dataset.deliveryOption = opt;

        const t = document.createElement('div');
        t.className = 'delivery-option-title';
        t.textContent = ui.title;

        const p = document.createElement('div');
        p.className = 'delivery-option-price';
        p.textContent = ui.price || '';

        btn.appendChild(t);
        btn.appendChild(p);

        btn.onclick = async () => {
            selectedDeliveryOption = opt;
            checkoutDeliveryMethod = (opt === 'pickup') ? 'pickup' : 'delivery';

            saveCartState();
            await refreshAfterAnyAction({ rerenderProducts: false });
        };

        wrap.appendChild(btn);
    });

    return wrap;
}

// function getDeliveryOptionUi(option){
//     if (option === 'city400') {
//         return { title: 'Доставка по Чебоксарам (ЮЗР, НЮР, ЦЕНТР, СЗР), Новому городу, Новочебоксарску, Кугеси, Лапсары.', price: '350 ₽' };
//     }
//     if (option === 'to10km490') {
//         return { title: 'До 10км. от Чебоксар', price: '600 ₽' };
//     }
//     if (option === 'beyond10km') {
//         return { title: 'За пределами 10км от Чебоксар', price: '(рассчитfunction renderDeliveryGrid(){
// //     const wrap = document.createElement('div');
// //     wrap.className = 'delivery-grid';
// //     wrap.id = 'deliveryGrid';
// //
// //     const options = ['city400','to10km490','beyond10km','pickup'];
// //
// //     options.forEach(opt => {
// //         const ui = getDeliveryOptionUi(opt);
// //
// //         const btn = document.createElement('div');
// //         btn.className = 'delivery-option' + (selectedDeliveryOption === opt ? ' active' : '');
// //         btn.dataset.deliveryOption = opt;
// //
// //         const t = document.createElement('div');
// //         t.className = 'delivery-option-title';
// //         t.textContent = ui.title;
// //
// //         const p = document.createElement('div');
// //         p.className = 'delivery-option-price';
// //         // для beyond10km покажем “20р/км …” строкой, а “0 ₽” как стоимость (по ТЗ цена не меняется)
// //         if (opt === 'beyond10km') {
// //             p.textContent = ui.title.includes('20р') ? '20р. за км. (рассчитывается менеджером)' : (ui.price || '');
// //         } else {
// //             p.textContent = ui.price || '';
// //         }
// //
// //         btn.appendChild(t);
// //         btn.appendChild(p);
// //
// //         btn.onclick = async () => {
// //             selectedDeliveryOption = opt;
// //
// //             // если выбрали самовывоз — при открытии оформления должны показываться pickupInfo
// //             // если выбрали любую из первых 3 — должны показываться deliveryFields
// //             // (сами кнопки в оформлении мы убираем, но метод сохраняем)
// //             checkoutDeliveryMethod = (opt === 'pickup') ? 'pickup' : 'delivery';
// //
// //             saveCartState();
// //             await refreshAfterAnyAction({ rerenderProducts: false });
// //         };
// //
// //         wrap.appendChild(btn);
// //     });
// //
// //     return wrap;
// // }ывается менеджером)', price2: '0 ₽' };
//     }
//     return { title: 'Самовывоз', price: '0 ₽' };
// }

// function renderDeliveryGrid(){
//     const wrap = document.createElement('div');
//     wrap.className = 'delivery-grid';
//     wrap.id = 'deliveryGrid';
//
//     const options = ['city400','to10km490','beyond10km','pickup'];
//
//     options.forEach(opt => {
//         const ui = getDeliveryOptionUi(opt);
//
//         const btn = document.createElement('div');
//         btn.className = 'delivery-option' + (selectedDeliveryOption === opt ? ' active' : '');
//         btn.dataset.deliveryOption = opt;
//
//         const t = document.createElement('div');
//         t.className = 'delivery-option-title';
//         t.textContent = ui.title;
//
//         const p = document.createElement('div');
//         p.className = 'delivery-option-price';
//         // для beyond10km покажем “20р/км …” строкой, а “0 ₽” как стоимость (по ТЗ цена не меняется)
//         if (opt === 'beyond10km') {
//             p.textContent = ui.title.includes('20р') ? '20р. за км. (рассчитывается менеджером)' : (ui.price || '');
//         } else {
//             p.textContent = ui.price || '';
//         }
//
//         btn.appendChild(t);
//         btn.appendChild(p);
//
//         btn.onclick = async () => {
//             selectedDeliveryOption = opt;
//
//             // если выбрали самовывоз — при открытии оформления должны показываться pickupInfo
//             // если выбрали любую из первых 3 — должны показываться deliveryFields
//             // (сами кнопки в оформлении мы убираем, но метод сохраняем)
//             checkoutDeliveryMethod = (opt === 'pickup') ? 'pickup' : 'delivery';
//
//             saveCartState();
//             await refreshAfterAnyAction({ rerenderProducts: false });
//         };
//
//         wrap.appendChild(btn);
//     });
//
//     return wrap;
// }

function normalizeRuPhone(raw) {
    let s = String(raw || '').trim();

    // оставляем + и цифры
    s = s.replace(/[^\d+]/g, '');

    // если начинается с 8XXXXXXXXXX → +7XXXXXXXXXX
    if (/^8\d{10}$/.test(s)) return '+7' + s.slice(1);

    // если начинается с 7XXXXXXXXXX без плюса → +7...
    if (/^7\d{10}$/.test(s)) return '+7' + s.slice(1);

    // если ровно 10 цифр → +7...
    if (/^\d{10}$/.test(s)) return '+7' + s;

    // если уже +7 и дальше цифры — ок
    if (/^\+7\d{10}$/.test(s)) return s;

    // если начинается с + и что-то другое — оставим как есть (но вы можете ужесточить)
    return s;
}

function normalizeRuPhoneStrict(raw) {
    // хотим получить формат: +7XXXXXXXXXX (0..10 цифр после +7)
    let digits = String(raw || '').replace(/\D/g, '');

    // если пользователь вставил 8XXXXXXXXXX (11 цифр) → делаем 7XXXXXXXXXX
    if (digits.length === 11 && digits[0] === '8') {
        digits = '7' + digits.slice(1);
    }

    // если 7XXXXXXXXXX (11 цифр) → оставляем последние 10 после кода страны
    if (digits.length === 11 && digits[0] === '7') {
        digits = digits.slice(1);
    }

    // если почему-то больше 10 цифр без кода — режем до 10 ПЕРВЫХ (а не последних),
    // чтобы при наборе не “съезжали” цифры
    if (digits.length > 10) {
        digits = digits.slice(0, 10);
    }

    return '+7' + digits;
}

function enforcePlus7Input(inputEl) {
    if (!inputEl || inputEl.dataset.plus7Bound) return;
    inputEl.dataset.plus7Bound = '1';

    const DIGITS_MAX = 10;

    const extractDigitsAfterPlus7 = (value) => {
        // берём все цифры из ввода
        const digits = String(value || '').replace(/\D/g, '');

        // правило: все цифры ДО первой 9 — выбросить
        const idx9 = digits.indexOf('9');
        if (idx9 === -1) return '';               // пока 9 не ввели — цифр "нет"
        return digits.slice(idx9);                 // начиная с первой 9 и дальше
    };

    const setValue = (digits, keepCaret = false) => {
        const prev = inputEl.value || '';
        const prevPos = inputEl.selectionStart ?? prev.length;

        // ограничение 10 цифр
        const d = String(digits || '').slice(0, DIGITS_MAX);
        inputEl.value = '+7' + d;

        if (!keepCaret) return;

        // аккуратно сохраняем каретку (минимум после +7)
        const maxPos = inputEl.value.length;
        let pos = Math.min(Math.max(prevPos, 2), maxPos);
        try { inputEl.setSelectionRange(pos, pos); } catch (_) {}
    };

    // стартовое значение
    if (!String(inputEl.value || '').startsWith('+7')) {
        setValue(extractDigitsAfterPlus7(inputEl.value), false);
    } else {
        // если было что-то после +7 — применим правило "до 9"
        const digits = extractDigitsAfterPlus7(inputEl.value);
        setValue(digits, false);
    }

    inputEl.addEventListener('keydown', (e) => {
        const start = inputEl.selectionStart ?? inputEl.value.length;
        const end = inputEl.selectionEnd ?? inputEl.value.length;

        // нельзя удалять "+7"
        if ((e.key === 'Backspace' && start <= 2 && end <= 2) ||
            (e.key === 'Delete' && start < 2)) {
            e.preventDefault();
            try { inputEl.setSelectionRange(2, 2); } catch (_) {}
            return;
        }

        // запрещаем ввод "+"
        if (e.key === '+') {
            e.preventDefault();
            return;
        }

        // запрещаем ввод если уже 10 цифр после +7 и нет выделения
        const currentDigits = inputEl.value.slice(2).replace(/\D/g, '');
        const isDigitKey = /^[0-9]$/.test(e.key);
        const hasSelection = end > start;

        if (isDigitKey && currentDigits.length >= DIGITS_MAX && !hasSelection) {
            // разрешаем редактировать внутри (если курсор не в конце)
            if (start >= inputEl.value.length) {
                e.preventDefault();
            }
        }
    });

    inputEl.addEventListener('input', () => {
        // берём цифры по правилу "до первой 9 удалить"
        const digits = extractDigitsAfterPlus7(inputEl.value);

        // НЕ даём увеличиваться больше 10: если пользователь попытался ввести 11-ю — просто оставим 10
        // (это единственное "обрезание", но оно строго лимит, без перестановок)
        setValue(digits, true);
    });

    inputEl.addEventListener('paste', () => {
        setTimeout(() => {
            const digits = extractDigitsAfterPlus7(inputEl.value);
            setValue(digits, false);
        }, 0);
    });

    inputEl.addEventListener('focus', () => {
        if (!String(inputEl.value || '').startsWith('+7')) {
            setValue(extractDigitsAfterPlus7(inputEl.value), false);
        }
        const pos = inputEl.selectionStart ?? 2;
        if (pos < 2) {
            try { inputEl.setSelectionRange(2, 2); } catch (_) {}
        }
    });
}






function bindPhoneNormalize(inputEl) {
    if (!inputEl || inputEl.dataset.phoneBound) return;

    inputEl.dataset.phoneBound = '1';

    // префилл
    if (!inputEl.value) inputEl.value = '+7';

    const apply = () => {
        const before = inputEl.value;
        const norm = normalizeRuPhone(before);

        // чтобы не ломать ввод, обновляем только если реально изменилось и/или стало валиднее
        if (norm && norm !== before) {
            inputEl.value = norm;
        }
    };

    inputEl.addEventListener('blur', apply);
    inputEl.addEventListener('paste', () => setTimeout(apply, 0));
}


function loadCartNotesFromStorage() {
    try {
        cartFloristComment = String(localStorage.getItem('cartFloristComment') || '');
        cartCardText = String(localStorage.getItem('cartCardText') || '');

        const rawEnabled = localStorage.getItem('cartCardEnabled');
        if (rawEnabled === null) {
            // если раньше тумблера не было — включаем, только если текст открытки уже задан
            cartCardEnabled = (cartCardText || '').trim().length > 0;
        } else {
            cartCardEnabled = rawEnabled === '1';
        }
    } catch (_) {}
}

function saveCartNotesToStorage() {
    try {
        localStorage.setItem('cartFloristComment', cartFloristComment || '');
        localStorage.setItem('cartCardText', cartCardText || '');
        localStorage.setItem('cartCardEnabled', cartCardEnabled ? '1' : '0');
    } catch (_) {}
}


function openCartNoteModal(mode) {
    const modal = document.getElementById('cartNoteModal');
    const title = document.getElementById('cartNoteModalTitle');
    const ta = document.getElementById('cartNoteModalTextarea');
    if (!modal || !title || !ta) return;

    cartNoteModalMode = mode;

    if (mode === 'card') {
        title.textContent = 'Открытка';
        ta.placeholder = 'Введите текст открытки...';
        ta.maxLength = 400;
        ta.value = cartCardText || '';
    } else {
        title.textContent = 'Комментарий';
        ta.placeholder = 'Введите комментарий...';
        ta.maxLength = 1000;
        ta.value = cartFloristComment || '';
    }

    try { window.__updateCartNoteCounter && window.__updateCartNoteCounter(); } catch (_) {}

    modal.classList.remove('hidden');
    document.body.classList.add('no-scroll');
    document.documentElement.classList.add('no-scroll');

    // фокус чуть позже, чтобы не дергалось в вебвью
    setTimeout(() => {
        try { ta.focus(); } catch (_) {}
    }, 50);
}

function closeCartNoteModal() {
    const modal = document.getElementById('cartNoteModal');
    if (!modal) return;

    modal.classList.add('hidden');
    document.body.classList.remove('no-scroll');
    document.documentElement.classList.remove('no-scroll');
    cartNoteModalMode = null;
}

function initCartNoteModal() {
    const modal = document.getElementById('cartNoteModal');
    const closeBtn = document.getElementById('cartNoteModalClose');
    const cancelBtn = document.getElementById('cartNoteModalCancel');
    const saveBtn = document.getElementById('cartNoteModalSave');
    const ta = document.getElementById('cartNoteModalTextarea');
    const counter = document.getElementById('cartNoteModalCounter');

    if (!modal || !saveBtn || !ta) return;

    const updateCounter = () => {
        const max = Number(ta.maxLength || 0);
        const len = ta.value.length;
        if (counter) counter.textContent = `${len}/${max || 0}`;
    };

    if (closeBtn) closeBtn.addEventListener('click', closeCartNoteModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeCartNoteModal);

    // клик по фону
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeCartNoteModal();
    });

    // жестко режем ввод сверх лимита + обновляем счетчик
    ta.addEventListener('input', () => {
        const max = Number(ta.maxLength || 0);
        if (max > 0 && ta.value.length > max) {
            ta.value = ta.value.slice(0, max);
        }
        updateCounter();
    });

    // обновляем счётчик каждый раз при фокусе (на всякий)
    ta.addEventListener('focus', updateCounter);

    saveBtn.addEventListener('click', () => {
        const text = String(ta.value || '');

        if (cartNoteModalMode === 'card') {
            cartCardText = text.trim();
            if (cartCardText.length > 0) cartCardEnabled = true;
        } else if (cartNoteModalMode === 'comment') {
            cartFloristComment = text.trim();
        }

        saveCartNotesToStorage();
        saveCartState();
        closeCartNoteModal();
        renderCart();
    });

    // сделаем updateCounter доступным для openCartNoteModal через window (без изменения логики)
    window.__updateCartNoteCounter = updateCounter;
}




function getCartQty(productId) {
    const item = cart.find(c => c.productId === productId);
    return item ? item.quantity : 0;
}

// === Инициализация Telegram WebApp ===
async function initTelegram() {
  if (window.Telegram && window.Telegram.WebApp) {
    tg = window.Telegram.WebApp;
    tg.ready();

      try { tg.expand(); } catch (_) {}

    telegramUser = tg.initDataUnsafe?.user || null;
    if (telegramUser) {
      telegramId = telegramUser.id.toString();
      await detectAdminEntryAccess();
      initUserOnServer();
      fillProfileHeader();
      loadInitialData();
    } else {
      // Для отладки в браузере без Telegram
      telegramId = 'debug-user-1';
      telegramUser = {
        first_name: 'Debug',
        last_name: 'User',
        username: 'debug_user'
      };
      adminEntryAllowed = false;
      initUserOnServer();
      fillProfileHeader();
      loadInitialData();
    }
  } else {
    // Отладка без Telegram
    telegramId = 'debug-user-1';
    telegramUser = {
      first_name: 'Debug',
      last_name: 'User',
      username: 'debug_user'
    };
    adminEntryAllowed = false;
    initUserOnServer();
    fillProfileHeader();
    loadInitialData();
  }
}

// === Запросы к серверу ===

async function initUserOnServer() {
  try {
    await fetch('/api/user/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegramId,
        firstName: telegramUser?.first_name,
        lastName: telegramUser?.last_name,
        username: telegramUser?.username,
        photoUrl: telegramUser?.photo_url
      })
    });
  } catch (err) {
    console.error('initUserOnServer error', err);
  }
}

async function loadInitialData() {
    await Promise.all([
        loadProducts(),
        loadAddresses(),
        loadOrders(),
        // loadBonusBalance()
    ]);

    renderCategories();
    renderProducts();
    renderAddressesProfile();
    renderOrdersProfile();
    renderCart(); // чтобы “У вас N бонусов” и итог сразу корректно показались
}


function startProductsAutoRefresh() {
    const REFRESH_INTERVAL_MS = 60 * 1000; // раз в минуту

    setInterval(async () => {
        try {
            await loadProducts();
            renderProducts();
            renderCart();
            renderCategories();
        } catch (e) {
            console.warn('Auto refresh products failed:', e);
        }
    }, REFRESH_INTERVAL_MS);
}


async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    products = await res.json();
  } catch (err) {
    console.error('loadProducts error', err);
  }
}

async function loadAddresses() {
  try {
    const res = await fetch(`/api/addresses/${telegramId}`);
    addresses = await res.json();
  } catch (err) {
    console.error('loadAddresses error', err);
  }
}

async function loadOrders() {
    try {
        // сначала подтянем статусы из МойСклад
        await fetch(`/api/moysklad/sync-order-statuses/${telegramId}`, {
            method: 'POST'
        });
    } catch (e) {
        console.warn('Cannot sync order statuses from MoySklad', e);
    }

    const res = await fetch(`/api/orders/${telegramId}`);
    orders = await res.json();
}


async function refreshAfterAnyAction({ rerenderProducts = true } = {}) {
    try {
        if (typeof renderCart === 'function') {
            renderCart();
        }

        if (rerenderProducts && typeof renderProducts === 'function') {
            renderProducts();
        }
    } catch (e) {
        console.warn('refreshAfterAnyAction error:', e);
    }
}

// async function refreshAfterAnyAction({ rerenderProducts = true } = {}) {
//     try {
//         // 1) бонусы (обновит и профиль, и при необходимости корзину)
//         await loadBonusBalance();
//
//         // 2) корзина (всегда пересчёт итога/тумблера/зачёркнутой цены)
//         if (typeof renderCart === 'function') {
//             renderCart();
//         }
//
//         // 3) каталог (чтобы кнопки qty/“корзина” в карточках не отставали)
//         if (rerenderProducts && typeof renderProducts === 'function') {
//             renderProducts();
//         }
//     } catch (e) {
//         console.warn('refreshAfterAnyAction error:', e);
//     }
// }



async function loadBonusBalance() {
    try {
        const resp = await fetch(`/api/bonuses/${telegramId}`);
        const data = await resp.json();

        if (!data.ok) {
            console.warn('loadBonusBalance failed:', data.error);
            return;
        }

        bonusBalance = Number(data.bonusBalance || 0);

        const el = document.getElementById('profileBonuses');
        if (el) {
            el.textContent = `Бонусы: ${bonusBalance} (1 бонус = 1 рубль)`;
        }

        // Если сейчас открыта корзина — пересчитаем отображение итога
        const activeTabBtn = document.querySelector('.nav-btn.active');
        const tabId = activeTabBtn?.dataset?.tab;
        if (tabId === 'cart' && typeof renderCart === 'function') {
            renderCart();
        }
    } catch (e) {
        console.error('loadBonusBalance error:', e);
    }
}


function getCategoriesFromProducts() {
    const set = new Set();
    products.forEach(p => {
        if (p.category) set.add(p.category);
    });
    return Array.from(set);
}

function renderCategories() {
    const bar = document.getElementById('categoriesBar');
    if (!bar) return;

    bar.innerHTML = '';

    const cats = ['ВСЕ', ...getCategoriesFromProducts()];

    cats.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'category-chip' + (cat === activeCategory ? ' active' : '');
        btn.textContent = cat;

        btn.onclick = () => {
            activeCategory = cat;
            renderCategories();
            renderProducts();
        };

        bar.appendChild(btn);
    });
}



// === Рендеринг ===

function renderProducts() {
    const list = document.getElementById('productsList');
    const searchValue = document.getElementById('searchInput').value
        .toLowerCase()
        .trim();

    list.innerHTML = '';

    const filtered = products.filter(p => {
        const okSearch = p.name.toLowerCase().includes(searchValue);
        const okCategory = (activeCategory === 'ВСЕ') || (p.category === activeCategory);
        return okSearch && okCategory;
    });

    filtered.forEach(product => {
        const card = document.createElement('div');
        card.className = 'product-card';

        const imgWrapper = document.createElement('div');
        imgWrapper.className = 'product-image-wrapper';

        let currentIndex = 0;
        const img = document.createElement('img');

        const images = product.images && product.images.length > 0
            ? product.images
            : ['https://via.placeholder.com/400x300?text=No+Image'];

        img.src = images[currentIndex];
        imgWrapper.appendChild(img);

        // === dots индикаторы ===
        let dotsWrap = null;
        const updateDots = () => {
            if (!dotsWrap) return;
            const dots = Array.from(dotsWrap.querySelectorAll('.image-dot'));
            dots.forEach((d, i) => d.classList.toggle('active', i === currentIndex));
        };

        if (images.length > 1) {
            // точки
            dotsWrap = document.createElement('div');
            dotsWrap.className = 'image-dots';

            images.forEach((_, i) => {
                const dot = document.createElement('span');
                dot.className = 'image-dot' + (i === currentIndex ? ' active' : '');
                dot.addEventListener('click', () => {
                    currentIndex = i;
                    img.src = images[currentIndex];
                    updateDots();
                });
                dotsWrap.appendChild(dot);
            });

            imgWrapper.appendChild(dotsWrap);

            // стрелки
            const prevBtn = document.createElement('button');
            prevBtn.className = 'image-nav-btn image-nav-btn-left';
            prevBtn.textContent = '◀';
            prevBtn.onclick = () => {
                currentIndex = (currentIndex - 1 + images.length) % images.length;
                img.src = images[currentIndex];
                updateDots();
            };

            const nextBtn = document.createElement('button');
            nextBtn.className = 'image-nav-btn image-nav-btn-right';
            nextBtn.textContent = '▶';
            nextBtn.onclick = () => {
                currentIndex = (currentIndex + 1) % images.length;
                img.src = images[currentIndex];
                updateDots();
            };

            imgWrapper.appendChild(prevBtn);
            imgWrapper.appendChild(nextBtn);
        }

        const bottom = document.createElement('div');
        bottom.className = 'product-bottom';

        const title = document.createElement('div');
        title.className = 'product-title';
        title.textContent = `${product.name}`;

        const price = document.createElement('div');
        price.className = 'product-price';
        price.textContent = `${product.price} ₽`;

        const controlsWrapper = document.createElement('div');

        const currentQty = getCartQty(product.id);
        const maxStock = product.stock ?? Infinity;

        if (currentQty === 0) {
            const addBtn = document.createElement('button');
            addBtn.className = 'product-add-btn';
            addBtn.textContent = 'Корзина';
            addBtn.onclick = () => addToCart(product);
            controlsWrapper.appendChild(addBtn);
        } else {
            const qtyControls = document.createElement('div');
            qtyControls.className = 'product-qty-controls';

            const minusBtn = document.createElement('button');
            minusBtn.className = 'product-qty-btn';
            minusBtn.textContent = '−';
            minusBtn.onclick = () => changeCartQty(product.id, -1);

            const value = document.createElement('div');
            value.className = 'product-qty-value';
            value.textContent = currentQty;

            const plusBtn = document.createElement('button');
            plusBtn.className = 'product-qty-btn';
            plusBtn.textContent = '+';
            plusBtn.onclick = () => changeCartQty(product.id, 1);

            qtyControls.appendChild(minusBtn);
            qtyControls.appendChild(value);
            qtyControls.appendChild(plusBtn);

            controlsWrapper.appendChild(qtyControls);
        }

        bottom.appendChild(price);
        bottom.appendChild(controlsWrapper);

        const info = document.createElement('div');
        info.className = 'product-info';

        info.appendChild(title);
        info.appendChild(bottom);

        card.appendChild(imgWrapper);
        card.appendChild(info);

        list.appendChild(card);
    });
}



function renderCart() {
    const container = document.getElementById('cartItems');
    const cartTotalEl = document.getElementById('cartTotal');

    // const bonusValueEl = document.getElementById('cartBonusValue');
    // const bonusEarnedValueEl = document.getElementById('bonusEarnedValue');
    // const bonusRowsEl = document.querySelector('.cart-bonus-rows');
    //
    // const bonusEarnedRowEl = document.querySelector('.bonus-earned-row');
    // const bonusBalanceRowEl = document.querySelector('.bonus-balance-row');
    //
    // const switchWrap = document.getElementById('bonusSwitchWrap');
    // const bonusTopRowEl = document.querySelector('.cart-bonus-top-row');
    // const bonusSectionEl = document.querySelector('.cart-bonus-section');
    //
    // const toggle = document.getElementById('useBonusesToggle');

    if (!container) return;

    // на всякий: если старый блок остался в DOM — убираем
    const legacyNotes = document.getElementById('cartNotes');
    if (legacyNotes) legacyNotes.remove();

    container.innerHTML = '';

    // “У вас бонусов”
    // if (bonusValueEl) bonusValueEl.textContent = String(bonusBalance || 0);

    // === Пустая корзина ===
    if (!cart || cart.length === 0) {
        container.innerHTML = '<p>Корзина пуста.</p>';

        // // скрываем "Списать" + тумблер
        // if (bonusTopRowEl) bonusTopRowEl.classList.add('hidden');
        //
        // // скрываем ТОЛЬКО строку "Будет начислено"
        // if (bonusEarnedRowEl) bonusEarnedRowEl.classList.add('hidden');
        //
        // // строка "У вас бонусов" ВСЕГДА остаётся
        // if (bonusBalanceRowEl) bonusBalanceRowEl.classList.remove('hidden');
        //
        // // убираем разделительную линию в секции бонусов
        // if (bonusSectionEl) bonusSectionEl.classList.add('no-divider');
        //
        // if (switchWrap) switchWrap.classList.add('hidden');
        //
        // if (toggle) toggle.checked = false;
        useBonusesSelected = false;

        if (cartTotalEl) cartTotalEl.textContent = '0 ₽';

        updateCartSumBadge();
        saveCartState();
        return;
    }

    // если корзина не пустая — показываем бонусный блок как обычно
    // if (bonusRowsEl) bonusRowsEl.classList.remove('hidden');
    // if (bonusTopRowEl) bonusTopRowEl.classList.remove('hidden');
    // if (bonusSectionEl) bonusSectionEl.classList.remove('no-divider');
    //
    // if (bonusEarnedRowEl) bonusEarnedRowEl.classList.remove('hidden');
    // if (bonusBalanceRowEl) bonusBalanceRowEl.classList.remove('hidden');

    // === Товары ===
    cart.forEach(item => {
        const row = document.createElement('div');
        row.className = 'cart-item';

        const info = document.createElement('div');
        info.className = 'cart-item-info';

        const name = document.createElement('div');
        name.className = 'cart-item-name';
        name.textContent = item.name;

        const price = document.createElement('div');
        price.className = 'cart-item-price';
        price.textContent = `${item.price} ₽`;

        info.appendChild(name);
        info.appendChild(price);

        const controls = document.createElement('div');
        controls.className = 'cart-item-controls';

        const minusBtn = document.createElement('button');
        minusBtn.className = 'cart-qty-btn';
        minusBtn.textContent = '-';
        minusBtn.onclick = () => changeCartQty(item.productId, -1);

        const qty = document.createElement('div');
        qty.className = 'cart-qty';
        qty.textContent = item.quantity;

        const plusBtn = document.createElement('button');
        plusBtn.className = 'cart-qty-btn';
        plusBtn.textContent = '+';
        plusBtn.onclick = () => changeCartQty(item.productId, 1);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'cart-remove-btn';
        removeBtn.textContent = 'Удалить';
        removeBtn.onclick = () => removeFromCart(item.productId);

        controls.appendChild(minusBtn);
        controls.appendChild(qty);
        controls.appendChild(plusBtn);
        controls.appendChild(removeBtn);

        row.appendChild(info);
        row.appendChild(controls);
        container.appendChild(row);
    });

    // === "Товар" Открытка (0 ₽) — ДОЛЖЕН быть НАД строкой тумблера ===
    if (cartCardEnabled) {
        const cardRow = document.createElement('div');
        cardRow.className = 'cart-item cart-item-note';
        cardRow.addEventListener('click', () => openCartNoteModal('card'));

        const info = document.createElement('div');
        info.className = 'cart-item-info';

        const name = document.createElement('div');
        name.className = 'cart-item-name';
        name.textContent = 'Открытка';

        const text = document.createElement('div');
        text.className = 'cart-item-note-text';
        text.textContent = (cartCardText && cartCardText.trim().length > 0)
            ? cartCardText
            : 'Нажмите, чтобы добавить текст открытки…';

        const price = document.createElement('div');
        price.className = 'cart-item-price';
        price.textContent = '0 ₽';

        info.appendChild(name);
        info.appendChild(text);
        info.appendChild(price);

        const hint = document.createElement('div');
        hint.className = 'cart-item-note-hint';
        hint.textContent = '>';

        cardRow.appendChild(info);
        cardRow.appendChild(hint);

        container.appendChild(cardRow);
    }

    // === Строка "Добавить открытку" + тумблер (под Открыткой) ===
    const cardToggleRow = document.createElement('div');
    cardToggleRow.className = 'cart-card-toggle-row';

    const cardToggleLabel = document.createElement('div');
    cardToggleLabel.className = 'cart-card-toggle-label';
    cardToggleLabel.textContent = 'Добавить открытку';

    const cardToggleWrap = document.createElement('div');
    cardToggleWrap.className = 'bonus-switch-wrapper';

    cardToggleWrap.innerHTML = `
      <label class="bonus-switch">
        <input type="checkbox" id="useCardToggle">
        <span class="switch-slider"></span>
      </label>
    `;

    cardToggleRow.appendChild(cardToggleLabel);
    cardToggleRow.appendChild(cardToggleWrap);
    container.appendChild(cardToggleRow);

    const useCardToggle = cardToggleWrap.querySelector('#useCardToggle');
    if (useCardToggle) {
        useCardToggle.checked = !!cartCardEnabled;
        useCardToggle.onchange = () => {
            cartCardEnabled = useCardToggle.checked;

            // если выключили — "товар открытка" исчезает, текст очищаем
            if (!cartCardEnabled) {
                cartCardText = '';
            }

            saveCartNotesToStorage();
            saveCartState();
            renderCart();
        };
    }

    // === Комментарий как кнопка — ДОЛЖЕН быть сразу под тумблером открытки ===
    const commentBtn = document.createElement('button');
    commentBtn.type = 'button';
    commentBtn.className = 'cart-note-btn';
    commentBtn.addEventListener('click', () => openCartNoteModal('comment'));

    const commentTitle = document.createElement('div');
    commentTitle.className = 'cart-note-btn-title';
    commentTitle.textContent = 'Комментарий';

    const commentText = document.createElement('div');
    commentText.className = 'cart-note-btn-text';
    commentText.textContent = (cartFloristComment && cartFloristComment.trim().length > 0)
        ? cartFloristComment
        : 'Нажмите, чтобы добавить комментарий…';

    commentBtn.appendChild(commentTitle);
    commentBtn.appendChild(commentText);
    container.appendChild(commentBtn);

    // === Сетка доставки (ниже комментария) ===
    container.appendChild(renderDeliveryGrid());

    // надпись про ночную доставку (как у тебя сейчас)
    const nightNote = document.createElement('div');
    nightNote.className = 'free-delivery-note';
    nightNote.textContent = 'Доставка с 21:00 до 08:00 + 500 ₽.';
    container.appendChild(nightNote);

    // === Тумблер бонусов показываем только если есть бонусы ===
    // if (switchWrap) {
    //     if (bonusBalance > 0) switchWrap.classList.remove('hidden');
    //     else switchWrap.classList.add('hidden');
    // }
    //
    // if (bonusBalance <= 0) {
    //     useBonusesSelected = false;
    //     if (toggle) toggle.checked = false;
    // }
    //
    // if (toggle) {
    //     toggle.checked = !!useBonusesSelected;
    //     toggle.onchange = () => {
    //         useBonusesSelected = toggle.checked;
    //         saveCartState();
    //         renderCart();
    //     };
    // }

    // === Итог ===
    // const pricing = computeCartPricing();
    //
    // if (cartTotalEl) {
    //     if (useBonusesSelected && pricing.redeemRub > 0) {
    //         cartTotalEl.innerHTML = `
    //           <span style="text-decoration: line-through; opacity: 0.7; font-size: 13px;">
    //             ${pricing.totalBeforeBonusRub} ₽
    //           </span>
    //           <span style="margin-left: 8px;">
    //             ${pricing.payableRub} ₽
    //           </span>
    //         `;
    //     } else {
    //         cartTotalEl.textContent = `${pricing.itemsTotalRub + pricing.deliveryFeeRub} ₽`;
    //     }
    // }
    //
    // // “Будет начислено” (5% от суммы к оплате)
    // if (bonusEarnedValueEl) {
    //     const willEarnRub = Math.floor(pricing.payableRub * 0.05);
    //     bonusEarnedValueEl.textContent = String(willEarnRub);
    // }
    //
    // updateCartSumBadge();
    // saveCartState();

    const pricing = computeCartPricing();

    if (cartTotalEl) {
        cartTotalEl.textContent = `${pricing.payableRub} ₽`;
    }

    updateCartSumBadge();
    saveCartState();
}



function updateCartSumBadge() {
    const badge = document.getElementById('cartSumBadge');
    if (!badge) return;

    const textEl = badge.querySelector('.cart-sum-text');

    const activeNavBtn = document.querySelector('.bottom-nav .nav-btn.active');
    const activeTab = activeNavBtn?.dataset?.tab || '';

    if (activeTab === 'cart' || !cart || cart.length === 0) {
        badge.classList.add('hidden');
        if (textEl) textEl.textContent = '';
        return;
    }

    const totalRub = cart.reduce(
        (sum, c) => sum + Number(c.price || 0) * Number(c.quantity || 0),
        0
    );

    if (textEl) textEl.textContent = `${totalRub} ₽`;
    badge.classList.remove('hidden');
}


function renderAddressesProfile() {
    const content = document.getElementById('profileContent');
    const activeTab =
        document.querySelector('.profile-tab-btn.active')?.dataset.profileTab ||
        'addresses';

    if (activeTab !== 'addresses') return;

    content.innerHTML = '';

    // ===== список адресов =====
    const listWrapper = document.createElement('div');

    if (!addresses || addresses.length === 0) {
        listWrapper.innerHTML = '<p>Адресов пока нет.</p>';
    } else {
        addresses.forEach(addr => {
            const item = document.createElement('div');
            item.className = 'address-item';

            const text = document.createElement('div');
            text.className = 'address-text';
            text.textContent = addr.address;

            const delBtn = document.createElement('button');
            delBtn.className = 'cart-remove-btn'; // как у тебя сейчас
            delBtn.textContent = 'Удалить';
            delBtn.onclick = () => deleteAddress(addr.id);

            item.appendChild(text);
            item.appendChild(delBtn);
            listWrapper.appendChild(item);
        });
    }

    // ===== форма добавления =====
    // ===== форма добавления =====
    const form = document.createElement('div');
    form.className = 'address-add-form';

// label как в модалке
    const label = document.createElement('label');
    label.className = 'address-add-label';
    label.textContent = 'Адрес';

// input
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'newAddressTextProfile';
    input.setAttribute('list', 'profileAddressSuggestions');
    input.placeholder = 'Город, улица, дом...';
    input.className = 'profile-address-input'; // <-- добавили класс

// datalist
    const dl = document.createElement('datalist');
    dl.id = 'profileAddressSuggestions';

// кнопка (всегда под input)
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.id = 'saveAddressProfileBtn';
    btn.textContent = 'Сохранить';

// собираем
    label.appendChild(input);
    form.appendChild(label);
    form.appendChild(dl);
    form.appendChild(btn);


    content.appendChild(listWrapper);
    content.appendChild(form);

    // ===== подсказки =====
    dl.innerHTML = '';
    (addresses || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.address;
        dl.appendChild(opt);
    });

    // ===== обработчик =====
    btn.addEventListener('click', saveNewAddressFromProfile);
}



function renderOrdersProfile() {
    const content = document.getElementById('profileContent');
    const activeTab =
        document.querySelector('.profile-tab-btn.active')?.dataset.profileTab ||
        'addresses';

    if (activeTab !== 'orders') return;

    content.innerHTML = '';

    if (orders.length === 0) {
        content.innerHTML = '<p>Заказов пока нет.</p>';
        return;
    }

    orders.forEach(order => {
        const item = document.createElement('div');
        item.className = 'order-item';

        const header = document.createElement('div');
        header.className = 'order-header';

        const idEl = document.createElement('div');
        idEl.className = 'order-id';

        // если есть номер из МойСклад — используем его, иначе fallback на локальный id
        const orderNumber = order.msName || order.ms_name || order.id;
        idEl.textContent = `${orderNumber}`;

        const status = document.createElement('div');
        status.className = 'order-status';
        status.textContent = order.status;

        header.appendChild(idEl);
        header.appendChild(status);

        const total = document.createElement('div');
        total.className = 'order-total';
        total.textContent = `${order.total} ₽`;

        const date = document.createElement('div');
        date.className = 'order-date';
        const d = new Date(order.createdAt || order.created_at);
        date.textContent = d.toLocaleString('ru-RU');

        item.appendChild(header);
        item.appendChild(total);
        item.appendChild(date);

        content.appendChild(item);
    });
}


function markError(input) {
    input.classList.add('input-error');
}

function clearError(input) {
    input.classList.remove('input-error');
}


async function syncOrdersAndRenderProfile() {
    try {
        const resp = await fetch('/api/orders/sync-statuses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramId })
        });

        const data = await resp.json();
        if (!data.ok) {
            console.warn('orders sync failed:', data.error);
            return;
        }

        // обновляем глобальный массив orders
        orders = data.orders.map(o => ({
            ...o,
            createdAt: o.createdAt || o.created_at
        }));

        // перерисовываем только если сейчас реально открыта вкладка "Заказы"
        const activeProfileTab =
            document.querySelector('.profile-tab-btn.active')?.dataset.profileTab ||
            'addresses';

        if (activeProfileTab === 'orders') {
            renderOrdersProfile();
        }
    } catch (e) {
        console.error('orders sync error:', e);
    }
}





function renderSupportProfile() {
  const content = document.getElementById('profileContent');
  content.innerHTML = `
    <p class="text">Чтобы обратиться в службу поддержки, нажмите на кнопку "Связаться с менеджером 👩🏼‍💻" в меню бота или сверните приложение и отправьте свой вопрос напрямую в чат с ботом.</p>
  `;
}

function fillProfileHeader() {
  const avatarEl = document.getElementById('profileAvatar');
  const nameEl = document.getElementById('profileName');
  const usernameEl = document.getElementById('profileUsername');

  const name = `${telegramUser?.first_name || ''} ${
    telegramUser?.last_name || ''
  }`.trim();
  nameEl.textContent = name || 'Гость';

  if (telegramUser?.username) {
    usernameEl.textContent = '@' + telegramUser.username;
  } else {
    usernameEl.textContent = '';
  }

  ensureAdminEntryButton();

  // Аватар
  if (telegramUser?.photo_url) {
    avatarEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = telegramUser.photo_url;
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (telegramUser?.first_name || '👤')[0];
  }
}

// === Логика корзины ===

async function addToCart(product) {
    const maxStock = product.stock ?? Infinity;
    const existing = cart.find(c => c.productId === product.id);
    const currentQty = existing ? existing.quantity : 0;

    if (!existing) {
        if (maxStock <= 0) return;

        cart.push({
            productId: product.id,      // локальный id (оставляем для UI)
            msId: product.ms_id || null, // ВАЖНО: сохраняем ms_id
            name: product.name,
            price: product.price,
            quantity: 1,
            stock: product.stock ?? null
        });
    } else {
        if (existing.quantity + 1 > maxStock) return;
        existing.quantity += 1;
    }

    await refreshAfterAnyAction({ rerenderProducts: true });
}

async function changeCartQty(productId, diff) {
    const item = cart.find(c => c.productId === productId);
    if (!item) return;

    const product = products.find(p => p.id === productId);
    const maxStock = product?.stock ?? Infinity;

    if (diff > 0 && item.quantity >= maxStock) {
        //alert(`Нельзя добавить больше ${maxStock} шт. этого товара.`);
        return;
    }

    item.quantity += diff;

    if (item.quantity <= 0) {
        // убираем из корзины полностью
        cart = cart.filter(c => c.productId !== productId);
    }

    await refreshAfterAnyAction({ rerenderProducts: true });
}


async function removeFromCart(productId) {
    cart = cart.filter(c => c.productId !== productId);
    await refreshAfterAnyAction({ rerenderProducts: true });
}

const CHECKOUT_CONTACT_STORAGE_KEY = 'checkoutContact_v1';

function loadCheckoutContactFromStorage() {
    try {
        const raw = localStorage.getItem(CHECKOUT_CONTACT_STORAGE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;

        return {
            firstName: String(obj.firstName || '').trim(),
            lastName: String(obj.lastName || '').trim(),
            phone: String(obj.phone || '').trim(),
            email: String(obj.email || '').trim()
        };
    } catch (_) {
        return null;
    }
}

function saveCheckoutContactToStorage({ firstName, lastName, phone, email }) {
    try {
        localStorage.setItem(CHECKOUT_CONTACT_STORAGE_KEY, JSON.stringify({
            firstName: String(firstName || '').trim(),
            lastName: String(lastName || '').trim(),
            phone: String(phone || '').trim(),
            email: String(email || '').trim()
        }));
    } catch (_) {}
}

// === Оформление заказа ===

function openCheckoutModal() {
    if (cart.length === 0) return;

    const modal = document.getElementById('checkoutFormWrapper');
    const firstNameInput = document.getElementById('checkoutFirstName');
    const lastNameInput = document.getElementById('checkoutLastName');
    const phoneInput = document.getElementById('checkoutPhone');
    const emailInput = document.getElementById('checkoutEmail');

    // важно: нормализация телефона + префикс +7 (если поле пустое)
    if (phoneInput) enforcePlus7Input(phoneInput);

    const addressesContainer = document.getElementById('addressesContainer');
    const newAddressInput = document.getElementById('newAddressInput');

    const checkoutConfirmBtn = document.getElementById('checkoutConfirm');

    document.documentElement.classList.add('no-scroll');
    document.body.classList.add('no-scroll');

    // === НОВОЕ: подставляем последние введённые данные (приоритетнее Telegram) ===
    const saved = loadCheckoutContactFromStorage();

    const tgFirst = telegramUser?.first_name || '';
    const tgLast = telegramUser?.last_name || '';

    if (firstNameInput) firstNameInput.value = (saved?.firstName || tgFirst);
    if (lastNameInput) lastNameInput.value = (saved?.lastName || tgLast);

    // телефон: если есть сохранённый — ставим его, иначе оставляем как есть (enforcePlus7Input уже подставит +7 при пустом)
    if (phoneInput && saved?.phone) phoneInput.value = saved.phone;
    if (emailInput && saved?.email) emailInput.value = saved.email;

    // метод доставки берём из выбора в корзине (4 кнопки)
    checkoutDeliveryMethod = (selectedDeliveryOption === 'pickup') ? 'pickup' : 'delivery';

    // слот времени сбрасываем при каждом открытии
    selectedDeliveryInterval = '';
    const hiddenInterval = document.getElementById('deliveryTimeInterval');
    if (hiddenInterval) hiddenInterval.value = '';

    // самовывоз: дата/время самовывоза сбрасываем при каждом открытии
    const pickupDateEl0 = document.getElementById('pickupDate');
    const pickupTimeEl0 = document.getElementById('pickupTime');
    const pickupTimeWrap0 = document.getElementById('pickupTimeWrap');
    if (pickupDateEl0) pickupDateEl0.value = '';
    if (pickupTimeEl0) pickupTimeEl0.value = '';
    if (pickupTimeWrap0) pickupTimeWrap0.classList.add('hidden');

    // режим получателя по умолчанию
    checkoutReceiverMode = 'self';

    // кнопки "я получу сам / другой получатель"
    const btnSelf = document.getElementById('receiverModeSelfBtn');
    const btnOther = document.getElementById('receiverModeOtherBtn');
    if (btnSelf && btnOther) {
        btnSelf.classList.add('active');
        btnOther.classList.remove('active');
        btnSelf.onclick = () => setCheckoutReceiverMode('self');
        btnOther.onclick = () => setCheckoutReceiverMode('other');
    }
    setCheckoutReceiverMode('self');

    // КНОПКИ delivery/pickup в форме (если они ещё есть в html) — НЕ ЛОМАЕМ, но логика берётся из корзины
    const btnDelivery = document.getElementById('deliveryMethodDeliveryBtn');
    const btnPickup = document.getElementById('deliveryMethodPickupBtn');
    if (btnDelivery && btnPickup) {
        btnDelivery.onclick = () => setCheckoutDeliveryMethod('delivery');
        btnPickup.onclick = () => setCheckoutDeliveryMethod('pickup');
    }

    // адреса + подсказки
    if (addressesContainer) addressesContainer.innerHTML = '';

    if (addresses.length === 1 && newAddressInput) {
        newAddressInput.value = addresses[0].address;
    }

    const suggestions = document.getElementById('addressSuggestions');
    if (suggestions) {
        suggestions.innerHTML = '';
        addresses.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.address;
            suggestions.appendChild(opt);
        });
    }

    // дата доставки: min ставим, но value оставляем пустым
    const dateEl = document.getElementById('deliveryDate');
    if (dateEl) {
        const now = new Date();
        const todayStr = toISODateLocal(now);

        // если уже позже 22:00 — сегодня запрещаем
        const tooLateForToday = isNowAfter2200(now);
        const minDate = tooLateForToday ? toISODateLocal(addDays(now, 1)) : todayStr;

        // ограничение выбора
        dateEl.min = minDate;

        // ВАЖНО: НЕ проставляем дату автоматически.
        // Если дата была уже выбрана ранее — проверим её на валидность.
        if (dateEl.value) {
            if (dateEl.value < minDate) {
                dateEl.value = ''; // сбрасываем, чтобы пользователь выбрал заново
            }
        }

        // Слоты должны быть скрыты, пока дата не выбрана
        renderDeliveryTimeSlots(dateEl.value || '');

        dateEl.onchange = () => {
            const curNow = new Date();
            const tooLate = isNowAfter2200(curNow);

            // если выбрали сегодня, но уже поздно — сбрасываем выбор (или можно автопереключать на завтра)
            if (dateEl.value === toISODateLocal(curNow) && tooLate) {
                dateEl.value = '';
            }

            renderDeliveryTimeSlots(dateEl.value || '');
            validateCheckoutForm({ showErrors: false });
        };
    }


    // дата самовывоза: полностью аналогично дате доставки (min, без автозаполнения)
    const pickupDateEl = document.getElementById('pickupDate');
    const pickupTimeEl = document.getElementById('pickupTime');
    const pickupTimeWrap = document.getElementById('pickupTimeWrap');

    const setPickupTimeVisible = (visible) => {
        if (!pickupTimeWrap) return;
        pickupTimeWrap.classList.toggle('hidden', !visible);
    };

    if (pickupDateEl) {
        const now = new Date();
        const todayStr = toISODateLocal(now);

        // если уже позже 22:00 — сегодня запрещаем (как для доставки)
        const tooLateForToday = isNowAfter2200(now);
        const minDate = tooLateForToday ? toISODateLocal(addDays(now, 1)) : todayStr;

        pickupDateEl.min = minDate;

        if (pickupDateEl.value) {
            if (pickupDateEl.value < minDate) pickupDateEl.value = '';
        }

        // время скрыто пока дата не выбрана
        setPickupTimeVisible(!!pickupDateEl.value);

        pickupDateEl.onchange = () => {
            const curNow = new Date();
            const tooLate = isNowAfter2200(curNow);

            if (pickupDateEl.value === toISODateLocal(curNow) && tooLate) {
                pickupDateEl.value = '';
            }

            // при смене даты сбрасываем время, чтобы не отправить "старое"
            if (pickupTimeEl) pickupTimeEl.value = '';

            setPickupTimeVisible(!!pickupDateEl.value);
            validateCheckoutForm({ showErrors: false });
        };
    }

    if (pickupTimeEl) {
        pickupTimeEl.onchange = () => validateCheckoutForm({ showErrors: false });
    }

    // кнопка активна всегда (валидация управляет фактом отправки через validateCheckoutForm/confirm)
    if (checkoutConfirmBtn) checkoutConfirmBtn.disabled = false;

    modal.classList.remove('hidden');

    // ключевое: показываем deliveryFields или pickupInfo по текущему выбору в корзине
    setCheckoutDeliveryMethod(checkoutDeliveryMethod);

    validateCheckoutForm({ showErrors: false });
}




async function closeCheckoutModal() {
  const modal = document.getElementById('checkoutFormWrapper');
  modal.classList.add('hidden');
    document.documentElement.classList.remove('no-scroll');
    document.body.classList.remove('no-scroll');

    // после любого закрытия оформления — обновляем бонусы/итоги/кнопки
    await refreshAfterAnyAction({ rerenderProducts: true });

}

async function onCheckoutConfirmClick() {
    const isValid = validateCheckoutForm({ showErrors: true });
    if (!isValid) return;

    await confirmCheckout();
}


function setCheckoutReceiverMode(mode) {
    checkoutReceiverMode = (mode === 'other') ? 'other' : 'self';

    const btnSelf = document.getElementById('receiverModeSelfBtn');
    const btnOther = document.getElementById('receiverModeOtherBtn');
    const receiverFields = document.getElementById('receiverFields');

    if (btnSelf && btnOther) {
        btnSelf.classList.toggle('active', checkoutReceiverMode === 'self');
        btnOther.classList.toggle('active', checkoutReceiverMode === 'other');
    }

    if (receiverFields) {
        if (checkoutReceiverMode === 'other') {
            const phoneEl = document.getElementById('receiverPhone');
            if (phoneEl) enforcePlus7Input(phoneEl);
            receiverFields.classList.remove('hidden');
        } else {
            receiverFields.classList.add('hidden');

            // очищаем, чтобы не путалось при переключениях
            const nameEl = document.getElementById('receiverFullName');
            const phoneEl = document.getElementById('receiverPhone');
            if (nameEl) nameEl.value = '';
            if (phoneEl) phoneEl.value = '';
        }
    }

    validateCheckoutForm({ showErrors: false });
}


function setCheckoutDeliveryMethod(method) {
    checkoutDeliveryMethod = method === 'pickup' ? 'pickup' : 'delivery';

    const btnDelivery = document.getElementById('deliveryMethodDeliveryBtn');
    const btnPickup = document.getElementById('deliveryMethodPickupBtn');
    const deliveryFields = document.getElementById('deliveryFields');
    const pickupInfo = document.getElementById('pickupInfo');

    if (btnDelivery && btnPickup) {
        btnDelivery.classList.toggle('active', checkoutDeliveryMethod === 'delivery');
        btnPickup.classList.toggle('active', checkoutDeliveryMethod === 'pickup');
    }

    if (deliveryFields && pickupInfo) {
        if (checkoutDeliveryMethod === 'pickup') {
            deliveryFields.classList.add('hidden');
            pickupInfo.classList.remove('hidden');

            // при самовывозе очищаем слот времени/дату (в МС время доставки должно быть пустое)
            const hiddenInterval = document.getElementById('deliveryTimeInterval');
            if (hiddenInterval) hiddenInterval.value = '';
            selectedDeliveryInterval = '';

            // самовывоз: показываем/скрываем поле времени в зависимости от выбранной даты
            const pickupDateEl = document.getElementById('pickupDate');
            const pickupTimeWrap = document.getElementById('pickupTimeWrap');
            if (pickupTimeWrap) pickupTimeWrap.classList.toggle('hidden', !(pickupDateEl && pickupDateEl.value));
        } else {
            deliveryFields.classList.remove('hidden');
            pickupInfo.classList.add('hidden');

            const dateEl = document.getElementById('deliveryDate');
            if (dateEl && dateEl.value) {
                renderDeliveryTimeSlots(dateEl.value);
            }

            // доставка: прячем/сбрасываем самовывозные поля, чтобы не путалось
            const pickupDateEl = document.getElementById('pickupDate');
            const pickupTimeEl = document.getElementById('pickupTime');
            const pickupTimeWrap = document.getElementById('pickupTimeWrap');
            if (pickupDateEl) pickupDateEl.value = '';
            if (pickupTimeEl) pickupTimeEl.value = '';
            if (pickupTimeWrap) pickupTimeWrap.classList.add('hidden');
        }
    }

    validateCheckoutForm({ showErrors: false });
}

function renderDeliveryTimeSlots(dateStr) {
    const titleEl = document.getElementById('deliveryTimeTitle');
    const slotsBar = document.getElementById('deliveryTimeSlots');
    const hiddenInterval = document.getElementById('deliveryTimeInterval');
    const noticeEl = document.getElementById('deliveryHoursNotice');
    if (!slotsBar || !hiddenInterval) return;

    const setVisible = (isVisible) => {
        if (titleEl) titleEl.classList.toggle('hidden', !isVisible);
        slotsBar.classList.toggle('hidden', !isVisible);
    };

    const setNotice = (show) => {
        if (!noticeEl) return;
        noticeEl.classList.toggle('hidden', !show);
    };

    slotsBar.innerHTML = '';

    // нет даты — скрываем
    if (!dateStr) {
        hiddenInterval.value = '';
        selectedDeliveryInterval = '';
        setVisible(false);
        setNotice(false);
        return;
    }

    // самовывоз — слоты не нужны
    if (checkoutDeliveryMethod === 'pickup') {
        hiddenInterval.value = '';
        selectedDeliveryInterval = '';
        setVisible(false);
        setNotice(false);
        return;
    }

    setVisible(true);

    const now = new Date();
    const todayStr = toISODateLocal(now);

    // показываем предупреждение только если сейчас ночь (после 22 и до 8)
    setNotice(isNightClosedHours(now));

    // если сегодня и уже позже 22:00 — сегодня выбирать нельзя
    if (dateStr === todayStr && isNowAfter2200(now)) {
        const dateEl = document.getElementById('deliveryDate');
        if (dateEl) {
            const tomorrow = toISODateLocal(addDays(now, 1));
            dateEl.value = tomorrow;
            dateEl.min = tomorrow;
            return renderDeliveryTimeSlots(tomorrow);
        }
    }

    const slots = buildTimeSlots(dateStr, now);

    slots.forEach(interval => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'category-chip' + (interval === selectedDeliveryInterval ? ' active' : '');
        btn.textContent = interval;

        btn.onclick = () => {
            selectedDeliveryInterval = interval;
            hiddenInterval.value = interval;
            renderDeliveryTimeSlots(dateStr);
            validateCheckoutForm({ showErrors: false });
        };

        slotsBar.appendChild(btn);
    });

    // если текущий выбор исчез — очищаем
    if (selectedDeliveryInterval && !slots.includes(selectedDeliveryInterval)) {
        selectedDeliveryInterval = '';
        hiddenInterval.value = '';
    }
}

// Генерация интервалов по 2 часа, шаг 1 час.
// Окно доставки: 08:00..22:00 (последний слот 22:00-00:00)
// Завтра и далее: сетка ровно по часам.
// Сегодня: 1-й слот от (now + 120min) с текущими минутами,
// дальше слоты строго по часам: 15:00-17:00, 16:00-18:00 ... до 22:00-00:00
function buildTimeSlots(dateStr, now) {
    const slots = [];

    const dateBase = new Date(dateStr + 'T00:00:00');
    const todayStr = toISODateLocal(now);
    const isToday = (dateStr === todayStr);

    const startOfWindow = new Date(dateBase);
    startOfWindow.setHours(0, 0, 0, 0);

    const lastStart = new Date(dateBase);
    lastStart.setHours(22, 0, 0, 0);

    // округление вверх до ближайшего часа
    const ceilToNextHour = (d) => {
        const x = new Date(d);
        if (x.getMinutes() === 0 && x.getSeconds() === 0 && x.getMilliseconds() === 0) return x;
        x.setHours(x.getHours() + 1, 0, 0, 0);
        return x;
    };

    if (!isToday) {
        let curStart = new Date(startOfWindow);
        while (curStart <= lastStart) {
            const end = new Date(curStart.getTime() + 120 * 60 * 1000);
            slots.push(`${fmtHM(curStart)} - ${fmtHM(end)}`);
            curStart = new Date(curStart.getTime() + 60 * 60 * 1000);
        }
        return slots;
    }

    // ---- сегодня ----
    let firstStart = new Date(now.getTime() + 120 * 60 * 1000);

    // если раньше 08:00 — первый слот начинаем с 08:00
    if (firstStart < startOfWindow) firstStart = new Date(startOfWindow);

    // если уже позже последнего возможного старта — слотов нет
    if (firstStart > lastStart) return [];

    const firstEnd = new Date(firstStart.getTime() + 120 * 60 * 1000);
    slots.push(`${fmtHM(firstStart)} - ${fmtHM(firstEnd)}`);

    // следующий старт: округление вверх до ближайшего часа
    let curStart = ceilToNextHour(firstStart);

    // если округление вернуло тот же час (например, firstStart = 08:00),
    // следующий слот должен стартовать через 1 час, а не дублировать
    if (curStart.getTime() === firstStart.getTime()) {
        curStart = new Date(curStart.getTime() + 60 * 60 * 1000);
    }

    while (curStart <= lastStart) {
        const end = new Date(curStart.getTime() + 120 * 60 * 1000);
        slots.push(`${fmtHM(curStart)} - ${fmtHM(end)}`);
        curStart = new Date(curStart.getTime() + 60 * 60 * 1000);
    }

    return slots;
}


function fmtHM(d) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function toISODateLocal(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function addDays(d, days) {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
}

function isNowAfter2200(now) {
    const h = now.getHours();
    const m = now.getMinutes();
    return (h > 22) || (h === 22 && m > 0);
}

// true, если сейчас между 22:00..08:00 (включая ночь)
function isNightClosedHours(now) {
    const h = now.getHours();
    return (h >= 22) || (h < 8);
}






let checkoutRequestInFlight = false;

async function confirmCheckout() {
    const ok = validateCheckoutForm({ showErrors: true });
    if (!ok) return;

    if (checkoutRequestInFlight) return;

    const btn = document.getElementById('checkoutConfirm');
    try {
        checkoutRequestInFlight = true;
        if (btn) btn.disabled = true;

        const firstName = document.getElementById('checkoutFirstName').value.trim();
        const lastName = document.getElementById('checkoutLastName').value.trim();
        const phone = normalizeRuPhoneStrict(document.getElementById('checkoutPhone')?.value || '+7');
        const email = (document.getElementById('checkoutEmail')?.value || '').trim();

        saveCheckoutContactToStorage({ firstName, lastName, phone, email });

        let floristComment = (document.getElementById('cartFloristComment')?.value || cartFloristComment || '').trim();
        const cardText = (document.getElementById('cartCardText')?.value || cartCardText || '').trim();

        // получатель
        let recipientFullName = '';
        let recipientPhone = '';

        if (checkoutReceiverMode === 'other') {
            recipientFullName = (document.getElementById('receiverFullName')?.value || '').trim();
            recipientPhone = normalizeRuPhoneStrict(document.getElementById('receiverPhone')?.value || '+7');
        } else {
            recipientFullName = `${firstName} ${lastName}`.trim();
            recipientPhone = phone;
        }

        const newAddressInput = document.getElementById('newAddressInput');
        const radioSelected = document.querySelector('input[name="checkoutAddress"]:checked');
        const dateEl = document.getElementById('deliveryDate');
        const hiddenInterval = document.getElementById('deliveryTimeInterval');

        let address = '';
        let deliveryDate = '';
        let deliveryTimeInterval = '';

        if (checkoutDeliveryMethod === 'delivery') {
            deliveryDate = (dateEl?.value || '').trim();
            deliveryTimeInterval = (hiddenInterval?.value || '').trim();
            address = radioSelected
                ? String(radioSelected.value || '').trim()
                : String(newAddressInput?.value || '').trim();
        } else {
            address = 'САМОВЫВОЗ';

            const pickupDateEl = document.getElementById('pickupDate');
            const pickupTimeEl = document.getElementById('pickupTime');

            const pickupDate = (pickupDateEl?.value || '').trim();
            const pickupTime = (pickupTimeEl?.value || '').trim();

            // кладём дату/время самовывоза в те же поля, что и доставка (бек уже их принимает)
            deliveryDate = pickupDate;
            deliveryTimeInterval = pickupTime;

            // комментарий в МойСклад: склеиваем ровно в нужном формате
            const baseComment = floristComment || '';
            floristComment = `Комментарий: ${baseComment}; Время самовывоза: ${pickupTime}`;
        }

        const payload = {
            telegramId,
            firstName,
            lastName,
            phone,

            email,
            deliveryOption: selectedDeliveryOption,
            deliveryFeeRub: getDeliveryFeeRub(),


            receiverMode: checkoutReceiverMode, // 'self' | 'other'
            recipientFullName,
            recipientPhone,

            floristComment,
            cardText,

            deliveryMethod: checkoutDeliveryMethod,
            address,
            deliveryDate,
            deliveryTime: deliveryTimeInterval,

            useBonuses: false,
            items: cart.map(c => ({
                productId: c.productId,
                msId: c.msId,
                name: c.name,
                price: c.price,
                quantity: c.quantity
            }))
        };

        const resp = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await resp.json();
        if (!data.ok) {
            const code = data.error || 'CHECKOUT_FAILED';
            let msg = 'Не получилось оформить заказ. Попробуйте чуть позже или напишите в поддержку.';
            if (code === 'checkout_failed_moysklad_sync') {
                msg = 'Не удалось связать заказ с учётной системой. Попробуйте позже или напишите в поддержку.';
            } else if (code === 'checkout_failed_missing_ms_ids') {
                msg = 'В корзине есть товар без привязки к каталогу. Обновите страницу или выберите товар заново.';
            } else if (code === 'BAD_REQUEST') {
                msg = 'Проверьте, что корзина не пустая и контактные данные заполнены.';
            }
            alert(msg);
            return;
        }

        const { paymentUrl, orderId } = data;
        if (data.warning_code === 'moysklad_degraded') {
            alert('Заказ принят и передан на оплату. Синхронизация с учётной системой временно не прошла — менеджер увидит заказ здесь.');
        }

        if (window.Telegram && window.Telegram.WebApp) {
            Telegram.WebApp.openLink(paymentUrl);
        } else {
            window.location.href = paymentUrl;
        }

        waitForOrderCompletion(orderId).then(success => {
            if (!success) return;

            cart = [];
            try { localStorage.removeItem(CART_STORAGE_KEY); } catch (_) {}

            if (typeof renderCart === 'function') renderCart();
            if (typeof updateCartBadge === 'function') updateCartBadge();

            closeCheckoutModal();
            syncOrdersAndRenderProfile();
        });

    } catch (e) {
        console.error('confirmCheckout error:', e);
    } finally {
        checkoutRequestInFlight = false;
        if (btn) btn.disabled = false;
    }
}





async function waitForOrderCompletion(orderId, {
    timeoutMs = 10 * 60 * 1000,   // 10 минут
    intervalMs = 5000            // опрос каждые 5 секунд
} = {}) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, intervalMs));

        try {
            const resp = await fetch(`/api/orders/status/${orderId}`);
            const data = await resp.json();

            // await loadBonusBalance();

            if (!data.ok) continue;

            // УСПЕХ: только после подтверждённой оплаты
            if (data.status === 'PAID') {
                return true;
            }

            // НЕУСПЕХ: отмена/ошибка
            if (
                data.status === 'CANCELLED' ||
                data.status === 'REJECTED' ||
                data.status === 'FAILED' ||
                data.status === 'PAYMENT_FAILED'
            ) {
                return false;
            }
        } catch (e) {
            console.error('waitForOrderCompletion error:', e);
        }
    }

    return false;
}





function validateCheckoutForm({ showErrors = false } = {}) {
    const firstNameEl = document.getElementById('checkoutFirstName');
    const lastNameEl = document.getElementById('checkoutLastName');
    const phoneEl = document.getElementById('checkoutPhone');

    const emailEl = document.getElementById('checkoutEmail');
    const email = (emailEl?.value || '').trim();

    const receiverNameEl = document.getElementById('receiverFullName');
    const receiverPhoneEl = document.getElementById('receiverPhone');

    const dateEl = document.getElementById('deliveryDate');
    const newAddressInput = document.getElementById('newAddressInput');
    const radioSelected = document.querySelector('input[name="checkoutAddress"]:checked');

    const hiddenInterval = document.getElementById('deliveryTimeInterval');

    const firstName = (firstNameEl?.value || '').trim();
    const lastName = (lastNameEl?.value || '').trim();
    const phone = normalizeRuPhoneStrict(phoneEl?.value || '+7');

    const receiverFullName = (receiverNameEl?.value || '').trim();
    const receiverPhone = normalizeRuPhoneStrict(receiverPhoneEl?.value || '+7');

    // доставка-зависимые значения
    let addressValue = '';
    let deliveryDate = '';
    let deliveryInterval = '';

    // самовывоз-зависимые значения
    let pickupDate = '';
    let pickupTime = '';

    if (checkoutDeliveryMethod === 'delivery') {
        deliveryDate = (dateEl?.value || '').trim();
        deliveryInterval = (hiddenInterval?.value || '').trim();

        addressValue = radioSelected
            ? String(radioSelected.value || '').trim()
            : String(newAddressInput?.value || '').trim();    } else if (checkoutDeliveryMethod === 'pickup') {
        const pickupDateEl = document.getElementById('pickupDate');
        const pickupTimeEl = document.getElementById('pickupTime');
        pickupDate = (pickupDateEl?.value || '').trim();
        pickupTime = (pickupTimeEl?.value || '').trim();
    }

    const errors = {
        firstName: firstName.length === 0,
        lastName: lastName.length === 0,
        phone: !/^\+7\d{10}$/.test(phone),
        email: email.length === 0,

        // если "другой получатель" — эти 2 поля обязательные
        receiverName: checkoutReceiverMode === 'other' ? (receiverFullName.length === 0) : false,
        receiverPhone: checkoutReceiverMode === 'other' ? !/^\+7\d{10}$/.test(receiverPhone) : false,

        address: checkoutDeliveryMethod === 'delivery' ? (addressValue.length === 0) : false,
        date: checkoutDeliveryMethod === 'delivery' ? (deliveryDate.length === 0) : false,
        time: checkoutDeliveryMethod === 'delivery' ? (deliveryInterval.length === 0) : false,

        pickupDate: checkoutDeliveryMethod === 'pickup' ? (pickupDate.length === 0) : false,
        pickupTime: checkoutDeliveryMethod === 'pickup' ? (pickupTime.length === 0) : false
    };

    if (showErrors) {
        if (firstNameEl) firstNameEl.classList.toggle('input-error', errors.firstName);
        if (lastNameEl) lastNameEl.classList.toggle('input-error', errors.lastName);
        if (phoneEl) phoneEl.classList.toggle('input-error', errors.phone);
        if (emailEl) emailEl.classList.toggle('input-error', errors.email);

        if (receiverNameEl) receiverNameEl.classList.toggle('input-error', errors.receiverName);
        if (receiverPhoneEl) receiverPhoneEl.classList.toggle('input-error', errors.receiverPhone);

        if (checkoutDeliveryMethod === 'delivery') {
            if (newAddressInput) newAddressInput.classList.toggle('input-error', errors.address);
            if (dateEl) dateEl.classList.toggle('input-error', errors.date);
            const slotsBar = document.getElementById('deliveryTimeSlots');
            if (slotsBar) slotsBar.classList.toggle('input-error', errors.time);
            const pickupDateEl = document.getElementById('pickupDate');
            const pickupTimeEl = document.getElementById('pickupTime');
            if (pickupDateEl) pickupDateEl.classList.remove('input-error');
            if (pickupTimeEl) pickupTimeEl.classList.remove('input-error');
        } else {
            if (newAddressInput) newAddressInput.classList.remove('input-error');
            if (dateEl) dateEl.classList.remove('input-error');
            const slotsBar = document.getElementById('deliveryTimeSlots');
            if (slotsBar) slotsBar.classList.remove('input-error');

            const pickupDateEl = document.getElementById('pickupDate');
            const pickupTimeEl = document.getElementById('pickupTime');
            if (pickupDateEl) pickupDateEl.classList.toggle('input-error', errors.pickupDate);
            if (pickupTimeEl) pickupTimeEl.classList.toggle('input-error', errors.pickupTime);
        }
    } else {
        if (firstNameEl && !errors.firstName) firstNameEl.classList.remove('input-error');
        if (lastNameEl && !errors.lastName) lastNameEl.classList.remove('input-error');
        if (phoneEl && !errors.phone) phoneEl.classList.remove('input-error');

        if (receiverNameEl && !errors.receiverName) receiverNameEl.classList.remove('input-error');
        if (receiverPhoneEl && !errors.receiverPhone) receiverPhoneEl.classList.remove('input-error');

        const pickupDateEl = document.getElementById('pickupDate');
        const pickupTimeEl = document.getElementById('pickupTime');
        if (pickupDateEl && !errors.pickupDate) pickupDateEl.classList.remove('input-error');
        if (pickupTimeEl && !errors.pickupTime) pickupTimeEl.classList.remove('input-error');
    }

    return !Object.values(errors).some(Boolean);
}






// === Профиль: адреса ===

async function saveNewAddressFromProfile() {
    const addrInput = document.getElementById('newAddressTextProfile');
    const address = (addrInput.value || '').trim();

    if (!address) return;

    // защита от дублей на фронте
    const exists = addresses.some(a =>
        String(a.address || '').trim().toLowerCase() === address.toLowerCase()
    );
    if (exists) {
        // адрес уже есть — просто перерисуем (и можно очистить поле)
        addrInput.value = '';
        renderAddressesProfile();
        return;
    }

    try {
        const res = await fetch(`/api/addresses/${telegramId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label: '', address })
        });

        const newAddr = await res.json();

        // на всякий случай: если сервер вернул дубль/ошибку
        if (!newAddr || !newAddr.id) {
            console.warn('Address was not created:', newAddr);
            return;
        }

        addresses.push(newAddr);
        addrInput.value = '';
        renderAddressesProfile();
    } catch (err) {
        console.error('saveNewAddressFromProfile error', err);
        alert('Не удалось сохранить адрес');
    }
}


async function deleteAddress(addressId) {
    //if (!confirm('Удалить этот адрес?')) return;

    try {
        const res = await fetch(`/api/addresses/${addressId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegramId })
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
            throw new Error(data.error || 'Ошибка удаления');
        }

        addresses = addresses.filter(a => a.id !== addressId);
        renderAddressesProfile();
    } catch (err) {
        console.error('deleteAddress error', err);
        alert('Не удалось удалить адрес');
    }
}



// === Навигация ===

function initNav() {
  const navButtons = document.querySelectorAll('.nav-btn');
  const tabs = document.querySelectorAll('.tab-content');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      navButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      tabs.forEach(tab => {
        tab.classList.toggle('active', tab.id === `tab-${tabId}`);
      });

      const searchWrapper = document.getElementById('shop-search-wrapper');
      if (tabId === 'shop') {
        searchWrapper.style.display = 'block';
      } else {
        searchWrapper.style.display = 'none';
      }

        // если уходим с профиля — стопим автообновление заказов
        if (tabId !== 'profile' && ordersSyncTimer) {
            clearInterval(ordersSyncTimer);
            ordersSyncTimer = null;
        }


        if (tabId === 'cart') {
        renderCart();
      } else if (tabId === 'profile') {
        const activeProfileTab =
          document.querySelector('.profile-tab-btn.active')
            ?.dataset.profileTab || 'addresses';
        if (activeProfileTab === 'addresses') {
          renderAddressesProfile();
        } else if (activeProfileTab === 'orders') {
            // Останавливаем старый таймер, если он крутится
            if (ordersSyncTimer) {
                clearInterval(ordersSyncTimer);
                ordersSyncTimer = null;
            }

            // Сразу подтягиваем статусы и рисуем
            syncOrdersAndRenderProfile();

            // Каждые 60 секунд — автообновление
            ordersSyncTimer = setInterval(syncOrdersAndRenderProfile, 60000);
        } else {
          renderSupportProfile();
        }
      }
        updateCartSumBadge();
    });
  });
}

function initCartSumBadgeClick() {
    const badge = document.getElementById('cartSumBadge');
    if (!badge) return;

    badge.addEventListener('click', () => {
        const cartBtn = document.querySelector('.nav-btn[data-tab="cart"]');
        if (cartBtn) {
            cartBtn.click();
        }
    });
}


function initProfileTabs() {
  const buttons = document.querySelectorAll('.profile-tab-btn');
  const content = document.getElementById('profileContent');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.dataset.profileTab) return;

      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.profileTab;
      if (tab === 'addresses') {
        renderAddressesProfile();
      } else if (tab === 'orders') {
        renderOrdersProfile();
      } else if (tab === 'support') {
        renderSupportProfile();
      }
    });
  });

  // По умолчанию — адреса
  content.innerHTML = '';
  renderAddressesProfile();
  ensureAdminEntryButton();
}

// function enableDragScroll(el) {
//     if (!el) return;
//
//     let isDown = false;
//     let startX = 0;
//     let scrollLeft = 0;
//
//     el.addEventListener('mousedown', (e) => {
//         isDown = true;
//         el.classList.add('dragging');
//         startX = e.pageX - el.offsetLeft;
//         scrollLeft = el.scrollLeft;
//     });
//
//     window.addEventListener('mouseup', () => {
//         isDown = false;
//         el.classList.remove('dragging');
//     });
//
//     el.addEventListener('mouseleave', () => {
//         isDown = false;
//         el.classList.remove('dragging');
//     });
//
//     el.addEventListener('mousemove', (e) => {
//         if (!isDown) return;
//         e.preventDefault();
//         const x = e.pageX - el.offsetLeft;
//         const walk = (x - startX);
//         el.scrollLeft = scrollLeft - walk;
//     });
// }



// === Инициализация событий ===

document.addEventListener('DOMContentLoaded', () => {
    console.log('[StorefrontClient] boot', { build: getF21StorefrontRuntimeBuild(), path: location.pathname });
    setupKeyboardHideFixedBars();
    //setupInputFocusScrollFix();
    initCartNoteModal();
    loadCartNotesFromStorage();

    const restored = loadCartState();
    if (restored) {
        if (Array.isArray(restored.cart)) cart = restored.cart;
        if (restored.selectedDeliveryOption) selectedDeliveryOption = restored.selectedDeliveryOption;
        if (typeof restored.useBonusesSelected === 'boolean') useBonusesSelected = restored.useBonusesSelected;
        if (typeof restored.floristComment === 'string') floristComment = restored.floristComment; // у вас есть, но не используется — оставляем
        if (typeof restored.cardText === 'string') cardText = restored.cardText;
    }

    initTelegram().catch((e) => {
        console.error('initTelegram error', e);
    });
    setupKeyboardOverlayFix();
    initNav();
    updateCartSumBadge();
    initCartSumBadgeClick();
    initProfileTabs();
    applyInitialRouteFromUrl();
    startProductsAutoRefresh();
    //enableDragScroll(document.getElementById('categoriesRow'));


    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', renderProducts);
    }

    const checkoutBtn = document.getElementById('checkoutBtn');
    if (checkoutBtn) {
        checkoutBtn.addEventListener('click', openCheckoutModal);
    }

    const checkoutCancel = document.getElementById('checkoutCancel');
    if (checkoutCancel) {
        checkoutCancel.addEventListener('click', closeCheckoutModal);
    }

    const checkoutCloseIcon = document.getElementById('checkoutCloseIcon');
    if (checkoutCloseIcon) {
        checkoutCloseIcon.addEventListener('click', closeCheckoutModal);
    }

    // ВАЖНО: кнопка "Перейти к оплате" всегда активна, валидация на клик
    const checkoutConfirmBtn = document.getElementById('checkoutConfirm');
    if (checkoutConfirmBtn) {
        checkoutConfirmBtn.disabled = false;
        checkoutConfirmBtn.addEventListener('click', onCheckoutConfirmClick);
    }

    const fieldsToWatch = [
        'checkoutFirstName',
        'checkoutLastName',
        'checkoutPhone',
        'newAddressInput',
        'deliveryDate',
        'deliveryTime'
    ];

    fieldsToWatch.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => validateCheckoutForm({ showErrors: false }));
        el.addEventListener('change', () => validateCheckoutForm({ showErrors: false }));
    });



    document.addEventListener('change', e => {
        if (e.target.name === 'checkoutAddress') {
            validateCheckoutForm();
        }
    });

    // document.addEventListener('change', async (e) => {
    //     if (e.target && e.target.id === 'useBonusesToggle') {
    //         useBonusesSelected = e.target.checked;
    //         await refreshAfterAnyAction({ rerenderProducts: false });
    //     }
    // });

    // Disable pinch-zoom (iOS Safari/WebView)
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
});
