await WBG.i18n.load('chess');
WBG.i18n.apply(document.getElementById('game-board'));

(() => {
  const t = WBG.t;
  const $ = (id) => document.getElementById(id);
  const myId = localStorage.getItem('userId');
  const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const LIGHT = '#dde2f4';
  const DARK = '#6a76ad';

  let state = null;
  let prevState = null;
  let selected = null;
  let flipped = false;
  let drag = null;          // { from, startX, startY, active, ghost, owned }
  let dragFrom = null;      // square whose piece is being dragged (dimmed)
  let skipAnimTo = null;    // own drag-dropped move: do not slide it again
  let clockAt = 0;          // performance.now() when the clock values were received
  let clockTicker = 0;
  let resignArmed = 0;

  socket.off('chess-state');
  WBG.onTeardown(() => { clearInterval(clockTicker); clearTimeout(resignArmed); removeGhost(); document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); });

  WBG.setRules({
    title: t('chess.rules.title'),
    sections: [
      { title: t('chess.rules.goal'), items: [t('chess.rules.goal.1'), t('chess.rules.goal.2')] },
      { title: t('chess.rules.moving'), items: [t('chess.rules.moving.1'), t('chess.rules.moving.2')] },
      { title: t('chess.rules.clock'), items: [t('chess.rules.clock.1'), t('chess.rules.clock.2')] },
      { title: t('chess.rules.controls'), items: [t('chess.rules.controls.1'), t('chess.rules.controls.2')] }
    ]
  });

  // How a game ended (the server sends these codes in the snapshot).
  const REASON = {
    checkmate: 'chess.reason.checkmate', resignation: 'chess.reason.resignation', timeout: 'chess.reason.timeout',
    agreement: 'chess.reason.agreement', timeoutInsufficient: 'chess.reason.timeoutInsufficient',
    stalemate: 'chess.reason.stalemate', insufficient: 'chess.reason.insufficient',
    fiftyMove: 'chess.reason.fiftyMove', threefold: 'chess.reason.threefold', left: 'chess.reason.left'
  };
  const PIECE = { p: 'chess.piece.p', n: 'chess.piece.n', b: 'chess.piece.b', r: 'chess.piece.r', q: 'chess.piece.q', k: 'chess.piece.k' };

  const sq = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
  const idx = (name) => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
  const isWhite = (p) => p !== '.' && p === p.toUpperCase();

  const myColor = () => (state.white === myId ? 'w' : state.black === myId ? 'b' : null);
  const bottomColor = () => ((myColor() === 'b') !== flipped ? 'b' : 'w');
  const canMove = () => !!state && !state.result && myColor() === state.turn;
  const legalFrom = (from) => state.legal.filter((m) => m.from === from);

  /* ------------------------------------------------------------- clocks */
  const fmtClock = (ms) => {
    if (ms < 10000) return `0:${(ms / 1000).toFixed(1).padStart(4, '0')}`;
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const clockNow = (color) => {
    if (!state?.clock) return null;
    let ms = state.clock[color];
    if (state.clock.running === color && !state.result) ms -= performance.now() - clockAt;
    return Math.max(0, ms);
  };

  function paintClocks() {
    if (!state?.clock) return;
    for (const color of ['w', 'b']) {
      const el = document.querySelector(`[data-clock="${color}"]`);
      if (!el) continue;
      const ms = clockNow(color);
      el.textContent = fmtClock(ms);
      const running = state.clock.running === color && !state.result;
      el.className = `rounded-lg px-3 py-1 font-mono text-lg font-bold tabular-nums ${running ? 'bg-white text-ink-900' : 'bg-white/8 text-slate-200'} ${running && ms < 20000 ? 'clock-low' : ''}`;
    }
    const c = myColor();
    if (c && state.clock.running === c) {
      const secs = Math.ceil(clockNow(c) / 1000);
      if (secs <= 10 && secs !== paintClocks.lastTick) { paintClocks.lastTick = secs; WBG.sound.play('tick'); }
    }
  }
  clockTicker = setInterval(paintClocks, 100);

  /* ------------------------------------------------------- captured etc. */
  function captured() {
    const have = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const ch of state.board) {
      if (ch === '.' || ch.toLowerCase() === 'k') continue;
      have[isWhite(ch) ? 'w' : 'b'][ch.toLowerCase()]++;
    }
    const lost = (c) => Object.entries(START).flatMap(([k, n]) => Array(Math.max(0, n - have[c][k])).fill(k));
    return { w: lost('w'), b: lost('b') };
  }

  function playerBar(el, color) {
    const id = color === 'w' ? state.white : state.black;
    const name = state.names[id] || t('chess.player');
    const turn = !state.result && state.turn === color;
    const lost = captured();
    const taken = lost[color === 'w' ? 'b' : 'w'];
    const lead = taken.reduce((s, k) => s + VALUE[k], 0) - lost[color].reduce((s, k) => s + VALUE[k], 0);
    el.className = `flex items-center gap-3 rounded-2xl border px-3 py-2 transition ${turn ? 'border-brand-400/60 bg-brand-500/12' : 'border-white/8 bg-white/4'}`;
    el.innerHTML = `${WBG.avatar(name)}
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-2 text-sm font-semibold text-white"><span class="truncate">${WBG.esc(name)}</span>${id === myId ? `<span class="chip">${t('chess.you')}</span>` : ''}
          <span class="inline-block size-3.5 shrink-0 rounded-full border border-white/30 ${color === 'w' ? 'bg-slate-100' : 'bg-slate-800'}" title="${color === 'w' ? t('chess.white') : t('chess.black')}"></span></p>
        <p class="flex h-4 items-center">${taken.map((k) => WBG.chessPiece(color === 'w' ? k : k.toUpperCase(), 'size-4 -mr-1.5')).join('')}${lead > 0 ? `<span class="ml-2.5 text-xs text-slate-400">+${lead}</span>` : ''}</p>
      </div>
      ${state.clock ? '<span data-clock="' + color + '"></span>' : turn ? `<span class="chip chip-brand animate-pulse-soft">${state.check ? t('chess.chip.check') : t('chess.chip.toMove')}</span>` : ''}`;
  }

  /* -------------------------------------------------------------- render */
  const cellPx = () => $('chess-board').clientWidth / 8;
  const cellPos = (name) => {
    const file = name.charCodeAt(0) - 97;
    const rank = Number(name[1]);
    return bottomColor() === 'w' ? { c: file, r: 8 - rank } : { c: 7 - file, r: rank - 1 };
  };

  function render(opts = {}) {
    if (!state) return;
    const mc = myColor();
    const targets = new Set(selected && canMove() ? legalFrom(selected).map((m) => m.to) : []);
    const bc = bottomColor();
    const cells = [];

    for (let k = 0; k < 64; k++) {
      const i = bc === 'b' ? 63 - k : k;
      const name = sq(i);
      const row = Math.floor(i / 8), col = i % 8;
      const piece = state.board[i];
      const dark = (row + col) % 2 === 1;
      const cell = document.createElement('div');
      cell.className = 'relative grid aspect-square place-items-center';
      cell.style.background = dark ? DARK : LIGHT;
      cell.dataset.sq = name;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', piece !== '.' ? t('chess.cell.piece', { sq: name, color: isWhite(piece) ? t('chess.white') : t('chess.black'), piece: t(PIECE[piece.toLowerCase()]) }) : name);
      let html = '';
      if (state.lastMove && (state.lastMove.from === name || state.lastMove.to === name)) html += '<span class="pointer-events-none absolute inset-0 bg-amber-300/45"></span>';
      if (selected === name) html += '<span class="pointer-events-none absolute inset-0 bg-emerald-400/55"></span>';
      if (state.check && piece === (state.turn === 'w' ? 'K' : 'k')) html += '<span class="pointer-events-none absolute inset-0" style="background:radial-gradient(circle,rgba(244,63,94,.9),rgba(244,63,94,0) 70%)"></span>';
      if (piece !== '.') {
        const own = mc && (isWhite(piece) ? 'w' : 'b') === mc;
        html += `<span class="piece pointer-events-none relative size-[88%] ${own && canMove() && legalFrom(name).length ? '' : ''}" style="${dragFrom === name ? 'opacity:.3' : ''}">${WBG.chessPiece(piece)}</span>`;
      }
      if (targets.has(name)) {
        html += piece !== '.'
          ? '<span class="pointer-events-none absolute inset-[6%] rounded-full border-[5px] border-emerald-500/70"></span>'
          : '<span class="pointer-events-none absolute size-[28%] rounded-full bg-emerald-600/70"></span>';
      }
      if (col === (bc === 'w' ? 0 : 7)) html += `<span class="pointer-events-none absolute top-0.5 left-1 text-[10px] font-bold" style="color:${dark ? LIGHT : DARK}">${8 - row}</span>`;
      if (row === (bc === 'w' ? 7 : 0)) html += `<span class="pointer-events-none absolute right-1 bottom-0.5 text-[10px] font-bold" style="color:${dark ? LIGHT : DARK}">${'abcdefgh'[col]}</span>`;
      cell.innerHTML = html;
      cells.push(cell);
    }
    $('chess-board').replaceChildren(...cells);

    const topColor = bc === 'w' ? 'b' : 'w';
    playerBar($('chess-top'), topColor);
    playerBar($('chess-bottom'), bc);
    paintClocks();

    // status
    const nameOf = (id) => state.names[id] || t('chess.player');
    let status;
    const sub = t(REASON[state.result?.reason] || 'chess.reason.checkmate');
    if (state.result) status = `${state.result.winner ? t('chess.title.wins', { name: nameOf(state.result.winner) }) : t('chess.title.draw')} - ${sub}`;
    else if (!mc) status = t(state.check ? 'chess.status.toMoveCheck' : 'chess.status.toMove', { name: nameOf(state.turn === 'w' ? state.white : state.black) });
    else if (canMove()) status = t(state.check ? 'chess.status.yourMoveCheck' : 'chess.status.yourMove');
    else status = t('chess.status.waiting', { name: nameOf(state.turn === 'w' ? state.white : state.black) });
    $('chess-status').textContent = status;

    // controls
    const playing = !!mc && !state.result;
    $('chess-resign').hidden = !playing;
    $('chess-draw').hidden = !playing;
    const offered = state.drawOffer;
    $('chess-draw').disabled = !!offered || state.moveCount < 2;
    $('chess-draw').querySelector('span').textContent = offered === mc ? t('chess.btn.offered') : t('chess.btn.draw');
    const incoming = playing && offered && offered !== mc;
    $('chess-offer').hidden = !incoming;
    if (incoming) $('chess-offer-text').textContent = t('chess.offer.text', { name: nameOf(offered === 'w' ? state.white : state.black) });

    renderMoves();
    if (!opts.noAnim) animateLastMove();
  }

  function renderMoves() {
    const moves = state.moves || [];
    const pairs = [];
    for (let i = 0; i < moves.length; i += 2) pairs.push([moves[i], moves[i + 1]]);
    const last = moves.length - 1;
    const cls = (n) => `rounded px-1.5 py-0.5 font-medium ${n === last ? 'bg-brand-500/30 text-white' : 'text-slate-300'}`;
    $('chess-moves').innerHTML = pairs.map((p, n) => `<li class="contents"><span class="py-0.5 text-right text-xs text-slate-500">${n + 1}.</span><span class="${cls(n * 2)}">${WBG.esc(p[0])}</span><span class="${cls(n * 2 + 1)}">${p[1] ? WBG.esc(p[1]) : ''}</span></li>`).join('');
    $('chess-moves').scrollTop = $('chess-moves').scrollHeight;
    $('chess-strip').innerHTML = moves.map((m, i) => `<span class="${i === last ? 'rounded-md bg-brand-500/30 px-2 py-1 text-xs font-semibold text-white' : 'rounded-md bg-white/6 px-2 py-1 text-xs text-slate-300'}">${i % 2 === 0 ? `${i / 2 + 1}. ` : ''}${WBG.esc(m)}</span>`).join('');
    $('chess-strip').scrollLeft = $('chess-strip').scrollWidth;
  }

  /* ------------------------------------------------------ animation, sound */
  function animateLastMove() {
    const lm = state.lastMove;
    if (!lm || !prevState || prevState.moveCount === state.moveCount) return;
    if (skipAnimTo === lm.to) { skipAnimTo = null; return; }
    const piece = document.querySelector(`[data-sq="${lm.to}"] .piece`);
    if (!piece || WBG.prefs.reduceMotion) return;
    const a = cellPos(lm.from), b = cellPos(lm.to);
    const px = cellPx();
    piece.animate([{ transform: `translate(${(a.c - b.c) * px}px, ${(a.r - b.r) * px}px)`, zIndex: 5 }, { transform: 'none' }], { duration: 170, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }

  function moveSound() {
    const san = state.moves?.[state.moves.length - 1] || '';
    if (/[+#]$/.test(san)) WBG.sound.play('check');
    else if (san.startsWith('O-O')) WBG.sound.play('castle');
    else if (san.includes('x')) WBG.sound.play('capture');
    else WBG.sound.play('move');
  }

  /* ---------------------------------------------------- interaction (tap + drag) */
  function commit(from, to) {
    const options = legalFrom(from).filter((m) => m.to === to);
    if (!options.length) return false;
    selected = null;
    if (options.some((m) => m.promo)) { render({ noAnim: true }); askPromotion(from, to, myColor()); return true; }
    WBG.haptic(10);
    socket.emit('chess-move', { from, to });
    render({ noAnim: true });
    return true;
  }

  function handleTap(name) {
    if (!canMove()) return;
    if (selected && commit(selected, name)) return;
    const piece = state.board[idx(name)];
    const mine = piece !== '.' && (isWhite(piece) ? 'w' : 'b') === myColor();
    selected = mine && legalFrom(name).length ? (selected === name ? null : name) : null;
    if (selected) WBG.sound.play('click');
    render({ noAnim: true });
  }

  function removeGhost() {
    drag?.ghost?.remove();
  }

  function onPointerDown(e) {
    if (e.button > 0) return;
    const cell = e.target.closest('[data-sq]');
    if (!cell || !canMove()) return;
    const name = cell.dataset.sq;
    const piece = state.board[idx(name)];
    const owned = piece !== '.' && (isWhite(piece) ? 'w' : 'b') === myColor() && legalFrom(name).length > 0;
    drag = { from: name, startX: e.clientX, startY: e.clientY, active: false, ghost: null, owned, piece };
    if (owned && selected !== name) { selected = name; render({ noAnim: true }); }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
    document.addEventListener('pointercancel', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.active) {
      if (!drag.owned || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      drag.active = true;
      const size = cellPx();
      const ghost = document.createElement('div');
      ghost.className = 'chess-ghost';
      ghost.style.width = ghost.style.height = `${size * 0.95}px`;
      ghost.innerHTML = WBG.chessPiece(drag.piece);
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      dragFrom = drag.from;
      render({ noAnim: true });
    }
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
  }

  function onPointerUp(e) {
    document.removeEventListener('pointermove', onPointerMove);
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.active) {
      if (e.type !== 'pointercancel') handleTap(d.from);
      return;
    }
    d.ghost?.remove();
    dragFrom = null;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-sq]')?.dataset.sq;
    if (target && target !== d.from && e.type !== 'pointercancel' && commit(d.from, target)) {
      skipAnimTo = target; // the piece is already where the user dropped it
      return;
    }
    render({ noAnim: true });
  }

  $('chess-board').addEventListener('pointerdown', onPointerDown);

  function askPromotion(from, to, color) {
    const box = $('chess-promo-options');
    box.replaceChildren(...['q', 'r', 'b', 'n'].map((p) => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary size-16 p-2';
      b.setAttribute('aria-label', t('chess.promote.to', { piece: t(PIECE[p]) }));
      b.innerHTML = WBG.chessPiece(color === 'w' ? p.toUpperCase() : p);
      b.addEventListener('click', () => {
        $('chess-promo').hidden = true;
        socket.emit('chess-move', { from, to, promotion: p });
      });
      return b;
    }));
    $('chess-promo').hidden = false;
  }

  /* ---------------------------------------------------------------- socket */
  socket.on('chess-state', (s) => {
    const first = !state;
    prevState = state;
    state = s;
    clockAt = performance.now();
    selected = canMove() && selected && legalFrom(selected).length ? selected : null;
    $('chess-promo').hidden = true;
    render({ noAnim: first });
    if (!first && prevState && prevState.moveCount !== s.moveCount) moveSound();
    if (!first && !prevState.drawOffer && s.drawOffer && s.drawOffer !== myColor() && myColor()) WBG.sound.play('notify');
    if (!first && s.moveCount !== prevState.moveCount && canMove()) WBG.sound.later('turn', 220);
  });

  $('chess-flip').addEventListener('click', () => { flipped = !flipped; WBG.sound.play('click'); render({ noAnim: true }); });
  $('chess-draw').addEventListener('click', () => { WBG.sound.play('click'); socket.emit('chess-offer-draw'); });
  $('chess-accept').addEventListener('click', () => socket.emit('chess-accept-draw'));
  $('chess-decline').addEventListener('click', () => socket.emit('chess-decline-draw'));
  $('chess-resign').addEventListener('click', () => {
    const btn = $('chess-resign');
    if (resignArmed) {
      clearTimeout(resignArmed);
      resignArmed = 0;
      socket.emit('chess-resign');
      return;
    }
    btn.querySelector('span').textContent = t('chess.btn.tapAgain');
    btn.classList.add('!bg-rose-600');
    resignArmed = setTimeout(() => {
      resignArmed = 0;
      btn.querySelector('span').textContent = t('chess.btn.resign');
      btn.classList.remove('!bg-rose-600');
    }, 3000);
  });

  WBG.gameReady('chess-page-loaded');
})();
