await WBG.i18n.load('dice');
WBG.i18n.apply(document.getElementById('game-board'));

(() => {
  const t = WBG.t;
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const TURN_MS = 45000;
  const fmt = (n) => Number(n).toLocaleString(WBG.locale);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  WBG.addIcons({
    'fk-bank': '<path d="M4 9l8-5 8 5"/><path d="M5 9h14M6.5 9v8M10 9v8M14 9v8M17.5 9v8M4 20h16"/>',
    'fk-flame': '<path d="M12 3c1 3.500 4.500 5 4.500 9.500a4.500 4.500 0 0 1-9 0c0-2 1-3 2-4 .2 1.500 1 2 1.500 2C11 8 10.500 5 12 3z"/>',
    'fk-skull': '<path d="M12 4a7 7 0 0 0-7 7c0 2.500 1.200 4 3 5v3h8v-3c1.800-1 3-2.500 3-5a7 7 0 0 0-7-7z"/><circle cx="9.500" cy="11.500" r="1.300"/><circle cx="14.500" cy="11.500" r="1.300"/>',
    'fk-check': '<path d="M5 12.500l4.500 4.500L19 7.500"/>'
  });

  let state = null;
  let offset = 0;
  let sel = new Set();
  let rolling = false;
  let lastRollSeq = null;
  let lastEventSeq = null;
  let lastTurnKey = '';
  let wasMyTurn = false;
  let diceKey = '';
  let ticker = 0;
  const timers = new Set();

  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  WBG.onTeardown(() => { clearInterval(ticker); timers.forEach(clearTimeout); document.removeEventListener('keydown', onKey); });
  socket.off('dice-state');
  socket.off('dice-error');

  /* -------------------------------------------------------- scoring (client copy, used for the live preview) */
  const tripleBase = (f) => (f === 1 ? 1000 : f * 100);
  function scoreSelection(values) {
    const n = values.length;
    if (!n || n > 6) return { valid: false, score: 0 };
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const v of values) c[v]++;
    let best = -1;
    let sum = 0;
    let ok = true;
    for (let f = 1; f <= 6; f++) {
      if (!c[f]) continue;
      if (c[f] >= 3) sum += tripleBase(f) * 2 ** (c[f] - 3);
      else if (f === 1) sum += 100 * c[f];
      else if (f === 5) sum += 50 * c[f];
      else { ok = false; break; }
    }
    if (ok) best = sum;
    if (n === 6) {
      const key = c.slice(1).filter(Boolean).sort((a, b) => b - a).join('');
      if (key === '111111' || key === '222' || key === '42') best = Math.max(best, 1500);
      if (key === '33') best = Math.max(best, 2500);
    }
    return best < 0 ? { valid: false, score: 0 } : { valid: true, score: best };
  }
  function bestScoring(values) {
    let best = { indices: [], score: 0 };
    for (let m = 1; m < (1 << values.length); m++) {
      const idx = [];
      values.forEach((_, i) => { if (m & (1 << i)) idx.push(i); });
      const r = scoreSelection(idx.map(i => values[i]));
      if (r.valid && (r.score > best.score || (r.score === best.score && idx.length < best.indices.length))) best = { indices: idx, score: r.score };
    }
    return best;
  }
  /** Can this die ever contribute (1, 5 or part of a triple among the dice still in play)? */
  function canScore(i) {
    const free = state.dice.filter(d => !d.held);
    const v = state.dice[i].v;
    return v === 1 || v === 5 || free.filter(d => d.v === v).length >= 3 || free.length === 6;
  }

  WBG.setRules({
    title: t('dice.rules.title'),
    sections: [
      { title: t('dice.rules.turn'), items: [t('dice.rules.turn.1'), t('dice.rules.turn.2'), t('dice.rules.turn.3'), t('dice.rules.turn.4')] },
      { title: t('dice.rules.scoring'), items: [t('dice.rules.scoring.1'), t('dice.rules.scoring.2'), t('dice.rules.scoring.3'), t('dice.rules.scoring.4'), t('dice.rules.scoring.5')] },
      { title: t('dice.rules.winning'), items: [t('dice.rules.winning.1'), t('dice.rules.winning.2'), t('dice.rules.winning.3'), t('dice.rules.winning.4')] }
    ]
  });

  /* ------------------------------------------------------------- helpers */
  const nameOf = (id) => state.players.find(p => p.id === id)?.name || t('dice.player');
  const isMyTurn = () => !spectator && state && state.turn === myId;
  const remaining = () => Math.max(0, (state?.deadline || 0) - (Date.now() + offset));
  const freeIdx = () => state.dice.map((d, i) => i).filter(i => !state.dice[i].held);
  const selValues = () => [...sel].sort((a, b) => a - b).map(i => state.dice[i].v);
  const selScore = () => (sel.size ? scoreSelection(selValues()) : { valid: false, score: 0 });

  function dieHtml(v, cls) {
    return WBG.dieFace(v, cls || 'size-full');
  }

  /* -------------------------------------------------------------- render */

  function renderHeader() {
    const s = state;
    $('fk-target').textContent = fmt(s.target);
    const turnP = s.players.find(p => p.id === s.turn);
    let eyebrow = t('dice.eyebrow');
    let title;
    if (s.phase === 'over') { title = t('dice.over'); eyebrow = t('dice.finalScores'); }
    else if (s.phase === 'waiting' || !turnP) title = t('dice.ready');
    else if (s.turn === myId) { title = s.phase === 'roll' ? t('dice.title.roll') : (s.phase === 'busy' ? t('dice.title.mine') : t('dice.title.choose')); eyebrow = t('dice.youAreUp'); }
    else { title = t('dice.title.turnOf', { name: turnP.name }); eyebrow = spectator ? t('dice.hostView') : t('dice.waiting'); }
    $('fk-title').textContent = title;
    $('fk-eyebrow').textContent = eyebrow;
    $('fk-avatar').innerHTML = turnP && s.phase !== 'over' ? WBG.avatar(turnP.name, `size-11 ring-2 ${s.turn === myId ? 'ring-brand-400' : 'ring-white/20'}`) : `<span class="grid size-11 place-items-center rounded-full bg-white/8 text-amber-300">${WBG.icon('dice', 'size-6')}</span>`;

    const fin = $('fk-final');
    if (s.finalRound && s.phase !== 'over') {
      const who = s.finalTrigger ? nameOf(s.finalTrigger) : t('dice.someone');
      const left = s.players.filter(p => !p.left && !p.finalDone).length;
      fin.hidden = false;
      fin.innerHTML = `${WBG.icon('flag', 'size-5 shrink-0')}<span><strong>${WBG.esc(t('dice.final.title'))}</strong> ${WBG.esc(t(left ? 'dice.final.textLeft' : 'dice.final.text', { name: who, target: fmt(s.target), n: left }))}</span>`;
    } else fin.hidden = true;
  }

  function renderBoard() {
    const s = state;
    $('fk-board').innerHTML = s.players.map((p) => {
      const turn = p.id === s.turn && s.phase !== 'over';
      const pct = Math.min(100, (p.banked / s.target) * 100);
      const pips = [0, 1, 2].map(i => `<span class="size-2 rounded-full ${i < p.strikes ? 'bg-rose-400' : 'bg-white/15'}"></span>`).join('');
      const need = s.opening > 0 && !p.opened && !p.left ? `<span class="chip chip-warn" title="${WBG.esc(t('dice.needsTitle', { n: fmt(s.opening) }))}">${WBG.esc(t('dice.needs', { n: fmt(s.opening) }))}</span>` : '';
      const fin = s.finalRound && p.finalDone && !p.left ? `<span class="text-emerald-300" title="${WBG.esc(t('dice.finalPlayed'))}">${WBG.icon('fk-check', 'size-4')}</span>` : '';
      return `<li class="rounded-xl border px-3 py-2 transition ${turn ? 'border-brand-400/60 bg-brand-500/12' : 'border-transparent bg-white/4'} ${p.left ? 'opacity-50' : ''}">
        <div class="flex items-center gap-2.5">
          ${WBG.avatar(p.name, 'size-8 text-xs')}
          <span class="min-w-0 flex-1 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}${p.id === myId ? ` <span class="font-normal text-slate-400">(${t('dice.you')})</span>` : ''}${p.left ? ` <span class="font-normal text-rose-300">${t('dice.left')}</span>` : ''}</span>
          ${need}${fin}
          <span class="flex items-center gap-1" title="${WBG.esc(t('dice.strikes', { n: p.strikes }))}">${pips}</span>
          <span class="w-16 text-right text-lg font-bold text-white tabular-nums">${fmt(p.banked)}</span>
        </div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500 transition-[width] duration-500" style="width:${pct}%"></div></div>
      </li>`;
    }).join('');
  }

  function renderTable() {
    const s = state;
    const mine = isMyTurn();
    const busy = s.phase === 'busy';
    const picking = s.phase === 'pick' && mine && !rolling;
    const sc = selScore();

    // Dice still in play and set-aside tray.
    const dieSize = 'size-[4.75rem] sm:size-[5.25rem]';
    const free = freeIdx();
    $('fk-dice').innerHTML = s.dice.map((d, i) => {
      if (d.held) return '';
      const on = sel.has(i);
      const dim = busy || (!picking && s.phase === 'pick' && !mine) ? 'opacity-90' : '';
      const farkled = busy && s.event?.kind?.includes('farkle');
      return `<button type="button" data-i="${i}" ${picking ? '' : 'tabindex="-1"'} aria-pressed="${on}" aria-label="${WBG.esc(t(on ? 'dice.dieSelected' : 'dice.die', { v: d.v }))}"
        class="fk-die relative ${dieSize} rounded-[22%] shadow-[0_6px_14px_rgb(0_0_0/0.45)] transition duration-150 ${picking ? 'cursor-pointer active:scale-95' : 'cursor-default'} ${on ? '-translate-y-2 ring-4 ring-amber-300 shadow-[0_0_26px_rgb(252_211_77/0.55)]' : ''} ${farkled ? 'saturate-50 brightness-75' : ''} ${dim}">
        <span class="fk-face block size-full">${dieHtml(d.v)}</span>
        ${on ? `<span class="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-amber-300 text-ink-900">${WBG.icon('fk-check', 'size-4')}</span>` : ''}
      </button>`;
    }).join('') || (s.phase === 'roll' ? `<div class="flex items-center gap-3">${[1, 2, 3, 4, 5, 6].map(() => `<span class="block size-9 rounded-xl border border-dashed border-white/20 sm:size-11"></span>`).join('')}</div>` : '');

    $('fk-tray').innerHTML = s.dice.some(d => d.held)
      ? s.dice.map(d => (d.held ? `<span class="block size-9 rounded-[22%] shadow-md sm:size-10">${dieHtml(d.v)}</span>` : '')).join('')
      : `<span class="text-xs text-slate-500">${t('dice.nothing')}</span>`;

    // Scores
    $('fk-turnscore').textContent = fmt(s.turnScore);
    const pv = $('fk-preview');
    if (picking && sel.size) {
      pv.textContent = sc.valid ? `+${fmt(sc.score)}` : t('dice.noScore');
      pv.className = `text-lg font-bold tabular-nums ${sc.valid ? 'text-amber-300' : 'text-rose-300'}`;
    } else pv.textContent = '';

    // Hint
    const hint = $('fk-hint');
    const me = s.players.find(p => p.id === myId);
    const total = s.turnScore + (sc.valid ? sc.score : 0);
    let msg = '';
    if (spectator) msg = s.phase === 'pick' || s.phase === 'roll' ? t('dice.hint.playing', { name: nameOf(s.turn) }) : '';
    else if (!mine && s.phase !== 'over') msg = s.turn ? t('dice.hint.waiting', { name: nameOf(s.turn) }) : '';
    else if (mine && s.phase === 'roll') msg = t('dice.hint.rollAll');
    else if (picking) {
      if (!sel.size) msg = t('dice.hint.tap');
      else if (!sc.valid) msg = t('dice.hint.invalid');
      else if (!(me?.opened) && s.opening > 0 && total < s.opening) msg = t('dice.hint.opening', { n: fmt(s.opening), now: fmt(total) });
      else msg = free.length === sel.size ? t('dice.hint.hot') : t('dice.hint.rollOrBank', { n: free.length - sel.size, bank: fmt(total) });
    }
    if (busy) msg = '';
    hint.textContent = msg;

    // Buttons
    const roll = $('fk-roll');
    const bank = $('fk-bank');
    const best = $('fk-best');
    const showActions = !spectator;
    $('fk-actions').hidden = !showActions;
    best.hidden = !(picking);
    if (showActions) {
      let canRoll = false;
      let canBank = false;
      let rollLabel = t('dice.btn.roll');
      if (mine && s.phase === 'roll') { canRoll = !rolling; rollLabel = t('dice.btn.roll6'); }
      if (picking) {
        canRoll = sc.valid;
        const remain = free.length - sel.size;
        rollLabel = !sel.size ? t('dice.btn.roll') : (remain === 0 ? t('dice.btn.rollFresh') : t('dice.btn.rollN', { n: remain }));
        const openOk = me?.opened || !(s.opening > 0) || total >= s.opening;
        canBank = sc.valid && openOk;
      }
      roll.disabled = !canRoll;
      bank.disabled = !canBank;
      roll.innerHTML = `${WBG.icon('dice', 'size-5')}<span>${rollLabel}</span>`;
      const bankTotal = picking && sc.valid ? total : s.turnScore;
      bank.innerHTML = `${WBG.icon('fk-bank', 'size-5')}<span>${t('dice.btn.bank')}${bankTotal > 0 && (picking && sc.valid) ? ' ' + fmt(bankTotal) : ''}</span>`;
      roll.classList.toggle('animate-pulse-soft', canRoll && mine && (s.phase === 'roll' || (picking && sc.valid)));
    }
  }

  function renderTimer() {
    const t = $('fk-timer');
    const bar = $('fk-bar');
    if (!state || !state.deadline || (state.phase !== 'roll' && state.phase !== 'pick')) {
      t.textContent = '';
      bar.style.width = '0%';
      return;
    }
    const left = remaining();
    const secs = Math.ceil(left / 1000);
    t.textContent = WBG.t('dice.secs', { s: secs });
    t.className = `mb-1 h-4 text-xs font-semibold tabular-nums ${secs <= 10 ? 'text-rose-300' : 'text-slate-400'}`;
    bar.style.width = `${Math.min(100, (left / TURN_MS) * 100)}%`;
    bar.className = `h-full rounded-full ${secs <= 10 ? 'bg-rose-400' : 'bg-gradient-to-r from-brand-500 to-violet-500'}`;
    if (isMyTurn() && secs <= 5 && secs > 0 && t.dataset.s !== String(secs)) { WBG.sound.play('tick'); }
    t.dataset.s = String(secs);
  }

  /* ----------------------------------------------------------- animations */

  function rollAnimation(indices) {
    if (reduceMotion || !indices.length) { WBG.sound.play('land'); return; }
    rolling = true;
    WBG.sound.play('roll');
    WBG.haptic(18);
    const faces = [1, 2, 3, 4, 5, 6];
    let finished = 0;
    indices.forEach((i, k) => {
      const btn = $('fk-dice').querySelector(`[data-i="${i}"]`);
      if (!btn) { finished++; return; }
      const face = btn.querySelector('.fk-face');
      const final = state.dice[i].v;
      const dur = 520 + k * 70;
      const dir = k % 2 ? 1 : -1;
      btn.animate([
        { transform: `translate(${dir * -60}px, -90px) rotate(${dir * -280}deg) scale(0.7)`, opacity: 0.2 },
        { transform: `translate(${dir * 14}px, 6px) rotate(${dir * 40}deg) scale(1.08)`, opacity: 1, offset: 0.7 },
        { transform: 'translate(0,0) rotate(0) scale(1)' }
      ], { duration: dur, easing: 'cubic-bezier(.3,.7,.4,1)' });
      const cycle = setInterval(() => { face.innerHTML = dieHtml(faces[Math.floor(Math.random() * 6)]); }, 65);
      timers.add(cycle);
      later(() => {
        clearInterval(cycle);
        face.innerHTML = dieHtml(final);
        finished++;
        if (k === 0 || finished === indices.length) WBG.sound.play('land');
        if (finished === indices.length) { rolling = false; renderTable(); }
      }, dur);
    });
    if (finished === indices.length) rolling = false;
  }

  function shake(el) {
    if (!el || reduceMotion) return;
    el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 320 });
  }

  function banner(kind, title, sub) {
    const tone = {
      farkle: 'border-rose-400/60 bg-rose-950/85 text-rose-200',
      hot: 'border-amber-300/70 bg-amber-950/85 text-amber-200',
      bank: 'border-emerald-400/60 bg-emerald-950/85 text-emerald-200'
    }[kind];
    const icon = { farkle: 'fk-skull', hot: 'fk-flame', bank: 'fk-bank' }[kind];
    const host = $('fk-banner');
    host.innerHTML = `<div class="fk-banner flex flex-col items-center rounded-3xl border-2 px-6 py-3 text-center shadow-2xl backdrop-blur-sm ${tone}">
      <span class="flex items-center gap-2 text-3xl font-black tracking-tight uppercase sm:text-4xl">${WBG.icon(icon, 'size-8')}${WBG.esc(title)}</span>
      ${sub ? `<span class="mt-0.5 text-sm font-semibold">${WBG.esc(sub)}</span>` : ''}
    </div>`;
    const el = host.firstElementChild;
    if (!reduceMotion) {
      el.animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1, offset: 0.55 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, fill: 'forwards' });
      if (kind === 'farkle') shake($('fk-felt'));
    }
    later(() => {
      if (host.firstElementChild !== el) return;
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }).onfinish = () => { if (host.firstElementChild === el) host.innerHTML = ''; };
    }, kind === 'farkle' ? 2100 : 1300);
  }

  function handleEvent(ev, quiet) {
    if (!ev) return;
    const mine = ev.by === myId;
    if (ev.kind === 'farkle' || ev.kind === 'triple-farkle') {
      if (quiet) return;
      const lost = ev.points > 0 ? (mine ? t('dice.lost.you', { n: fmt(ev.points) }) : t('dice.lost.other', { name: nameOf(ev.by), n: fmt(ev.points) })) : (ev.timeout ? t('dice.outOfTime') : t('dice.noScoring'));
      banner('farkle', ev.kind === 'triple-farkle' ? t('dice.farkle3') : t('dice.farkle'), ev.kind === 'triple-farkle' ? t('dice.penalty', { lost, n: fmt(ev.penalty || 0) }) : lost);
      WBG.sound.play('farkle');
      if (mine) WBG.haptic([80, 40, 80]);
    } else if (ev.kind === 'hot-dice') {
      if (quiet) return;
      banner('hot', t('dice.hot'), mine ? t('dice.hot.you') : t('dice.hot.other', { name: nameOf(ev.by) }));
      WBG.sound.play('boost');
      later(() => WBG.sound.play('coin'), 120);
    } else if (ev.kind === 'bank') {
      if (quiet) return;
      banner('bank', t('dice.banked', { n: fmt(ev.points) }), mine ? t('dice.niceOne') : nameOf(ev.by));
      WBG.sound.play('coin');
      if (mine) WBG.haptic(30);
      if (ev.reached) later(() => WBG.sound.play('notify'), 500);
    } else if (ev.kind === 'left') {
      if (!quiet) WBG.toast(t('dice.toast.left', { name: nameOf(ev.by) }), { icon: 'logout' });
    }
  }

  /* --------------------------------------------------------------- events */

  socket.on('dice-state', (s) => {
    offset = (s.now || Date.now()) - Date.now();
    const first = state === null;
    state = s;

    const turnKey = `${s.turn}:${s.turnNo}`;
    const newTurn = turnKey !== lastTurnKey;
    lastTurnKey = turnKey;
    const newRoll = lastRollSeq !== null && s.rollSeq !== lastRollSeq;
    if (newTurn || newRoll) sel = new Set();
    // keep only still-valid selections
    sel = new Set([...sel].filter(i => s.dice[i] && !s.dice[i].held));

    const active = isMyTurn() && (s.phase === 'roll' || s.phase === 'pick');
    if (active && !wasMyTurn) { WBG.sound.play('turn'); WBG.haptic(25); }
    wasMyTurn = active;

    const newEvent = lastEventSeq !== null && s.event && s.event.seq !== lastEventSeq;
    lastEventSeq = s.event ? s.event.seq : 0;
    lastRollSeq = s.rollSeq;

    renderHeader();
    renderBoard();
    renderTable();
    renderTimer();
    // A reload or host view joining mid-turn shows the table quietly.
    if (newRoll && !first) {
      if (rolling) { /* previous animation superseded */ rolling = false; }
      renderTable();
      rollAnimation(s.rolled);
      // Banners wait for the dice to land.
      if (newEvent) later(() => handleEvent(s.event, false), reduceMotion ? 0 : 520 + s.rolled.length * 70 + 120);
    } else if (newEvent) {
      handleEvent(s.event, false);
    }
  });

  socket.on('dice-error', ({ message }) => {
    WBG.sound.play('error');
    WBG.haptic(60);
    WBG.toast(message ? WBG.tr(message) : t('dice.err.default'), { type: 'error' });
    shake($('fk-dice'));
  });

  /* ---------------------------------------------------------------- input */

  function toggle(i) {
    if (!state || !isMyTurn() || state.phase !== 'pick' || rolling) return;
    if (state.dice[i].held) return;
    if (sel.has(i)) { sel.delete(i); WBG.sound.play('click'); }
    else {
      if (!canScore(i) && !sel.size) {
        WBG.sound.play('error');
        WBG.haptic(30);
        shake($('fk-dice').querySelector(`[data-i="${i}"]`));
        return;
      }
      sel.add(i);
      WBG.sound.play('pop');
    }
    WBG.haptic(8);
    renderTable();
  }

  $('fk-dice').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) toggle(Number(b.dataset.i));
  });

  function doRoll() {
    if (!state || !isMyTurn() || rolling) return;
    if (state.phase === 'roll') { socket.emit('dice-roll', {}); return; }
    if (state.phase !== 'pick') return;
    if (!selScore().valid) { invalid(); return; }
    socket.emit('dice-roll', { keep: [...sel] });
    sel = new Set();
    renderTable();
  }

  function doBank() {
    if (!state || !isMyTurn() || state.phase !== 'pick' || rolling) return;
    if (!selScore().valid) { invalid(); return; }
    socket.emit('dice-bank', { keep: [...sel] });
  }

  function invalid() {
    WBG.sound.play('error');
    WBG.haptic(40);
    shake($('fk-dice'));
  }

  $('fk-roll').addEventListener('click', doRoll);
  $('fk-bank').addEventListener('click', doBank);
  $('fk-best').addEventListener('click', () => {
    if (!state || !isMyTurn() || state.phase !== 'pick' || rolling) return;
    const idx = freeIdx();
    const best = bestScoring(idx.map(i => state.dice[i].v));
    sel = new Set(best.indices.map(k => idx[k]));
    WBG.sound.play('pop');
    renderTable();
  });

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'r' || k === ' ' || k === 'enter') { if (e.target.closest?.('button')) return; e.preventDefault(); doRoll(); }
    else if (k === 'b') doBank();
    else if (/^[1-6]$/.test(k)) {
      const idx = freeIdx();
      const i = idx[Number(k) - 1];
      if (i !== undefined) toggle(i);
    }
  }
  document.addEventListener('keydown', onKey);

  ticker = setInterval(renderTimer, 250);
  WBG.gameReady('dice-page-loaded');
})();
