await WBG.i18n.load('poker');

const $ = (id) => document.getElementById(id);
const myId = localStorage.getItem('userId');
const spectator = WBG.isSpectator;
const T = (key, p) => WBG.t(key, p);
const nf = (n) => Number(n).toLocaleString(WBG.locale);
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const cardSvg = (c, cls) => WBG.art.card(RANK_LABEL[c.r] || String(c.r), c.s, cls);
const key = (c) => `${c.r}${c.s}`;
const reduceMotion = () => WBG.prefs.reduceMotion;

let state = null;
let prev = null;
let deadlineLocal = 0;
let levelLocal = null;
let lastTick = -1;
let raiseKey = '';
let raiseVal = 0;
let confirmUntil = 0;
let confirmTimer = null;

socket.off('poker-state');
const timer = setInterval(tick, 100);
WBG.onTeardown(() => { clearInterval(timer); clearTimeout(confirmTimer); });

WBG.setRules({
  title: T('poker.rules.title'),
  sections: ['goal', 'betting', 'hands', 'blinds', 'timer'].map((s) => ({
    title: T(`poker.rules.${s}.title`),
    items: [T(`poker.rules.${s}.1`), T(`poker.rules.${s}.2`)].filter(Boolean)
  }))
});

/* ------------------------------------------------------------------ chip art */
const DENOMS = [
  [1000, '#f59e0b', '#7c4a03'],
  [500, '#8b5cf6', '#3b1f86'],
  [100, '#1f2937', '#05070d'],
  [25, '#16a34a', '#0a5a28'],
  [5, '#dc2626', '#7f1414'],
  [1, '#e5e7eb', '#8b93a7']
];

function chipList(amount) {
  const out = [];
  let rest = Math.max(0, Math.floor(amount));
  for (const d of DENOMS) {
    while (rest >= d[0] && out.length < 40) { out.push(d); rest -= d[0]; }
  }
  // keep the picture small: the biggest chips first, at most 7
  return out.slice(0, 7).reverse();
}

/** A side-view stack of chips drawn as SVG. */
function chipStack(amount, cls = 'w-7') {
  const chips = chipList(amount);
  if (!chips.length) return '';
  const h = 12 + chips.length * 4.5;
  let body = '';
  chips.forEach((d, i) => {
    const y = h - 8 - i * 4.5;
    body += `<rect x="2" y="${y}" width="28" height="5.5" fill="${d[2]}"/><ellipse cx="16" cy="${y + 5.5}" rx="14" ry="5" fill="${d[2]}"/>`
      + `<ellipse cx="16" cy="${y}" rx="14" ry="5" fill="${d[1]}" stroke="${d[2]}" stroke-width=".8"/>`
      + `<ellipse cx="16" cy="${y}" rx="9" ry="3" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-dasharray="3 3"/>`;
  });
  return `<svg class="${cls} shrink-0" viewBox="0 0 32 ${h}" aria-hidden="true">${body}</svg>`;
}

function chipTop(color = '#8b5cf6') {
  return `<svg viewBox="0 0 40 40" class="size-6" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="${color}" stroke="#fff" stroke-opacity=".8" stroke-width="1.5"/><circle cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="7 7.3" opacity=".9"/><circle cx="20" cy="20" r="10.5" fill="${color}" stroke="#fff" stroke-opacity=".7" stroke-width="1.5"/></svg>`;
}

/* ------------------------------------------------------------------- helpers */
const player = (id) => state.players.find((p) => p.id === id);
const me = () => (spectator ? null : player(myId));

function winnersUnion() {
  const set = new Set();
  const r = state?.result;
  if (!r || r.uncontested) return null;
  for (const pot of r.pots) for (const w of pot.winners) for (const c of r.shown[w.id]?.best || []) set.add(key(c));
  return set;
}

function visible(selector, id) {
  const all = [...document.querySelectorAll(`${selector}[data-pid="${id}"]`)];
  return all.find((e) => e.offsetParent !== null) || all[0] || null;
}

