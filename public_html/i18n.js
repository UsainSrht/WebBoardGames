/**
 * Translations (English and Turkish).
 *
 * Dictionaries are plain JSON files, one per namespace: /i18n/<ns>.json = { "en": { "key": "text" }, "tr": { ... } }
 * with fully qualified keys ("chess.status.yourMove"). `core` (site, lobby, rooms, game catalogue) is loaded at startup;
 * a game loads its own namespace with `await WBG.i18n.load('chess')` before it renders.
 *
 *   WBG.t('key', { name })                    "Hello {name}"
 *   WBG.t('key', { n: 3 })                    plural: looks for key_one / key_other (Intl.PluralRules), then key
 *   WBG.tr(x)                                 renders a string, or a server message object { k, p } (params may nest)
 *   <span data-i18n="key"></span>             static markup, filled in on load (keep English inside as the fallback)
 *   <input data-i18n-attr="placeholder:key;aria-label:key2">
 *
 * Servers never send English sentences for the UI: they send { k: 'ns.key', p: { ... } } objects and the client renders
 * them in the viewer's own language. A missing key falls back to English, then to the key itself.
 */
(() => {
  const WBG = (window.WBG = window.WBG || {});
  const LANGS = [
    { code: 'en', name: 'English' },
    { code: 'tr', name: 'Türkçe' }
  ];
  const CODES = LANGS.map((l) => l.code);

  function detect() {
    const onTr = /^\/tr(\/|$)/.test(location.pathname);
    try {
      const q = new URLSearchParams(location.search).get('lang');
      if (q && CODES.includes(q)) { localStorage.setItem('wbg.lang', q); return q; }
      const saved = onTr ? null : localStorage.getItem('wbg.lang');
      if (saved && CODES.includes(saved)) return saved;
    } catch { /* storage blocked */ }
    if (/^\/tr(\/|$)/.test(location.pathname)) return 'tr';
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const short = String(l).toLowerCase().slice(0, 2);
      if (CODES.includes(short)) return short;
    }
    return 'en';
  }

  const lang = detect();
  document.documentElement.lang = lang;

  const dict = { en: {}, tr: {} };
  const loaded = new Map();
  const missing = new Set();
  const plural = new Intl.PluralRules(lang);

  function add(data) {
    for (const code of CODES) Object.assign(dict[code], data[code] || {});
  }

  function load(ns) {
    if (!loaded.has(ns)) {
      loaded.set(ns, fetch(`/i18n/${ns}.json`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`i18n ${ns}: HTTP ${r.status}`))))
        .then((data) => { add(data); return ns; })
        .catch((err) => { console.warn(err.message); loaded.delete(ns); return ns; }));
    }
    return loaded.get(ns);
  }

  const lookup = (key) => dict[lang][key] ?? dict.en[key];

  function t(key, params) {
    let s;
    if (params && typeof params.n === 'number') {
      s = lookup(`${key}_${plural.select(params.n)}`) ?? lookup(`${key}_other`) ?? lookup(key);
    } else {
      s = lookup(key);
    }
    if (s === undefined) {
      if (params && params.fallback !== undefined) s = String(params.fallback);
      else { missing.add(key); s = key; }
    }
    return s.replace(/\{(\w+)\}/g, (m, name) => {
      if (!params || !(name in params)) return m;
      const v = params[name];
      return v !== null && typeof v === 'object' ? tr(v) : String(v);
    });
  }

  /** Render a string or a server message object { k, p }. */
  function tr(x) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.map(tr).join(' ');
    if (typeof x === 'object' && x.k) return t(x.k, x.p);
    return String(x);
  }

  function apply(root = document) {
    const nodes = [];
    if (root.nodeType === 1 && root.matches('[data-i18n],[data-i18n-attr]')) nodes.push(root);
    if (root.querySelectorAll) nodes.push(...root.querySelectorAll('[data-i18n],[data-i18n-attr]'));
    for (const el of nodes) {
      if (el.dataset.i18n) el.textContent = t(el.dataset.i18n);
      if (el.dataset.i18nAttr) {
        for (const pair of el.dataset.i18nAttr.split(';')) {
          const [attr, key] = pair.split(':').map((s) => s.trim());
          if (attr && key) el.setAttribute(attr, t(key));
        }
      }
    }
  }

  function setLang(code) {
    if (!CODES.includes(code) || code === lang) return;
    try { localStorage.setItem('wbg.lang', code); } catch { /* ignore */ }
    // The page (and a running game) reloads in the new language; rooms resume seamlessly.
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    location.href = url.toString();
  }

  const ready = load('core').then(() => {
    apply(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) apply(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  });

  WBG.i18n = { lang, langs: LANGS, ready, load, add, t, tr, apply, setLang, missing };
  WBG.t = t;
  WBG.tr = tr;
  WBG.lang = lang;
  WBG.locale = lang === 'tr' ? 'tr-TR' : 'en-US';
})();
