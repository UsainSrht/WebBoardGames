(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const MOVES = ['rock', 'paper', 'scissors'];
  const LABEL = { rock: 'Rock', paper: 'Paper', scissors: 'Scissors' };
  const KEYS = { r: 'rock', p: 'paper', s: 'scissors', 1: 'rock', 2: 'paper', 3: 'scissors' };
  const SHOOT_MS = 2600;
  const BEATS = [0, 560, 1120, 1700]; // Rock, Paper, Scissors, SHOOT
  const WORDS = ['Rock', 'Paper', 'Scissors', 'SHOOT!'];

  WBG.addIcons({
    'rps-check': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'rps-x': '<path d="M6 6l12 12M18 6L6 18"/>',
    'rps-lock': '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    'rps-eq': '<path d="M6 9h12M6 15h12"/>'
  });

  let state = null;
  let offset = 0;              // server clock minus local clock
  let ticker = 0;
  let lastKey = '';            // what the stage is currently showing
  let lastBeat = -1;
  let revealedRound = -1;
  let prevPhase = null;
  let prevRound = -1;
  const timers = new Set();

  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
  WBG.onTeardown(() => { clearInterval(ticker); timers.forEach(clearTimeout); document.removeEventListener('keydown', onKey); });
  socket.off('rps-state');
  socket.off('rps-error');

  const nameOf = (id) => state?.players.find(p => p.id === id)?.name || 'Player';
  const me = () => state?.players.find(p => p.id === myId);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  WBG.setRules({
    title: 'Rock Paper Scissors',
    sections: [
      { title: 'Each round', items: [
        'Everybody picks Rock, Paper or Scissors in secret within 8 seconds. You can change your pick until time is up.',
        'If you do not pick in time a random move is thrown for you and you are marked AFK.',
        'Then comes the beat: Rock, Paper, Scissors, SHOOT. All moves are revealed at the same moment.',
        'Rock beats Scissors, Scissors beats Paper, Paper beats Rock.'
      ] },
      { title: 'Points mode', items: [
        'Every pair of players counts: you get +1 for every opponent you beat that round. Nobody loses points.',
        'After the chosen number of rounds the highest score wins.',
        'A tie for first place goes to sudden death: only the tied players throw, round after round, until one of them leads.'
      ] },
      { title: 'Elimination mode', items: [
        'All players still in throw every round.',
        'If exactly two different moves appear, everybody who threw the losing move is out.',
        'If everybody threw the same move, or all three moves appear, it is a draw and the round is replayed.',
        'The last player standing wins. With two players one decisive round ends the match.'
      ] },
      { title: 'Tips', items: ['On a keyboard press R, P or S (or 1, 2, 3) to pick.'] }
    ]
  });

  /* ------------------------------------------------------------- helpers */

  const remaining = () => Math.max(0, (state.deadline || 0) - (Date.now() + offset));

  function moveBtn(move, { active = false, disabled = false } = {}) {
    return `<button type="button" data-move="${move}" aria-pressed="${active}" aria-label="${LABEL[move]}" ${disabled ? 'disabled' : ''}
      class="rps-move group relative flex min-h-[7.5rem] flex-col items-center justify-center gap-1 rounded-3xl border-2 p-2.5 transition duration-150 active:scale-95 sm:min-h-[10rem] sm:p-4
        ${active ? 'border-brand-400 bg-brand-500/25 shadow-[0_0_0_4px_rgb(99_102_241/0.18)]' : 'border-white/12 bg-white/5 hover:border-brand-400/60 hover:bg-white/10'} ${disabled && !active ? 'opacity-50' : ''}">
      <span class="block size-[4.5rem] transition duration-150 group-hover:scale-110 sm:size-24">${WBG.art.rps(move)}</span>
      <span class="text-sm font-semibold text-white sm:text-base">${LABEL[move]}</span>
      ${active ? `<span class="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-brand-500 text-white">${WBG.icon('rps-check', 'size-4')}</span>` : ''}
    </button>`;
  }

  function ring(secs, frac) {
    const C = 2 * Math.PI * 44;
    return `<div class="relative grid size-24 place-items-center sm:size-28">
      <svg viewBox="0 0 100 100" class="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r="44" fill="none" stroke="rgb(255 255 255/0.1)" stroke-width="7"/>
        <circle id="rps-ring" cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}" class="text-brand-400"/>
      </svg>
      <span id="rps-secs" class="text-4xl font-extrabold text-white tabular-nums sm:text-5xl">${secs}</span>
    </div>`;
  }

  /* -------------------------------------------------------------- stages */

  function stageChoosing(fresh = false) {
    const amIn = !spectator && state.contenders.includes(myId);
    const mine = state.mine;
    const locked = state.players.filter(p => state.contenders.includes(p.id) && p.locked).length;
    const total = state.contenders.length;
    const secs = Math.ceil(remaining() / 1000);
    let top;
    let sub;
    if (spectator) { top = 'Players are choosing'; sub = `${locked} of ${total} locked in`; }
    else if (!amIn) { top = me()?.left ? 'You left the game' : (state.mode === 'elimination' ? 'You are out' : 'Sit this one out'); sub = state.mode === 'elimination' ? 'Watch the others fight it out.' : 'Only the tied players throw in sudden death.'; }
    else if (mine) { top = 'Locked in'; sub = locked < total ? `Waiting for ${total - locked} more. You can still change your mind.` : 'Everybody is ready.'; }
    else { top = 'Choose your move'; sub = 'Tap one. No pick means a random move.'; }

    const lockedChips = state.contenders.map((id) => {
      const p = state.players.find(x => x.id === id);
      return `<li class="flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-1 text-xs font-medium ${p.locked ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/6 text-slate-400'}">${WBG.avatar(p.name, 'size-5 text-[10px]')}<span class="max-w-20 truncate">${WBG.esc(p.name)}</span>${WBG.icon(p.locked ? 'rps-lock' : 'clock', 'size-3.5')}</li>`;
    }).join('');

    $('rps-stage').innerHTML = `
      <div class="${fresh ? 'reveal ' : ''}flex w-full flex-col items-center gap-4">
        <div class="flex items-center gap-4">
          <div class="text-brand-300">${ring(secs, remaining() / 8000)}</div>
          <div class="text-left">
            <p class="text-lg font-bold text-white sm:text-xl">${top}</p>
            <p class="max-w-56 text-sm text-slate-400">${sub}</p>
          </div>
        </div>
        ${amIn ? `<div id="rps-moves" class="grid w-full max-w-xl grid-cols-3 gap-2.5 sm:gap-4">${MOVES.map(m => moveBtn(m, { active: mine === m })).join('')}</div>`
          : `<div class="flex size-24 items-center justify-center rounded-3xl bg-white/5 text-slate-500">${WBG.icon('eye', 'size-10')}</div>`}
        <ul class="flex max-w-xl flex-wrap justify-center gap-1.5">${lockedChips}</ul>
      </div>`;
  }

  function stageShoot() {
    const amIn = state.contenders.includes(myId);
    $('rps-stage').innerHTML = `
      <div class="flex w-full flex-col items-center gap-5">
        <div id="rps-hands" class="flex items-center justify-center gap-6 sm:gap-12">
          <span id="rps-hand-a" class="block size-28 sm:size-40" style="transform: scaleX(-1)">${WBG.art.rps('rock')}</span>
          <span id="rps-hand-b" class="block size-28 sm:size-40">${WBG.art.rps('rock')}</span>
        </div>
        <p id="rps-word" class="h-12 text-4xl font-black tracking-tight text-white uppercase sm:h-16 sm:text-6xl"></p>
        <p class="text-sm text-slate-400">${amIn ? 'Your move is locked in.' : 'Moves are about to be revealed.'}</p>
      </div>`;
    if (!reduceMotion) {
      for (const id of ['rps-hand-a', 'rps-hand-b']) {
        const flip = id === 'rps-hand-a' ? ' scaleX(-1)' : '';
        $(id).animate([
          { transform: `translateY(0)${flip}` }, { transform: `translateY(-26px) rotate(-6deg)${flip}` }, { transform: `translateY(0)${flip}` }
        ], { duration: 560, iterations: 3 });
      }
    }
  }

  function resultChip(t) {
    if (state.mode === 'points' && t.result === 'draw' && t.delta > 0) {
      return `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-bold text-emerald-200">${WBG.icon('trophy', 'size-3.5')}+${t.delta}</span>`;
    }
    const map = {
      win: ['Win', 'bg-emerald-500/20 text-emerald-300', 'trophy'],
      lose: ['Lose', 'bg-rose-500/20 text-rose-300', 'rps-x'],
      draw: ['Draw', 'bg-white/10 text-slate-300', 'rps-eq']
    }[t.result];
    return `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${map[1]}">${WBG.icon(map[2], 'size-3.5')}${map[0]}${t.delta > 0 ? ` +${t.delta}` : ''}</span>`;
  }

  function headline(rev) {
    const t = rev.throws[myId];
    const elim = state.mode === 'elimination';
    if (rev.outcome === 'draw') return { text: elim ? 'Draw: replay the round' : 'Draw', tone: 'text-slate-200' };
    if (elim && rev.eliminated.length) {
      const names = rev.eliminated.map(nameOf);
      if (t) {
        return t.result === 'lose'
          ? { text: 'You are out', tone: 'text-rose-300' }
          : { text: 'You survive', tone: 'text-emerald-300' };
      }
      return { text: names.length > 2 ? `${names.length} players are out` : `${names.join(' and ')} out`, tone: 'text-rose-300' };
    }
    if (t) {
      if (t.result === 'win') return { text: t.delta > 1 ? `You win +${t.delta}` : 'You win', tone: 'text-emerald-300' };
      if (t.result === 'lose') return { text: 'You lose', tone: 'text-rose-300' };
      return t.delta > 0 ? { text: `You score +${t.delta}`, tone: 'text-emerald-300' } : { text: 'No change for you', tone: 'text-slate-200' };
    }
    return { text: 'Round result', tone: 'text-slate-200' };
  }

  function stageReveal() {
    const rev = state.reveal;
    const ids = state.contenders.length ? state.contenders : Object.keys(rev.throws);
    const big = ids.length <= 3;
    const h = headline(rev);
    const cards = ids.map((id, i) => {
      const t = rev.throws[id];
      if (!t) return '';
      const p = state.players.find(x => x.id === id);
      const win = t.result === 'win' && rev.outcome !== 'draw';
      const lose = t.result === 'lose';
      return `<li class="rps-card flex flex-col items-center gap-1.5 rounded-2xl border-2 px-2 py-3 ${win ? 'border-emerald-400/70 bg-emerald-500/12 shadow-[0_0_24px_rgb(52_211_153/0.25)]' : lose ? 'border-rose-400/30 bg-rose-500/6 opacity-75' : 'border-white/10 bg-white/5'} ${id === myId ? 'ring-2 ring-brand-400/60' : ''}" style="animation-delay:${i * 70}ms" data-i="${i}">
        <span class="${big ? 'size-20 sm:size-28' : 'size-14 sm:size-20'} block">${WBG.art.rps(t.move)}</span>
        <span class="flex max-w-full items-center gap-1.5">${WBG.avatar(p?.name || '?', 'size-5 text-[10px]')}<span class="max-w-24 truncate text-sm font-semibold text-white">${WBG.esc(p?.name || '')}${id === myId ? ' (you)' : ''}</span></span>
        ${resultChip(t)}
        ${t.afk ? '<span class="text-[10px] font-bold tracking-wider text-amber-300 uppercase">AFK random</span>' : ''}
      </li>`;
    }).join('');
    const last = state.phase === 'over';
    $('rps-stage').innerHTML = `
      <div class="flex w-full flex-col items-center gap-4">
        <p class="reveal text-2xl font-extrabold tracking-tight sm:text-3xl ${h.tone}">${WBG.esc(h.text)}</p>
        <ul class="grid w-full max-w-2xl ${big ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-4'} gap-2 sm:gap-3">${cards}</ul>
        <p id="rps-foot" class="text-sm text-slate-400">${last ? 'Final result' : 'Next round starting...'}</p>
      </div>`;
    if (!reduceMotion) {
      for (const el of $('rps-stage').querySelectorAll('.rps-card')) {
        el.animate([{ transform: 'rotateY(90deg) scale(0.8)', opacity: 0 }, { transform: 'none', opacity: 1 }],
          { duration: 360, delay: Number(el.dataset.i) * 70, easing: 'cubic-bezier(.2,1.1,.4,1)', fill: 'backwards' });
      }
    }
  }

  function stageWaiting() {
    $('rps-stage').innerHTML = `<div class="reveal"><span class="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-white/8 text-brand-300">${WBG.icon('spinner', 'size-7 animate-spin')}</span>
      <p class="font-semibold text-white">Waiting for everyone to load...</p></div>`;
  }

  /* ------------------------------------------------------------ chrome */

  function renderHeader() {
    const elim = state.mode === 'elimination';
    const alive = state.players.filter(p => p.alive && !p.left).length;
    let eyebrow;
    if (elim) eyebrow = `Round ${Math.max(1, state.round)}`;
    else if (state.sudden) eyebrow = `Sudden death, round ${state.round}`;
    else eyebrow = `Round ${Math.max(1, state.round)} of ${state.rounds}`;
    const titles = { waiting: 'Getting ready', choosing: 'Make your pick', shoot: 'Get set', reveal: 'The reveal', over: 'Game over' };
    $('rps-eyebrow').textContent = eyebrow;
    $('rps-title').textContent = titles[state.phase] || 'Rock Paper Scissors';
    $('rps-mode').className = `chip shrink-0 ${elim || state.sudden ? 'chip-danger' : 'chip-brand'}`;
    $('rps-mode').innerHTML = elim ? `${WBG.icon('users', 'size-3.5')}${alive} left` : (state.sudden ? `${WBG.icon('bolt', 'size-3.5')}Sudden death` : `${WBG.icon('trophy', 'size-3.5')}Points`);
  }

  function renderBoard() {
    const elim = state.mode === 'elimination';
    $('rps-board-title').innerHTML = `${WBG.icon(elim ? 'users' : 'trophy', 'size-4 text-amber-300')}${elim ? 'Players' : 'Scoreboard'}`;
    const rows = [...state.players].sort((a, b) => elim
      ? (Number(b.alive && !b.left) - Number(a.alive && !a.left)) || (b.score - a.score)
      : (b.score - a.score));
    $('rps-board').innerHTML = rows.map((p) => {
      const out = elim && !p.alive;
      let tag = '';
      if (p.left) tag = '<span class="chip chip-danger">Left</span>';
      else if (out) tag = '<span class="chip chip-danger">Out</span>';
      else if (p.afk) tag = '<span class="chip chip-warn">AFK</span>';
      const score = elim ? '' : `<span class="text-lg font-bold text-white tabular-nums">${p.score}</span>`;
      return `<li class="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 ${p.id === myId ? 'bg-brand-500/15' : 'bg-white/4'} ${out || p.left ? 'opacity-55' : ''}">
        ${WBG.avatar(p.name, 'size-8 text-xs')}
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-white">${WBG.esc(p.name)}${p.id === myId ? ' <span class="text-slate-400">(you)</span>' : ''}</span>
        ${tag}${score}</li>`;
    }).join('');
  }

  function renderHistory() {
    const h = state.history;
    $('rps-history-wrap').hidden = h.length === 0;
    $('rps-history').innerHTML = h.map((r) => {
      const mineT = r.throws[myId];
      const res = mineT?.result;
      const tone = res === 'win' ? 'border-emerald-400/60 bg-emerald-500/10' : res === 'lose' ? 'border-rose-400/40 bg-rose-500/8' : 'border-white/10 bg-white/5';
      const body = mineT
        ? `<span class="block size-8">${WBG.art.rps(mineT.move)}</span>`
        : `<span class="grid size-8 place-items-center text-slate-400">${WBG.icon(r.outcome === 'draw' ? 'rps-eq' : 'users', 'size-5')}</span>`;
      return `<li class="flex w-12 shrink-0 flex-col items-center rounded-xl border px-1 py-1.5 ${tone}" title="Round ${r.round}${r.sudden ? ' (sudden death)' : ''}">
        ${body}<span class="mt-0.5 text-[10px] font-semibold text-slate-400">${r.sudden ? 'SD' : ''}${r.round}</span></li>`;
    }).join('');
    const el = $('rps-history');
    el.scrollLeft = el.scrollWidth;
  }

  /* --------------------------------------------------------------- tick */

  function tick() {
    if (!state) return;
    if (state.phase === 'choosing') {
      const left = remaining();
      const secs = Math.ceil(left / 1000);
      const s = $('rps-secs');
      if (s && s.textContent !== String(secs)) {
        s.textContent = secs;
        if (secs <= 3 && secs > 0) { WBG.sound.play('tick'); }
      }
      const r = $('rps-ring');
      if (r) {
        const C = 2 * Math.PI * 44;
        r.setAttribute('stroke-dashoffset', (C * (1 - Math.min(1, left / 8000))).toFixed(1));
        r.classList.toggle('text-rose-400', secs <= 3);
        r.classList.toggle('text-brand-400', secs > 3);
      }
    } else if (state.phase === 'shoot') {
      const elapsed = Math.max(0, SHOOT_MS - remaining());
      let beat = -1;
      BEATS.forEach((t, i) => { if (elapsed >= t) beat = i; });
      if (beat !== lastBeat && beat >= 0) {
        lastBeat = beat;
        const w = $('rps-word');
        if (w) {
          w.textContent = WORDS[beat];
          w.classList.toggle('text-amber-300', beat === 3);
          if (!reduceMotion) w.animate([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1.08)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 220 });
        }
        if (beat === 3) {
          WBG.sound.play('go');
          WBG.haptic(30);
          const a = $('rps-hand-a');
          const b = $('rps-hand-b');
          if (a && b && !reduceMotion) {
            a.animate([{ transform: 'translateX(0) scaleX(-1)' }, { transform: 'translateX(26px) scaleX(-1) scale(1.12)' }], { duration: 300, fill: 'forwards' });
            b.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-26px) scale(1.12)' }], { duration: 300, fill: 'forwards' });
          }
        } else WBG.sound.play('countdown');
      }
    }
  }

  /* -------------------------------------------------------------- render */

  function render() {
    renderHeader();
    renderBoard();
    renderHistory();
    const key = state.phase === 'reveal' || state.phase === 'over' ? `reveal-${state.reveal?.round}` : `${state.phase}-${state.round}`;
    const sameStage = key === lastKey;
    lastKey = key;
    switch (state.phase) {
      case 'waiting': return stageWaiting();
      case 'choosing': return stageChoosing(!sameStage);
      case 'shoot':
        if (!sameStage) { lastBeat = -1; stageShoot(); }
        return;
      case 'reveal':
      case 'over':
        if (state.reveal) {
          if (!sameStage) { stageReveal(); onRevealed(); }
          else if (state.phase === 'over' && $('rps-foot')) $('rps-foot').textContent = 'Final result';
        } else $('rps-stage').innerHTML = '';
    }
  }

  function onRevealed() {
    const rev = state.reveal;
    const first = revealedRound !== rev.round;
    revealedRound = rev.round;
    if (!first || prevPhase !== 'shoot') return;   // reloaded mid-reveal: show it quietly
    WBG.sound.play('reveal');
    later(() => {
      const t = rev.throws[myId];
      if (!t || rev.outcome === 'draw') { WBG.sound.play('pop'); return; }
      if (t.result === 'win') { WBG.sound.play(state.mode === 'elimination' ? 'win' : 'coin'); WBG.haptic([20, 40, 20]); }
      else if (t.result === 'lose') { WBG.sound.play('error'); WBG.haptic(60); }
      else WBG.sound.play('pop');
    }, 380);
  }

  socket.on('rps-state', (s) => {
    offset = (s.now || Date.now()) - Date.now();
    prevPhase = state?.phase ?? null;
    prevRound = state?.round ?? -1;
    state = s;
    if (s.phase === 'choosing' && prevPhase !== 'choosing' && !spectator && s.contenders.includes(myId)) WBG.sound.play('turn');
    render();
    tick();
  });

  // Picking: delegated so re-rendering never loses the handler.
  $('rps-stage').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (btn) choose(btn.dataset.move);
  });

  function choose(move) {
    if (spectator || !state || state.phase !== 'choosing' || !state.contenders.includes(myId)) return;
    if (state.mine === move) return;
    WBG.sound.play('click');
    WBG.haptic(15);
    state.mine = move;                       // optimistic; the server echoes the real state
    stageChoosing();
    socket.emit('rps-move', { move });
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || /input|textarea/i.test(e.target.tagName)) return;
    const move = KEYS[e.key.toLowerCase()];
    if (move) choose(move);
  }
  document.addEventListener('keydown', onKey);

  ticker = setInterval(tick, 100);
  WBG.gameReady('rps-page-loaded');
})();
