(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const IMAGES = { rock: '/images/rps-rock.png', paper: '/images/rps-paper.png', scissors: '/images/rps-scissors.png' };
  const spectator = WBG.isSpectator;

  let countdownTimer = 0;

  WBG.onTeardown(() => clearInterval(countdownTimer));

  for (const ev of ['rps-game-started', 'update-scoreboard', 'rps-move-selected', 'rps-game-ended']) socket.off(ev);

  function show(which) {
    for (const id of ['rps-wait', 'rps-popup', 'rps-reveal']) $(id).hidden = id !== which;
  }

  function renderScores(data) {
    const list = $('rps-scores');
    const rows = Object.entries(data).sort((a, b) => b[1].score - a[1].score);
    list.replaceChildren(...rows.map(([id, p]) => {
      const li = document.createElement('li');
      li.className = `flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${id === myId ? 'bg-brand-500/20' : 'bg-white/4'}`;
      li.innerHTML = `${WBG.avatar(p.name, 'size-6 text-[11px]')}<span class="min-w-0 flex-1 truncate text-white">${WBG.esc(p.name)}</span><span class="font-bold tabular-nums ${p.score < 0 ? 'text-rose-300' : 'text-emerald-300'}">${p.score > 0 ? '+' : ''}${p.score}</span>`;
      return li;
    }));
  }

  function setSelected(move) {
    for (const btn of document.querySelectorAll('.rps-move')) {
      const on = btn.dataset.move === move;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('border-brand-400', on);
      btn.classList.toggle('bg-brand-500/20', on);
      btn.classList.toggle('border-white/10', !on);
    }
  }

  function startCountdown(endUnix) {
    clearInterval(countdownTimer);
    const total = Math.max(1000, endUnix - Date.now());
    const tick = () => {
      const left = Math.max(0, endUnix - Date.now());
      $('rps-countdown').textContent = String(Math.ceil(left / 1000));
      $('rps-bar').style.width = `${Math.min(100, (left / total) * 100)}%`;
      if (left <= 0) clearInterval(countdownTimer);
    };
    tick();
    countdownTimer = setInterval(tick, 100);
  }

  socket.on('rps-game-started', ({ countdownEndUnix, round, maxRounds }) => {
    $('rps-round').textContent = round ?? 1;
    $('rps-rounds').textContent = maxRounds ?? 3;
    setSelected(null);
    $('rps-title').textContent = spectator ? 'Players are choosing' : 'Choose your move';
    $('rps-moves').classList.toggle('hidden', spectator);
    $('rps-hint').textContent = spectator ? 'Host view: moves are revealed when time is up.' : 'No pick? A random move is chosen for you.';
    show('rps-popup');
    startCountdown(countdownEndUnix);
  });

  socket.on('update-scoreboard', ({ playerGameData }) => renderScores(playerGameData));

  socket.on('rps-move-selected', ({ move }) => setSelected(move));

  socket.on('rps-game-ended', ({ playerGameData, round, final }) => {
    clearInterval(countdownTimer);
    $('rps-reveal-round').textContent = round ?? '';
    $('rps-reveal-title').textContent = final ? 'Final round revealed' : 'Moves revealed';
    const grid = $('rps-reveal-grid');
    grid.replaceChildren(...Object.entries(playerGameData).map(([id, p], i) => {
      const card = document.createElement('div');
      card.className = `card-flat animate-pop p-4 ${id === myId ? 'ring-2 ring-brand-400' : ''}`;
      card.style.animationDelay = `${i * 70}ms`;
      card.innerHTML = `<img src="${IMAGES[p.move]}" alt="${WBG.esc(p.move)}" class="mx-auto size-20 object-contain" width="80" height="80">
        <p class="mt-2 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}</p>
        <p class="text-xs text-slate-400 capitalize">${WBG.esc(p.move)}</p>`;
      return card;
    }));
    show('rps-reveal');
  });

  for (const btn of document.querySelectorAll('.rps-move')) {
    btn.addEventListener('click', () => {
      if (spectator) return;
      WBG.haptic();
      setSelected(btn.dataset.move); // optimistic; the server confirms
      socket.emit('rps-select-move', { move: btn.dataset.move });
    });
  }

  WBG.gameReady('rps-page-loaded');
})();
