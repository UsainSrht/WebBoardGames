(() => {
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const LIGHT = '#dde2f4';
  const DARK = '#6a76ad';

  let state = null;
  let selected = null;
  let flipped = false;

  socket.off('chess-state');

  const sq = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
  const isWhite = (p) => p !== '.' && p === p.toUpperCase();

  /** Pieces each side has lost, derived from the board. */
  function captured() {
    const have = { w: { ...START }, b: { ...START } };
    for (const k of Object.keys(have.w)) { have.w[k] = 0; have.b[k] = 0; }
    for (const ch of state.board) {
      if (ch === '.' || ch.toLowerCase() === 'k') continue;
      have[isWhite(ch) ? 'w' : 'b'][ch.toLowerCase()]++;
    }
    const lost = (c) => Object.entries(START).flatMap(([k, n]) => Array(Math.max(0, n - have[c][k])).fill(k));
    return { w: lost('w'), b: lost('b') }; // pieces lost BY colour c
  }

  function playerBar(el, color, id) {
    const name = state.names[id] || 'Player';
    const mine = id === myId;
    const turn = !state.result && state.turn === color;
    const lost = captured();
    const taken = lost[color === 'w' ? 'b' : 'w']; // pieces this colour has captured
    const score = taken.reduce((s, k) => s + VALUE[k], 0);
    const other = lost[color]; const otherScore = other.reduce((s, k) => s + VALUE[k], 0);
    const lead = score - otherScore;
    el.className = `flex items-center gap-3 rounded-2xl border px-3 py-2 transition ${turn ? 'border-brand-400/60 bg-brand-500/12' : 'border-white/8 bg-white/4'}`;
    el.innerHTML = `${WBG.avatar(name)}
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-2 text-sm font-semibold text-white"><span class="truncate">${WBG.esc(name)}</span>${mine ? '<span class="chip">you</span>' : ''}
          <span class="inline-block size-3.5 shrink-0 rounded-full border border-white/30 ${color === 'w' ? 'bg-slate-100' : 'bg-slate-800'}" title="${color === 'w' ? 'White' : 'Black'}"></span></p>
        <p class="flex h-4 items-center gap-px">${taken.map((k) => WBG.chessPiece(color === 'w' ? k : k.toUpperCase(), 'size-4 -mr-1')).join('')}${lead > 0 ? `<span class="ml-2 text-xs text-slate-400">+${lead}</span>` : ''}</p>
      </div>
      ${turn ? `<span class="chip chip-brand animate-pulse-soft">${state.check ? 'Check' : 'To move'}</span>` : ''}`;
  }

  function render() {
    if (!state) return;
    const myColor = state.white === myId ? 'w' : state.black === myId ? 'b' : null;
    const bottomColor = (myColor === 'b') !== flipped ? 'b' : 'w';
    const myTurn = !state.result && myColor === state.turn;
    const targets = new Map();
    if (selected && myTurn) for (const m of state.legal) if (m.from === selected) targets.set(m.to, true);

    const board = $('chess-board');
    const cells = [];
    for (let k = 0; k < 64; k++) {
      const i = bottomColor === 'b' ? 63 - k : k;
      const name = sq(i);
      const row = Math.floor(i / 8), col = i % 8;
      const piece = state.board[i];
      const dark = (row + col) % 2 === 1;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'relative grid aspect-square place-items-center p-0 outline-offset-[-3px]';
      cell.style.background = dark ? DARK : LIGHT;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${name}${piece !== '.' ? ` ${isWhite(piece) ? 'white' : 'black'} ${piece.toLowerCase()}` : ''}`);
      const inMove = state.lastMove && (state.lastMove.from === name || state.lastMove.to === name);
      let html = '';
      if (inMove) html += '<span class="absolute inset-0 bg-amber-300/45"></span>';
      if (selected === name) html += '<span class="absolute inset-0 bg-emerald-400/55"></span>';
      if (state.check && piece === (state.turn === 'w' ? 'K' : 'k')) html += '<span class="absolute inset-0" style="background:radial-gradient(circle,rgba(244,63,94,.85),rgba(244,63,94,0) 70%)"></span>';
      if (piece !== '.') {
        const moved = state.lastMove && state.lastMove.to === name;
        html += `<span class="relative size-[88%] ${moved ? 'animate-pop' : ''}">${WBG.chessPiece(piece)}</span>`;
      }
      if (targets.has(name)) {
        html += piece !== '.'
          ? '<span class="absolute inset-[6%] rounded-full border-[5px] border-emerald-500/70"></span>'
          : '<span class="absolute size-[28%] rounded-full bg-emerald-600/70"></span>';
      }
      if (col === (bottomColor === 'w' ? 0 : 7) ) html += `<span class="pointer-events-none absolute top-0.5 left-1 text-[10px] font-bold" style="color:${dark ? LIGHT : DARK}">${8 - row}</span>`;
      if (row === (bottomColor === 'w' ? 7 : 0)) html += `<span class="pointer-events-none absolute right-1 bottom-0.5 text-[10px] font-bold" style="color:${dark ? LIGHT : DARK}">${'abcdefgh'[col]}</span>`;
      cell.innerHTML = html;
      cell.addEventListener('click', () => onCell(name, piece, myTurn, myColor));
      cells.push(cell);
    }
    board.replaceChildren(...cells);

    const topColor = bottomColor === 'w' ? 'b' : 'w';
    const idOf = (c) => (c === 'w' ? state.white : state.black);
    playerBar($('chess-top'), topColor, idOf(topColor));
    playerBar($('chess-bottom'), bottomColor, idOf(bottomColor));

    const nameOf = (id) => state.names[id] || 'Player';
    let status;
    if (state.result) status = state.result.winner ? `${nameOf(state.result.winner)} wins by ${state.result.reason}` : `Draw by ${state.result.reason}`;
    else if (!myColor) status = `${nameOf(idOf(state.turn))} to move${state.check ? ' - check' : ''}`;
    else status = myTurn ? (state.check ? 'Your move - you are in check' : 'Your move') : 'Waiting for your opponent';
    $('chess-status').textContent = status;

    $('chess-resign').hidden = !!state.result || !myColor;

    const res = $('chess-result');
    res.hidden = !state.result;
    if (state.result) {
      $('chess-result-title').textContent = state.result.winner
        ? (state.result.winner === myId ? 'You win' : `${nameOf(state.result.winner)} wins`)
        : 'Draw';
      $('chess-result-sub').textContent = `By ${state.result.reason}. Returning to the lobby shortly.`;
    }
  }

  function onCell(name, piece, myTurn, myColor) {
    if (!myTurn) return;
    if (selected) {
      const options = state.legal.filter((m) => m.from === selected && m.to === name);
      if (options.length) {
        const from = selected;
        selected = null;
        if (options.some((m) => m.promo)) { render(); return askPromotion(from, name, myColor); }
        WBG.haptic(10);
        socket.emit('chess-move', { from, to: name });
        // optimistic: clear the selection immediately; the server state redraws the board
        render();
        return;
      }
    }
    const mine = piece !== '.' && (isWhite(piece) ? 'w' : 'b') === myColor;
    selected = mine && state.legal.some((m) => m.from === name) ? (selected === name ? null : name) : null;
    render();
  }

  function askPromotion(from, to, color) {
    const box = $('chess-promo-options');
    box.replaceChildren(...['q', 'r', 'b', 'n'].map((p) => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary size-16 p-2';
      b.setAttribute('aria-label', `Promote to ${p}`);
      b.innerHTML = WBG.chessPiece(color === 'w' ? p.toUpperCase() : p);
      b.addEventListener('click', () => {
        $('chess-promo').hidden = true;
        socket.emit('chess-move', { from, to, promotion: p });
      });
      return b;
    }));
    $('chess-promo').hidden = false;
  }

  socket.on('chess-state', (s) => { state = s; selected = null; render(); });
  $('chess-flip').addEventListener('click', () => { flipped = !flipped; render(); });
  $('chess-resign').addEventListener('click', () => {
    if (confirm('Resign this game?')) socket.emit('chess-resign');
  });

  WBG.gameReady('chess-page-loaded');
})();
