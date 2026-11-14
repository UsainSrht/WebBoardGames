import { fly, later, bubble, centerOf, clearAll } from './card-ui.js';

await WBG.i18n.load('gofish');

const $ = (id) => document.getElementById(id);
const t = WBG.t;
const spectator = WBG.isSpectator;
const rankLabel = (r, n = 2) => t(`gofish.rank.${r}`, { n });

let S = null;
let lastSeq = -1;
let selTarget = null;
let selRank = null;
let deadlineLocal = 0;
let lastTick = -1;
let prevHandIds = new Set();

socket.off('gofish-state');
const timer = setInterval(tick, 200);
WBG.onTeardown(() => { clearInterval(timer); clearAll(); });

WBG.setRules({
  title: t('gofish.rules.title'),
  sections: ['goal', 'turn', 'books', 'empty', 'timer'].map((k) => ({ title: t(`gofish.rules.${k}.title`), items: [t(`gofish.rules.${k}.text`)] }))
});

const back = (cls = 'w-full h-auto') => WBG.art.cardBack(cls);
const face = (c, cls = 'w-full h-auto') => WBG.art.card(c.r, c.s, cls);
const me = () => S?.you;
const myTurn = () => !spectator && S && S.phase === 'play' && S.turn === me();
const playerEl = (id) => (id === me() ? $('gf-hand') : document.querySelector(`[data-pid="${id}"]`));
const nameOf = (id) => S?.players.find((p) => p.id === id)?.name || '';

function bookBadge(r, fresh) {
  return `<span class="${fresh ? 'gf-pulse' : ''} inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-amber-400/90 px-1 text-[11px] font-extrabold text-ink-900" title="${WBG.esc(rankLabel(r, 2))}">${r}</span>`;
}

function render() {
  if (!S) return;
  const mine = myTurn();
  if (!mine || !S.players.some((p) => p.id === selTarget && p.count > 0)) selTarget = null;
  if (!mine || !S.hand.some((c) => c.r === selRank)) selRank = null;

  // opponents
  const opps = S.players.filter((p) => p.id !== me());
  $('gf-players').replaceChildren(...opps.map((p) => {
    const li = document.createElement('li');
    const turn = p.id === S.turn && S.phase === 'play';
    const pickable = mine && p.count > 0;
    const sel = selTarget === p.id;
    const el = document.createElement(pickable ? 'button' : 'div');
    el.dataset.pid = p.id;
    if (pickable) {
      el.type = 'button';
      el.setAttribute('aria-pressed', String(sel));
      el.setAttribute('aria-label', t('gofish.aria.player', { name: p.name }));
      el.addEventListener('click', () => { selTarget = sel ? null : p.id; WBG.haptic(10); WBG.sound.play('click'); render(); });
    }
    el.className = `flex min-h-14 w-40 items-center gap-2 rounded-2xl border px-2.5 py-2 text-left transition sm:w-48 ${sel ? 'border-brand-400 bg-brand-500/25 ring-2 ring-brand-400' : turn ? 'border-emerald-400/70 bg-emerald-500/10' : 'border-white/10 bg-white/5'} ${pickable ? 'cursor-pointer hover:bg-white/10 active:scale-95' : ''} ${mine && p.count === 0 ? 'opacity-50' : ''}`;
    const minis = Math.min(p.count, 6);
    el.innerHTML = `${WBG.avatar(p.name, 'size-9 shrink-0')}
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-white">${WBG.esc(p.name)}</p>
        <div class="flex items-center gap-1.5">
          <span class="flex pl-1">${Array.from({ length: minis }, () => '<span class="-ml-1 inline-block h-4 w-3 rounded-[3px] border border-white/70 bg-brand-700"></span>').join('')}</span>
          <span class="text-xs font-bold text-slate-300 tabular-nums">${t('gofish.cards', { n: p.count })}</span>
        </div>
        <div class="mt-0.5 flex min-h-6 flex-wrap gap-1">${p.books.map((r) => bookBadge(r, false)).join('')}</div>
      </div>`;
    li.appendChild(el);
    return li;
  }));

  // pond
  $('gf-pond-top').innerHTML = S.stock > 0 ? back() : '<div class="aspect-[64/90] w-full rounded-lg border-2 border-dashed border-white/25"></div>';
  $('gf-pond-under').innerHTML = S.stock > 1 ? back() : '';
  $('gf-pond-count').textContent = S.stock;
  $('gf-pond').setAttribute('aria-label', t('gofish.aria.pond', { n: S.stock }));

  // status
  let status;
  if (S.phase === 'over') status = t('gofish.status.over');
  else if (!S.turn) status = t('gofish.status.dealing');
  else if (spectator) status = t('gofish.status.watching', { name: nameOf(S.turn) });
  else if (mine) status = !selTarget ? t('gofish.status.pickPlayer') : !selRank ? t('gofish.status.pickRank') : t('gofish.status.ready');
  else status = t('gofish.status.theirTurn', { name: nameOf(S.turn) });
  $('gf-status').textContent = status;

  // log
  $('gf-log').replaceChildren(...S.log.slice(-4).map((l, i, arr) => {
    const li = document.createElement('li');
    li.className = i === arr.length - 1 ? 'font-semibold text-white' : 'opacity-60';
    li.textContent = WBG.tr(l);
    return li;
  }));

  // my area
  const meP = S.players.find((p) => p.id === me());
  $('gf-hand-label').textContent = spectator ? t('gofish.hostView') : t('gofish.yourHand', { n: S.hand.length });
  $('gf-mybooks').replaceChildren(...(meP ? meP.books.map((r) => {
    const s = document.createElement('span');
    s.innerHTML = bookBadge(r, false);
    return s.firstChild;
  }) : []));
  const groups = [];
  for (const c of S.hand) {
    const g = groups.find((x) => x.r === c.r);
    if (g) g.cards.push(c); else groups.push({ r: c.r, cards: [c] });
  }
  $('gf-hand').replaceChildren(...(spectator ? [] : groups.map((g) => {
    const sel = selRank === g.r;
    const el = document.createElement(mine ? 'button' : 'div');
    if (mine) {
      el.type = 'button';
      el.setAttribute('aria-pressed', String(sel));
      el.addEventListener('click', () => { selRank = sel ? null : g.r; WBG.haptic(10); WBG.sound.play('card'); render(); });
    }
    el.setAttribute('aria-label', t('gofish.aria.rank', { rank: rankLabel(g.r, g.cards.length), n: g.cards.length }));
    el.className = `relative flex shrink-0 rounded-xl p-1 transition ${sel ? '-translate-y-3 bg-brand-500/25 ring-2 ring-brand-400' : mine ? 'hover:-translate-y-1' : ''} ${mine ? 'cursor-pointer active:scale-95' : ''}`;
    el.innerHTML = g.cards.map((c, i) => `<span class="${prevHandIds.size && !prevHandIds.has(c.id) ? 'gf-new' : ''} block shrink-0 drop-shadow-md ${i ? '-ml-[1.9rem] sm:-ml-10' : ''}" style="width:var(--cw)">${face(c)}</span>`).join('');
    return el;
  })));
  prevHandIds = new Set(S.hand.map((c) => c.id));

  // ask button
  const ask = $('gf-ask');
  ask.hidden = spectator || S.phase !== 'play';
  ask.disabled = !(mine && selTarget && selRank);
  ask.textContent = selTarget && selRank ? t('gofish.askFor', { name: nameOf(selTarget), rank: rankLabel(selRank, 2) }) : t('gofish.ask');
  tick();
}

