await WBG.i18n.load('monopoly');
(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const t = (k, p) => WBG.t(k, p);
  const esc = WBG.esc;
  const reduced = () => WBG.prefs?.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = matchMedia('(min-width: 1024px)');

  let board = null;     // static board from the server
  let S = null;         // latest snapshot
  let prev = null;
  let dead = false;
  let zoom = Number(WBG.store.get('mp.zoom', '2')) || 2;
  let viewId = null;    // whose properties the side panel shows
  let tab = 'assets';
  let propOpen = null;
  let seen = null;      // { move, dice, card } sequence numbers already animated
  let deadlineAt = 0;   // local time the current countdown ends
  let lastTick = -1;
  let auctionKey = '';
  let tb = null;        // trade builder state
  let cardFor = 0;
  const shown = {};     // id -> position currently drawn (animated)
  const tokenEls = new Map();
  const timers = new Set();
  const cells = [];

  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const sleep = (ms) => new Promise((res) => later(res, reduced() ? Math.min(ms, 40) : ms));

  socket.off('monopoly-board');
  socket.off('monopoly-state');
  const onErr = () => WBG.sound.play('error');
  const ticker = setInterval(tick, 200);
  WBG.onTeardown(() => {
    dead = true;
    clearInterval(ticker);
    timers.forEach(clearTimeout);
    ro.disconnect();
    desktop.removeEventListener('change', layout);
    window.removeEventListener('resize', layout);
    socket.off('monopoly-board');
    socket.off('monopoly-state');
    socket.off('error', onErr);
  });

  /* ------------------------------------------------------------ icons + art */
  WBG.addIcons({
    'mp-x': '<path d="M6 6l12 12M18 6L6 18"/>',
    'mp-train': '<rect x="6" y="4" width="12" height="12" rx="3"/><path d="M6 11h12M9 20l2-4M15 20l-2-4"/><circle cx="9.500" cy="13.500" r=".6"/><circle cx="14.500" cy="13.500" r=".6"/>',
    'mp-drop': '<path d="M12 4c3 4 5 6.500 5 9.500a5 5 0 0 1-10 0C7 10.500 9 8 12 4z"/>',
    'mp-question': '<path d="M9 9a3 3 0 1 1 4.500 2.600c-1 .6-1.500 1.200-1.500 2.400M12 17.500v.5"/>',
    'mp-chest': '<path d="M4 10h16v9H4zM4 10a8 6 0 0 1 16 0M12 12.500v3"/>',
    'mp-jail': '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 5v14M12.500 5v14M16 5v14"/>',
    'mp-cuffs': '<circle cx="8" cy="14" r="3.500"/><circle cx="16" cy="14" r="3.500"/><path d="M10.500 11.500l3-4M13.500 11.500l-3-4"/>',
    'mp-check': '<path d="M5 12.500l4.500 4.500L19 7.500"/>'
  });

  const GLYPH = {
    rocket: '<path d="M12 5c2.200 2 3 4.500 2.600 8H9.400C9 9.500 9.800 7 12 5z"/><path d="M9.400 13l-2 2.200M14.600 13l2 2.200M12 15v3"/>',
    anchor: '<circle cx="12" cy="7" r="1.600"/><path d="M12 8.600V18M8.500 11.500h7M7 14.500c.4 2.200 2.600 3.500 5 3.500s4.600-1.300 5-3.500"/>',
    kite: '<path d="M12 5l4.500 5-4.500 6-4.500-6z"/><path d="M12 5v11M7.500 10h9M12 16c-1 1.500-2.500 1.500-3 3"/>',
    crown: '<path d="M6 16l-.5-7 3.500 3L12 7l3 5 3.500-3-.5 7z"/>',
    lantern: '<path d="M10 6h4M12 6v1.500M9 9.500c0-1.200 1.300-2 3-2s3 .8 3 2v5.500c0 1-1.300 1.800-3 1.800s-3-.8-3-1.800z"/><path d="M12 10.500v3"/>',
    compass: '<circle cx="12" cy="12" r="6"/><path d="M14.500 9.500l-1.500 3.500-3.500 1.500 1.500-3.500z"/>'
  };
  const tokenSvg = (token, color, cls = 'size-full') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="${color}" stroke="#fff" stroke-width="1.500"/><g fill="none" stroke="#fff" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${GLYPH[token] || ''}</g></svg>`;
  const houseSvg = '<svg class="mp-house" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5l4-3.500L9 5v4H1z" fill="#16a34a" stroke="#064e3b" stroke-width=".7"/></svg>';

  /* ---------------------------------------------------------------- helpers */
  const locale = () => WBG.locale || 'en-US';
  const money = (n) => t('monopoly.money', { n: Number(n).toLocaleString(locale()) });
  const spaceName = (i) => t(`monopoly.space.${i}`);
  function xp(p) {
    if (!p) return p;
    const o = {};
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('m_')) o[k] = money(v);
      else if (k.startsWith('s_')) o[k] = spaceName(v);
      else if (v && typeof v === 'object' && v.k) o[k] = { k: v.k, p: xp(v.p) };
      else o[k] = v;
    }
    return o;
  }
  const tx = (m) => (typeof m === 'string' ? m : WBG.t(m.k, xp(m.p)));
  const T = (k, p) => tx({ k, p });
  const player = (id) => S?.players.find((p) => p.id === id);
  const me = () => (spectator ? null : player(myId));
  const seatPlayer = (seat) => S?.players.find((p) => p.seat === seat);
  const ownerOf = (i) => (S && S.own[i] >= 0 ? seatPlayer(S.own[i]) : null);
  const groupName = (g) => t(`monopoly.group.${g}`);
  const sp = (i) => board.spaces[i];
  const isMyTurn = () => !!S && !spectator && S.turn === myId && !S.over && !me()?.bankrupt;
  const locked = () => fx.running;

  /* ------------------------------------------------------------- board build */
  const EDGE = (() => { const w = [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5]; let a = 0; return [0, ...w.map((x) => (a += x / 12))]; })();
  const rc = (i) => (i <= 10 ? [10, 10 - i] : i <= 20 ? [20 - i, 0] : i <= 30 ? [0, i - 20] : [i - 30, 10]);
  const center = (i) => { const [r, c] = rc(i); return [(EDGE[c] + EDGE[c + 1]) / 2, (EDGE[r] + EDGE[r + 1]) / 2]; };
  const sideOf = (i) => (i > 10 && i < 20 ? 'left' : i > 20 && i < 30 ? 'top' : i > 30 ? 'right' : 'bottom');

  const ICON_OF = { go: 'arrow-right', jail: 'mp-jail', parking: 'p', gotojail: 'mp-cuffs', station: 'mp-train', chance: 'mp-question', chest: 'mp-chest', tax: 'coin' };

  function buildBoard() {
    const el = $('mp-board');
    el.replaceChildren();
    cells.length = 0;
    el.insertAdjacentHTML('beforeend', '<div class="mp-center" id="mp-center"></div>');
    board.spaces.forEach((s) => {
      const [r, c] = rc(s.i);
      const d = document.createElement('div');
      const corner = [0, 10, 20, 30].includes(s.i);
      const side = sideOf(s.i);
      d.className = `mp-cell${corner ? ' corner' : ''}`;
      d.style.gridArea = `${r + 1} / ${c + 1}`;
      d.style.flexDirection = { bottom: 'column', top: 'column-reverse', left: 'row-reverse', right: 'row' }[side];
      if (corner) d.style.flexDirection = 'column';
      d.dataset.i = s.i;
      d.tabIndex = 0;
      d.setAttribute('role', 'gridcell');
      const vertical = side === 'left' || side === 'right';
      const bar = s.type === 'street'
        ? `<div class="bar" style="background:${board.groups[s.group].color};${vertical ? 'width:26%' : 'height:26%'}"></div>` : '';
      let icon = '';
      if (s.type === 'utility') icon = WBG.icon(s.i === 12 ? 'bolt' : 'mp-drop', 'size-[1.7em]');
      else if (ICON_OF[s.type]) icon = WBG.icon(ICON_OF[s.type], corner ? 'size-[2.6em]' : 'size-[1.9em]');
      const price = s.price ? money(s.price) : s.type === 'tax' ? money(s.tax) : '';
      d.innerHTML = `${bar}<div class="body"><span class="nm"></span>${icon ? `<span class="ic">${icon}</span>` : ''}<span class="pr">${esc(price)}</span></div><span class="own" hidden></span>`;
      d.addEventListener('click', () => openProp(s.i));
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProp(s.i); } });
      el.appendChild(d);
      cells[s.i] = d;
    });
    labelBoard();
  }

  function labelBoard() {
    board.spaces.forEach((s) => {
      const d = cells[s.i];
      d.querySelector('.nm').textContent = spaceName(s.i);
      d.setAttribute('aria-label', spaceName(s.i));
      const own = d.querySelector('.own');
      const side = sideOf(s.i);
      own.style.cssText = `${side === 'bottom' || side === 'right' ? 'left' : 'right'}:2px;${side === 'top' || side === 'left' ? 'bottom' : 'top'}:2px`;
    });
  }

  function renderBoard() {
    if (!board || !S) return;
    board.spaces.forEach((s) => {
      const d = cells[s.i];
      const o = ownerOf(s.i);
      const own = d.querySelector('.own');
      own.hidden = !o;
      if (o) { own.style.background = o.color; own.title = o.name; }
      d.classList.toggle('mort', !!S.ms[s.i]);
      if (s.type === 'street') {
        const bar = d.querySelector('.bar');
        const h = S.hs[s.i];
        bar.innerHTML = h === 5 ? '<span class="mp-hotel"></span>' : houseSvg.repeat(h);
      }
    });
    renderTokens();
  }

  function renderTokens() {
    const el = $('mp-board');
    const byCell = {};
    for (const p of S.players) {
      if (p.bankrupt) continue;
      (byCell[shown[p.id] ?? p.pos] ||= []).push(p);
    }
    const seen2 = new Set();
    for (const [pos, list] of Object.entries(byCell)) {
      const [cx, cy] = center(Number(pos));
      list.forEach((p, k) => {
        seen2.add(p.id);
        let tEl = tokenEls.get(p.id);
        if (!tEl) {
          tEl = document.createElement('div');
          tEl.className = 'mp-token';
          tEl.innerHTML = tokenSvg(p.token, p.color);
          el.appendChild(tEl);
          tokenEls.set(p.id, tEl);
        }
        const spread = list.length > 1 ? 0.016 : 0;
        const ang = (k / list.length) * Math.PI * 2 + 0.6;
        tEl.style.left = `${(cx + Math.cos(ang) * spread) * 100}%`;
        tEl.style.top = `${(cy + Math.sin(ang) * spread) * 100}%`;
        tEl.classList.toggle('turn', p.id === S.turn && !S.over);
        tEl.setAttribute('aria-label', p.name);
      });
    }
    for (const [id, tEl] of tokenEls) if (!seen2.has(id)) { tEl.remove(); tokenEls.delete(id); }
  }

  function layout() {
    const wrap = $('mp-wrap');
    if (!wrap) return;
    const b = $('mp-board');
    wrap.style.display = 'flex';
    b.style.margin = 'auto';
    b.style.flex = 'none';
    const w = wrap.clientWidth - 8;
    const h = wrap.clientHeight - 8;
    let size;
    if (desktop.matches) size = Math.max(320, Math.min(w, h));
    else size = Math.max(320, Math.round(w * zoom));
    b.style.width = `${size}px`;
    b.style.height = `${size}px`;
    $('mp-root').style.setProperty('--u', `${size / 100}px`);
  }
  const ro = new ResizeObserver(layout);
  ro.observe($('mp-wrap'));
  desktop.addEventListener('change', layout);
  window.addEventListener('resize', layout);

  function scrollToCell(i) {
    const wrap = $('mp-wrap');
    const b = $('mp-board');
    if (!wrap || desktop.matches || b.offsetWidth <= wrap.clientWidth + 2) return;
    const [cx, cy] = center(i);
    wrap.scrollTo({ left: b.offsetLeft + cx * b.offsetWidth - wrap.clientWidth / 2, top: b.offsetTop + cy * b.offsetHeight - wrap.clientHeight / 2, behavior: reduced() ? 'auto' : 'smooth' });
  }

  function setZoom(z) {
    zoom = Math.min(3, Math.max(1, z));
    WBG.store.set('mp.zoom', String(zoom));
    layout();
    const mine = me();
    if (mine) scrollToCell(shown[mine.id] ?? mine.pos);
  }
  $('mp-zin').addEventListener('click', () => setZoom(zoom + 0.4));
  $('mp-zout').addEventListener('click', () => setZoom(zoom - 0.4));

  /* ------------------------------------------------------------- fx queue */
  const fx = { q: [], running: false };
  function enqueue(fn) {
    fx.q.push(fn);
    if (!fx.running) runFx();
  }
  async function runFx() {
    fx.running = true;
    while (fx.q.length && !dead) {
      try { await fx.q.shift()(); } catch { /* keep going */ }
    }
    fx.running = false;
    if (!dead) { syncPos(); renderAll(); }
  }
  function syncPos() {
    for (const p of S?.players || []) shown[p.id] = p.pos;
  }

  async function animateDice(values) {
    const box = $('mp-dice');
    if (!box) return;
    WBG.sound.play('roll');
    WBG.haptic(15);
    const dice = box.querySelectorAll('.mp-die');
    dice.forEach((d) => d.classList.add('roll'));
    const end = performance.now() + (reduced() ? 80 : 650);
    while (performance.now() < end && !dead) {
      dice.forEach((d) => { d.innerHTML = WBG.dieFace(1 + Math.floor(Math.random() * 6), 'size-full'); });
      await sleep(80);
    }
    dice.forEach((d, i) => { d.classList.remove('roll'); d.innerHTML = WBG.dieFace(values[i], 'size-full'); });
    await sleep(120);
  }

  async function animateMove(m) {
    const from = m.from;
    shown[m.id] = from;
    if (m.mode === 'jump') {
      shown[m.id] = m.to;
      renderTokens();
      WBG.sound.play(m.jail ? 'fall' : 'land');
      scrollToCell(m.to);
      await sleep(500);
      return;
    }
    const dir = m.mode === 'back' ? -1 : 1;
    const steps = m.mode === 'back' ? (from - m.to + 40) % 40 : (m.to - from + 40) % 40;
    const gap = Math.min(150, 2600 / Math.max(1, steps));
    for (let k = 0; k < steps && !dead; k++) {
      shown[m.id] = (shown[m.id] + dir + 40) % 40;
      renderTokens();
      if (m.id === myId) scrollToCell(shown[m.id]);
      WBG.sound.play('move');
      await sleep(gap);
    }
    shown[m.id] = m.to;
    renderTokens();
    WBG.sound.play('land');
    await sleep(160);
  }

  async function showCard(c) {
    const ov = $('mp-ov-card');
    const by = player(c.by);
    const deckName = t(`monopoly.deck.${c.deck}`);
    ov.innerHTML = `<div class="card animate-pop w-full max-w-xs p-5 text-center" role="dialog" aria-label="${esc(deckName)}">
      <p class="eyebrow">${esc(deckName)}</p>
      <div class="mx-auto my-3 grid size-14 place-items-center rounded-2xl ${c.deck === 'chance' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'}">${WBG.icon(c.deck === 'chance' ? 'mp-question' : 'mp-chest', 'size-8')}</div>
      <p class="text-xs text-slate-400">${esc(by?.name || '')}</p>
      <p class="mt-1 text-lg font-semibold leading-snug text-white">${esc(T(`monopoly.card.${c.deck}.${c.n}`, c.p))}</p>
    </div>`;
    ov.hidden = false;
    WBG.sound.play('card');
    await new Promise((res) => {
      const done = () => { ov.hidden = true; ov.onclick = null; res(); };
      ov.onclick = done;
      later(done, reduced() ? 1200 : 2800);
    });
  }

  function floatMoney(id, delta) {
    if (reduced() || !delta) return;
    const chip = document.querySelector(`[data-pid="${id}"]`);
    if (!chip) return;
    const r = chip.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'mp-float';
    s.textContent = `${delta > 0 ? '+' : '-'}${money(Math.abs(delta))}`;
    s.style.color = delta > 0 ? '#34d399' : '#fb7185';
    s.style.left = `${r.left + r.width / 2 - 20}px`;
    s.style.top = `${r.bottom - 6}px`;
    document.body.appendChild(s);
    const a = s.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(34px)', opacity: 0 }], { duration: 1500, easing: 'ease-out' });
    a.onfinish = () => s.remove();
  }

  /* --------------------------------------------------------------- players */
  function renderPlayers() {
    $('mp-players').replaceChildren(...S.players.map((p) => {
      const li = document.createElement('li');
      li.dataset.pid = p.id;
      const turn = p.id === S.turn && !S.over && !p.bankrupt;
      li.className = `shrink-0 cursor-pointer rounded-xl border px-2 py-1 text-left transition ${turn ? 'border-emerald-400/70 bg-emerald-500/12' : 'border-white/8 bg-white/4'} ${p.bankrupt ? 'opacity-45' : ''} ${p.id === viewId ? 'ring-2 ring-brand-400' : ''}`;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      const flags = [];
      if (p.jail) flags.push(WBG.icon('mp-jail', 'size-3.5 text-amber-300'));
      if (p.cards) flags.push(`<span class="chip !px-1.5 !py-0">${WBG.icon('key', 'size-3')}${p.cards}</span>`);
      if (p.auto) flags.push(`<span class="chip chip-warn !px-1.5 !py-0">${esc(t('monopoly.ui.auto'))}</span>`);
      li.innerHTML = `<div class="flex items-center gap-1.5"><span class="size-6 shrink-0">${tokenSvg(p.token, p.color)}</span>
        <div class="min-w-0"><p class="max-w-24 truncate text-[13px] leading-4 font-semibold text-white ${p.bankrupt ? 'line-through' : ''}">${esc(p.name)}${p.id === myId ? ` <span class="font-normal text-slate-400">${esc(t('monopoly.ui.you'))}</span>` : ''}</p>
        <p class="flex items-center gap-1 text-xs leading-4 font-bold text-emerald-300 tabular-nums">${p.bankrupt ? esc(t('monopoly.ui.bankrupt')) : esc(money(p.cash))}${flags.join('')}</p></div></div>`;
      const pick = () => { viewId = p.id; tab = 'assets'; renderAll(); if (!desktop.matches) setSheet(true); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      return li;
    }));
  }

  /* ---------------------------------------------------------------- center */
  function renderCenter() {
    const c = $('mp-center');
    if (!c) return;
    if (!$('mp-dice')) {
      c.innerHTML = `<p class="font-black tracking-[0.18em] uppercase" style="font-size:calc(var(--u)*2.6);color:#a5b4fc">${esc(t('monopoly.ui.title'))}</p>
        <div id="mp-dice" class="flex gap-[calc(var(--u)*1.2)]" aria-live="polite"><span class="mp-die" style="width:calc(var(--u)*7);height:calc(var(--u)*7)"></span><span class="mp-die" style="width:calc(var(--u)*7);height:calc(var(--u)*7)"></span></div>
        <div id="mp-cinfo" class="space-y-[calc(var(--u)*0.6)] font-semibold text-slate-300" style="font-size:calc(var(--u)*1.7)"></div>`;
      const dice = c.querySelectorAll('.mp-die');
      dice.forEach((d, i) => { d.innerHTML = WBG.dieFace(S.dice[i] || 1, 'size-full'); });
    }
    const info = [];
    if (S.opts.freeParking === 'pot') info.push(`<p>${esc(t('monopoly.ui.pot', { amount: money(S.pot) }))}</p>`);
    info.push(`<p class="opacity-80">${esc(t('monopoly.ui.bank', { h: S.housesLeft, k: S.hotelsLeft }))}</p>`);
    if (S.endsIn !== null && !S.over) info.push(`<p id="mp-limit">${WBG.icon('hourglass', 'inline size-[1.1em]')} <span></span></p>`);
    $('mp-cinfo').innerHTML = info.join('');
    if (!fx.running) c.querySelectorAll('.mp-die').forEach((d, i) => { d.innerHTML = WBG.dieFace(S.dice[i] || 1, 'size-full'); });
  }

  /* ---------------------------------------------------------------- banner + actions */
  function banner() {
    if (S.over) return t('monopoly.ui.over');
    const cur = player(S.turn);
    const name = cur?.name || '';
    const my = isMyTurn();
    const idx = cur?.pos;
    switch (S.phase) {
      case 'roll':
        if (my) return cur.jail ? T('monopoly.ui.myJail') : S.rolled ? T('monopoly.ui.myRollAgain') : T('monopoly.ui.myRoll');
        return T('monopoly.ui.theirRoll', { name });
      case 'buy':
        return my ? T('monopoly.ui.myBuy', { s_i: idx, m_a: sp(idx).price }) : T('monopoly.ui.theirBuy', { name, s_i: idx });
      case 'debt': {
        const d = S.debt;
        if (my) return T('monopoly.ui.myDebt', { m_a: d.amount });
        return T('monopoly.ui.theirDebt', { name, m_a: d.amount });
      }
      case 'auction': return T('monopoly.ui.auctionFor', { s_i: S.auction?.idx ?? 0 });
      case 'end': return my ? T('monopoly.ui.myEnd') : T('monopoly.ui.theirEnd', { name });
      default: return '';
    }
  }

  const btn = (act, label, cls = 'btn-secondary', icon = '', attrs = '') =>
    `<button class="btn ${cls}" data-act="${act}" ${attrs}>${icon ? WBG.icon(icon, 'size-4') : ''}<span>${esc(label)}</span></button>`;

  function renderActions() {
    $('mp-banner').textContent = banner();
    const box = $('mp-actions');
    const m = me();
    const out = [];
    if (S.over || spectator || !m) {
      if (m?.bankrupt && !S.over) out.push(`<p class="text-sm text-slate-400">${esc(t('monopoly.ui.watching'))}</p>`);
      box.innerHTML = out.join('');
      return;
    }
    const lock = locked() ? 'disabled' : '';
    if (isMyTurn()) {
      switch (S.phase) {
        case 'roll':
          out.push(btn('roll', t('monopoly.ui.roll'), 'btn-primary btn-lg', 'dice', lock));
          if (m.jail) {
            out.push(btn('jailpay', t('monopoly.ui.payBail', { amount: money(board.consts.BAIL) }), 'btn-secondary', 'coin', m.cash < board.consts.BAIL || locked() ? 'disabled' : ''));
            if (m.cards) out.push(btn('jailcard', t('monopoly.ui.useCard'), 'btn-secondary', 'key', lock));
          }
          break;
        case 'buy': {
          const price = sp(m.pos).price;
          out.push(btn('buy', t('monopoly.ui.buy', { amount: money(price) }), 'btn-success', 'coin', m.cash < price || locked() ? 'disabled' : ''));
          out.push(btn('decline', S.opts.auction === 'on' ? t('monopoly.ui.auction') : t('monopoly.ui.pass'), 'btn-secondary', 'users', lock));
          break;
        }
        case 'debt': {
          const d = S.debt;
          out.push(btn('paydebt', t('monopoly.ui.pay', { amount: money(d.amount) }), 'btn-success', 'coin', m.cash < d.amount || locked() ? 'disabled' : ''));
          out.push(btn('assets', t('monopoly.ui.raise'), 'btn-secondary', 'house'));
          out.push(btn('resign', t('monopoly.ui.declareBankrupt'), 'btn-danger', 'flag'));
          if (m.cash < d.amount) out.push(`<p class="w-full text-xs text-slate-400">${esc(t('monopoly.ui.canRaise', { amount: money(Math.max(0, m.liquid - m.cash)), need: money(d.amount - m.cash) }))}</p>`);
          break;
        }
        case 'end':
          out.push(btn('end', t('monopoly.ui.endTurn'), 'btn-primary btn-lg', 'arrow-right', lock));
          break;
        default:
      }
    } else if (!m.bankrupt && !S.over) {
      out.push(`<p class="text-xs text-slate-400">${esc(t('monopoly.ui.waiting'))}</p>`);
    }
    if (m.bankrupt) out.push(`<p class="text-sm text-rose-300">${esc(t('monopoly.ui.youBankrupt'))}</p>`);
    box.innerHTML = out.join('');
  }

  $('mp-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    WBG.sound.play('click');
    const a = b.dataset.act;
    if (a === 'roll') socket.emit('monopoly-roll');
    else if (a === 'buy') socket.emit('monopoly-buy');
    else if (a === 'decline') socket.emit('monopoly-decline');
    else if (a === 'end') socket.emit('monopoly-end-turn');
    else if (a === 'paydebt') socket.emit('monopoly-pay-debt');
    else if (a === 'jailpay') socket.emit('monopoly-jail', { how: 'pay' });
    else if (a === 'jailcard') socket.emit('monopoly-jail', { how: 'card' });
    else if (a === 'assets') { viewId = myId; tab = 'assets'; renderAll(); setSheet(true); }
    else if (a === 'resign') askResign();
  });

  function confirmBox(text, okLabel, onOk, danger = true) {
    const ov = $('mp-ov-confirm');
    ov.innerHTML = `<div class="card animate-pop w-full max-w-xs p-5 text-center" role="alertdialog"><p class="text-base font-semibold text-white">${esc(text)}</p>
      <div class="mt-4 flex gap-2"><button class="btn btn-secondary flex-1" data-no>${esc(t('monopoly.ui.cancel'))}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'} flex-1" data-yes>${esc(okLabel)}</button></div></div>`;
    ov.hidden = false;
    ov.querySelector('[data-no]').onclick = () => { ov.hidden = true; };
    ov.querySelector('[data-yes]').onclick = () => { ov.hidden = true; onOk(); };
    ov.querySelector('[data-no]').focus();
  }
  const askResign = () => confirmBox(t('monopoly.ui.resignAsk'), t('monopoly.ui.resign'), () => socket.emit('monopoly-resign'));

  /* ---------------------------------------------------------------- side panels */
  function setSheet(open) {
    $('mp-root').classList.toggle('mp-sheet-open', open);
  }
  $('mp-sheet').addEventListener('click', () => { if (!viewId) viewId = myId || S?.turn; renderAll(); setSheet(true); });
  $('mp-sheet-close').addEventListener('click', () => setSheet(false));
  $('mp-tab-assets').addEventListener('click', () => { tab = 'assets'; renderPanels(); });
  $('mp-tab-log').addEventListener('click', () => { tab = 'log'; renderPanels(); });
  for (const id of ['mp-trade-open', 'mp-trade-open2']) $(id).addEventListener('click', () => openTradeBuilder());

  function propRow(i, mine, manage) {
    const s = sp(i);
    const color = s.group ? board.groups[s.group].color : s.type === 'station' ? '#94a3b8' : '#fbbf24';
    const h = S.hs[i];
    const mort = !!S.ms[i];
    const cell = (what, icon, label) => {
      const reason = manage?.[what];
      const dis = !mine || !manage || reason || locked();
      return `<button class="btn btn-secondary mp-mini ${dis ? 'mp-dis' : ''}" data-m="${what}" data-i="${i}" aria-label="${esc(label)}" ${reason ? `data-why="${esc(tx(reason))}" title="${esc(tx(reason))}"` : ''} aria-disabled="${dis ? 'true' : 'false'}">${WBG.icon(icon, 'size-4')}</button>`;
    };
    let btns = '';
    if (mine && manage) {
      if (s.type === 'street') btns += cell('b', 'plus', t('monopoly.ui.build')) + cell('s', 'minus', t('monopoly.ui.sell'));
      btns += mort ? cell('u', 'undo', t('monopoly.ui.unmortgage')) : cell('m', 'lock', t('monopoly.ui.mortgage'));
    }
    const status = mort ? `<span class="chip chip-warn !py-0">${esc(t('monopoly.ui.mortgaged'))}</span>` : h === 5 ? `<span class="chip chip-danger !py-0">${esc(t('monopoly.ui.hotel'))}</span>` : h ? `<span class="chip chip-success !py-0">${esc(t('monopoly.ui.nHouses', { n: h }))}</span>` : '';
    return `<div class="mp-prop"><span class="h-8 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>
      <button class="min-w-0 flex-1 text-left" data-open="${i}"><span class="block truncate text-sm font-semibold text-white">${esc(spaceName(i))}</span><span class="flex flex-wrap items-center gap-1 text-xs text-slate-400">${esc(money(s.price))} ${status}</span></button>
      <div class="flex gap-1">${btns}</div></div>`;
  }

  function renderAssets() {
    const box = $('mp-assets');
    const p = player(viewId) || me() || player(S.turn);
    if (!p) { box.innerHTML = ''; return; }
    const mine = p.id === myId && !p.bankrupt && !S.over;
    const manage = mine ? S.manage : null;
    const list = board.spaces.filter((s) => s.price && ownerOf(s.i)?.id === p.id);
    const order = Object.keys(board.groups);
    list.sort((a, b) => {
      const ga = a.group ? order.indexOf(a.group) : a.type === 'station' ? 20 : 21;
      const gb = b.group ? order.indexOf(b.group) : b.type === 'station' ? 20 : 21;
      return ga - gb || a.i - b.i;
    });
    let html = `<div class="flex items-center gap-2 rounded-xl bg-white/5 p-2.5"><span class="size-8 shrink-0">${tokenSvg(p.token, p.color)}</span>
      <div class="min-w-0 flex-1"><p class="truncate text-sm font-bold text-white">${esc(p.name)}</p><p class="text-xs text-slate-400">${esc(t('monopoly.ui.netWorth', { amount: money(p.net) }))}</p></div>
      <p class="text-lg font-extrabold text-emerald-300 tabular-nums">${esc(money(p.cash))}</p></div>`;
    if (!mine && !spectator && !p.bankrupt && p.id !== myId) html += `<button class="btn btn-secondary btn-sm w-full" data-trade="${p.id}">${WBG.icon('swap', 'size-4')}<span>${esc(t('monopoly.ui.tradeWith', { name: p.name }))}</span></button>`;
    html += list.length ? list.map((s) => propRow(s.i, mine, manage?.[s.i])).join('') : `<p class="py-4 text-center text-sm text-slate-500">${esc(t('monopoly.ui.noProps'))}</p>`;
    if (mine) html += `<button class="btn btn-ghost btn-sm w-full text-rose-300" data-act2="resign">${esc(t('monopoly.ui.resign'))}</button>`;
    box.innerHTML = html;
  }

  $('mp-assets').addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    if (m) {
      if (m.getAttribute('aria-disabled') === 'true') {
        if (m.dataset.why) { WBG.sound.play('error'); WBG.toast(m.dataset.why, { type: 'error' }); }
        return;
      }
      const type = { b: 'monopoly-build', s: 'monopoly-sell', m: 'monopoly-mortgage', u: 'monopoly-unmortgage' }[m.dataset.m];
      WBG.sound.play('click');
      socket.emit(type, { idx: Number(m.dataset.i) });
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o) return openProp(Number(o.dataset.open));
    const tr = e.target.closest('[data-trade]');
    if (tr) return openTradeBuilder(tr.dataset.trade);
    if (e.target.closest('[data-act2="resign"]')) askResign();
  });

  function renderLog() {
    const log = $('mp-log');
    log.innerHTML = [...S.log].reverse().map((l) => `<li class="rounded-lg bg-white/4 px-2.5 py-1.5">${esc(tx(l.m))}</li>`).join('');
  }

  function renderPanels() {
    $('mp-tab-assets').className = `btn btn-sm flex-1 ${tab === 'assets' ? 'btn-secondary' : 'btn-ghost'}`;
    $('mp-tab-log').className = `btn btn-sm flex-1 ${tab === 'log' ? 'btn-secondary' : 'btn-ghost'}`;
    $('mp-assets').hidden = tab !== 'assets';
    $('mp-log').hidden = tab !== 'log';
    $('mp-trade-open').hidden = spectator || !!me()?.bankrupt;
    $('mp-trade-open2').hidden = spectator || !!me()?.bankrupt;
    if (tab === 'assets') renderAssets(); else renderLog();
  }

  /* ---------------------------------------------------------------- property card */
  function propCardHtml(i) {
    const s = sp(i);
    const o = ownerOf(i);
    const color = s.group ? board.groups[s.group].color : '#475569';
    const rows = [];
    const row = (a, b, hl) => rows.push(`<div class="flex justify-between gap-3 py-0.5 ${hl ? 'font-bold text-white' : ''}"><span>${esc(a)}</span><span class="tabular-nums">${esc(b)}</span></div>`);
    if (s.type === 'street') {
      const h = S.hs[i];
      row(t('monopoly.rent.base'), money(s.rent[0]), !h);
      row(t('monopoly.rent.set'), money(s.rent[0] * 2));
      for (let k = 1; k <= 4; k++) row(t('monopoly.rent.houses', { n: k }), money(s.rent[k]), h === k);
      row(t('monopoly.rent.hotel'), money(s.rent[5]), h === 5);
      rows.push('<hr class="my-1.5 border-white/10">');
      row(t('monopoly.rent.houseCost'), money(s.house));
    } else if (s.type === 'station') {
      board.consts.STATION_RENT.forEach((r, k) => row(t('monopoly.rent.stations', { n: k + 1 }), money(r)));
    } else if (s.type === 'utility') {
      rows.push(`<p class="py-1">${esc(t('monopoly.rent.util1'))}</p><p class="py-1">${esc(t('monopoly.rent.util2'))}</p>`);
    } else if (s.type === 'tax') {
      rows.push(`<p class="py-1">${esc(t('monopoly.rent.tax', { amount: money(s.tax) }))}</p>`);
    }
    if (s.price) row(t('monopoly.rent.mortgage'), money(s.mortgage));
    const state = o ? t('monopoly.ui.ownedBy', { name: o.name }) + (S.ms[i] ? ` - ${t('monopoly.ui.mortgaged')}` : '') : s.price ? t('monopoly.ui.unowned') : '';
    return { color, rows: rows.join(''), state, price: s.price };
  }

  function openProp(i) {
    if (!board || !S) return;
    const s = sp(i);
    if (!['street', 'station', 'utility', 'tax'].includes(s.type)) return;
    propOpen = i;
    renderProp();
  }

  function renderProp() {
    const ov = $('mp-ov-prop');
    if (propOpen === null || !S) { ov.hidden = true; return; }
    const i = propOpen;
    const s = sp(i);
    const c = propCardHtml(i);
    const m = me();
    const mine = m && S.own[i] === m.seat && !S.over;
    const man = mine ? S.manage?.[i] : null;
    const mbtn = (what, label, cls) => {
      const reason = man?.[what];
      return `<button class="btn ${cls} ${reason ? 'mp-dis' : ''}" data-m="${what}" ${reason ? `data-why="${esc(tx(reason))}"` : ''} aria-disabled="${reason ? 'true' : 'false'}">${esc(label)}</button>`;
    };
    let actions = '';
    if (mine && man) {
      if (s.type === 'street') actions += mbtn('b', t('monopoly.ui.build'), 'btn-secondary') + mbtn('s', t('monopoly.ui.sell'), 'btn-secondary');
      actions += S.ms[i] ? mbtn('u', t('monopoly.ui.unmortgage'), 'btn-secondary') : mbtn('m', t('monopoly.ui.mortgage'), 'btn-secondary');
    }
    const buying = isMyTurn() && S.phase === 'buy' && m.pos === i;
    if (buying) {
      actions = `<button class="btn btn-success" data-buy ${m.cash < s.price || locked() ? 'disabled' : ''}>${esc(t('monopoly.ui.buy', { amount: money(s.price) }))}</button><button class="btn btn-secondary" data-decline>${esc(S.opts.auction === 'on' ? t('monopoly.ui.auction') : t('monopoly.ui.pass'))}</button>`;
    }
    ov.innerHTML = `<div class="card animate-pop w-full max-w-sm overflow-hidden" role="dialog" aria-label="${esc(spaceName(i))}">
      <div class="px-5 py-4 text-center" style="background:${c.color}"><p class="text-xs font-semibold tracking-widest uppercase" style="color:${s.group === 'sky' || s.group === 'yellow' ? '#111' : '#fff'}">${esc(s.group ? groupName(s.group) : t(`monopoly.type.${s.type}`))}</p>
        <h3 class="text-xl font-extrabold" style="color:${s.group === 'sky' || s.group === 'yellow' ? '#111' : '#fff'}">${esc(spaceName(i))}</h3></div>
      <div class="p-5 text-sm text-slate-300">${s.price ? `<p class="mb-2 text-center text-lg font-bold text-white">${esc(money(s.price))}</p>` : ''}${c.rows}
        ${c.state ? `<p class="mt-3 rounded-lg bg-white/6 px-3 py-1.5 text-center font-semibold text-white">${esc(c.state)}</p>` : ''}
        <div class="mt-4 flex flex-wrap gap-2 [&>*]:flex-1">${actions}<button class="btn btn-ghost" data-close-prop>${esc(t('monopoly.ui.close'))}</button></div></div></div>`;
    ov.hidden = false;
  }

  $('mp-ov-prop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close-prop]')) { propOpen = null; renderProp(); return; }
    const m = e.target.closest('[data-m]');
    if (m) {
      if (m.getAttribute('aria-disabled') === 'true') { if (m.dataset.why) { WBG.sound.play('error'); WBG.toast(m.dataset.why, { type: 'error' }); } return; }
      socket.emit({ b: 'monopoly-build', s: 'monopoly-sell', m: 'monopoly-mortgage', u: 'monopoly-unmortgage' }[m.dataset.m], { idx: propOpen });
    } else if (e.target.closest('[data-buy]')) { socket.emit('monopoly-buy'); propOpen = null; renderProp(); }
    else if (e.target.closest('[data-decline]')) { socket.emit('monopoly-decline'); propOpen = null; renderProp(); }
  });

  /* ---------------------------------------------------------------- auction */
  function renderAuction() {
    const ov = $('mp-ov-auction');
    const a = S?.auction;
    if (!a) { ov.hidden = true; auctionKey = ''; return; }
    const m = me();
    const key = `${a.idx}:${m?.id}`;
    const i = a.idx;
    const s = sp(i);
    const top = a.top;
    const topP = top ? player(top.id) : null;
    const canBid = m && !m.bankrupt && a.participants.includes(m.id) && !a.passed.includes(m.id);
    if (auctionKey !== key) {
      auctionKey = key;
      const c = propCardHtml(i);
      ov.innerHTML = `<div class="card animate-pop w-full max-w-sm overflow-hidden" role="dialog" aria-label="${esc(t('monopoly.ui.auctionTitle'))}">
        <div class="px-5 py-3 text-center" style="background:${c.color}"><p class="text-xs font-semibold tracking-widest uppercase" style="color:${s.group === 'sky' || s.group === 'yellow' ? '#111' : '#fff'}">${esc(t('monopoly.ui.auctionTitle'))}</p>
          <h3 class="text-lg font-extrabold" style="color:${s.group === 'sky' || s.group === 'yellow' ? '#111' : '#fff'}">${esc(spaceName(i))}</h3></div>
        <div class="space-y-3 p-4">
          <p class="text-center text-xs text-slate-400">${esc(t('monopoly.ui.listPrice', { amount: money(s.price) }))}</p>
          <div class="text-center"><p id="mp-a-bid" class="text-3xl font-black text-emerald-300 tabular-nums"></p><p id="mp-a-who" class="text-sm text-slate-300"></p></div>
          <div class="h-1.5 overflow-hidden rounded-full bg-white/10"><div id="mp-a-bar" class="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-500"></div></div>
          <div id="mp-a-ctl" class="space-y-2"></div>
          <p id="mp-a-passed" class="text-center text-xs text-slate-500"></p>
        </div></div>`;
      ov.hidden = false;
      WBG.sound.play('notify');
    }
    const cur = top ? top.amount : 0;
    $('mp-a-bid').textContent = top ? money(top.amount) : '-';
    $('mp-a-who').textContent = top ? t('monopoly.ui.leads', { name: topP?.name || '' }) : t('monopoly.ui.noBids');
    const ctl = $('mp-a-ctl');
    const sig = `${canBid}:${cur}:${m?.cash}:${top?.id}`;
    if (ctl.dataset.sig !== sig) {
      const hadInput = ctl.querySelector('input');
      const keep = hadInput ? hadInput.value : '';
      const focus = document.activeElement === hadInput;
      ctl.dataset.sig = sig;
      if (!canBid) {
        ctl.innerHTML = `<p class="text-center text-sm text-slate-400">${esc(spectator ? t('monopoly.ui.watchingAuction') : m && a.passed.includes(m.id) ? t('monopoly.ui.youPassed') : t('monopoly.ui.cannotBid'))}</p>`;
      } else if (top?.id === m.id) {
        ctl.innerHTML = `<p class="text-center text-sm font-semibold text-emerald-300">${esc(t('monopoly.ui.youLead'))}</p>`;
      } else {
        const quick = [10, 50, 100].map((inc) => cur + inc).filter((v) => v > 0);
        ctl.innerHTML = `<div class="grid grid-cols-3 gap-2">${quick.map((v) => `<button class="btn btn-secondary" data-bid="${v}" ${v > m.cash ? 'disabled' : ''}>${esc(money(v))}</button>`).join('')}</div>
          <div class="flex gap-2"><input id="mp-a-in" class="input min-w-0 flex-1" type="number" inputmode="numeric" min="${cur + 1}" step="1" placeholder="${esc(t('monopoly.ui.yourBid'))}" aria-label="${esc(t('monopoly.ui.yourBid'))}"><button class="btn btn-primary" data-bidin>${esc(t('monopoly.ui.bid'))}</button></div>
          <button class="btn btn-ghost w-full" data-pass>${esc(t('monopoly.ui.passAuction'))}</button>`;
        const inp = ctl.querySelector('input');
        inp.value = keep;
        if (focus) inp.focus();
      }
    }
    $('mp-a-passed').textContent = a.passed.length ? t('monopoly.ui.passedList', { names: a.passed.map((id) => player(id)?.name).join(', ') }) : '';
    deadlineAt = performance.now() + a.left;
  }

  $('mp-ov-auction').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bid]');
    if (b && !b.disabled) { WBG.sound.play('coin'); socket.emit('monopoly-bid', { amount: Number(b.dataset.bid) }); return; }
    if (e.target.closest('[data-bidin]')) {
      const v = Number($('mp-a-in').value);
      if (Number.isInteger(v) && v > 0) { WBG.sound.play('coin'); socket.emit('monopoly-bid', { amount: v }); $('mp-a-in').value = ''; }
      else WBG.sound.play('error');
      return;
    }
    if (e.target.closest('[data-pass]')) { WBG.sound.play('click'); socket.emit('monopoly-auction-pass'); }
  });
  $('mp-ov-auction').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'mp-a-in') $('mp-ov-auction').querySelector('[data-bidin]').click(); });

  /* ---------------------------------------------------------------- trading */
  const emptyOffer = () => ({ cash: 0, jail: 0, props: new Set() });
  const offerOut = (o) => ({ cash: o.cash, jail: o.jail, props: [...o.props] });
  const interestOf = (i) => Math.ceil(sp(i).mortgage / 10);
  const groupBuilt = (i) => { const g = sp(i).group; return !!g && board.groups[g].spaces.some((j) => S.hs[j] > 0); };

  function tradeCheck(giveP, takeP, give, take) {
    const empty = (o) => !o.cash && !o.jail && !(o.props.size ?? o.props.length);
    if (empty(give) && empty(take)) return t('monopoly.err.emptyTrade');
    if (give.cash > giveP.cash) return t('monopoly.trade.noCash', { name: giveP.name });
    if (take.cash > takeP.cash) return t('monopoly.trade.noCash', { name: takeP.name });
    if (give.jail > giveP.cards) return t('monopoly.trade.noCards', { name: giveP.name });
    if (take.jail > takeP.cards) return t('monopoly.trade.noCards', { name: takeP.name });
    const fee = (o) => [...o.props].filter((i) => S.ms[i]).reduce((n, i) => n + interestOf(i), 0);
    if (giveP.cash - give.cash + take.cash < fee(take)) return t('monopoly.trade.noFee', { name: giveP.name });
    if (takeP.cash - take.cash + give.cash < fee(give)) return t('monopoly.trade.noFee', { name: takeP.name });
    return null;
  }

  function openTradeBuilder(partner, prefill) {
    const m = me();
    if (!m || m.bankrupt || S.over) return;
    const others = S.players.filter((p) => !p.bankrupt && p.id !== myId);
    if (!others.length) return;
    tb = prefill || { to: partner || others[0].id, give: emptyOffer(), take: emptyOffer() };
    if (!others.some((p) => p.id === tb.to)) tb.to = others[0].id;
    $('mp-ov-trade').dataset.mode = 'build';
    buildTradeUi();
  }

  function buildTradeUi() {
    const ov = $('mp-ov-trade');
    const box = (side, title) => `<section class="rounded-2xl bg-white/5 p-3"><h4 class="mb-2 text-sm font-bold text-white" id="tb-${side}-h">${esc(title)}</h4>
      <label class="mb-1 block text-xs text-slate-400" for="tb-${side}-cash">${esc(t('monopoly.trade.cash'))}</label>
      <input id="tb-${side}-cash" class="input mb-2 w-full" type="number" inputmode="numeric" min="0" step="10" value="${tb[side].cash || ''}" placeholder="0">
      <div id="tb-${side}-jail" class="mb-2 flex items-center gap-2 text-xs text-slate-300"></div>
      <div id="tb-${side}-props" class="space-y-1"></div></section>`;
    ov.innerHTML = `<div class="card animate-pop w-full max-w-2xl p-4" role="dialog" aria-label="${esc(t('monopoly.ui.trade'))}">
      <div class="mb-3 flex items-center justify-between gap-2"><h3 class="text-lg font-bold text-white">${esc(t('monopoly.trade.title'))}</h3><button class="btn btn-ghost btn-icon btn-sm" data-tb="close" aria-label="${esc(t('monopoly.ui.close'))}">${WBG.icon('mp-x', 'size-5')}</button></div>
      <div id="tb-partners" class="scroll-y mb-3 flex gap-1.5" style="overflow-y:hidden"></div>
      <div class="grid gap-3 sm:grid-cols-2">${box('give', t('monopoly.trade.youGive'))}${box('take', t('monopoly.trade.youGet'))}</div>
      <p id="tb-msg" class="mt-3 min-h-5 text-center text-sm text-amber-300" aria-live="polite"></p>
      <div class="mt-2 flex gap-2"><button class="btn btn-secondary flex-1" data-tb="close">${esc(t('monopoly.ui.cancel'))}</button><button id="tb-send" class="btn btn-primary flex-1" data-tb="send">${esc(tb.counter ? t('monopoly.trade.sendCounter') : t('monopoly.trade.send'))}</button></div></div>`;
    ov.hidden = false;
    for (const side of ['give', 'take']) {
      $(`tb-${side}-cash`).addEventListener('input', (e) => { tb[side].cash = Math.max(0, Math.floor(Number(e.target.value) || 0)); refreshTrade(); });
    }
    refreshTrade();
  }

  function refreshTrade() {
    if (!tb || $('mp-ov-trade').dataset.mode !== 'build') return;
    const m = me();
    const to = player(tb.to);
    if (!m || !to || to.bankrupt) { closeTrade(); return; }
    $('tb-partners').innerHTML = S.players.filter((p) => !p.bankrupt && p.id !== myId).map((p) =>
      `<button class="btn btn-sm ${p.id === tb.to ? 'btn-primary' : 'btn-secondary'} shrink-0" data-tb="to" data-id="${p.id}"><span class="size-5">${tokenSvg(p.token, p.color)}</span>${esc(p.name)}</button>`).join('');
    $('tb-give-h').textContent = t('monopoly.trade.youGive');
    $('tb-take-h').textContent = t('monopoly.trade.getFrom', { name: to.name });
    for (const [side, owner] of [['give', m], ['take', to]]) {
      const o = tb[side];
      $(`tb-${side}-jail`).innerHTML = `${WBG.icon('key', 'size-4')}<span class="flex-1">${esc(t('monopoly.trade.jailCards'))}</span>
        <button class="btn btn-secondary mp-mini" data-tb="jail-" data-side="${side}" aria-label="-">${WBG.icon('minus', 'size-4')}</button><span class="w-4 text-center font-bold text-white">${o.jail}</span>
        <button class="btn btn-secondary mp-mini ${o.jail >= owner.cards ? 'mp-dis' : ''}" data-tb="jail+" data-side="${side}" aria-label="+">${WBG.icon('plus', 'size-4')}</button>`;
      const mine = board.spaces.filter((s) => s.price && ownerOf(s.i)?.id === owner.id);
      $(`tb-${side}-props`).innerHTML = mine.length ? mine.map((s) => {
        const built = groupBuilt(s.i);
        const on = o.props.has(s.i);
        const color = s.group ? board.groups[s.group].color : s.type === 'station' ? '#94a3b8' : '#fbbf24';
        return `<button class="mp-prop w-full text-left ${on ? 'ring-2 ring-brand-400' : ''} ${built ? 'mp-dis' : ''}" data-tb="prop" data-side="${side}" data-i="${s.i}" aria-pressed="${on}" ${built ? `title="${esc(t('monopoly.trade.built'))}"` : ''}>
          <span class="h-6 w-1.5 shrink-0 rounded-full" style="background:${color}"></span><span class="min-w-0 flex-1 truncate text-sm text-white">${esc(spaceName(s.i))}</span>
          ${S.ms[s.i] ? `<span class="chip chip-warn !py-0">${esc(t('monopoly.ui.mortgaged'))}</span>` : ''}${built ? WBG.icon('lock', 'size-4 text-slate-400') : on ? WBG.icon('mp-check', 'size-4 text-brand-300') : ''}</button>`;
      }).join('') : `<p class="py-2 text-center text-xs text-slate-500">${esc(t('monopoly.ui.noProps'))}</p>`;
    }
    const msg = tradeCheck(m, to, tb.give, tb.take);
    $('tb-msg').textContent = msg || '';
    $('tb-send').disabled = !!msg;
  }

  function closeTrade() { tb = null; $('mp-ov-trade').hidden = true; $('mp-ov-trade').dataset.mode = ''; }

  $('mp-ov-trade').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tb]');
    if (e.target === e.currentTarget && $('mp-ov-trade').dataset.mode === 'build') return closeTrade();
    if (!b) return;
    const a = b.dataset.tb;
    if (a === 'close') return closeTrade();
    if (a === 'to') { tb.to = b.dataset.id; tb.take = emptyOffer(); return refreshTrade(); }
    if (a === 'jail+' || a === 'jail-') {
      const o = tb[b.dataset.side];
      const owner = b.dataset.side === 'give' ? me() : player(tb.to);
      o.jail = Math.max(0, Math.min(owner.cards, o.jail + (a === 'jail+' ? 1 : -1)));
      return refreshTrade();
    }
    if (a === 'prop') {
      const i = Number(b.dataset.i);
      if (groupBuilt(i)) { WBG.toast(t('monopoly.trade.built'), { type: 'error' }); return; }
      const set = tb[b.dataset.side].props;
      set.has(i) ? set.delete(i) : set.add(i);
      WBG.sound.play('click');
      return refreshTrade();
    }
    if (a === 'send') {
      const payload = { to: tb.to, give: offerOut(tb.give), take: offerOut(tb.take) };
      socket.emit(tb.counter ? 'monopoly-trade-counter' : 'monopoly-trade', payload);
      WBG.sound.play('coin');
      closeTrade();
    }
    if (a === 'accept') { socket.emit('monopoly-trade-accept'); }
    if (a === 'decline') { socket.emit('monopoly-trade-decline'); }
    if (a === 'cancel') { socket.emit('monopoly-trade-cancel'); }
    if (a === 'counter') {
      const tr = S.trade;
      tb = { to: tr.from, counter: true, give: { cash: tr.take.cash, jail: tr.take.jail, props: new Set(tr.take.props) }, take: { cash: tr.give.cash, jail: tr.give.jail, props: new Set(tr.give.props) } };
      $('mp-ov-trade').dataset.mode = 'build';
      buildTradeUi();
    }
  });

  function offerList(o) {
    const parts = [];
    if (o.cash) parts.push(`<li class="flex items-center gap-2">${WBG.icon('coin', 'size-4 text-emerald-300')}<span class="font-semibold text-white">${esc(money(o.cash))}</span></li>`);
    if (o.jail) parts.push(`<li class="flex items-center gap-2">${WBG.icon('key', 'size-4 text-amber-300')}<span class="text-white">${esc(t('monopoly.trade.cardsN', { n: o.jail }))}</span></li>`);
    for (const i of o.props) {
      const s = sp(i);
      const color = s.group ? board.groups[s.group].color : s.type === 'station' ? '#94a3b8' : '#fbbf24';
      parts.push(`<li class="flex items-center gap-2"><span class="h-4 w-1.5 rounded-full" style="background:${color}"></span><span class="text-white">${esc(spaceName(i))}</span>${S.ms[i] ? `<span class="chip chip-warn !py-0">${esc(t('monopoly.ui.mortgaged'))}</span>` : ''}</li>`);
    }
    return parts.length ? parts.join('') : `<li class="text-slate-500">${esc(t('monopoly.trade.nothing'))}</li>`;
  }

  function renderTradeView() {
    const ov = $('mp-ov-trade');
    if (ov.dataset.mode === 'build' && tb) return refreshTrade();
    const tr = S?.trade;
    const m = me();
    if (!tr || !m || (tr.from !== m.id && tr.to !== m.id)) {
      if (ov.dataset.mode === 'view') { ov.hidden = true; ov.dataset.mode = ''; }
      return;
    }
    const from = player(tr.from);
    const to = player(tr.to);
    const incoming = tr.to === m.id;
    const ok = incoming ? tradeCheck(from, to, { ...tr.give, props: new Set(tr.give.props) }, { ...tr.take, props: new Set(tr.take.props) }) : null;
    ov.dataset.mode = 'view';
    ov.innerHTML = `<div class="card animate-pop w-full max-w-lg p-4" role="dialog" aria-label="${esc(t('monopoly.ui.trade'))}">
      <h3 class="mb-3 text-lg font-bold text-white">${esc(incoming ? t('monopoly.trade.incoming', { name: from.name }) : t('monopoly.trade.outgoing', { name: to.name }))}</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <section class="rounded-2xl bg-white/5 p-3"><h4 class="mb-2 text-xs font-bold tracking-wide text-slate-400 uppercase">${esc(incoming ? t('monopoly.trade.theyGive', { name: from.name }) : t('monopoly.trade.youGive'))}</h4><ul class="space-y-1 text-sm">${offerList(tr.give)}</ul></section>
        <section class="rounded-2xl bg-white/5 p-3"><h4 class="mb-2 text-xs font-bold tracking-wide text-slate-400 uppercase">${esc(incoming ? t('monopoly.trade.theyWant') : t('monopoly.trade.getFrom', { name: to.name }))}</h4><ul class="space-y-1 text-sm">${offerList(tr.take)}</ul></section></div>
      <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10"><div id="mp-t-bar" class="h-full rounded-full bg-brand-400"></div></div>
      <p class="mt-2 min-h-5 text-center text-sm text-amber-300">${esc(incoming ? ok || '' : t('monopoly.trade.waiting'))}</p>
      <div class="mt-2 flex flex-wrap gap-2">${incoming
        ? `<button class="btn btn-success flex-1" data-tb="accept" ${ok ? 'disabled' : ''}>${esc(t('monopoly.trade.accept'))}</button><button class="btn btn-secondary flex-1" data-tb="counter">${esc(t('monopoly.trade.counter'))}</button><button class="btn btn-danger flex-1" data-tb="decline">${esc(t('monopoly.trade.decline'))}</button>`
        : `<button class="btn btn-secondary flex-1" data-tb="cancel">${esc(t('monopoly.trade.cancel'))}</button>`}</div></div>`;
    ov.hidden = false;
    ov.dataset.until = String(performance.now() + tr.left);
    if (incoming && !prev?.trade) { WBG.sound.play('notify'); WBG.haptic(20); }
  }

  /* ---------------------------------------------------------------- render + tick */
  function renderAll() {
    if (!S || !board) return;
    if (!viewId || !player(viewId)) viewId = myId && player(myId) ? myId : S.turn;
    if (!fx.running) syncPos();
    renderBoard();
    renderPlayers();
    renderCenter();
    renderActions();
    renderPanels();
    renderProp();
    renderAuction();
    renderTradeView();
  }

  function tick() {
    if (!S) return;
    const now = performance.now();
    if (S.phase === 'auction' && S.auction && deadlineAt) {
      const bar = $('mp-a-bar');
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((deadlineAt - now) / 20000) * 100))}%`;
    }
    const tv = $('mp-ov-trade');
    if (tv.dataset.mode === 'view' && $('mp-t-bar')) $('mp-t-bar').style.width = `${Math.max(0, ((Number(tv.dataset.until) - now) / 60000) * 100)}%`;
    const bar = $('mp-bar');
    if (S.over || S.phase === 'auction' || !S.turnMs || !turnDeadline) {
      bar.style.width = '0%';
    } else {
      const left = Math.max(0, turnDeadline - now);
      bar.style.width = `${Math.min(100, (left / S.turnMs) * 100)}%`;
      const s = Math.ceil(left / 1000);
      if (isMyTurn() && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
    }
    const lim = $('mp-limit');
    if (lim && S.endsIn !== null) lim.lastElementChild.textContent = WBG.clock(Math.max(0, limitAt - now));
  }
  let turnDeadline = 0;
  let limitAt = 0;

  /* ---------------------------------------------------------------- socket */
  socket.on('monopoly-board', (m) => {
    board = m.board;
    buildBoard();
    layout();
    if (S) renderAll();
  });

  socket.on('monopoly-state', (s) => {
    prev = S;
    S = s;
    turnDeadline = performance.now() + s.timeLeft;
    limitAt = s.endsIn !== null ? performance.now() + s.endsIn : 0;
    if (!board) return;
    const first = !prev;
    if (first) {
      later(() => { const mp = me(); if (mp) scrollToCell(mp.pos); }, 300);
      syncPos();
      seen = { move: Math.max(0, ...s.moves.map((m) => m.seq)), dice: s.diceSeq, card: s.lastCard?.seq || 0 };
      cardFor = seen.card;
    } else {
      if (s.diceSeq > seen.dice) { seen.dice = s.diceSeq; const v = [...s.dice]; enqueue(() => animateDice(v)); }
      let cardQueued = false;
      for (const m of s.moves.filter((x) => x.seq > seen.move)) {
        seen.move = m.seq;
        enqueue(() => animateMove(m));
        if (s.lastCard && s.lastCard.seq > cardFor && s.lastCard.after === m.seq) { cardQueued = true; const c = s.lastCard; cardFor = c.seq; enqueue(() => showCard(c)); }
      }
      if (s.lastCard && s.lastCard.seq > cardFor && !cardQueued) { const c = s.lastCard; cardFor = c.seq; enqueue(() => showCard(c)); }
      // money changes
      for (const p of s.players) {
        const old = prev.players.find((x) => x.id === p.id);
        if (old && old.cash !== p.cash) {
          floatMoney(p.id, p.cash - old.cash);
          if (p.id === myId || Math.abs(p.cash - old.cash) >= 100) WBG.sound.play('coin');
        }
        if (old && !old.bankrupt && p.bankrupt) { WBG.toast(T('monopoly.ui.wentBankrupt', { name: p.name }), { type: 'error' }); WBG.sound.play('lose'); }
      }
      if (s.turn === myId && prev.turn !== myId && !s.over) { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
      if (S.trade && !prev.trade && S.trade.to === myId) WBG.sound.play('notify');
    }
    renderAll();
  });

  socket.on('error', onErr);

  WBG.setRules({
    title: t('monopoly.rules.title'),
    sections: ['goal', 'turn', 'props', 'build', 'mortgage', 'jail', 'trade', 'auction', 'bankrupt', 'options'].map((k) => ({
      title: t(`monopoly.rules.${k}.title`),
      items: t(`monopoly.rules.${k}.items`).split('|')
    }))
  });

  WBG.gameReady('monopoly-page-loaded');
})();
