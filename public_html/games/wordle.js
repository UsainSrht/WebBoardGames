import { ALPHABET, LAYOUT, MAX_GUESSES, WORD_LEN, cleanWord, hardViolation, letterStates, lower, normLang, upper } from '/games/wordle-core.js';

await WBG.i18n.load('wordle');

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = WBG.esc;
  const myId = WBG.store.get('userId');
  const spectator = !!WBG.isSpectator;
  const t = WBG.t;
  const reduce = () => WBG.prefs.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  WBG.addIcons({
    wdcheck: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    wdcross: '<path d="M6 6l12 12M18 6 6 18"/>',
    wdback: '<path d="M21 5H9l-6 7 6 7h12z"/><path d="m13 9.5 5 5m0-5-5 5"/>',
    wdenter: '<path d="M20 5v7a3 3 0 0 1-3 3H5"/><path d="m9 11-4 4 4 4"/>'
  });

  let S = null;
  let lang = 'en';
  let valid = null;            // Set of valid words (client side instant feedback; the server stays authoritative)
  let cur = [];                // letters typed in the current row
  let pending = false;         // guess sent, waiting for the snapshot
  let paintedRows = 0;         // rows already shown with colours
  let roundSeen = -1;
  let keyStates = {};
  let kbBuilt = false;
  let deadlineLocal = 0;
  let nextLocal = 0;
  let lastTickSec = -1;
  let revealTimer = null;
  let msgTimer = null;
  let typingTimer = null;
  let lastTypingSent = -1;
  let animUntil = 0;
  let firstSync = true;
  const typingN = new Map();   // player id -> letters typed in their current row
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  socket.off('wordle-state');
  socket.off('wordle-reject');
  socket.off('wordle-typing');

  const tick = setInterval(onTick, 250);
  WBG.onTeardown(() => {
    clearInterval(tick);
    for (const id of timers) clearTimeout(id);
    clearTimeout(revealTimer);
    clearTimeout(msgTimer);
    clearTimeout(typingTimer);
    document.removeEventListener('keydown', onKeyDown);
  });

  /* ------------------------------------------------------------------ rules */
  WBG.setRules({
    title: t('wordle.rules.title'),
    sections: [
      { title: t('wordle.rules.goal.title'), items: [t('wordle.rules.goal.1'), t('wordle.rules.goal.2')] },
      { title: t('wordle.rules.colors.title'), items: [t('wordle.rules.colors.g'), t('wordle.rules.colors.y'), t('wordle.rules.colors.x'), t('wordle.rules.colors.dup')] },
      { title: t('wordle.rules.score.title'), items: [t('wordle.rules.score.1'), t('wordle.rules.score.2'), t('wordle.rules.score.3')] },
      { title: t('wordle.rules.hard.title'), items: [t('wordle.rules.hard.1')] }
    ]
  });

  /* --------------------------------------------------------------- board */
  const board = $('wd-board');
  const rowEls = [];
  const tileEls = [];
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement('div');
    row.className = 'wd-row flex';
    row.style.gap = 'var(--gap)';
    row.setAttribute('role', 'row');
    const tiles = [];
    for (let c = 0; c < WORD_LEN; c++) {
      const tile = document.createElement('div');
      tile.className = 'wd-tile';
      tile.style.setProperty('--i', c);
      tile.setAttribute('role', 'gridcell');
      row.appendChild(tile);
      tiles.push(tile);
    }
    board.appendChild(row);
    rowEls.push(row);
    tileEls.push(tiles);
  }

  const stateName = { g: 'correct', y: 'present', x: 'absent' };
  function setTile(tile, letter, fb) {
    tile.textContent = letter ? upper(letter, lang) : '';
    tile.className = `wd-tile${letter && !fb ? ' filled' : ''}${fb ? ` ${fb}` : ''}`;
    tile.setAttribute('aria-label', letter ? `${upper(letter, lang)}${fb ? ` ${t(`wordle.cell.${stateName[fb]}`)}` : ''}` : t('wordle.cell.empty'));
  }

  function clearBoard() {
    for (let r = 0; r < MAX_GUESSES; r++) { rowEls[r].classList.remove('win', 'shake'); for (const tile of tileEls[r]) setTile(tile, '', ''); }
    paintedRows = 0;
  }

  function paintRow(r, g, animate) {
    const letters = [...g.word];
    letters.forEach((ch, c) => {
      const tile = tileEls[r][c];
      if (!animate) { setTile(tile, ch, g.fb[c]); return; }
      setTile(tile, ch, '');
      tile.classList.remove('filled');
      tile.classList.add('flip');
      later(() => {
        tile.className = `wd-tile ${g.fb[c]} flip`;
        tile.setAttribute('aria-label', `${upper(ch, lang)} ${t(`wordle.cell.${stateName[g.fb[c]]}`)}`);
      }, c * 280 + 270);
      later(() => WBG.sound.play('flip'), c * 280 + 60);
    });
  }

  function paintCurrent() {
    const mine = S?.mine;
    if (!mine) return;
    const r = mine.guesses.length;
    if (r >= MAX_GUESSES || mine.status !== 'playing') return;
    for (let c = 0; c < WORD_LEN; c++) setTile(tileEls[r][c], cur[c] || '', '');
  }

  /* ------------------------------------------------------------- keyboard */
  function buildKeyboard() {
    const kb = $('wd-kb');
    kb.replaceChildren();
    const rows = LAYOUT[lang];
    rows.forEach((letters, ri) => {
      const row = document.createElement('div');
      row.className = 'flex w-full justify-center gap-1.5';
      if (ri === rows.length - 1) row.appendChild(specialKey('enter'));
      for (const ch of letters) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wd-key';
        b.dataset.key = ch;
        b.textContent = upper(ch, lang);
        b.setAttribute('aria-label', upper(ch, lang));
        b.addEventListener('click', () => typeLetter(ch));
        row.appendChild(b);
      }
      if (ri === rows.length - 1) row.appendChild(specialKey('back'));
      kb.appendChild(row);
    });
    kbBuilt = true;
    paintKeyboard();
  }

  function specialKey(kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wd-key wide';
    if (kind === 'enter') {
      b.innerHTML = `<span class="sr-only">${esc(t('wordle.key.enter'))}</span><span aria-hidden="true" class="hidden text-xs sm:inline">${esc(t('wordle.key.enter'))}</span>${WBG.icon('wdenter', 'size-5 sm:hidden')}`;
      b.addEventListener('click', submit);
    } else {
      b.innerHTML = WBG.icon('wdback', 'size-6');
      b.setAttribute('aria-label', t('wordle.key.back'));
      b.addEventListener('click', backspace);
    }
    return b;
  }

  function paintKeyboard() {
    for (const k of $('wd-kb').querySelectorAll('[data-key]')) {
      const st = keyStates[k.dataset.key];
      k.classList.remove('g', 'y', 'x');
      if (st) k.classList.add(st);
      k.setAttribute('aria-label', `${upper(k.dataset.key, lang)}${st ? ` ${t(`wordle.cell.${stateName[st]}`)}` : ''}`);
    }
  }

  /* ---------------------------------------------------------------- input */
  const canType = () => !spectator && S && S.phase === 'play' && S.mine && S.mine.status === 'playing' && !pending;

  function typeLetter(ch) {
    if (!canType() || cur.length >= WORD_LEN) return;
    cur.push(ch);
    WBG.sound.play('pop');
    WBG.haptic(8);
    paintCurrent();
    sendTyping();
  }

  function backspace() {
    if (!canType() || !cur.length) return;
    cur.pop();
    WBG.sound.play('click');
    paintCurrent();
    sendTyping();
  }

  function sendTyping() {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (lastTypingSent !== cur.length) { lastTypingSent = cur.length; socket.emit('wordle-typing', { n: cur.length }); }
    }, 140);
  }

  function say(message, tone = 'neutral', ms = 2200) {
    const el = $('wd-msg');
    el.textContent = WBG.tr(message);
    el.className = `h-6 text-center text-sm font-semibold ${tone === 'bad' ? 'text-rose-300' : tone === 'good' ? 'text-emerald-300' : 'text-slate-200'}`;
    clearTimeout(msgTimer);
    if (ms) msgTimer = setTimeout(() => { el.textContent = ''; }, ms);
  }

  function invalid(message) {
    const r = S?.mine?.guesses.length ?? 0;
    const row = rowEls[Math.min(r, MAX_GUESSES - 1)];
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
    WBG.sound.play('error');
    WBG.haptic([30, 40, 30]);
    say(message, 'bad');
  }

  function submit() {
    if (!canType()) return;
    const word = cleanWord(cur.join(''), lang);
    if (cur.length < WORD_LEN || !word) return invalid({ k: 'wordle.err.short' });
    if (valid && !valid.has(word)) return invalid({ k: 'wordle.err.notWord' });
    if (S.hard) {
      const v = hardViolation(word, S.mine.guesses, lang);
      if (v) return invalid(v);
    }
    pending = true;
    clearTimeout(typingTimer);
    socket.emit('wordle-guess', { word });
    // if the server never answers (lost connection) allow another try
    later(() => { pending = false; }, 4000);
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); return submit(); }
    if (e.key === 'Backspace') { e.preventDefault(); return backspace(); }
    if (e.key.length === 1) {
      const ch = lower(e.key, lang);
      if (ALPHABET[lang].includes(ch)) typeLetter(ch);
    }
  }
  document.addEventListener('keydown', onKeyDown);

  /* -------------------------------------------------------------- others */
  const STATUS_ICON = { solved: 'wdcheck', failed: 'wdcross' };

  function renderOthers() {
    const list = (S.players || []).filter((p) => spectator || p.id !== myId);
    const wrap = $('wd-others-wrap');
    wrap.hidden = list.length === 0;
    const big = spectator;
    $('wd-others').className = spectator
      ? 'flex flex-wrap justify-center gap-3 pb-2 lg:justify-start'
      : 'scroll-y flex gap-2 pb-1 lg:flex-wrap lg:overflow-visible';
    $('wd-others').replaceChildren(...list.map((p) => {
      const li = document.createElement('li');
      li.dataset.pid = p.id;
      const typing = S.phase === 'play' && p.status === 'playing' ? (typingN.get(p.id) || 0) : 0;
      const cells = [];
      for (let r = 0; r < MAX_GUESSES; r++) {
        for (let c = 0; c < WORD_LEN; c++) {
          let cls = '';
          if (r < p.board.length) cls = p.board[r][c];
          else if (r === p.board.length && p.status === 'playing' && c < typing) cls = 't';
          cells.push(`<i class="${cls}"></i>`);
        }
      }
      const statusText = t(`wordle.st.${p.status}`);
      li.className = `card-flat flex shrink-0 flex-col gap-1.5 rounded-2xl p-2 ${big ? 'w-36' : 'w-[5.4rem] lg:w-[6.4rem]'} ${p.status === 'solved' ? 'ring-1 ring-emerald-400/50' : ''}`;
      li.setAttribute('aria-label', `${p.name}: ${t('wordle.mini.aria', { n: p.board.length, status: statusText })}`);
      li.innerHTML = `<div class="flex items-center gap-1.5">${WBG.avatar(p.name, 'size-5 shrink-0')}<span class="min-w-0 flex-1 truncate text-xs font-semibold text-white">${esc(p.name)}</span></div>
        <div class="wd-mini">${cells.join('')}</div>
        <div class="flex items-center justify-between text-[11px] text-slate-400">
          <span class="flex items-center gap-1 ${p.status === 'solved' ? 'text-emerald-300' : p.status === 'failed' ? 'text-rose-300' : ''}">${STATUS_ICON[p.status] ? WBG.icon(STATUS_ICON[p.status], 'size-3.5') : ''}${esc(statusText)}</span>
          <span class="font-bold tabular-nums text-slate-200">${p.score}</span>
        </div>`;
      return li;
    }));
  }

  /* ------------------------------------------------------------- reveal */
  function renderReveal() {
    const el = $('wd-reveal');
    if (S.phase !== 'reveal') { el.hidden = true; return; }
    const me = (S.result || []).find((r) => r.id === myId);
    $('wd-reveal-eyebrow').textContent = t('wordle.round', { n: S.round, total: S.rounds });
    let title;
    if (spectator || !me) title = t('wordle.reveal.word');
    else if (me.status === 'solved') title = t('wordle.reveal.solved', { n: me.guesses });
    else title = t('wordle.reveal.failed');
    $('wd-reveal-title').textContent = title;
    const wordBox = $('wd-reveal-word');
    wordBox.replaceChildren(...[...S.word].map((ch, i) => {
      const d = document.createElement('div');
      d.className = 'wd-tile g';
      d.style.cssText = '--tile:2.9rem;width:2.9rem;height:2.9rem;font-size:1.5rem;--i:' + i;
      d.textContent = upper(ch, lang);
      return d;
    }));
    const names = Object.fromEntries(S.players.map((p) => [p.id, p.name]));
    const rows = [...(S.result || [])].sort((a, b) => (b.points + b.bonus) - (a.points + a.bonus) || a.guesses - b.guesses);
    $('wd-reveal-rows').replaceChildren(...rows.map((r) => {
      const li = document.createElement('li');
      const isMe = r.id === myId;
      li.className = `flex items-center gap-2.5 rounded-xl px-3 py-2 ${isMe ? 'bg-brand-500/15 ring-1 ring-brand-400/40' : 'bg-white/5'}`;
      const detail = r.status === 'solved' ? t('wordle.reveal.guesses', { n: r.guesses }) : t('wordle.reveal.missed');
      li.innerHTML = `${WBG.avatar(names[r.id] || '?', 'size-7 shrink-0')}
        <div class="min-w-0 flex-1"><p class="truncate text-sm font-semibold text-white">${esc(names[r.id] || '')}${isMe ? ` <span class="text-xs font-normal text-slate-400">${esc(t('wordle.you'))}</span>` : ''}</p>
        <p class="text-xs ${r.status === 'solved' ? 'text-emerald-300' : 'text-slate-400'}">${esc(detail)}</p></div>
        <div class="text-right"><p class="text-base font-extrabold text-white tabular-nums">+${r.points + r.bonus}</p>${r.bonus ? `<p class="text-[11px] text-amber-300">${esc(t('wordle.reveal.bonus', { n: r.bonus }))}</p>` : ''}</div>`;
      return li;
    }));
    el.hidden = false;
  }

  function onTick() {
    if (!S) return;
    const now = performance.now();
    const timer = $('wd-timer');
    if (S.phase === 'play' && S.time > 0) {
      const left = Math.max(0, deadlineLocal - now);
      timer.hidden = false;
      timer.textContent = WBG.clock(left);
      const low = left < 15000;
      timer.className = `chip tabular-nums ${low ? 'chip-danger' : ''}`;
      const sec = Math.ceil(left / 1000);
      if (low && sec !== lastTickSec && sec > 0 && S.mine?.status === 'playing') { WBG.sound.play('tick'); }
      lastTickSec = sec;
    } else {
      timer.hidden = true;
    }
    if (S.phase === 'reveal') {
      const left = Math.max(0, Math.ceil((nextLocal - now) / 1000));
      $('wd-reveal-next').textContent = S.final ? t('wordle.reveal.last', { s: left }) : t('wordle.reveal.next', { s: left });
    }
  }

  /* -------------------------------------------------------------- render */
  function render(prev) {
    const mine = S.mine;
    $('wd-round').textContent = S.phase === 'wait' ? t('wordle.round.ready') : t('wordle.round', { n: S.round, total: S.rounds });
    $('wd-hard').hidden = !S.hard;
    const me = S.players.find((p) => p.id === myId);
    $('wd-score').textContent = me ? t('wordle.score', { n: me.score }) : t('wordle.players', { n: S.players.length });
    $('wd-wait').hidden = S.phase !== 'wait';
    $('wd-play').hidden = S.phase === 'wait' || spectator;
    $('wd-spec').hidden = !(spectator && S.phase !== 'wait');
    if (spectator) $('wd-spec').textContent = S.phase === 'reveal' ? '' : t('wordle.spec');

    renderOthers();
    if (S.phase === 'wait' || spectator) return;

    if (S.round !== roundSeen) {
      roundSeen = S.round;
      cur = [];
      keyStates = {};
      lastTypingSent = -1;
      typingN.clear();
      clearBoard();
      paintKeyboard();
      $('wd-msg').textContent = '';
    }
    pending = false;

    const guesses = mine?.guesses || [];
    const fresh = guesses.length - paintedRows;
    const animate = !firstSync && fresh === 1 && !reduce();
    for (let r = paintedRows; r < guesses.length; r++) paintRow(r, guesses[r], animate && r === guesses.length - 1);
    if (fresh > 0) {
      cur = [];
      lastTypingSent = -1;
      const delay = animate ? WORD_LEN * 280 + 320 : 0;
      paintedRows = guesses.length;
      const snapshot = guesses.map((g) => ({ ...g }));
      const settle = () => {
        keyStates = letterStates(snapshot);
        paintKeyboard();
      };
      if (delay) { animUntil = performance.now() + delay; later(settle, delay); } else settle();
      if (mine.status === 'solved') {
        later(() => {
          rowEls[guesses.length - 1].classList.add('win');
          WBG.sound.play('win');
          WBG.haptic([40, 60, 40]);
          say({ k: `wordle.praise.${Math.min(guesses.length, 6)}` }, 'good', 4000);
        }, delay + 60);
      } else if (mine.status === 'failed') {
        later(() => say({ k: 'wordle.toast.failed' }, 'bad', 4000), delay);
      } else if (!animate) {
        // nothing
      }
    }
    paintCurrent();
    if (mine?.status === 'playing') { for (let c = 0; c < WORD_LEN; c++) if (guesses.length < MAX_GUESSES) setTile(tileEls[guesses.length][c], cur[c] || '', ''); }
  }

  socket.on('wordle-state', (s) => {
    const prev = S;
    S = s;
    lang = normLang(s.language);
    if (!kbBuilt) { buildKeyboard(); loadValid(); }
    deadlineLocal = performance.now() + s.timeLeft;
    nextLocal = performance.now() + s.nextIn;

    render(prev);

    // result overlay: wait for the last flip to finish
    clearTimeout(revealTimer);
    if (s.phase === 'reveal') {
      const justEnded = !prev || prev.phase !== 'reveal' || prev.round !== s.round;
      const extra = Math.max(0, animUntil - performance.now());
      revealTimer = setTimeout(renderReveal, justEnded && !firstSync ? Math.max(700, extra + 900) : 0);
      if (justEnded && !firstSync) {
        const me = s.mine;
        if (!me || me.status !== 'solved') later(() => WBG.sound.play(me && me.status === 'failed' ? 'lose' : 'reveal'), 400);
      }
    } else {
      $('wd-reveal').hidden = true;
    }

    if (prev && s.phase === 'play' && prev.phase !== 'play') { WBG.sound.play('go'); }
    if (prev && prev.phase === 'play' && s.phase === 'play') {
      // somebody else solved
      for (const p of s.players) {
        const was = prev.players.find((x) => x.id === p.id);
        if (p.id !== myId && was && was.status !== 'solved' && p.status === 'solved') { WBG.sound.play('coin'); }
        if (p.id !== myId && was && p.board.length > was.board.length) typingN.delete(p.id);
      }
    }
    if (s.phase === 'reveal' && s.final && prev && prev.phase !== 'reveal') { /* final result follows via the room */ }
    firstSync = false;
    onTick();
  });

  socket.on('wordle-reject', (m) => {
    pending = false;
    invalid(m.message);
  });

  socket.on('wordle-typing', (m) => {
    if (!S || m.id === myId) return;
    typingN.set(m.id, m.n);
    const li = document.querySelector(`#wd-others [data-pid="${CSS.escape(m.id)}"]`);
    const p = S.players.find((x) => x.id === m.id);
    if (!li || !p || p.status !== 'playing') return;
    const cells = li.querySelectorAll('.wd-mini i');
    for (let c = 0; c < WORD_LEN; c++) {
      const cell = cells[p.board.length * WORD_LEN + c];
      if (cell) cell.className = c < m.n ? 't' : '';
    }
  });

  /* -------------------------------------------------------------- word list */
  function loadValid() {
    fetch(`/data/wordle-${lang}-valid.txt`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('list'))))
      .then((txt) => { valid = new Set(txt.split('\n').filter(Boolean)); })
      .catch(() => { valid = null; }); // the server still validates
  }

  WBG.gameReady('wordle-page-loaded');
})();
