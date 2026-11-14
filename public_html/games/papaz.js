import { fly, later, bubble, centerOf, clearAll, reduced } from './card-ui.js';

await WBG.i18n.load('papaz');

const $ = (id) => document.getElementById(id);
const t = WBG.t;
const spectator = WBG.isSpectator;

let S = null;
let lastSeq = -1;
let deadlineLocal = 0;
let nextLocal = 0;
let lastTick = -1;
let prevHandIds = new Set();
let fanKey = '';
let revealShown = -1;

socket.off('papaz-state');
const timer = setInterval(tick, 200);
WBG.onTeardown(() => { clearInterval(timer); clearAll(); });

WBG.setRules({
  title: t('papaz.rules.title'),
  sections: ['goal', 'start', 'play', 'leave', 'score'].map((k) => ({ title: t(`papaz.rules.${k}.title`), items: [t(`papaz.rules.${k}.text`)] }))
});

const back = (cls = 'w-full h-auto') => WBG.art.cardBack(cls);
const face = (c, cls = 'w-full h-auto') => WBG.art.card(c.r, c.s, cls);
const me = () => S?.you;
const nameOf = (id) => S?.players.find((p) => p.id === id)?.name || '';
const myTurn = () => !spectator && S && S.phase === 'play' && S.turn === me();
const playerEl = (id) => (id === me() ? $('pz-hand') : document.querySelector(`[data-pid="${id}"]`));

