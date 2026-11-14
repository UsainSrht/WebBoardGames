await WBG.i18n.load('pisti');

(() => {
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => WBG.t(k, p);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const reduce = () => !!WBG.prefs?.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  let state = null;
  let pileView = null;       // { top, size } shown while a play is being animated
  let animating = false;
  let deadlineLocal = 0;
  let nextDealLocal = 0;
  let lastSeq = -1;
  let flyFrom = null;        // rect of the card the player just tapped
  let sent = false;
  let lastTick = -1;
  let alive = true;
  const queue = [];
  let pumping = false;

  socket.off('pisti-state');
  const timer = setInterval(tick, 150);
  WBG.onTeardown(() => { alive = false; clearInterval(timer); document.querySelectorAll('.pi-fly').forEach((e) => e.remove()); });

  WBG.setRules({
    title: t('pisti.rules.title'),
    sections: ['goal', 'play', 'pisti', 'score', 'teams', 'timer'].map((s) => ({
      title: t(`pisti.rules.${s}.title`),
      items: [1, 2, 3].map((n) => `pisti.rules.${s}.${n}`).filter((k) => WBG.t(k) !== k).map((k) => t(k))
    }))
  });

  /* --------------------------------------------------------------- helpers */
  const rankName = (r) => (['A', 'J', 'Q', 'K'].includes(r) ? t(`pisti.rank.${r}`) : r);
  const cardName = (c) => t('pisti.cardname', { rank: rankName(c.rank), suit: t(`pisti.suit.${c.suit}`) });
  const face = (c, cls = 'block w-full h-auto') => WBG.art.card(c.rank, c.suit, cls);
  const back = (cls = 'block w-full h-auto') => WBG.art.cardBack(cls);
  const player = (id) => state?.players.find((p) => p.id === id);
  const pname = (id) => player(id)?.name || '';
  const tilt = (id) => ((((id * 37) % 11) - 5) * 1.4);
  const me = () => (spectator ? null : player(myId));
  const upper = (s) => s.toLocaleUpperCase(WBG.locale);

  function unitLabel(u) {
    if (state.teams && me()) return u.members.includes(myId) ? t('pisti.ui.yourTeam') : t('pisti.ui.otherTeam');
    return u.members.map((m) => pname(m)).join(' & ');
  }

  /* --------------------------------------------------------------- render */
  function render() {
    if (!state) return;
    const s = state;
    const mine = me();
    const myTurn = !!mine && s.turn === myId && s.phase === 'play';

    // header
    $('pi-deal').textContent = `${t('pisti.ui.dealLabel', { n: s.deal })} - ${s.target ? t('pisti.ui.toTarget', { n: s.target }) : t('pisti.ui.oneDeal')}`;
    $('pi-scores').replaceChildren(...s.units.map((u) => {
      const li = document.createElement('li');
      const mineUnit = !!mine && u.members.includes(myId);
      li.className = `rounded-xl border px-2.5 py-1 text-xs ${mineUnit ? 'border-brand-400/60 bg-brand-500/15' : 'border-white/10 bg-white/5'}`;
      const pct = s.target ? Math.min(100, (u.score / s.target) * 100) : 0;
      li.innerHTML = `<div class="flex items-center gap-2"><span class="max-w-32 truncate font-medium text-slate-200">${WBG.esc(unitLabel(u))}</span><span class="font-bold text-white tabular-nums">${u.score}</span></div>
        ${s.target ? `<div class="mt-1 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin="0" aria-valuemax="${s.target}" aria-valuenow="${u.score}"><div class="h-full rounded-full bg-amber-400" style="width:${pct}%"></div></div>` : ''}`;
      return li;
    }));

    renderOpponents(myTurn);
    renderPile();
    renderDeck();
    renderMe(myTurn);
    renderHand(myTurn);
    renderEvent();
    renderSummary();
    tick();
  }

  function renderOpponents(myTurn) {
    const prev = renderOpponents.prev || {};
    const next = {};
    const others = state.players.filter((p) => p.id !== myId || spectator);
    $('pi-opps').replaceChildren(...others.map((p) => {
      const li = document.createElement('li');
      li.dataset.pid = p.id;
      const unit = state.units.find((u) => u.id === p.unit);
      const turn = p.id === state.turn && state.phase === 'play';
      const partner = state.teams && !spectator && unit.members.includes(myId);
      const fresh = prev[p.id] !== undefined && p.count > prev[p.id];
      next[p.id] = p.count;
      const minis = Math.min(p.count, 4);
      li.className = `flex min-w-0 flex-col gap-1 rounded-2xl border px-2.5 py-1.5 transition ${turn ? 'pi-turn bg-emerald-500/12 border-emerald-400/60' : partner ? 'border-brand-400/50 bg-brand-500/10' : 'border-white/10 bg-white/5'}`;
      li.style.width = others.length > 2 ? 'calc((100% - 1rem) / 3)' : '11rem';
      li.style.maxWidth = '11rem';
      li.innerHTML = `<div class="flex items-center gap-1.5">${WBG.avatar(p.name, 'size-6 text-[10px]')}
          <span class="min-w-0 flex-1 truncate text-xs font-semibold text-white">${WBG.esc(p.name)}</span></div>
        <div class="flex items-center gap-1.5">
          <span class="flex ${fresh ? 'pi-pop' : ''}" style="width:${minis ? 1.1 + minis * 0.55 : 0}rem">${Array.from({ length: minis }, (_, i) => `<span class="-mr-3 inline-block w-[1.1rem] shrink-0" style="transform:rotate(${(i - (minis - 1) / 2) * 7}deg)">${back('block w-full h-auto')}</span>`).join('')}</span>
          <span class="ml-auto text-[11px] font-bold tabular-nums text-slate-300" title="${WBG.esc(t('pisti.ui.captured'))}">${WBG.esc(t('pisti.ui.captured'))}: ${unit.captured}</span>
        </div>
        <div class="flex min-h-4 flex-wrap items-center gap-1">
          ${partner ? `<span class="chip">${WBG.esc(t('pisti.ui.partner'))}</span>` : ''}
          ${p.left ? `<span class="chip chip-danger">${WBG.esc(t('pisti.ui.left'))}</span>` : ''}
          ${p.pisti ? `<span class="chip">${WBG.esc(t('pisti.ui.pistis', { n: p.pisti }))}</span>` : ''}
        </div>`;
      return li;
    }));
    renderOpponents.prev = next;
  }

  function renderPile() {
    const top = pileView ? pileView.top : state.top;
    const size = pileView ? pileView.size : state.pileSize;
    const box = $('pi-pile');
    box.setAttribute('aria-label', size ? t(size === 1 ? 'pisti.ui.pileCount_one' : 'pisti.ui.pileCount_other', { n: size }) : t('pisti.ui.pileEmpty'));
    if (!size || !top) {
      box.innerHTML = `<div class="absolute inset-0 rounded-xl border-2 border-dashed border-white/25"></div>`;
      return;
    }
    const layers = [];
    const hidden = Math.min(size - 1, 3);
    const offsets = [[-5, -7], [4, 5], [-2, 2]];
    for (let i = 0; i < hidden; i++) {
      const [x, r] = offsets[i];
      layers.push(`<div class="absolute inset-0" style="transform:translate(${x}px,${-i * 2}px) rotate(${r}deg);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">${back()}</div>`);
    }
    layers.push(`<div id="pi-top" class="absolute inset-0" style="transform:rotate(${tilt(top.id)}deg);filter:drop-shadow(0 4px 6px rgba(0,0,0,.4))">${face(top)}</div>`);
    layers.push(`<span class="absolute -right-2 -bottom-2 grid min-w-6 place-items-center rounded-full border-2 border-white bg-ink-900 px-1.5 text-xs font-extrabold text-white shadow-lg tabular-nums">${size}</span>`);
    box.innerHTML = layers.join('');
  }

  function renderDeck() {
    const n = state.deckCount;
    const box = $('pi-deck');
    box.setAttribute('aria-label', t('pisti.ui.deckLeft', { n }));
    box.innerHTML = n
      ? Array.from({ length: Math.min(3, Math.ceil(n / 16)) }, (_, i) => `<div class="absolute inset-0" style="transform:translate(${i * 1.5}px,${-i * 1.5}px)">${back()}</div>`).join('')
      : `<div class="absolute inset-0 rounded-lg border-2 border-dashed border-white/20"></div>`;
    $('pi-deck-count').textContent = `${t('pisti.ui.deck')} ${n}`;
  }

  function renderMe(myTurn) {
    const mine = me();
    $('pi-me').hidden = !mine;
    if (!mine) return;
    const unit = state.units.find((u) => u.id === mine.unit);
    $('pi-me-avatar').innerHTML = WBG.avatar(mine.name, 'size-9');
    $('pi-me-name').textContent = `${mine.name} ${t('pisti.ui.you')}`;
    const status = state.phase !== 'play' ? '' : myTurn ? t('pisti.ui.yourTurn') : t('pisti.ui.waitingFor', { name: pname(state.turn) });
    $('pi-status').textContent = status;
    $('pi-status').className = `truncate text-xs ${myTurn ? 'font-bold text-emerald-300' : 'text-slate-300'}`;
    $('pi-me-chips').innerHTML = `<span class="chip">${WBG.esc(t('pisti.ui.captured'))}: ${unit.captured}</span>${mine.pisti ? `<span class="chip">${WBG.esc(t('pisti.ui.pistis', { n: mine.pisti }))}</span>` : ''}`;
  }

  function renderHand(myTurn) {
    const label = $('pi-hand-label');
    if (spectator) { label.textContent = t('pisti.ui.hostView'); $('pi-hand').replaceChildren(); return; }
    label.textContent = t('pisti.ui.handLabel');
    const prevIds = renderHand.ids || new Set();
    const hand = [...state.hand].sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) || a.suit.localeCompare(b.suit));
    const n = hand.length;
    const fresh = hand.filter((c) => renderHand.ids && !prevIds.has(c.id));
    $('pi-hand').replaceChildren(...hand.map((c, i) => {
      const el = document.createElement('button');
      const mid = (n - 1) / 2;
      const isNew = fresh.includes(c);
      el.type = 'button';
      el.className = `pi-card ${myTurn && !sent ? 'is-live' : 'is-dim'} ${isNew ? 'pi-deal' : ''}`;
      if (isNew) el.style.animationDelay = `${fresh.indexOf(c) * 80}ms`;
      el.style.setProperty('--r', `${(i - mid) * 4}deg`);
      el.style.setProperty('--y', `${Math.abs(i - mid) * 3}px`);
      el.innerHTML = face(c);
      el.setAttribute('aria-label', t('pisti.ui.playCard', { card: cardName(c) }));
      el.disabled = !(myTurn && !sent);
      el.addEventListener('click', () => {
        if (!state || state.turn !== myId || state.phase !== 'play' || sent) return;
        sent = true;
        flyFrom = el.getBoundingClientRect();
        WBG.haptic(12);
        socket.emit('pisti-play', { cardId: c.id });
        for (const b of $('pi-hand').children) { b.disabled = true; b.classList.remove('is-live'); }
      });
      return el;
    }));
    renderHand.ids = new Set(state.hand.map((c) => c.id));
  }

  function eventText(s) {
    const lp = s.lastPlay;
    if (!lp) return s.phase === 'play' ? t('pisti.ev.start', { name: pname(s.turn) }) : '';
    const name = pname(lp.by);
    if (!lp.capture) return t('pisti.ev.played', { name, card: cardName(lp.card) });
    if (lp.pisti === 2) return t('pisti.ev.double', { name });
    if (lp.pisti === 1) return t('pisti.ev.pisti', { name });
    if (lp.card.rank === 'J') return t('pisti.ev.jack', { name });
    return t('pisti.ev.captured', { name, n: lp.size });
  }

  function renderEvent() {
    if (!animating) $('pi-event').textContent = eventText(state);
  }

  function renderSummary() {
    const s = state;
    const show = !animating && (s.phase === 'dealOver' || s.phase === 'over') && !!s.dealResult;
    $('pi-summary').hidden = !show;
    if (!show) return;
    const r = s.dealResult;
    $('pi-sum-eyebrow').textContent = s.phase === 'over' ? t('pisti.sum.final') : t('pisti.sum.title', { n: r.deal });
    const rows = [...r.units].sort((a, b) => b.total - a.total);
    $('pi-sum-rows').replaceChildren(...rows.map((row) => {
      const u = s.units.find((x) => x.id === row.id);
      const mineUnit = !spectator && u.members.includes(myId);
      const lines = [];
      const add = (label, pts) => lines.push(`<div class="flex justify-between gap-3"><span class="text-slate-300">${WBG.esc(label)}</span><span class="font-semibold text-white tabular-nums">+${pts}</span></div>`);
      if (row.club2) add(cardName({ rank: '2', suit: 'c' }), row.club2);
      if (row.diamond10) add(cardName({ rank: '10', suit: 'd' }), row.diamond10);
      if (row.aces) add(t('pisti.sum.aces', { n: row.aces }), row.aces);
      if (row.jacks) add(t('pisti.sum.jacks', { n: row.jacks }), row.jacks);
      if (row.most) add(t('pisti.sum.most', { n: row.cards }), row.most);
      if (row.pisti) add(t('pisti.sum.pisti', { n: row.pisti }), row.pisti * 10);
      if (row.double) add(t('pisti.sum.double', { n: row.double }), row.double * 20);
      if (!lines.length) lines.push(`<p class="text-slate-400">${WBG.esc(t('pisti.sum.nothing'))}</p>`);
      const li = document.createElement('li');
      li.className = `rounded-xl border px-3 py-2 text-sm ${mineUnit ? 'border-brand-400/50 bg-brand-500/10' : 'border-white/10 bg-white/5'}`;
      li.innerHTML = `<div class="mb-1.5 flex items-center justify-between gap-3"><span class="min-w-0 truncate font-semibold text-white">${WBG.esc(unitLabel(u))}</span><span class="text-xs text-slate-400">${WBG.esc(t('pisti.sum.cards', { n: row.cards }))}</span></div>
        <div class="space-y-0.5 text-[13px]">${lines.join('')}</div>
        <div class="mt-1.5 flex justify-between border-t border-white/10 pt-1.5 font-bold"><span class="text-slate-200">${WBG.esc(t('pisti.sum.total'))}</span><span class="text-amber-300 tabular-nums">+${row.total}</span></div>
        <div class="flex justify-between text-xs text-slate-400"><span>${WBG.esc(t('pisti.sum.match'))}</span><span class="tabular-nums">${s.target ? WBG.esc(t('pisti.sum.progress', { score: u.score, target: s.target })) : u.score}</span></div>`;
      return li;
    }));
    $('pi-sum-sweep').textContent = r.sweep ? t('pisti.sum.sweep', { name: pname(r.sweep.by), n: r.sweep.n }) : '';
    nextDealLocal = s.phase === 'dealOver' ? performance.now() + s.nextDealIn : 0;
  }

  /* ------------------------------------------------------- timers + sound */
  function tick() {
    if (!state) return;
    const now = performance.now();
    const bar = $('pi-bar');
    const holder = player(state.turn);
    if (state.phase === 'play' && deadlineLocal && !holder?.left) {
      const left = Math.max(0, deadlineLocal - now);
      bar.style.width = `${Math.min(100, (left / state.turnMs) * 100)}%`;
      const secs = Math.ceil(left / 1000);
      $('pi-timer').textContent = t('pisti.ui.seconds', { n: secs });
      if (state.turn === myId && !spectator && secs <= 5 && secs > 0 && secs !== lastTick) { lastTick = secs; WBG.sound.play('tick'); }
    } else {
      bar.style.width = '0%';
      $('pi-timer').textContent = holder?.left && state.phase === 'play' ? t('pisti.ui.auto') : '';
    }
    if (state.phase === 'dealOver' && nextDealLocal) {
      const secs = Math.max(0, Math.ceil((nextDealLocal - now) / 1000));
      $('pi-sum-next').textContent = t('pisti.sum.next', { n: secs });
    } else $('pi-sum-next').textContent = '';
  }

  /* ------------------------------------------------------------ animations */
  function rectOf(id) {
    if (id === myId && !spectator) return flyFrom || $('pi-hand').getBoundingClientRect();
    const chip = document.querySelector(`[data-pid="${id}"]`);
    return chip ? chip.getBoundingClientRect() : $('pi-pile').getBoundingClientRect();
  }

  function fly(html, from, to, { duration = 320, scaleFrom = 1, scaleTo = 1, opacityTo = 1, rotateFrom = -8, rotateTo = 0 } = {}) {
    const el = document.createElement('div');
    el.className = 'pi-fly';
    el.innerHTML = html;
    Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    document.body.appendChild(el);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const a = el.animate(
      [{ transform: `translate(${dx}px,${dy}px) scale(${scaleFrom}) rotate(${rotateFrom}deg)`, opacity: 1 }, { transform: `translate(0,0) scale(${scaleTo}) rotate(${rotateTo}deg)`, opacity: opacityTo }],
      { duration, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }
    );
    return new Promise((res) => { a.onfinish = a.oncancel = () => { el.remove(); res(); }; });
  }

  function banner(double) {
    const el = document.createElement('div');
    el.className = 'pi-banner rounded-2xl border-4 border-white bg-gradient-to-br from-amber-400 to-rose-500 px-6 py-3 text-center text-3xl font-black tracking-wide text-white shadow-2xl sm:text-5xl';
    el.textContent = upper(t(double ? 'pisti.ui.double' : 'pisti.ui.pisti'));
    $('pi-banner-wrap').replaceChildren(el);
    setTimeout(() => { if (el.isConnected) el.remove(); }, 1600);
  }

  async function sweepTo(goal, pileRect, html) {
    const el = document.createElement('div');
    el.className = 'pi-fly';
    el.style.cssText += `;left:${pileRect.left}px;top:${pileRect.top}px;width:${pileRect.width}px;height:${pileRect.height}px`;
    el.innerHTML = `<div style="position:relative;width:100%;height:100%">${html}</div>`;
    document.body.appendChild(el);
    const dx = goal.left + goal.width / 2 - (pileRect.left + pileRect.width / 2);
    const dy = goal.top + goal.height / 2 - (pileRect.top + pileRect.height / 2);
    const a = el.animate(
      [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(.3)`, opacity: 0.1 }],
      { duration: 520, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' }
    );
    await new Promise((res) => { a.onfinish = a.oncancel = res; });
    el.remove();
  }

  /* ---------------------------------------------------------------- socket */
  async function apply(s, fast) {
    const first = !state;
    const prev = state;
    if (first) lastSeq = s.lastPlay?.seq ?? -1;
    const play = !!s.lastPlay && s.lastPlay.seq !== lastSeq && !first;
    state = s;
    deadlineLocal = performance.now() + s.timeLeft;
    sent = false;
    const animate = play && !fast && !!prev;
    animating = animate;
    pileView = animate ? { top: prev.top, size: prev.pileSize } : null;
    render();

    if (animate) {
      try { await animatePlay(prev, s); } catch (e) { console.warn(e); }
      animating = false;
      pileView = null;
      renderPile();
      renderEvent();
      renderSummary();
    } else if (play && prev) {
      WBG.sound.play(s.lastPlay.capture ? 'coin' : 'card');
    }
    if (play) lastSeq = s.lastPlay.seq;
    flyFrom = null;

    if (first) { WBG.sound.play('deal'); return; }
    if (prev.deal !== s.deal || prev.handNo !== s.handNo) WBG.sound.play('deal');
    if (!spectator && s.turn === myId && (prev.turn !== s.turn || prev.deal !== s.deal) && s.phase === 'play') { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
    if (s.phase !== prev.phase && (s.phase === 'dealOver' || s.phase === 'over')) WBG.sound.play('coin');
  }

  async function animatePlay(prev, s) {
    const lp = s.lastPlay;
    const prevSize = prev.pileSize;
    $('pi-event').textContent = eventText(s);
    const pileRect = $('pi-pile').getBoundingClientRect();
    if (!reduce()) {
      const from = rectOf(lp.by);
      await fly(face(lp.card), from, pileRect, { scaleFrom: lp.by === myId && !spectator ? Math.min(1.2, from.width / pileRect.width) : 0.45, rotateFrom: -10 });
    }
    if (!alive) return;
    WBG.sound.play('card');
    pileView = { top: lp.card, size: prevSize + 1 };
    renderPile();
    if (!lp.capture) return;
    await sleep(reduce() ? 150 : 380);
    if (!alive) return;
    WBG.sound.play(lp.pisti ? 'reveal' : 'coin');
    if (lp.pisti) { banner(lp.pisti === 2); WBG.haptic([40, 30, 60]); await sleep(reduce() ? 400 : 900); }
    if (!alive) return;
    const mineSweep = lp.by === myId && !spectator;
    const goalEl = mineSweep ? $('pi-me') : document.querySelector(`[data-pid="${lp.by}"]`);
    const html = $('pi-pile').innerHTML;
    pileView = null;
    renderPile();
    if (!reduce() && goalEl) await sweepTo(goalEl.getBoundingClientRect(), pileRect, html);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && alive) {
        const s = queue.shift();
        await apply(s, queue.length > 0);
      }
    } finally { pumping = false; }
  }

  socket.on('pisti-state', (s) => { queue.push(s); pump(); });

  WBG.gameReady('pisti-page-loaded');
})();
