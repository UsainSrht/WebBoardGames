(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const PHASE_MS = { rolling: 15000, reveal: 4000, over: 10000 };

  let state = null;
  let lastRound = -1;
  let rolledBefore = false;

  const timer = setInterval(tick, 120);
  WBG.onTeardown(() => clearInterval(timer));
  socket.off('dice-state');

  const pips = (dice, cls) => `<span class="animate-pop">${WBG.dieFace(dice[0], cls)}</span><span class="animate-pop" style="animation-delay:80ms">${WBG.dieFace(dice[1], cls)}</span>`;

  function render() {
    if (!state) return;
    const { round, maxRounds, phase, players, roundWinners } = state;
    const me = players[myId];

    $('dice-phase').textContent = { waiting: 'Waiting for players', rolling: 'Roll now', reveal: 'Round results', over: 'Final results' }[phase];
    $('dice-round').textContent = round;
    $('dice-rounds').textContent = maxRounds;

    // my dice
    const mine = $('dice-mine');
    if (spectator) {
      mine.innerHTML = `<p class="flex items-center gap-2 text-sm text-slate-400">${WBG.icon('eye', 'size-5 text-brand-300')}Host view: watching the table</p>`;
    } else if (me?.dice) {
      mine.innerHTML = `${pips(me.dice, 'size-16')}<span class="text-3xl font-bold text-white">= ${me.total}</span>`;
    } else {
      mine.innerHTML = `<span class="text-slate-500">${WBG.dieFace(1, 'size-16 opacity-30')}</span><span class="text-slate-500">${WBG.dieFace(1, 'size-16 opacity-30')}</span>`;
    }

    const btn = $('dice-roll-btn');
    btn.hidden = spectator;
    btn.disabled = !(phase === 'rolling' && me && !me.dice);
    btn.querySelector('span').textContent = phase === 'rolling' && me?.dice ? 'Waiting for the others...' : 'Roll the dice';

    // table
    const rows = Object.entries(players).sort((a, b) => b[1].score - a[1].score || a[1].name.localeCompare(b[1].name));
    $('dice-players').replaceChildren(...rows.map(([id, p]) => {
      const li = document.createElement('li');
      const hidden = phase === 'rolling' && id !== myId;
      const won = (phase === 'reveal' || phase === 'over') && roundWinners.includes(id);
      li.className = `flex items-center gap-3 rounded-2xl border p-3 transition ${won ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-white/8 bg-white/4'}`;
      const diceHtml = p.dice
        ? (hidden ? `<span class="chip chip-success">${WBG.icon('check', 'size-3.5')}Rolled</span>` : `<span class="flex gap-1">${pips(p.dice, 'size-9')}</span><span class="w-8 text-sm text-slate-300 tabular-nums">${p.total}</span>`)
        : '<span class="text-sm text-slate-500">Not rolled</span>';
      li.innerHTML = `${WBG.avatar(p.name)}
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}${id === myId ? ' <span class="chip ml-1">you</span>' : ''}</span>
        <span class="flex items-center gap-2">${diceHtml}</span>
        <span class="w-14 text-right text-sm font-bold text-brand-300 tabular-nums">${p.score} pt${p.score === 1 ? '' : 's'}</span>`;
      return li;
    }));

    // final
    const fin = $('dice-final');
    fin.hidden = phase !== 'over';
    if (phase === 'over') {
      const best = Math.max(...rows.map(([, p]) => p.score));
      const winners = rows.filter(([, p]) => p.score === best).map(([, p]) => p.name);
      $('dice-final-text').textContent = winners.length > 1 ? `Tie between ${winners.join(' and ')}` : `${winners[0]} wins`;
    }

    if (phase === 'rolling' && round !== lastRound) { lastRound = round; rolledBefore = false; }
    if (phase === 'rolling' && me?.dice && !rolledBefore) { rolledBefore = true; WBG.haptic(20); }
    tick();
  }

  function tick() {
    if (!state || !state.deadline || state.phase === 'waiting') {
      $('dice-timer').textContent = '';
      $('dice-bar').style.width = '0%';
      return;
    }
    const left = Math.max(0, state.deadline - Date.now());
    const total = PHASE_MS[state.phase] || 1;
    $('dice-bar').style.width = `${Math.min(100, (left / total) * 100)}%`;
    const s = Math.ceil(left / 1000);
    $('dice-timer').textContent = state.phase === 'rolling' ? `${s}s left to roll`
      : state.phase === 'reveal' ? `Next round in ${s}s` : `Back to the lobby in ${s}s`;
  }

  socket.on('dice-state', (s) => { state = s; render(); });
  $('dice-roll-btn').addEventListener('click', () => {
    WBG.haptic(15);
    socket.emit('dice-roll');
  });

  WBG.gameReady('dice-page-loaded');
})();