function render() {
  if (!S) return;
  const mine = myTurn();
  const iAmTarget = !spectator && S.target === me() && S.phase === 'play';

  // seat order starting after me
  const ids = S.players.map((p) => p.id);
  const start = Math.max(0, ids.indexOf(me()));
  const opps = [...S.players.slice(start + 1), ...S.players.slice(0, start)].filter((p) => p.id !== me());
  $('pz-players').replaceChildren(...opps.map((p) => {
    const li = document.createElement('li');
    const turn = p.id === S.turn && S.phase === 'play';
    const isTarget = p.id === S.target && S.phase === 'play';
    li.dataset.pid = p.id;
    li.className = `flex min-h-14 w-40 items-center gap-2 rounded-2xl border px-2.5 py-2 sm:w-48 ${turn ? 'border-emerald-400/70 bg-emerald-500/10' : isTarget ? 'border-brand-400/70 bg-brand-500/15' : 'border-white/10 bg-white/5'} ${p.count === 0 ? 'opacity-55' : ''}`;
    li.innerHTML = `${WBG.avatar(p.name, 'size-9 shrink-0')}
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-semibold text-white">${WBG.esc(p.name)}</p>
        <p class="text-xs text-slate-300 tabular-nums">${p.count === 0 ? `<span class="font-bold text-emerald-300">${t('papaz.safe')}</span>` : t('papaz.cards', { n: p.count })}</p>
        <p class="flex items-center gap-1.5 text-[11px] text-slate-400"><span>${t('papaz.pairs', { n: p.discards.length })}</span><span class="chip ${p.losses ? 'chip-danger' : ''} !px-1.5 !py-0">${t('papaz.lossesShort', { n: p.losses })}</span></p>
      </div>`;
    return li;
  }));

  $('pz-round').textContent = t('papaz.round', { n: S.round, total: S.rounds });

  // status
  let status;
  if (S.phase === 'over') status = t('papaz.status.over');
  else if (S.phase === 'roundOver') status = '';
  else if (!S.turn) status = t('papaz.status.dealing');
  else if (mine) status = t('papaz.status.yourTurn', { name: nameOf(S.target) });
  else if (iAmTarget) status = t('papaz.status.beingDrawn', { name: nameOf(S.turn) });
  else status = t('papaz.status.theirTurn', { name: nameOf(S.turn), target: nameOf(S.target) });
  $('pz-status').textContent = status;

  // the target's face-down fan
  const target = S.players.find((p) => p.id === S.target);
  const key = `${S.round}:${S.turn}:${S.target}:${target?.count}:${S.seq}`;
  const showFan = S.phase === 'play' && target && !iAmTarget;
  $('pz-fan').hidden = !showFan;
  if (showFan) {
    const n = target.count;
    const fresh = key !== fanKey;
    fanKey = key;
    $('pz-fan-in').replaceChildren(...Array.from({ length: n }, (_, i) => {
      const el = document.createElement(mine ? 'button' : 'div');
      if (mine) {
        el.type = 'button';
        el.setAttribute('aria-label', t('papaz.aria.pick', { n: i + 1 }));
        el.addEventListener('click', () => pick(i));
      }
      el.className = `block shrink-0 drop-shadow-md transition ${i ? '-ml-[2.1rem] sm:-ml-12' : ''} ${mine ? 'cursor-pointer hover:-translate-y-3 focus-visible:-translate-y-3 active:scale-95' : ''}`;
      el.style.width = 'var(--cw)';
      el.innerHTML = back();
      return el;
    }));
    if (fresh && mine && !reduced()) scramble();
  } else {
    $('pz-fan-in').replaceChildren();
  }
  $('pz-shuffle').hidden = !(S.canShuffle);

  // my hand (in the real fan order: that is what the next player draws from)
  $('pz-hand-label').textContent = spectator ? t('papaz.hostView') : t('papaz.yourHand', { n: S.hand.length });
  const meP = S.players.find((p) => p.id === me());
  $('pz-mypairs').textContent = meP ? t('papaz.pairs', { n: meP.discards.length }) : '';
  $('pz-hand').replaceChildren(...(spectator ? [] : S.hand.map((c, i) => {
    const el = document.createElement('span');
    const fresh = prevHandIds.size && !prevHandIds.has(c.id);
    el.className = `${fresh ? 'pz-new' : ''} block shrink-0 drop-shadow-md ${i ? '-ml-[1.7rem] sm:-ml-9' : ''}`;
    el.style.width = 'var(--cw)';
    el.innerHTML = face(c);
    return el;
  })));
  if (!spectator && S.hand.length === 0 && S.phase === 'play') {
    $('pz-hand').innerHTML = `<p class="rounded-xl bg-emerald-500/15 px-4 py-3 text-sm font-semibold text-emerald-300">${t('papaz.escaped')}</p>`;
  }
  prevHandIds = new Set(S.hand.map((c) => c.id));

  // log
  $('pz-log').replaceChildren(...S.log.slice(-3).map((l, i, arr) => {
    const li = document.createElement('li');
    li.className = i === arr.length - 1 ? 'font-semibold text-white' : 'opacity-60';
    li.textContent = WBG.tr(l);
    return li;
  }));

  renderReveal();
  tick();
}

