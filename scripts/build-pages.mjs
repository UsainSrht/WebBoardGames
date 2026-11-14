// Generates the localized home pages from public_html/i18n/core.json and the game catalogue:
//   public_html/index.html     (English, served at /)
//   public_html/tr/index.html  (Turkish, served at /tr/)
// Every text node carries data-i18n so the client can also switch language without a reload of the markup.
// Run with `npm run build:pages` (part of `npm run build`).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { GAME_CONFIGS } from '../src/games/config.js';

const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/core.json', import.meta.url), 'utf8'));
const LANGS = [
  { code: 'en', path: '/', file: 'public_html/index.html', locale: 'en_US', name: 'English' },
  { code: 'tr', path: '/tr/', file: 'public_html/tr/index.html', locale: 'tr_TR', name: 'T\u00fcrk\u00e7e' }
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(lang) {
  const plural = new Intl.PluralRules(lang.code);
  const raw = (k) => dict[lang.code][k] ?? dict.en[k];
  const T = (key, params) => {
    let s;
    if (params && typeof params.n === 'number') s = raw(`${key}_${plural.select(params.n)}`) ?? raw(`${key}_other`) ?? raw(key);
    else s = raw(key);
    if (s === undefined) throw new Error(`missing key ${key}`);
    return s.replace(/\{(\w+)\}/g, (m, n) => (params && n in params ? params[n] : m));
  };
  // a translated element: text content in the page language + the key for client side switching
  const I = (key) => `data-i18n="${key}"`;
  const tx = (key, params) => esc(T(key, params));

  const games = Object.entries(GAME_CONFIGS).sort((a, b) => Number(b[1].featured) - Number(a[1].featured) || a[1].added - b[1].added);
  const playersText = (g) => (g.min === g.max ? T('catalog.playersExact', { n: g.min }) : T('catalog.playersRange', { min: g.min, max: g.max }));

  const faqKeys = Array.from({ length: 10 }, (_, i) => i + 1);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Web Board Games', description: T('home.description'), inLanguage: lang.code },
      { '@type': 'WebApplication', name: 'Web Board Games', applicationCategory: 'GameApplication', operatingSystem: 'Any (web browser)', inLanguage: lang.code, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, browserRequirements: 'Requires JavaScript and WebSocket support' },
      {
        '@type': 'ItemList', name: T('home.games.title'),
        itemListElement: games.map(([id, g], i) => ({
          '@type': 'ListItem', position: i + 1,
          item: { '@type': 'VideoGame', name: T(`games.${id}.name`), description: T(`games.${id}.long`), numberOfPlayers: playersText(g), playMode: 'MultiPlayer', gamePlatform: 'Web browser', inLanguage: lang.code }
        }))
      },
      { '@type': 'FAQPage', inLanguage: lang.code, mainEntity: faqKeys.map((n) => ({ '@type': 'Question', name: T(`home.faq.q${n}`), acceptedAnswer: { '@type': 'Answer', text: T(`home.faq.a${n}`) } })) }
    ]
  };

  const strip = games.filter(([, g]) => g.featured).concat(games.filter(([, g]) => !g.featured)).slice(0, 8).map(([id, g], i) => `
            <div class="grid size-14 place-items-center rounded-2xl border border-white/8 bg-white/5 text-brand-300 animate-float" style="animation-delay:${(i * 0.3).toFixed(1)}s" title="${esc(T(`games.${id}.name`))}"><i data-icon="${g.icon}" class="size-6"></i></div>`).join('');

  const cards = games.map(([id, g], i) => `
          <article class="card group p-6 transition duration-200 hover:-translate-y-1 hover:border-white/15 reveal-${(i % 3) + 1}">
            <div class="mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/30 to-violet-500/25 text-brand-300 ring-1 ring-white/10 transition group-hover:scale-105">
              <i data-icon="${g.icon}" class="size-6"></i>
            </div>
            <div class="mb-1 flex items-center justify-between gap-3">
              <h3 class="text-lg font-semibold text-white" ${I(`games.${id}.name`)}>${tx(`games.${id}.name`)}</h3>
              <span class="chip shrink-0">${esc(playersText(g))}</span>
            </div>
            <p class="text-sm leading-relaxed text-slate-400" ${I(`games.${id}.long`)}>${tx(`games.${id}.long`)}</p>
          </article>`).join('');

  const faq = faqKeys.map((n) => `
          <details class="card-flat group p-5 open:bg-white/6">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-white">
              <span ${I(`home.faq.q${n}`)}>${tx(`home.faq.q${n}`)}</span>
              <i data-icon="chevron-down" class="size-5 shrink-0 text-slate-400 transition group-open:rotate-180"></i>
            </summary>
            <p class="mt-3 leading-relaxed text-slate-400" ${I(`home.faq.a${n}`)}>${tx(`home.faq.a${n}`)}</p>
          </details>`).join('');

  const other = LANGS.find((l) => l.code !== lang.code);
  const prefix = lang.code === 'en' ? '' : '/tr';
  const alternates = LANGS.map((l) => `  <link rel="alternate" hreflang="${l.code}" href="${l.path}" data-abs>`).join('\n') + '\n  <link rel="alternate" hreflang="x-default" href="/" data-abs>';

  return `<!DOCTYPE html>
<html lang="${lang.code}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${tx('home.title')}</title>
  <meta name="description" content="${tx('home.description')}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#07090f">
  <link rel="canonical" href="${lang.path}" data-abs>
${alternates}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Web Board Games">
  <meta property="og:locale" content="${lang.locale}">
  <meta property="og:locale:alternate" content="${other.locale}">
  <meta property="og:title" content="${tx('home.title')}">
  <meta property="og:description" content="${tx('home.description')}">
  <meta property="og:url" content="${lang.path}" data-abs>
  <meta property="og:image" content="/og-image.png" data-abs>
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${tx('home.ogAlt')}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${tx('home.title')}">
  <meta name="twitter:description" content="${tx('home.description')}">
  <meta name="twitter:image" content="/og-image.png" data-abs>
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <link rel="preload" href="/i18n/core.json" as="fetch" crossorigin>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/tailwind.css">
  <!-- Warm the cache for the room page so entering a room feels instant -->
  <link rel="prefetch" href="/game" as="document">
  <link rel="prefetch" href="/game.js" as="script">
  <link rel="prefetch" href="/socket-client.js" as="script">
</head>
<body>
  <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-ink-900" ${I('home.skip')}>${tx('home.skip')}</a>

  <header class="sticky top-0 z-30 border-b border-white/6 bg-ink-950/70 backdrop-blur-xl safe-t">
    <nav class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6" aria-label="${tx('home.mainNav')}" data-i18n-attr="aria-label:home.mainNav">
      <a href="${lang.path}" class="flex items-center gap-3" aria-label="${tx('home.homeAria')}" data-i18n-attr="aria-label:home.homeAria">
        <span class="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-lg shadow-brand-500/30"><i data-icon="logo" class="size-5"></i></span>
        <span class="text-base font-bold tracking-tight text-white">Web Board Games</span>
      </a>
      <div class="flex items-center gap-1 text-sm font-medium text-slate-300">
        <a class="btn btn-ghost btn-sm hidden sm:inline-flex" href="#games" ${I('home.nav.games')}>${tx('home.nav.games')}</a>
        <a class="btn btn-ghost btn-sm hidden md:inline-flex" href="#how-it-works" ${I('home.nav.how')}>${tx('home.nav.how')}</a>
        <a class="btn btn-ghost btn-sm hidden sm:inline-flex" href="#faq" ${I('home.nav.faq')}>${tx('home.nav.faq')}</a>
        <a class="btn btn-secondary btn-sm" href="${other.path}" hreflang="${other.code}" lang="${other.code}" data-lang="${other.code}" aria-label="${esc(T('home.language'))}: ${other.name}"><i data-icon="globe" class="size-4"></i><span>${other.name}</span></a>
      </div>
    </nav>
  </header>

  <main id="main">
    <!-- Hero -->
    <section class="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 pb-16 sm:px-6 sm:pt-16 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pt-24">
      <div class="text-center lg:text-left">
        <p class="eyebrow reveal" ${I('home.eyebrow')}>${tx('home.eyebrow')}</p>
        <h1 class="reveal-2 mt-3 text-4xl leading-[1.05] font-extrabold tracking-tight text-white sm:text-5xl lg:text-6xl">
          <span ${I('home.h1a')}>${tx('home.h1a')}</span>
          <span class="bg-gradient-to-r from-brand-300 via-violet-400 to-pink-400 bg-clip-text text-transparent" ${I('home.h1b')}>${tx('home.h1b')}</span>
        </h1>
        <p class="reveal-3 mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-400 lg:mx-0" ${I('home.lead')}>${tx('home.lead')}</p>
        <ul class="reveal-4 mt-6 flex flex-wrap justify-center gap-2 lg:justify-start">
          <li class="chip"><i data-icon="check" class="size-3.5 text-emerald-300"></i><span ${I('home.chip.nosignup')}>${tx('home.chip.nosignup')}</span></li>
          <li class="chip"><i data-icon="users" class="size-3.5 text-brand-300"></i><span ${I('home.chip.players')}>${tx('home.chip.players')}</span></li>
          <li class="chip"><i data-icon="qr" class="size-3.5 text-brand-300"></i><span ${I('home.chip.qr')}>${tx('home.chip.qr')}</span></li>
          <li class="chip"><i data-icon="mobile" class="size-3.5 text-brand-300"></i><span ${I('home.chip.phone')}>${tx('home.chip.phone')}</span></li>
        </ul>
        <div class="mt-10 hidden flex-wrap gap-3 lg:flex" aria-hidden="true">${strip}
        </div>
      </div>

      <!-- Entry card -->
      <div class="reveal-3 mx-auto w-full max-w-md" id="entry">
        <div class="card p-6 sm:p-8">
          <!-- Step 1: nickname -->
          <form id="name-form" class="space-y-5" novalidate hidden>
            <div>
              <h2 class="text-2xl font-bold tracking-tight text-white" ${I('home.name.title')}>${tx('home.name.title')}</h2>
              <p class="mt-1 text-sm text-slate-400" ${I('home.name.desc')}>${tx('home.name.desc')}</p>
            </div>
            <div>
              <label class="field-label" for="nickname" ${I('home.name.label')}>${tx('home.name.label')}</label>
              <div class="relative">
                <input id="nickname" class="input pr-16" type="text" maxlength="16" autocomplete="nickname" autocapitalize="words" spellcheck="false" placeholder="${tx('home.name.placeholder')}" data-i18n-attr="placeholder:home.name.placeholder" aria-describedby="name-error">
                <span id="char-count" class="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-xs text-slate-500">0/16</span>
              </div>
              <p id="name-error" class="field-error" role="alert" hidden></p>
            </div>
            <button class="btn btn-primary btn-lg w-full" type="submit"><span ${I('home.name.continue')}>${tx('home.name.continue')}</span> <i data-icon="arrow-right" class="size-5"></i></button>
          </form>

          <!-- Step 2: room -->
          <div id="room-panel" class="space-y-6" hidden>
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-3">
                <span id="hello-avatar"></span>
                <div class="min-w-0">
                  <p class="text-xs text-slate-400" ${I('home.playingAs')}>${tx('home.playingAs')}</p>
                  <p id="hello-name" class="truncate font-semibold text-white"></p>
                </div>
              </div>
              <button id="change-name" class="btn btn-ghost btn-sm" type="button" ${I('home.change')}>${tx('home.change')}</button>
            </div>

            <button id="rejoin" class="btn btn-secondary w-full justify-between" type="button" hidden>
              <span class="flex items-center gap-2"><i data-icon="refresh" class="size-4 text-brand-300"></i><span ${I('home.rejoin')}>${tx('home.rejoin')}</span> <strong id="rejoin-code" class="font-mono tracking-widest"></strong></span>
              <i data-icon="arrow-right" class="size-4"></i>
            </button>

            <div class="space-y-3">
              <button id="create-room" class="btn btn-primary btn-lg w-full" type="button"><i data-icon="plus" class="size-5"></i><span ${I('home.create')}>${tx('home.create')}</span></button>
              <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-white/8 bg-white/4 p-3.5">
                <input id="host-only" type="checkbox" class="switch mt-0.5">
                <span>
                  <span class="flex items-center gap-1.5 text-sm font-semibold text-white"><i data-icon="eye" class="size-4 text-brand-300"></i><span ${I('home.hostOnly')}>${tx('home.hostOnly')}</span></span>
                  <span class="mt-0.5 block text-xs leading-relaxed text-slate-400" ${I('home.hostOnlyDesc')}>${tx('home.hostOnlyDesc')}</span>
                </span>
              </label>
            </div>

            <div class="flex items-center gap-3 text-xs font-semibold tracking-wider text-slate-500 uppercase"><span class="divider flex-1"></span><span class="shrink-0" ${I('home.orJoin')}>${tx('home.orJoin')}</span><span class="divider flex-1"></span></div>

            <form id="join-form" class="space-y-2" novalidate>
              <label class="field-label" for="room-code" ${I('home.codeLabel')}>${tx('home.codeLabel')}</label>
              <div class="flex gap-2">
                <input id="room-code" class="input flex-1 text-center font-mono text-xl font-bold tracking-[0.35em] uppercase" type="text" maxlength="64" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${tx('home.codePlaceholder')}" aria-describedby="join-error">
                <button id="scan-btn" class="btn btn-secondary btn-icon size-12" type="button" aria-label="${tx('home.scan')}" data-i18n-attr="aria-label:home.scan" hidden><i data-icon="qr" class="size-5"></i></button>
              </div>
              <button id="join-btn" class="btn btn-secondary w-full" type="submit" ${I('home.join')}>${tx('home.join')}</button>
              <p id="join-error" class="field-error" role="alert" hidden></p>
            </form>
          </div>

          <!-- skeleton while we read saved state -->
          <div id="entry-skeleton" class="space-y-4" aria-hidden="true">
            <div class="skeleton h-8 w-2/3"></div><div class="skeleton h-12"></div><div class="skeleton h-14"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Games -->
    <section id="games" class="mx-auto max-w-6xl px-4 py-14 sm:px-6" aria-labelledby="games-heading">
      <div class="mx-auto mb-10 max-w-2xl text-center">
        <p class="eyebrow" ${I('home.games.eyebrow')}>${tx('home.games.eyebrow')}</p>
        <h2 id="games-heading" class="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl" ${I('home.games.title')}>${tx('home.games.title')}</h2>
        <p class="mt-3 text-slate-400" ${I('home.games.lead')}>${tx('home.games.lead')}</p>
      </div>
      <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">${cards}
      </div>
    </section>

    <!-- How it works -->
    <section id="how-it-works" class="mx-auto max-w-5xl px-4 py-14 sm:px-6" aria-labelledby="how-heading">
      <h2 id="how-heading" class="mb-10 text-center text-3xl font-bold tracking-tight text-white sm:text-4xl" ${I('home.how.title')}>${tx('home.how.title')}</h2>
      <ol class="grid gap-5 md:grid-cols-3">
        ${[1, 2, 3].map((n) => `<li class="card-flat p-6"><span class="mb-4 grid size-10 place-items-center rounded-full bg-brand-500/20 font-bold text-brand-300">${n}</span><h3 class="mb-1 font-semibold text-white" ${I(`home.how.${n}.title`)}>${tx(`home.how.${n}.title`)}</h3><p class="text-sm text-slate-400" ${I(`home.how.${n}.desc`)}>${tx(`home.how.${n}.desc`)}</p></li>`).join('\n        ')}
      </ol>
    </section>

    <!-- FAQ -->
    <section id="faq" class="mx-auto max-w-3xl px-4 py-14 sm:px-6" aria-labelledby="faq-heading">
      <h2 id="faq-heading" class="mb-8 text-center text-3xl font-bold tracking-tight text-white sm:text-4xl" ${I('home.faq.title')}>${tx('home.faq.title')}</h2>
      <div class="space-y-3">${faq}
      </div>
    </section>
  </main>

  <footer class="border-t border-white/6 py-10 text-center text-sm text-slate-500 safe-b">
    <nav aria-label="${tx('home.footerNav')}" data-i18n-attr="aria-label:home.footerNav" class="mb-3 flex justify-center gap-5">
      <a class="hover:text-slate-300" href="#games" ${I('home.nav.games')}>${tx('home.nav.games')}</a>
      <a class="hover:text-slate-300" href="#how-it-works" ${I('home.nav.how')}>${tx('home.nav.how')}</a>
      <a class="hover:text-slate-300" href="#faq" ${I('home.nav.faq')}>${tx('home.nav.faq')}</a>
    </nav>
    <p ${I('home.footer.made')}>${tx('home.footer.made')}</p>
  </footer>

  <!-- QR scanner -->
  <div id="scan-modal" class="modal-backdrop" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
      <div class="mb-4 flex items-center justify-between">
        <h2 id="scan-title" class="modal-title" ${I('home.scanTitle')}>${tx('home.scanTitle')}</h2>
        <button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="${tx('common.close')}" data-i18n-attr="aria-label:common.close"><i data-icon="x" class="size-5"></i></button>
      </div>
      <div class="relative aspect-square overflow-hidden rounded-2xl bg-black">
        <video id="scan-video" class="size-full object-cover" playsinline muted></video>
        <div class="pointer-events-none absolute inset-8 rounded-2xl border-2 border-white/70"></div>
      </div>
      <p id="scan-status" class="mt-3 text-center text-sm text-slate-400" ${I('home.scanStatus')}>${tx('home.scanStatus')}</p>
    </div>
  </div>

  <script src="/i18n.js"></script>
  <script src="/core.js"></script>
  <script src="/index.js"></script>
</body>
</html>
`;
}

for (const lang of LANGS) {
  const out = new URL(`../${lang.file}`, import.meta.url);
  mkdirSync(new URL('./', out), { recursive: true });
  writeFileSync(out, page(lang));
  console.log(`pages: ${lang.file}`);
}
