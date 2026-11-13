(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const spectator = WBG.isSpectator;
  const TURN_MS = 30000;
  const COLORS = { red: '#dc2626', yellow: '#eab308', green: '#16a34a', blue: '#2563eb' };
  const WILD_BG = 'conic-gradient(#dc2626 0 25%, #2563eb 0 50%, #16a34a 0 75%, #eab308 0)';

  let state = null;
  let wasMyTurn = false;

  const timer = setInterval(tick, 150);
  WBG.onTeardown(() => clearInterval(timer));
  socket.off('uno-state');

  const bgOf = (card) => (card.color === 'wild' ? WILD_BG : COLORS[card.color]);

  function face(card, big) {
    const textColor = card.color === 'wild' ? '#111827' : COLORS[card.color];
    const size = big ? 'size-9' : 'size-7';
    let inner;
    switch (card.value) {
      case 'skip': inner = WBG.icon('skip', size); break;
      case 'reverse': inner = WBG.icon('swap', size); break;
      case 'draw2': inner = '+2'; break;
      case 'wild4': inner = '+4'; break;
      case 'wild': inner = WBG.icon('star', size); break;
      default: inner = card.value;
    }
    return { inner, textColor };
  }

  function corner(card) {
    return { skip: 'S', reverse: 'R', draw2: '+2', wild: 'W', wild4: '+4' }[card.value] || card.value;
  }

  function cardEl(card, { big = false, playable = false, dim = false, lifted = false, ring = false } = {}) {
    const el = document.createElement(playable ? 'button' : 'div');
    const { inner, textColor } = face(card, big);
    const scale = big ? 1.2 : 1;
    el.style.cssText = `width:calc(var(--cw)*${scale});height:calc(var(--ch)*${scale});background:${bgOf(card)}`;
    el.className = `relative shrink-0 select-none overflow-hidden rounded-xl border-[3px] border-white shadow-lg transition duration-150 ${dim ? 'opacity-45' : ''} ${lifted ? '-translate-y-3' : ''} ${ring ? 'ring-4 ring-emerald-400' : ''} ${playable ? 'cursor-pointer hover:-translate-y-4 active:scale-95' : ''}`;
    el.innerHTML = `<span class="absolute inset-[14%] -rotate-[24deg] rounded-[50%] bg-white/95"></span>
      <span class="absolute inset-0 grid place-items-center text-2xl font-black ${big ? 'sm:text-4xl' : ''}" style="color:${textColor}">${inner}</span>
      <span class="absolute top-1 left-1.5 text-[10px] font-extrabold text-white drop-shadow">${corner(card)}</span>
      <span class="absolute right-1.5 bottom-1 rotate-180 text-[10px] font-extrabold text-white drop-shadow">${corner(card)}</span>`;
    el.setAttribute('aria-label', card.color === 'wild' ? (card.value === 'wild4' ? 'Wild draw four' : 'Wild') : `${card.color} ${card.value}`);
    return el;
  }

  const playable = (card) => card.color === 'wild' || card.color === state.color || card.value === state.top.value;

  function render() {
    if (!state) return;
    const myTurn = state.turn === myId && !state.winner;

    // opponents
    $('uno-players').replaceChildren(...state.players.map((p) => {
      const li = document.createElement('li');
      const turn = p.id === state.turn && !state.winner;
      li.className = `flex shrink-0 items-center gap-2 rounded-2xl border px-3 py-2 transition ${turn ? 'border-emerald-400/60 bg-emerald-500/12' : 'border-white/8 bg-white/4'}`;
      li.innerHTML = `${WBG.avatar(p.name, 'size-8')}
        <span class="max-w-24 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}${p.id === myId ? ' (you)' : ''}</span>
        <span class="flex items-center gap-1 text-sm font-bold tabular-nums ${p.count === 1 ? 'text-rose-300' : 'text-slate-300'}">${WBG.icon('cards', 'size-4')}${p.count}</span>
        ${p.count === 1 ? '<span class="chip chip-danger">UNO</span>' : ''}`;
      return li;
    }));

    // table
    $('uno-top').replaceChildren(cardEl(state.top.color === 'wild' ? { ...state.top, color: state.color } : state.top, { big: true }));
    const ring = $('uno-color-ring');
    ring.style.background = COLORS[state.color];
    ring.title = `Current colour: ${state.color}`;
    ring.innerHTML = WBG.icon(state.dir === 1 ? 'refresh' : 'undo', 'size-4 text-white drop-shadow');
    $('uno-deck-count').textContent = `${state.deckCount}`;
    $('uno-deck').disabled = !myTurn || state.pending !== null;
    $('uno-log').textContent = state.winner ? state.log : (myTurn && !state.pending ? `Your turn. ${state.log}` : state.log);
    $('uno-pass').hidden = !(myTurn && state.pending !== null);

    // hand
    const hand = $('uno-hand');
    $('uno-hand-label').textContent = spectator ? 'Host view: hands are private' : `Your hand (${state.hand.length})`;
    if (spectator) {
      hand.replaceChildren();
    } else {
      hand.replaceChildren(...state.hand.map((card) => {
        const ok = myTurn && playable(card) && (state.pending === null || state.pending === card.id);
        const el = cardEl(card, { playable: ok, dim: !ok, lifted: ok, ring: state.pending === card.id });
        if (ok) {
          el.addEventListener('click', () => {
            WBG.haptic(12);
            if (card.color === 'wild') chooseColor((color) => socket.emit('uno-play', { cardId: card.id, color }));
            else socket.emit('uno-play', { cardId: card.id });
          });
        }
        return el;
      }));
    }

    // winner
    $('uno-winner').hidden = !state.winner;
    if (state.winner) {
      const w = state.players.find((p) => p.id === state.winner);
      $('uno-winner-text').textContent = state.winner === myId ? 'You win' : `${w ? w.name : 'Someone'} wins`;
    }

    if (myTurn && !wasMyTurn) WBG.haptic([30, 40, 30]);
    wasMyTurn = myTurn;
    tick();
  }

  function tick() {
    if (!state || !state.deadline || state.winner) {
      $('uno-timer').textContent = '';
      $('uno-bar').style.width = '0%';
      return;
    }
    const left = Math.max(0, state.deadline - Date.now());
    $('uno-bar').style.width = `${Math.min(100, (left / TURN_MS) * 100)}%`;
    $('uno-timer').textContent = `${Math.ceil(left / 1000)}s`;
  }

  function chooseColor(done) {
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
  }

  socket.on('uno-state', (s) => { state = s; render(); });
  $('uno-deck').addEventListener('click', () => socket.emit('uno-draw'));
  $('uno-pass').addEventListener('click', () => socket.emit('uno-pass'));

  WBG.gameReady('uno-page-loaded');
})();