/** Visual shuffle of the target's fan so positions cannot be memorised. */
function scramble() {
  const kids = [...$('pz-fan-in').children];
  kids.forEach((k, i) => {
    const dx = (Math.random() - 0.5) * 120;
    const dy = -10 - Math.random() * 26;
    k.animate(
      [{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px) rotate(${(Math.random() - 0.5) * 30}deg)` }, { transform: 'translate(0,0)' }],
      { duration: 520, delay: i * 18, easing: 'ease-in-out' }
    );
  });
  WBG.sound.play('deal');
}

function pick(i) {
  if (!myTurn()) return;
  WBG.haptic(15);
  WBG.sound.play('card');
  socket.emit('papaz-draw', { index: i });
}

function renderReveal() {
  const show = S.phase === 'roundOver' && S.result;
  $('pz-reveal').hidden = !show;
  if (!show) { revealShown = -1; return; }
  const r = S.result;
  const loserIsMe = r.loser === me();
  $('pz-reveal-card').innerHTML = WBG.art.card('K', 's', 'w-full h-auto');
  $('pz-reveal-title').textContent = !r.loser ? t('papaz.reveal.none') : loserIsMe ? t('papaz.reveal.you') : t('papaz.reveal.stuck', { name: nameOf(r.loser) });
  $('pz-reveal-rows').replaceChildren(...[...S.players].sort((a, b) => a.losses - b.losses).map((p) => {
    const li = document.createElement('li');
    li.className = `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm ${p.id === r.loser ? 'bg-rose-500/15' : 'bg-white/5'}`;
    li.innerHTML = `${WBG.avatar(p.name, 'size-7 text-xs')}<span class="min-w-0 flex-1 truncate font-medium text-white">${WBG.esc(p.name)}</span><span class="font-bold text-slate-200 tabular-nums">${t('papaz.lossesShort', { n: p.losses })}</span>`;
    return li;
  }));
  nextLocal = performance.now() + S.nextIn;
  if (revealShown !== S.round) {
    revealShown = S.round;
    WBG.sound.play(loserIsMe ? 'lose' : 'win');
    if (loserIsMe) WBG.haptic([60, 40, 90]);
  }
}

function tick() {
  if (!S) return;
  const now = performance.now();
  if (S.phase === 'play' && deadlineLocal && S.turn) {
    const left = Math.max(0, deadlineLocal - now);
    $('pz-bar').style.width = `${Math.min(100, (left / S.turnMs) * 100)}%`;
    const s = Math.ceil(left / 1000);
    $('pz-timer').textContent = t('papaz.seconds', { n: s });
    if (myTurn() && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
  } else {
    $('pz-bar').style.width = '0%';
    $('pz-timer').textContent = '';
  }
  if (S.phase === 'roundOver') {
    const last = S.round >= S.rounds;
    $('pz-reveal-next').textContent = last ? t('papaz.reveal.final') : t('papaz.reveal.next', { n: Math.max(0, Math.ceil((nextLocal - now) / 1000)) });
  }
}

function animate(events) {
  let at = 0;
  for (const e of events) {
    const d = at;
    if (e.t === 'draw') {
      later(() => {
        const from = centerOf(playerEl(e.from));
        const to = centerOf(playerEl(e.to));
        const known = e.card && (e.to === me() || e.from === me());
        fly({ html: known ? face(e.card) : back(), from, to, onEnd: () => WBG.sound.play('card') });
        if (e.pair) {
          later(() => {
            bubble(playerEl(e.to), t('papaz.bubble.pair', { rank: e.pair[0].r }), { tone: 'good' });
            WBG.sound.play('pop');
          }, 480);
        } else if (e.card && e.to === me() && e.card.r === 'K') {
          later(() => { bubble($('pz-hand'), t('papaz.bubble.gotPapaz'), { tone: 'bad', ms: 2200 }); WBG.sound.play('error'); WBG.haptic([40, 40, 80]); }, 480);
        }
      }, d);
      at += 800;
    } else if (e.t === 'shuffle') {
      later(() => { bubble(playerEl(e.who), t('papaz.bubble.shuffle')); WBG.sound.play('deal'); }, d);
      at += 400;
    } else if (e.t === 'safe') {
      later(() => {
        bubble(playerEl(e.who), t('papaz.bubble.safe'), { tone: 'good' });
        if (e.who === me()) { WBG.sound.play('win'); WBG.haptic([30, 30, 60]); }
      }, d + 500);
    } else if (e.t === 'turn' && e.who === me()) {
      later(() => { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }, d);
    } else if (e.t === 'deal') {
      later(() => WBG.sound.play('deal'), d);
    }
  }
}

socket.on('papaz-state', (s) => {
  const first = !S;
  S = s;
  deadlineLocal = performance.now() + s.timeLeft;
  const fresh = first ? [] : s.events.filter((e) => e.seq > lastSeq);
  lastSeq = Math.max(lastSeq, s.seq);
  if (!first && S.round && fresh.some((e) => e.t === 'deal')) prevHandIds = new Set();
  render();
  if (first) { WBG.sound.play('deal'); return; }
  animate(fresh);
});

$('pz-shuffle').addEventListener('click', () => { WBG.haptic(12); WBG.sound.play('deal'); socket.emit('papaz-shuffle'); });

WBG.gameReady('papaz-page-loaded');