function badges(p) {
  let h = '';
  if (p.dealer) h += `<span class="grid size-5 place-items-center rounded-full bg-white text-[10px] font-extrabold text-ink-900" title="${T('poker.badge.dealer')}">D</span>`;
  if (p.sb) h += `<span class="grid h-5 min-w-5 place-items-center rounded-full bg-sky-300 px-1 text-[10px] font-extrabold text-ink-900" title="${T('poker.badge.sb')}">${T('poker.badge.sbShort')}</span>`;
  if (p.bb) h += `<span class="grid h-5 min-w-5 place-items-center rounded-full bg-amber-300 px-1 text-[10px] font-extrabold text-ink-900" title="${T('poker.badge.bb')}">${T('poker.badge.bbShort')}</span>`;
  return h;
}

function statusOf(p) {
  if (p.left) return ['poker.status.left', 'text-slate-400'];
  if (p.out) return ['poker.status.out', 'text-slate-400'];
  if (p.sittingOut) return ['poker.status.away', 'text-amber-300'];
  if (p.folded) return ['poker.status.folded', 'text-slate-400'];
  if (p.allIn) return ['poker.status.allin', 'text-rose-300'];
  return null;
}

function seatEl(p, desktop) {
  const li = document.createElement('li');
  li.dataset.pid = p.id;
  const turn = state.turn === p.id && state.stage === 'bet';
  const gone = p.out || p.folded || p.sittingOut;
  const won = state.result && state.result.pots.some((pot) => pot.winners.some((w) => w.id === p.id));
  const hit = winnersUnion();
  const st = statusOf(p);
  li.className = `pk-seat min-w-0 ${desktop ? "" : "relative"} rounded-xl border border-white/10 bg-ink-950/70 p-1.5 backdrop-blur-sm ${turn ? 'pk-turn' : ''} ${gone ? 'pk-gone' : ''} ${won ? 'pk-win' : ''} ${desktop ? 'absolute w-36 -translate-x-1/2 -translate-y-1/2' : ''}`;
  let cards = '';
  if (p.hole) {
    cards = p.hole.map((c) => `<span class="pk-card pk-mini ${hit && !state.result.uncontested ? (hit.has(key(c)) ? 'pk-hit' : 'pk-dim') : ''}">${cardSvg(c, '')}</span>`).join('');
  } else if (p.hasCards) {
    const fresh = prev && prev.handNo !== state.handNo ? 'pk-deal' : '';
    cards = `<span class="pk-card pk-mini ${fresh}">${WBG.art.cardBack('')}</span><span class="pk-card pk-mini ${fresh}" style="margin-left:-.6rem;animation-delay:.08s">${WBG.art.cardBack('')}</span>`;
  }
  const prevBet = prev?.players.find((x) => x.id === p.id)?.bet || 0;
  const bet = p.bet > 0
    ? `<div class="pk-bet mt-1 flex items-center justify-center gap-1 rounded-lg bg-black/35 px-1.5 py-0.5 text-[11px] font-bold text-amber-200 tabular-nums ${p.bet !== prevBet ? 'pk-pop' : ''}">${chipStack(p.bet, 'w-4')}${nf(p.bet)}</div>`
    : '';
  li.innerHTML = `<div class="flex items-center gap-1.5">
      <span class="relative shrink-0">${WBG.avatar(p.name, 'size-8 text-xs')}${turn ? `<svg class="pk-ring" viewBox="0 0 36 36"><circle data-ring cx="18" cy="18" r="16.5" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="103.7" stroke-dashoffset="0"/></svg>` : ''}</span>
      <div class="min-w-0 flex-1 leading-tight">
        <p class="truncate text-[11px] font-semibold text-white sm:text-xs">${WBG.esc(p.name)}</p>
        <p class="text-[11px] font-bold text-emerald-300 tabular-nums sm:text-xs">${nf(p.chips)}</p>
      </div>
    </div>
    <div class="mt-1 flex min-h-[2.4rem] items-center justify-between gap-1">
      <span class="flex items-center">${cards}</span>
      <span class="flex flex-wrap justify-end gap-0.5">${badges(p)}</span>
    </div>
    ${st ? `<p class="mt-0.5 text-center text-[10px] font-semibold tracking-wide uppercase ${st[1]}">${T(st[0])}</p>` : ''}
    ${bet}`;
  return li;
}

