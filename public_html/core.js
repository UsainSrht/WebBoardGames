/**
 * Shared client core: SVG icons (no emojis anywhere in this project), toasts, modals,
 * clipboard/share helpers, QR codes and user preferences.
 *
 * Add new icons to ICONS below and use them with <i data-icon="name" class="size-5"></i>
 * or WBG.icon('name', 'size-5').
 */
(() => {
  const WBG = (window.WBG = window.WBG || {});

  /* ------------------------------------------------------------------ icons */
  // 24x24 grid, stroke icons drawn with currentColor. Add a "fill" class to fill them.
  const ICONS = {
    // interface
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>',
    'x-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V7a3 3 0 0 1 3-3h8"/>',
    share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    qr: '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h2.5v2.5M20.5 14.5v.01M14.5 20.5v.01M17.5 20.5h3v-3"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="M17.5 13.6c2.4.3 4 2 4 4.4"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5"/>',
    'user-x': '<circle cx="10" cy="8" r="3.4"/><path d="M3.5 19.5c0-3.6 2.9-6 6.5-6 1.3 0 2.5.3 3.5.9"/><path d="M16.5 14.5l5 5M21.5 14.5l-5 5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    'eye-off': '<path d="M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.2 7.5A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9.5 9.5 0 0 0 4-.9"/><path d="M10 10a2.8 2.8 0 0 0 4 4M3 3l18 18"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    logout: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>',
    chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h-.5A2.5 2.5 0 0 1 4 13.5z"/>',
    send: '<path d="M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>',
    wifi: '<path d="M3 9.5a14 14 0 0 1 18 0M6 13a9.5 9.5 0 0 1 12 0M9 16.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19.6" r=".7" fill="currentColor"/>',
    'wifi-off': '<path d="M3 9.5a14 14 0 0 1 4-2.7M21 9.5a14 14 0 0 0-6-3.2M6 13a9.5 9.5 0 0 1 3-2M18 13a9.5 9.5 0 0 0-2-1.6M9 16.5a5 5 0 0 1 6 0"/><circle cx="12" cy="19.6" r=".7" fill="currentColor"/><path d="M3 3l18 18"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 9M4 5v4h4M4 13a8 8 0 0 0 14 4.5L20 15M20 19v-4h-4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5v1.5A3 3 0 0 0 8 10.5M16 6h3.5v1.5A3 3 0 0 1 16 10.5M12 13v4M8.5 20h7M10 17h4"/>',
    crown: '<path d="M4 18.5h16M4.5 17L3 7.5l5 4 4-6.5 4 6.5 5-4L19.5 17z"/>',
    shield: '<path d="M12 3.5l7 2.8v5.4c0 4.3-2.9 7.6-7 8.8-4.1-1.2-7-4.5-7-8.8V6.3z"/><path d="M9 12l2.2 2.2L15.2 10"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
    camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
    alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.2v.01"/>',
    bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
    keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.5v.01M10.5 10.5v.01M14 10.5v.01M17 10.5v.01M7.5 14h9"/>',
    mobile: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20z"/>',
    home: '<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    lightbulb: '<path d="M9.5 18h5M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.1 2V16h5v-.2c0-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/>',
    swap: '<path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/>',
    skip: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>',
    undo: '<path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6"/>',
    // games
    chess: '<circle cx="12" cy="6.6" r="2.9"/><path d="M9.2 9.9h5.6M10 10.2c-.9 1.3-2 3.6-2.3 8.3h8.6c-.3-4.7-1.4-7-2.3-8.3M6.5 20.5h11"/>',
    cards: '<rect x="3.5" y="6.5" width="11" height="14" rx="2" transform="rotate(-9 9 13.5)"/><rect x="9.5" y="3.5" width="11" height="14" rx="2" transform="rotate(8 15 10.5)"/>',
    castle: '<path d="M4 20.5V7.5h3v2.2h2.3V7.5h1.4M20 20.5V7.5h-3v2.2h-2.3V7.5h-1.4M4 20.5h16M4 11.5h16M10 20.5v-4.2a2 2 0 0 1 4 0v4.2"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/>',
    scissors: '<circle cx="6.5" cy="6.5" r="2.7"/><circle cx="6.5" cy="17.5" r="2.7"/><path d="M8.7 8L20 17.5M8.7 16L20 6.5"/>',
    ball: '<circle cx="12" cy="13.2" r="7.6"/><circle cx="8.2" cy="6.6" r="2"/><circle cx="15.8" cy="6.6" r="2"/><circle cx="9.8" cy="12.6" r=".9" fill="currentColor"/><circle cx="14.2" cy="12.6" r=".9" fill="currentColor"/><path d="M10.5 15.7c.9.7 2.1.7 3 0"/>',
    fist: '<path d="M7 11V8a1.6 1.6 0 0 1 3.2 0v-.5a1.6 1.6 0 0 1 3.2 0V8a1.6 1.6 0 0 1 3.2 0v3.2a1.6 1.6 0 0 1 2 1.5V15a6 6 0 0 1-6 6h-1a5 5 0 0 1-5-5v-3a1.6 1.6 0 0 1 1.4-1.6"/>',
    paper: '<path d="M7 3.5h7.5L19 8v12.5H7z"/><path d="M14 3.5V8h5M10 12.5h6M10 16h6"/>',
    logo: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="8.8" cy="8.8" r="1.2" fill="currentColor"/><circle cx="15.2" cy="8.8" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="8.8" cy="15.2" r="1.2" fill="currentColor"/><circle cx="15.2" cy="15.2" r="1.2" fill="currentColor"/>'
  };

  const svgAttrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

  /** SVG markup for an icon (HTML string). */
  WBG.icon = (name, cls = 'size-5') => `<svg class="${cls}" ${svgAttrs}>${ICONS[name] || ''}</svg>`;
  WBG.hasIcon = (name) => name in ICONS;
  WBG.iconNames = () => Object.keys(ICONS);

  function hydrate(root) {
    const nodes = root.nodeType === 1 && root.matches('[data-icon]') ? [root] : [];
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[data-icon]'));
    for (const el of nodes) {
      const tpl = document.createElement('template');
      tpl.innerHTML = WBG.icon(el.dataset.icon, el.className || 'size-5');
      const svg = tpl.content.firstChild;
      for (const attr of ['id', 'title', 'aria-label', 'role', 'style']) {
        if (el.hasAttribute(attr)) svg.setAttribute(attr, el.getAttribute(attr));
      }
      if (el.getAttribute('aria-label')) svg.removeAttribute('aria-hidden');
      el.replaceWith(svg);
    }
  }
  WBG.hydrate = hydrate;

  /* ------------------------------------------------------ chess / dice art */
  const PIECE_PATHS = {
    p: '<circle cx="22.5" cy="12" r="5"/><path d="M17.5 24.5h10M17.5 25c0-2 1.6-3.6 5-3.6s5 1.6 5 3.6c2.2 2 4 6 4 12.5h-18c0-6.500 1.800-10.500 4-12.500z"/>',
    r: '<path d="M11 11h5v4h4v-4h5v4h4v-4h5v9H11z"/><path d="M14 20h17l1.500 14h-20z"/><path d="M10 34h25v5H10z"/>',
    n: '<path d="M13 38c0-9 .5-14.500 6-18-1.200-1.600-3-2-4.500-3.500L22 8c2.500 2.200 3.500 2.200 5.500 3 5 2.500 8 8 7.500 16-.2 4-.5 7-.5 11z"/><circle cx="25" cy="15" r="1.300" fill="currentColor" stroke="none"/><path d="M10 38.500h26"/>',
    b: '<circle cx="22.5" cy="6.500" r="2.200"/><path d="M22.500 9c4 3.500 7 8 7 12.500 0 2.500-1.500 4.300-3 5.500h-8c-1.500-1.200-3-3-3-5.500 0-4.500 3-9 7-12.500z"/><path d="M17 27h11l1.500 11h-14z"/><path d="M24 13.500l-3 6"/>',
    q: '<path d="M9 14l4.500 15 3-13 6 13 6-13 3 13L36 14l-2 18H11z"/><circle cx="9" cy="12.500" r="2"/><circle cx="15.500" cy="9.500" r="2"/><circle cx="22.500" cy="8.500" r="2"/><circle cx="29.500" cy="9.500" r="2"/><circle cx="36" cy="12.500" r="2"/><path d="M11 32h23l1.500 6.500h-26z"/>',
    k: '<path d="M22.500 5v9M18 9h9"/><path d="M22.500 14c-7 0-11.500 5-11.500 11.500 0 3 1 5.500 3 6.500h17c2-1 3-3.500 3-6.500C34 19 29.500 14 22.500 14z"/><path d="M11.500 32h22l1.500 6.500H10z"/>'
  };

  /** A chess piece as an inline SVG string. `char` is FEN style: uppercase = white. */
  WBG.chessPiece = (char, cls = 'size-full') => {
    const white = char === char.toUpperCase();
    const fill = white ? '#f4f1e8' : '#2a2d3a';
    const stroke = white ? '#161826' : '#0a0b12';
    return `<svg class="${cls}" viewBox="0 0 45 45" fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" style="color:${stroke}">${PIECE_PATHS[char.toLowerCase()]}</svg>`;
  };

  const PIPS = {
    1: [[12, 12]],
    2: [[8, 8], [16, 16]],
    3: [[8, 8], [12, 12], [16, 16]],
    4: [[8, 8], [16, 8], [8, 16], [16, 16]],
    5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]],
    6: [[8, 7.5], [16, 7.5], [8, 12], [16, 12], [8, 16.5], [16, 16.5]]
  };

  /** A die face (1-6) as an inline SVG string. */
  WBG.dieFace = (n, cls = 'size-16') => {
    const pips = (PIPS[n] || []).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="#1b1f3a"/>`).join('');
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#f7f7fb" stroke="#c7cbe6" stroke-width="1"/>${pips}</svg>`;
  };

  /* --------------------------------------------------------------- helpers */
  WBG.esc = (value) => String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  WBG.initials = (name) => (String(name || '?').trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();

  WBG.avatarColor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return `hsl(${h} 62% 46%)`;
  };

  /** Avatar element markup for a player name. */
  WBG.avatar = (name, cls = '') =>
    `<span class="avatar ${cls}" style="background:${WBG.avatarColor(name)}">${WBG.esc(WBG.initials(name))}</span>`;

  WBG.NAME_RE = /^[\p{L}\p{N} _.\-]{3,16}$/u;

  WBG.roomUrl = (code) => `${location.origin}/game?room=${encodeURIComponent(code)}`;

  WBG.haptic = (ms = 12) => {
    // Browsers block vibration until the user has interacted with the page.
    if (!navigator.userActivation?.hasBeenActive) return;
    try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
  };

  /** localStorage that never throws (private mode, blocked storage). */
  WBG.store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
  };

  WBG.prefs = {
    get notify() { return WBG.store.get('wbg.notify', '1') === '1'; },
    set notify(v) { WBG.store.set('wbg.notify', v ? '1' : '0'); },
    get reduceMotion() { return WBG.store.get('wbg.reduceMotion', '0') === '1'; },
    set reduceMotion(v) {
      WBG.store.set('wbg.reduceMotion', v ? '1' : '0');
      document.documentElement.classList.toggle('reduce-motion', v);
    }
  };
  document.documentElement.classList.toggle('reduce-motion', WBG.prefs.reduceMotion);

  /* ---------------------------------------------------------------- toasts */
  let toastBox = null;
  const recent = new Map();

  WBG.toast = (message, options = {}) => {
    const { type = 'info', icon, duration = 3600 } = options;
    const now = Date.now();
    if (recent.get(message) > now - 800) return;
    recent.set(message, now);

    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'toasts';
      toastBox.setAttribute('role', 'status');
      toastBox.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastBox);
    }
    while (toastBox.children.length >= 4) toastBox.firstChild.remove();

    const iconName = icon || (type === 'error' ? 'alert' : type === 'success' ? 'check-circle' : 'info');
    const color = type === 'error' ? 'text-rose-300' : type === 'success' ? 'text-emerald-300' : 'text-brand-300';
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="${color}">${WBG.icon(iconName, 'size-5')}</span><span></span>`;
    el.lastChild.textContent = message;
    toastBox.appendChild(el);

    const remove = () => {
      el.dataset.leaving = '';
      setTimeout(() => el.remove(), 260);
    };
    const timer = setTimeout(remove, duration);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  };

  /* ---------------------------------------------------------------- modals */
  const openStack = [];

  WBG.openModal = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    el.hidden = false;
    el._returnFocus = document.activeElement;
    requestAnimationFrame(() => {
      el.dataset.open = '';
      const focus = el.querySelector('[data-autofocus]') || el.querySelector('input, button, [href]');
      focus?.focus({ preventScroll: true });
    });
    if (!openStack.includes(el)) openStack.push(el);
    document.documentElement.style.overflow = 'hidden';
    el.dispatchEvent(new CustomEvent('modal-open'));
    return el;
  };

  WBG.closeModal = (id) => {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el || el.hidden) return;
    delete el.dataset.open;
    const i = openStack.indexOf(el);
    if (i >= 0) openStack.splice(i, 1);
    setTimeout(() => {
      if (!('open' in el.dataset)) el.hidden = true;
    }, 220);
    if (!openStack.length) document.documentElement.style.overflow = '';
    el._returnFocus?.focus?.({ preventScroll: true });
    el.dispatchEvent(new CustomEvent('modal-close'));
  };

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open-modal]');
    if (opener) { e.preventDefault(); WBG.openModal(opener.dataset.openModal); return; }
    const closer = e.target.closest('[data-close]');
    if (closer) { WBG.closeModal(closer.closest('.modal-backdrop, .drawer-backdrop')); return; }
    if ((e.target.classList?.contains('modal-backdrop') || e.target.classList?.contains('drawer-backdrop')) && !e.target.hasAttribute('data-static')) {
      WBG.closeModal(e.target);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openStack.length) {
      const top = openStack[openStack.length - 1];
      if (!top.hasAttribute('data-static')) WBG.closeModal(top);
    }
  });

  /* --------------------------------------------------- clipboard and share */
  WBG.copy = async (text, successMessage = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    WBG.toast(successMessage, { type: 'success', icon: 'check-circle' });
  };

  WBG.canShare = () => typeof navigator.share === 'function';

  WBG.share = async (data) => {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err?.name !== 'AbortError') WBG.copy(data.url, 'Link copied');
    }
  };

  /* --------------------------------------------------------------- QR codes */
  let qrLoader = null;
  const loadQr = () => qrLoader || (qrLoader = new Promise((resolve, reject) => {
    if (window.qrcode) return resolve();
    const s = document.createElement('script');
    s.src = '/vendor/qrcode.js';
    s.onload = () => resolve();
    s.onerror = () => { qrLoader = null; reject(new Error('QR library failed to load')); };
    document.head.appendChild(s);
  }));

  /** Crisp, scalable QR code as an SVG string (dark modules on a white card). */
  WBG.qrSvg = async (text, { quiet = 3, dark = '#0b0e1a', light = '#ffffff', cls = 'size-full' } = {}) => {
    await loadQr();
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) { c++; continue; }
        const start = c;
        while (c < n && qr.isDark(r, c)) c++;
        d += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
      }
    }
    const size = n + quiet * 2;
    return `<svg class="${cls}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  };

  /* ------------------------------------------------- game helpers (in-game) */
  WBG.isSpectator = false;
  WBG.role = 'player';

  /** Tell the server this game UI is loaded. Spectators get a state replay instead. */
  WBG.gameReady = (event) => {
    const socket = window.socket;
    if (!socket) return;
    socket.emit(WBG.isSpectator ? 'spectate-ready' : event);
  };

  /** Format seconds as m:ss. */
  WBG.clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  /* ------------------------------------------------------------- bootstrap */
  const start = () => {
    hydrate(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) hydrate(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