function tick() {
  if (!S) return;
  if (S.phase === 'play' && deadlineLocal && S.turn) {
    const left = Math.max(0, deadlineLocal - performance.now());
    $('gf-bar').style.width = `${Math.min(100, (left / S.turnMs) * 100)}%`;
    const s = Math.ceil(left / 1000);
    $('gf-timer').textContent = t('gofish.seconds', { n: s });
    if (myTurn() && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
  } else {
    $('gf-bar').style.width = '0%';
    $('gf-timer').textContent = '';
  }
}

/** Play the animations for events newer than the last snapshot. */
function animate(events) {
  let at = 0;
  const step = 520;
  for (const e of events) {
    const d = at;
    if (e.t === 'ask') {
      later(() => { bubble(playerEl(e.target), t('gofish.bubble.ask', { rank: rankLabel(e.rank, 2) })); WBG.sound.play('click'); }, d);
      at += 700;
    } else if (e.t === 'give') {
      later(() => {
        const from = centerOf(playerEl(e.from));
        const to = centerOf(playerEl(e.to));
        for (let i = 0; i < e.n; i++) {
          fly({ html: face({ r: e.rank, s: ['s', 'h', 'd', 'c'][i % 4] }), from, to, delay: i * 90, spin: (i - 1) * 8, onEnd: () => WBG.sound.play('card') });
        }
        if (e.to === me()) WBG.haptic(25);
      }, d);
      at += step + e.n * 90;
    } else if (e.t === 'gofish') {
      later(() => { bubble(playerEl(e.who), t('gofish.bubble.goFish'), { tone: 'warn' }); WBG.sound.play('pop'); }, d);
      at += 650;
    } else if (e.t === 'fish') {
      later(() => {
        const html = e.lucky && e.card ? face(e.card) : back();
        fly({ html, from: centerOf($('gf-pond')), to: centerOf(playerEl(e.who)), onEnd: () => WBG.sound.play('card') });
        if (e.lucky) later(() => bubble(playerEl(e.who), t('gofish.bubble.lucky'), { tone: 'good' }), 450);
      }, d);
      at += e.lucky ? 1000 : step;
    } else if (e.t === 'refill') {
      later(() => {
        for (let i = 0; i < Math.min(e.n, 5); i++) fly({ html: back(), from: centerOf($('gf-pond')), to: centerOf(playerEl(e.who)), delay: i * 80 });
        WBG.sound.play('deal');
      }, d);
      at += step;
    } else if (e.t === 'book') {
      later(() => {
        bubble(playerEl(e.who), t('gofish.bubble.book', { rank: rankLabel(e.rank, 2) }), { tone: 'good', ms: 2000 });
        WBG.sound.play('coin');
        WBG.haptic([20, 30, 40]);
      }, d);
      at += 600;
    } else if (e.t === 'turn' && e.who === me()) {
      later(() => { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }, d);
    }
  }
}

socket.on('gofish-state', (s) => {
  const first = !S;
  S = s;
  deadlineLocal = performance.now() + s.timeLeft;
  const fresh = first ? [] : s.events.filter((e) => e.seq > lastSeq);
  lastSeq = Math.max(lastSeq, s.seq);
  render();
  if (first) { WBG.sound.play('deal'); return; }
  animate(fresh);
});

$('gf-ask').addEventListener('click', () => {
  if (!myTurn() || !selTarget || !selRank) return;
  WBG.haptic(15);
  socket.emit('gofish-ask', { target: selTarget, rank: selRank });
  selTarget = null;
  selRank = null;
});

WBG.gameReady('gofish-page-loaded');