/* -------------------------------------------------------------------- render */
function render() {
  if (!state) return;
  const mine = me();
  const others = state.players.filter((p) => p.id !== myId || spectator);
  // order clockwise starting after me
  let ordered = others;
  if (!spectator && mine) {
    const i = state.players.indexOf(mine);
    ordered = [...state.players.slice(i + 1), ...state.players.slice(0, i)];
  }
  $('pk-opp').replaceChildren(...ordered.map((p) => seatEl(p, false)));
  const n = state.players.length;
  const oval = ordered.map((p, k) => {
    const el = seatEl(p, true);
    const idx = spectator ? k : k + 1;
    const a = ((90 + (idx * 360) / n) * Math.PI) / 180;
    el.style.left = `${50 + 46 * Math.cos(a)}%`;
    el.style.top = `${50 + 44 * Math.sin(a)}%`;
    return el;
  });
  $('pk-oval').replaceChildren(...oval);

  renderCenter();
  renderDock(mine);
  renderInfo();
  renderLog();
}

function renderInfo() {
  const b = state.blinds;
  $('pk-blinds').textContent = T('poker.info.blinds', { sb: nf(b.sb), bb: nf(b.bb) }) + (state.handNo ? ` - ${T('poker.info.hand', { n: state.handNo })}` : '');
  levelLocal = b.inMs === null ? null : performance.now() + b.inMs;
  $('pk-level').textContent = '';
  tick();
}

function renderCenter() {
  const potBox = $('pk-pot');
  const pot = state.pot;
  potBox.innerHTML = pot > 0 ? `${chipStack(pot, 'w-8')}<span class="text-lg font-extrabold tabular-nums">${nf(pot)}</span><span class="text-xs text-emerald-100/80">${T('poker.pot')}</span>` : '';
  const pots = state.pots || [];
  $('pk-pots').replaceChildren(...(pots.length > 1 ? pots.map((p, i) => {
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = `${i === 0 ? T('poker.pot.main') : T('poker.pot.side', { n: i })}: ${nf(p.amount)}`;
    return s;
  }) : []));

  const hit = winnersUnion();
  const prevLen = prev && prev.handNo === state.handNo ? prev.board.length : 0;
  const slots = [];
  for (let i = 0; i < 5; i++) {
    const c = state.board[i];
    const d = document.createElement('div');
    d.className = 'pk-card';
    if (c) {
      const fresh = i >= prevLen && prev;
      d.className += ` ${fresh ? 'pk-flip' : ''} ${hit ? (hit.has(key(c)) ? 'pk-hit' : 'pk-dim') : ''}`;
      if (fresh) d.style.animationDelay = `${(i - prevLen) * 0.12}s`;
      d.innerHTML = cardSvg(c, '');
    } else {
      d.innerHTML = '<div class="aspect-[64/90] w-full rounded-md border border-dashed border-white/20 bg-black/15"></div>';
    }
    slots.push(d);
  }
  $('pk-board').replaceChildren(...slots);

  const banner = $('pk-banner');
  banner.replaceChildren();
  const r = state.result;
  if (r) {
    r.pots.forEach((pot, i) => {
      const line = document.createElement('span');
      line.className = 'block';
      const label = r.pots.length > 1 ? `${i === 0 ? T('poker.pot.main') : T('poker.pot.side', { n: i })}: ` : '';
      const names = pot.winners.map((w) => player(w.id)?.name || '').join(', ');
      if (r.uncontested) line.textContent = label + T('poker.res.fold', { name: names, n: nf(pot.amount) });
      else if (pot.winners.length > 1) line.textContent = label + T('poker.res.split', { names, n: nf(pot.winners[0].amount), hand: WBG.tr(pot.hand) });
      else line.textContent = label + T('poker.res.win', { name: names, n: nf(pot.winners[0].amount), hand: WBG.tr(pot.hand) });
      banner.appendChild(line);
    });
  } else if (state.stage === 'lobby') {
    banner.textContent = T('poker.status.starting');
  } else if (state.turn && state.turn !== myId) {
    banner.textContent = T('poker.status.turn', { name: player(state.turn)?.name || '' });
    banner.className = banner.className.replace('text-amber-200', 'text-slate-200');
    return;
  }
  banner.className = banner.className.replace('text-slate-200', 'text-amber-200');
}

