(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const COLORS = { red: '#dc2626', yellow: '#eab308', green: '#16a34a', blue: '#2563eb' };
  const GLOW = { red: 'rgba(220,38,38,.55)', yellow: 'rgba(234,179,8,.55)', green: 'rgba(22,163,74,.55)', blue: 'rgba(37,99,235,.55)' };
  const WILD_BG = 'conic-gradient(#dc2626 0 25%, #2563eb 0 50%, #16a34a 0 75%, #eab308 0)';
  const COLOR_ORDER = ['red', 'yellow', 'green', 'blue', 'wild'];
  const VALUE_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2', 'wild', 'wild4'];

  let state = null;
  let prev = null;
  let deadlineLocal = 0;
  let nextRoundLocal = 0;
  let unoLeftLocal = 0;
  let lastSeq = -1;
  let flyFrom = null;        // rect of the card the player just tapped
  let hideTop = false;       // real top card hidden while the flying clone is in the air
  let lastTick = -1;
  const pileHistory = [];     // older discards, for the stacked look
  const tilt = new Map();     // card id -> stable random rotation

  socket.off('uno-state');
  const timer = setInterval(tick, 150);
  WBG.onTeardown(() => clearInterval(timer));

  WBG.setRules({
    title: 'Uno',
    sections: [
      { title: 'Goal', items: ['Be the first to play all your cards. The round winner scores the points left in the other hands (numbers = face value, Skip / Reverse / +2 = 20, Wild = 50). The host chooses a single round or a target score.'] },
      { title: 'Playing', items: ['Play a card that matches the top card by colour or by number / symbol. Wild cards can always be played and let you pick the colour.', 'No playable card? Draw one. If it can be played you may play it right away, otherwise your turn passes.'] },
      { title: 'Action cards', items: ['Skip: the next player loses their turn. Reverse: flips the direction (acts as Skip with two players).', '+2 and Wild +4: the next player draws that many cards and loses their turn. With stacking on, they can answer with another +2 (or +4) to pass the penalty on.'] },
      { title: 'UNO!', items: ['When you are down to one card, press UNO! (you may even press it before playing your second to last card). If someone presses Catch before the next player acts, you draw two cards.'] },
      { title: 'Timer', items: ['If your turn timer runs out you draw a card and the turn passes.'] }
    ]
  });

  const bgOf = (card) => (card.color === 'wild' ? WILD_BG : COLORS[card.color]);
  const corner = (card) => ({ skip: 'S', reverse: 'R', draw2: '+2', wild: 'W', wild4: '+4' }[card.value] || card.value);

  function faceMarkup(card, big) {
    const textColor = card.color === 'wild' ? '#111827' : COLORS[card.color];
    const size = big ? 'size-10' : 'size-8';
    switch (card.value) {
      case 'skip': return { inner: WBG.icon('skip', size), textColor };
      case 'reverse': return { inner: WBG.icon('swap', size), textColor };
      case 'draw2': return { inner: '+2', textColor };
      case 'wild4': return { inner: '+4', textColor };
      case 'wild': return { inner: WBG.icon('star', size), textColor };
      default: return { inner: card.value, textColor };
    }
  }

  function cardEl(card, { big = false, tag = 'div', extra = '' } = {}) {
    const el = document.createElement(tag);
    const { inner, textColor } = faceMarkup(card, big);
    el.style.cssText = `width:calc(var(--cw)*${big ? 1.15 : 1});height:calc(var(--ch)*${big ? 1.15 : 1});background:${bgOf(card)}`;
    el.className = `relative shrink-0 select-none overflow-hidden rounded-xl border-[3px] border-white shadow-lg ${extra}`;
    el.innerHTML = `<span class="absolute inset-[13%] -rotate-[24deg] rounded-[50%] bg-white/95"></span>
      <span class="absolute inset-0 grid place-items-center text-3xl font-black ${big ? 'sm:text-4xl' : 'sm:text-3xl'}" style="color:${textColor}">${inner}</span>
      <span class="absolute top-1 left-1.5 text-[11px] font-extrabold text-white drop-shadow">${corner(card)}</span>
      <span class="absolute right-1.5 bottom-1 rotate-180 text-[11px] font-extrabold text-white drop-shadow">${corner(card)}</span>`;
    el.setAttribute('aria-label', card.color === 'wild' ? (card.value === 'wild4' ? 'Wild draw four' : 'Wild') : `${card.color} ${card.value}`);
    return el;
  }

  const rotationFor = (id) => {
    if (!tilt.has(id)) tilt.set(id, (Math.random() - 0.5) * 24);
    return tilt.get(id);
  };

  /* --------------------------------------------------------------- render */
  function render() {
    if (!state) return;
    const myTurn = state.turn === myId && state.phase === 'play';
    const playable = new Set(state.playable || []);

    // opponents
    $('uno-players').replaceChildren(...state.players.map((p) => {
      const li = document.createElement('li');
      li.dataset.pid = p.id;
      const turn = p.id === state.turn && state.phase === 'play';
      const prevCount = prev?.players.find((x) => x.id === p.id)?.count;
      const bumped = prevCount !== undefined && prevCount !== p.count;
      const minis = Math.min(p.count, 7);
      li.className = `flex shrink-0 items-center gap-2.5 rounded-2xl border px-3 py-2 transition ${turn ? 'border-emerald-400/70 bg-emerald-500/12 shadow-lg shadow-emerald-500/10' : 'border-white/8 bg-white/4'}`;
      li.innerHTML = `${WBG.avatar(p.name, 'size-9')}
        <div class="min-w-0">
          <p class="max-w-28 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}${p.id === myId ? ' <span class="text-xs font-normal text-slate-400">(you)</span>' : ''}</p>
          <div class="flex items-center gap-1.5">
            <span class="flex ${bumped ? 'uno-bump' : ''}">${Array.from({ length: minis }, (_, i) => `<span class="-mr-1.5 inline-block h-5 w-3.5 rounded-[3px] border border-white/70 bg-ink-900" style="transform:rotate(${(i - minis / 2) * 3}deg)"></span>`).join('')}</span>
            <span class="ml-2 text-sm font-bold tabular-nums ${p.count === 1 ? 'text-rose-300' : 'text-slate-300'}">${p.count}</span>
            ${state.target ? `<span class="chip ml-1">${p.score} pts</span>` : ''}
            ${p.count === 1 ? '<span class="chip chip-danger">UNO</span>' : ''}
          </div>
        </div>`;
      return li;
    }));

    // header
    $('uno-round').hidden = !state.target;
    $('uno-round').textContent = `Round ${state.round} - first to ${state.target}`;

    // table: pile, colour glow, direction
    renderPile();
    const glow = $('uno-glow');
    glow.style.background = GLOW[state.color];
    glow.style.boxShadow = `0 0 46px 6px ${GLOW[state.color]}`;
    $('uno-dir').innerHTML = WBG.icon(state.dir === 1 ? 'rotate' : 'undo', 'size-5');
    $('uno-dir').firstChild.style.animation = `spin 6s linear infinite ${state.dir === 1 ? 'normal' : 'reverse'}`;
    $('uno-deck-count').textContent = `${state.deckCount}`;
    $('uno-deck').disabled = !myTurn || state.pending !== null;
    const badge = $('uno-deck-badge');
    badge.hidden = !(state.pendingDraw > 0);
    badge.textContent = `+${state.pendingDraw}`;

    const names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
    let log = state.log;
    if (myTurn && state.pendingDraw > 0) log = state.stacking ? `Stack a ${state.pendingType === 'draw2' ? '+2' : '+4'} or draw ${state.pendingDraw}` : log;
    else if (myTurn && !state.pending) log = `Your turn. ${state.log}`;
    $('uno-log').textContent = state.phase === 'play' || state.phase === 'over' ? log : state.log;
    $('uno-pass').hidden = !(myTurn && state.pending !== null);

    // UNO / catch
    const ex = state.uno;
    const showCall = !spectator && state.unoCall && state.phase === 'play' && ((ex && ex.id === myId) || (myTurn && state.hand.length === 2));
    const showCatch = !spectator && ex && ex.id !== myId;
    $('uno-callbtn').hidden = !showCall;
    $('uno-catchbtn').hidden = !showCatch;
    if (showCatch) $('uno-catchbtn').querySelector('span').textContent = `Catch ${names[ex.id] || ''}`;
    unoLeftLocal = ex ? performance.now() + ex.left : 0;

    // hand
    $('uno-hand-label').textContent = spectator ? 'Host view: hands are private' : `Your hand (${state.hand.length})`;
    const prevIds = new Set(prev?.hand?.map((c) => c.id) || []);
    const sorted = [...state.hand].sort((a, b) => COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color) || VALUE_ORDER.indexOf(a.value) - VALUE_ORDER.indexOf(b.value));
    $('uno-hand').replaceChildren(...(spectator ? [] : sorted.map((card) => {
      const ok = playable.has(card.id);
      const fresh = prev && !prevIds.has(card.id);
      const el = cardEl(card, {
        tag: ok ? 'button' : 'div',
        extra: `transition duration-150 ${fresh ? 'uno-new' : ''} ${ok ? '-translate-y-3 cursor-pointer hover:-translate-y-5 active:scale-95' : myTurn ? 'opacity-45' : ''} ${state.pending === card.id ? 'ring-4 ring-emerald-400' : ''}`
      });
      if (ok) {
        el.addEventListener('click', () => {
          flyFrom = el.getBoundingClientRect();
          WBG.haptic(12);
          if (card.color === 'wild') chooseColor((color) => socket.emit('uno-play', { cardId: card.id, color }), () => { flyFrom = null; });
          else socket.emit('uno-play', { cardId: card.id });
        });
      }
      return el;
    })));

    renderSummary();
    tick();
  }

  function renderPile() {
    const top = state.top.color === 'wild' ? { ...state.top, color: state.color } : state.top;
    const layers = [];
    // older cards underneath, slightly rotated
    for (const old of pileHistory.slice(-3)) {
      const el = cardEl(old.color === 'wild' ? { ...old, color: old.shownColor || 'red' } : old, { big: true });
      el.style.position = 'absolute';
      el.style.inset = '0';
      el.style.transform = `rotate(${rotationFor(old.id)}deg)`;
      el.style.opacity = '.85';
      layers.push(el);
    }
    const topEl = cardEl(top, { big: true });
    topEl.id = 'uno-top';
    topEl.style.position = 'absolute';
    topEl.style.inset = '0';
    topEl.style.transform = `rotate(${rotationFor(state.top.id) / 2}deg)`;
    topEl.style.opacity = hideTop ? '0' : '1';
    layers.push(topEl);
    $('uno-pile').replaceChildren(...layers);
  }

  function renderSummary() {
    const show = state.phase === 'roundOver' && state.roundResult;
    $('uno-summary').hidden = !show;
    if (!show) return;
    const r = state.roundResult;
    const name = (id) => state.players.find((p) => p.id === id)?.name || 'Player';
    $('uno-summary-title').textContent = `${name(r.winner)} wins the round: +${r.points}`;
    $('uno-summary-rows').replaceChildren(...[...state.players].sort((a, b) => b.score - a.score).map((p) => {
      const li = document.createElement('li');
      li.className = `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm ${p.id === r.winner ? 'bg-amber-500/12' : 'bg-white/5'}`;
      li.innerHTML = `${WBG.avatar(p.name, 'size-7 text-xs')}<span class="min-w-0 flex-1 truncate font-medium text-white">${WBG.esc(p.name)}</span>
        <span class="text-xs text-slate-400">${p.id === r.winner ? 'out' : `${r.left[p.id] ?? 0} left`}</span>
        <span class="w-14 text-right font-bold text-brand-300 tabular-nums">${p.score}</span>`;
      return li;
    }));
    nextRoundLocal = performance.now() + state.nextRoundIn;
  }

  /* ------------------------------------------------------- timers + sound */
  function tick() {
    if (!state) return;
    const now = performance.now();
    if (state.phase === 'play' && deadlineLocal) {
      const left = Math.max(0, deadlineLocal - now);
      $('uno-bar').style.width = `${Math.min(100, (left / state.turnMs) * 100)}%`;
      const s = Math.ceil(left / 1000);
      $('uno-timer').textContent = `${s}s`;
      if (state.turn === myId && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
    } else {
      $('uno-bar').style.width = '0%';
      $('uno-timer').textContent = '';
    }
    if (state.phase === 'roundOver') {
      const s = Math.max(0, Math.ceil((nextRoundLocal - now) / 1000));
      $('uno-summary-next').textContent = `Next round in ${s}s`;
    }
    if (state.uno && unoLeftLocal && now > unoLeftLocal) {
      $('uno-callbtn').hidden = true;
      $('uno-catchbtn').hidden = true;
    }
  }

  /** Slide a card from where it was played to the discard pile. */
  function flyCard(card, fromRect) {
    const topEl = $('uno-top');
    if (!topEl || !fromRect || WBG.prefs.reduceMotion) { hideTop = false; if (topEl) topEl.style.opacity = '1'; return; }
    const to = topEl.getBoundingClientRect();
    const shown = card.color === 'wild' ? { ...card, color: state.color } : card;
    const clone = cardEl(shown, { big: true });
    clone.classList.add('uno-fly');
    Object.assign(clone.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    document.body.appendChild(clone);
    const dx = fromRect.left + fromRect.width / 2 - (to.left + to.width / 2);
    const dy = fromRect.top + fromRect.height / 2 - (to.top + to.height / 2);
    const scale = fromRect.width / to.width;
    topEl.style.opacity = '0';
    const anim = clone.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(-8deg)` }, { transform: 'translate(0,0) scale(1) rotate(0)' }],
      { duration: 280, easing: 'cubic-bezier(.2,.8,.3,1)' }
    );
    anim.onfinish = anim.oncancel = () => {
      clone.remove();
      hideTop = false;
      const t = $('uno-top');
      if (t) t.style.opacity = '1';
      WBG.sound.play('card');
    };
  }

  function chooseColor(done, cancel) {
    const box = $('uno-color-options');
    box.replaceChildren(...Object.entries(COLORS).map(([name, hex]) => {
      const b = document.createElement('button');
      b.className = 'h-16 w-28 rounded-2xl border-4 border-white text-sm font-bold text-white capitalize shadow-lg transition active:scale-95';
      b.style.background = hex;
      b.textContent = name;
      b.addEventListener('click', () => { $('uno-colors').hidden = true; done(name); });
      return b;
    }));
    $('uno-colors').hidden = false;
    $('uno-colors').onclick = (e) => { if (e.target === $('uno-colors')) { $('uno-colors').hidden = true; cancel?.(); } };
  }

  /* ---------------------------------------------------------------- socket */
  socket.on('uno-state', (s) => {
    const first = !state;
    prev = state;
    state = s;
    deadlineLocal = performance.now() + s.timeLeft;

    // keep a short history of discards for the stacked look
    if (prev && prev.top.id !== s.top.id) pileHistory.push({ ...prev.top, shownColor: prev.color });
    if (first) lastSeq = s.lastPlay?.seq ?? -1;

    const newPlay = s.lastPlay && s.lastPlay.seq !== lastSeq && !first;
    if (newPlay) { hideTop = true; }
    render();

    if (newPlay) {
      lastSeq = s.lastPlay.seq;
      let rect = null;
      if (s.lastPlay.by === myId && flyFrom) rect = flyFrom;
      else {
        const chip = document.querySelector(`[data-pid="${s.lastPlay.by}"]`);
        rect = chip?.getBoundingClientRect() || null;
      }
      flyFrom = null;
      flyCard(s.lastPlay.card, rect);
    }

    if (first) { WBG.sound.play('deal'); return; }
    if (prev) {
      if (prev.round !== s.round) WBG.sound.play('deal');
      if (s.turn === myId && prev.turn !== s.turn && s.phase === 'play') { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
      if (s.hand.length > prev.hand.length) WBG.sound.play('deal');
      if (s.uno && (!prev.uno || prev.uno.id !== s.uno.id)) WBG.sound.play('uno');
      if (prev.uno && !s.uno && /says UNO/.test(s.log)) WBG.sound.play('click');
      if (/caught/.test(s.log) && s.log !== prev.log) WBG.sound.play('error');
      if (s.phase === 'roundOver' && prev.phase !== 'roundOver') WBG.sound.play('coin');
    }
  });

  $('uno-deck').addEventListener('click', () => { WBG.sound.play('card'); socket.emit('uno-draw'); });
  $('uno-pass').addEventListener('click', () => { WBG.sound.play('click'); socket.emit('uno-pass'); });
  $('uno-callbtn').addEventListener('click', () => { WBG.haptic(20); socket.emit('uno-call'); });
  $('uno-catchbtn').addEventListener('click', () => { WBG.haptic(20); socket.emit('uno-catch'); });

  WBG.gameReady('uno-page-loaded');
})();