function renderDock(mine) {
  $('pk-dock').hidden = spectator;
  if (spectator || !mine) return;
  const hit = winnersUnion();
  const hole = $('pk-hole');
  const fresh = prev && prev.handNo !== state.handNo ? 'pk-deal' : '';
  hole.replaceChildren(...(mine.hole || []).map((c, i) => {
    const d = document.createElement('div');
    d.className = `pk-card ${fresh} ${mine.folded ? 'pk-dim' : ''} ${hit && !state.result.uncontested && !mine.folded ? (hit.has(key(c)) ? 'pk-hit' : 'pk-dim') : ''}`;
    if (fresh) d.style.animationDelay = `${i * 0.12}s`;
    d.innerHTML = cardSvg(c, '');
    return d;
  }));
  $('pk-me').innerHTML = `${WBG.avatar(mine.name, 'size-8 text-xs')}<div class="leading-tight"><p class="max-w-32 truncate font-semibold text-white">${WBG.esc(mine.name)}</p><p class="font-bold text-emerald-300 tabular-nums">${nf(mine.chips)}</p></div>${mine.bet > 0 ? `<span class="flex items-center gap-1 rounded-lg bg-black/35 px-1.5 py-0.5 text-xs font-bold text-amber-200 tabular-nums">${chipStack(mine.bet, 'w-4')}${nf(mine.bet)}</span>` : ''}<span class="flex gap-0.5">${badges(mine)}</span>`;

  let handName = '';
  if (state.myHand) handName = T('poker.yourHand', { hand: WBG.tr(state.myHand) });
  else if (state.result && state.result.shown[myId]) handName = T('poker.yourHand', { hand: WBG.tr(state.result.shown[myId].hand) });
  $('pk-myhand').textContent = handName;

  const st = statusOf(mine);
  $('pk-away').hidden = !(mine.sittingOut && !mine.out);
  $('pk-status').textContent = mine.out ? T(mine.left ? 'poker.status.left' : 'poker.status.outWatching') : mine.sittingOut ? T('poker.status.awayHint') : st ? T(st[0]) : '';
  renderActions(mine);
}

function renderActions(mine) {
  const L = state.legal;
  const box = $('pk-actions');
  box.hidden = !L;
  if (!L) { confirmUntil = 0; return; }
  const k = `${state.handNo}:${state.street}:${L.currentBet}:${L.minTo}`;
  if (k !== raiseKey) { raiseKey = k; raiseVal = L.minTo; confirmUntil = 0; }
  raiseVal = Math.min(Math.max(raiseVal, L.minTo), L.maxTo);

  const allInCall = !L.canCheck && L.toCall >= mine.chips;
  $('pk-call').textContent = L.canCheck ? T('poker.act.check') : allInCall ? T('poker.act.callAllIn', { n: nf(L.toCall) }) : T('poker.act.call', { n: nf(L.toCall) });
  $('pk-call').dataset.allin = allInCall ? '1' : '';
  $('pk-raise').hidden = !(L.canRaise && L.minTo < L.maxTo);
  $('pk-raise-btn').hidden = !L.canRaise;
  box.querySelector('.grid-cols-3, .grid-cols-2').className = `grid ${L.canRaise ? 'grid-cols-3' : 'grid-cols-2'} gap-2`;
  const range = $('pk-raise-range');
  range.min = L.minTo; range.max = L.maxTo; range.step = Math.max(1, Math.floor(state.blinds.bb / 2));
  syncRaise(L);
}

function syncRaise(L = state.legal) {
  if (!L) return;
  $('pk-raise-range').value = raiseVal;
  if (document.activeElement !== $('pk-raise-input')) $('pk-raise-input').value = raiseVal;
  const btn = $('pk-raise-btn');
  const confirming = performance.now() < confirmUntil;
  const allIn = raiseVal >= L.maxTo;
  btn.textContent = confirming ? T('poker.act.confirmAllIn') : allIn ? T('poker.act.allIn', { n: nf(raiseVal) }) : L.currentBet === 0 ? T('poker.act.bet', { n: nf(raiseVal) }) : T('poker.act.raiseTo', { n: nf(raiseVal) });
  btn.classList.toggle('animate-pulse-soft', confirming);
}

function renderLog() {
  $('pk-log').replaceChildren(...[...state.log].reverse().map((e) => {
    const li = document.createElement('li');
    li.className = 'rounded-lg bg-white/5 px-2.5 py-1.5';
    li.textContent = WBG.tr({ k: e.k, p: e.p });
    return li;
  }));
}

/* ------------------------------------------------------------- timers + tick */
function tick() {
  if (!state) return;
  const now = performance.now();
  let left = 0;
  if (state.stage === 'bet' && deadlineLocal) {
    left = Math.max(0, deadlineLocal - now);
    const frac = Math.min(1, left / state.turnMs);
    for (const c of document.querySelectorAll('[data-ring]')) {
      c.style.strokeDashoffset = String(103.7 * (1 - frac));
      c.style.stroke = left < 5000 ? '#fb7185' : '#34d399';
    }
    const s = Math.ceil(left / 1000);
    if (state.turn === myId && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
  }
  if (state.turn === myId && state.stage === 'bet') $('pk-banner').textContent = T('poker.status.yourTurn', { n: Math.ceil(left / 1000) });
  const lvl = $('pk-level');
  if (state.blinds.soon) lvl.textContent = T('poker.info.nextHand', { sb: nf(state.blinds.next.sb), bb: nf(state.blinds.next.bb) });
  else if (levelLocal !== null) {
    const ms = Math.max(0, levelLocal - now);
    lvl.textContent = T('poker.info.level', { n: state.blinds.level, time: WBG.clock(ms), sb: nf(state.blinds.next.sb), bb: nf(state.blinds.next.bb) });
  } else lvl.textContent = T('poker.info.levelFixed', { n: state.blinds.level });
}

/* ---------------------------------------------------------------- animation */
function flyChip(from, to, delay = 0, color) {
  if (!from || !to || reduceMotion()) return;
  const el = document.createElement('div');
  el.className = 'pk-fly';
  el.innerHTML = chipTop(color);
  Object.assign(el.style, { left: `${from.left + from.width / 2 - 12}px`, top: `${from.top + from.height / 2 - 12}px` });
  document.body.appendChild(el);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const a = el.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.8)`, opacity: 0.95 }],
    { duration: 520, delay, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
  a.onfinish = a.oncancel = () => el.remove();
}

function potRect() { return $('pk-pot').getBoundingClientRect(); }

function seatRect(id) {
  if (id === myId && !spectator) return $('pk-me').getBoundingClientRect();
  return visible('li.pk-seat', id)?.getBoundingClientRect() || null;
}

/** Called before the DOM is replaced: chips from the bets in front of the seats fly into the pot. */
function animateBetsToPot(next) {
  if (!prev || reduceMotion()) return;
  const collect = next.handNo === prev.handNo && (next.street !== prev.street || (next.result && !prev.result));
  if (!collect) return;
  let i = 0;
  for (const p of prev.players) {
    if (p.bet > 0 && (next.players.find((x) => x.id === p.id)?.bet || 0) === 0) {
      const el = p.id === myId && !spectator ? $('pk-me') : visible('li.pk-seat', p.id)?.querySelector('.pk-bet') || visible('li.pk-seat', p.id);
      flyChip(el?.getBoundingClientRect(), potRect(), i++ * 60);
    }
  }
}

function animatePotToWinners() {
  const r = state.result;
  if (!r) return;
  let i = 0;
  for (const pot of r.pots) for (const w of pot.winners) flyChip(potRect(), seatRect(w.id), 500 + i++ * 120, '#f59e0b');
}

/* ------------------------------------------------------------------- sounds */
function sounds(first) {
  if (first || !prev) return;
  const s = state;
  if (s.handNo !== prev.handNo) { WBG.sound.play('deal'); return; }
  if (s.board.length > prev.board.length) WBG.sound.play('card');
  const raised = s.players.some((p) => p.bet > (prev.players.find((x) => x.id === p.id)?.bet || 0));
  if (raised) WBG.sound.play('coin');
  if (s.result && !prev.result) setTimeout(() => WBG.sound.play(s.result.pots.some((p) => p.winners.some((w) => w.id === myId)) ? 'win' : 'coin'), 450);
  if (s.turn === myId && prev.turn !== s.turn && s.stage === 'bet') { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
}

/* ------------------------------------------------------------------- socket */
socket.on('poker-state', (s) => {
  const first = !state;
  prev = state;
  state = s;
  deadlineLocal = performance.now() + s.timeLeft;
  lastTick = -1;
  if (prev) animateBetsToPot(s);
  render();
  sounds(first);
  if (prev && s.result && !prev.result) animatePotToWinners();
});

/* ------------------------------------------------------------------ actions */
const send = (type, amount) => socket.emit('poker-action', { action: type, amount });

$('pk-fold').addEventListener('click', () => { WBG.sound.play('click'); send('fold'); });
$('pk-call').addEventListener('click', (e) => {
  const L = state?.legal;
  if (!L) return;
  if (L.canCheck) { WBG.sound.play('click'); return send('check'); }
  if (e.currentTarget.dataset.allin) {
    if (performance.now() > confirmUntil) {
      confirmUntil = performance.now() + 3500;
      e.currentTarget.textContent = T('poker.act.confirmAllIn');
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmUntil = 0; if (state) renderActions(me()); }, 3600);
      return;
    }
    confirmUntil = 0;
  }
  WBG.sound.play('coin');
  send('call');
});

$('pk-raise-btn').addEventListener('click', () => {
  const L = state?.legal;
  if (!L) return;
  const allIn = raiseVal >= L.maxTo;
  if (allIn && performance.now() > confirmUntil) {
    confirmUntil = performance.now() + 3500;
    syncRaise(L);
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => { confirmUntil = 0; syncRaise(); }, 3600);
    return;
  }
  confirmUntil = 0;
  WBG.sound.play('coin');
  if (allIn) send('allin'); else send('raise', raiseVal);
});

function setRaise(v) {
  const L = state?.legal;
  if (!L) return;
  raiseVal = Math.min(Math.max(Math.round(Number(v) || 0), L.minTo), L.maxTo);
  confirmUntil = 0;
  syncRaise(L);
}
$('pk-raise-range').addEventListener('input', (e) => setRaise(e.target.value));
$('pk-raise-input').addEventListener('input', (e) => { const L = state?.legal; if (L) { raiseVal = Math.min(Math.max(Math.round(Number(e.target.value) || 0), 0), L.maxTo); $('pk-raise-range').value = raiseVal; } });
$('pk-raise-input').addEventListener('change', (e) => setRaise(e.target.value));
$('pk-presets').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const L = state?.legal;
  if (!b || !L) return;
  WBG.sound.play('click');
  const p = b.dataset.p;
  if (p === 'min') return setRaise(L.minTo);
  if (p === 'max') return setRaise(L.maxTo);
  const pot = state.pot + state.players.reduce((n, x) => n + x.bet, 0);
  setRaise(L.currentBet + Number(p) * (pot + L.toCall));
});
$('pk-back').addEventListener('click', () => socket.emit('poker-sitin'));
$('pk-log-btn').addEventListener('click', () => { $('pk-log-modal').hidden = false; });
$('pk-log-close').addEventListener('click', () => { $('pk-log-modal').hidden = true; });
$('pk-log-modal').addEventListener('click', (e) => { if (e.target === $('pk-log-modal')) $('pk-log-modal').hidden = true; });

WBG.gameReady('poker-page-loaded');
