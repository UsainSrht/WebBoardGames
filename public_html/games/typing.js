import { scoreTyped, wpmOf, round1 } from '/games/typing-core.js';

await WBG.i18n.load('typing');

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = WBG.esc;
  const t = WBG.t;
  const myId = WBG.store.get('userId');
  const spectator = !!WBG.isSpectator;
  const reduce = () => WBG.prefs.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (n, d = 0) => Number(n).toLocaleString(WBG.locale, { maximumFractionDigits: d, minimumFractionDigits: d });

  let S = null;
  let words = [];
  let committed = [];     // finished words as typed
  let cur = '';           // word being typed
  let idx = 0;
  let ks = 0;
  let mistakes = 0;
  let running = false;    // between "go" and the end of my own run
  let finished = false;
  let startLocal = 0;     // performance.now() of "go"
  let endLocal = 0;
  let lastSent = '';
  let dirty = false;
  let lastClick = 0;
  let lastError = 0;
  let lastCountN = -1;
  let builtFor = null;
  let resultsShown = false;
  let progress = new Map(); // id -> { c, pos, wpm, done, dq }
  const wordEls = [];
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  socket.off('typing-state');
  socket.off('typing-progress');

  const input = $('ty-input');
  const tickTimer = setInterval(onTick, 100);
  const sendTimer = setInterval(sendProgress, 220);
  WBG.onTeardown(() => {
    clearInterval(tickTimer);
    clearInterval(sendTimer);
    for (const id of timers) clearTimeout(id);
    window.removeEventListener('resize', layout);
  });

  WBG.setRules({
    title: t('typing.rules.title'),
    sections: [
      { title: t('typing.rules.goal.title'), items: [t('typing.rules.goal.1'), t('typing.rules.goal.2')] },
      { title: t('typing.rules.typing.title'), items: [t('typing.rules.typing.1'), t('typing.rules.typing.2')] },
      { title: t('typing.rules.score.title'), items: [t('typing.rules.score.1'), t('typing.rules.score.2'), t('typing.rules.score.3')] }
    ]
  });

  /* ------------------------------------------------------------ text view */
  const typedFull = () => (idx > 0 ? `${committed.join(' ')} ${cur}` : cur);

  function buildText() {
    const box = $('ty-words');
    box.replaceChildren();
    wordEls.length = 0;
    words.forEach((w) => {
      const el = document.createElement('span');
      el.className = 'w';
      el.innerHTML = [...w].map((ch) => `<span class="l">${esc(ch)}</span>`).join('');
      box.appendChild(el);
      wordEls.push(el);
      box.appendChild(document.createTextNode(' '));
    });
    $('ty-inner').lang = S.language;
    $('ty-inner').style.transform = '';
    layout();
  }

  function paintWord(i) {
    const el = wordEls[i];
    if (!el) return;
    const target = words[i];
    const typed = i < idx ? committed[i] : i === idx ? cur : '';
    const n = Math.max(target.length, typed.length);
    let html = '';
    for (let j = 0; j < n; j++) {
      const ch = j < target.length ? target[j] : typed[j];
      let cls = 'l';
      if (j >= typed.length) cls += '';
      else if (j >= target.length) cls += ' ex';
      else cls += typed[j] === target[j] ? ' ok' : ' no';
      html += `<span class="${cls}">${esc(ch)}</span>`;
    }
    el.innerHTML = html;
    el.classList.toggle('bad', i < idx && committed[i] !== target);
  }

  function layout() {
    const el = wordEls[Math.min(idx, wordEls.length - 1)];
    if (!el) return;
    const line = parseFloat(getComputedStyle($('ty-root')).getPropertyValue('--line')) * parseFloat(getComputedStyle(document.documentElement).fontSize) || 40;
    const row = Math.round(el.offsetTop / line);
    $('ty-inner').style.transform = `translateY(${-Math.max(0, row - 1) * line}px)`;
    // caret
    const letters = el.children;
    const j = Math.min(cur.length, letters.length);
    let x;
    let y = el.offsetTop;
    if (j < letters.length) x = letters[j].offsetLeft;
    else if (letters.length) x = letters[letters.length - 1].offsetLeft + letters[letters.length - 1].offsetWidth;
    else x = el.offsetLeft;
    $('ty-caret').style.transform = `translate(${x}px, ${y}px)`;
  }

  /* ---------------------------------------------------------------- input */
  function emitLetters(added, from) {
    for (let k = 0; k < added.length; k++) {
      ks++;
      const expected = words[idx]?.[from + k];
      if (added[k] !== expected) {
        mistakes++;
        const now = performance.now();
        if (now - lastError > 220) { lastError = now; WBG.sound.play('error'); }
      } else {
        const now = performance.now();
        if (now - lastClick > 35) { lastClick = now; WBG.sound.play('click'); }
      }
    }
  }

  function applyValue(v) {
    const maxLen = (words[idx]?.length || 0) + 8;
    const sp = v.indexOf(' ');
    let word = sp >= 0 ? v.slice(0, sp) : v;
    if (word.length > maxLen) word = word.slice(0, maxLen);
    // diff against the current word
    let k = 0;
    while (k < cur.length && k < word.length && cur[k] === word[k]) k++;
    emitLetters(word.slice(k), k);
    cur = word;
    let commit = false;
    if (sp >= 0) {
      if (word.length === 0) { /* a leading space is ignored */ } else if (idx < words.length - 1) commit = true;
    }
    if (commit) {
      ks++;
      if (word !== words[idx]) mistakes++;
      committed.push(word);
      const prevIdx = idx;
      idx++;
      cur = '';
      paintWord(prevIdx);
    }
    input.value = commit ? '' : cur;
    paintWord(idx);
    dirty = true;
    $('ty-caret').classList.add('typing');
    clearTimeout(applyValue.t);
    applyValue.t = setTimeout(() => $('ty-caret').classList.remove('typing'), 600);
    layout();
    updateLive();
    if (idx === words.length - 1 && cur.length >= words[idx].length) finishRun(true);
  }

  input.addEventListener('input', () => {
    if (!running || finished) { input.value = ''; return; }
    applyValue(input.value);
  });

  // going back into the previous word (only while it is wrong, like monkeytype)
  function backIntoPrevious() {
    if (!running || finished || input.value !== '' || idx === 0) return false;
    if (committed[idx - 1] === words[idx - 1]) return false;
    const prevIdx = idx;
    idx--;
    cur = committed.pop();
    input.value = cur;
    paintWord(prevIdx);
    paintWord(idx);
    layout();
    dirty = true;
    return true;
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && backIntoPrevious()) {
      e.preventDefault();
      requestAnimationFrame(() => input.setSelectionRange(cur.length, cur.length));
    }
    if (e.key === 'Tab') e.preventDefault();
  });
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward' && backIntoPrevious()) e.preventDefault();
  });
  input.addEventListener('paste', (e) => e.preventDefault());
  input.addEventListener('drop', (e) => e.preventDefault());
  input.addEventListener('focus', () => { $('ty-focus').hidden = true; });
  input.addEventListener('blur', () => { if (running && !finished) showFocusHint(); });
  window.addEventListener('resize', layout);

  function showFocusHint() {
    $('ty-focus').hidden = false;
  }

  /* ------------------------------------------------------------ progress */
  function sendProgress() {
    if (!running || finished || !dirty) return;
    const typed = typedFull();
    if (typed === lastSent) { dirty = false; return; }
    lastSent = typed;
    dirty = false;
    socket.emit('typing-progress', { typed, keystrokes: ks, mistakes });
  }

  function finishRun(complete) {
    if (finished || !running) return;
    finished = true;
    running = false;
    input.blur();
    $('ty-focus').hidden = true;
    socket.emit('typing-finish', { typed: typedFull(), keystrokes: ks, mistakes });
    $('ty-hint').textContent = t(complete ? 'typing.hint.done' : 'typing.hint.timeUp');
    WBG.sound.play(complete ? 'coin' : 'reveal');
  }

  function updateLive() {
    const elapsed = Math.max(0, Math.min(performance.now() - startLocal, S.duration * 1000));
    const s = scoreTyped(S.text, typedFull());
    const wpm = running || finished ? wpmOf(s.correct, Math.max(elapsed, 1000)) : 0;
    $('ty-wpm').textContent = fmt(wpm);
    const keys = Math.max(ks, typedFull().length);
    $('ty-acc').textContent = `${keys ? fmt(Math.max(0, (1 - Math.max(mistakes, s.wrong) / keys) * 100)) : 100}%`;
    if (running) {
      const me = progress.get(myId) || {};
      progress.set(myId, { ...me, c: s.correct, pos: typedFull().length, wpm: round1(wpm) });
      paintLane(myId);
    }
  }

  /* ---------------------------------------------------------------- lanes */
  function buildLanes() {
    $('ty-lanes').replaceChildren(...S.players.map((p) => {
      const li = document.createElement('li');
      li.dataset.lane = p.id;
      const me = p.id === myId;
      li.className = 'flex items-center gap-2.5';
      li.innerHTML = `${WBG.avatar(p.name, 'size-6 shrink-0')}
        <span class="w-20 shrink-0 truncate text-xs font-semibold ${me ? 'text-white' : 'text-slate-300'} sm:w-28">${esc(p.name)}${me ? ` <span class="font-normal text-slate-400">${esc(t('typing.you'))}</span>` : ''}</span>
        <div class="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/8"><div class="ty-lane-fill h-full w-0 rounded-full ${me ? 'bg-gradient-to-r from-brand-500 to-violet-400' : 'bg-slate-400/70'}"></div></div>
        <span class="w-14 shrink-0 text-right text-xs font-bold tabular-nums text-slate-300"><span class="lane-wpm">0</span> <span class="font-normal text-slate-500">${esc(t('typing.wpmShort'))}</span></span>`;
      return li;
    }));
    for (const p of S.players) paintLane(p.id);
  }

  function paintLane(id) {
    const li = document.querySelector(`#ty-lanes [data-lane="${CSS.escape(id)}"]`);
    if (!li || !S) return;
    const p = progress.get(id) || { c: 0, pos: 0, wpm: 0 };
    const pct = Math.min(100, (p.c / Math.max(1, S.text.length)) * 100);
    li.querySelector('.ty-lane-fill').style.width = `${pct}%`;
    li.querySelector('.lane-wpm').textContent = p.dq ? '-' : fmt(p.wpm);
    li.classList.toggle('opacity-60', !!p.dq);
  }

  /* ---------------------------------------------------------------- timer */
  function onTick() {
    if (!S) return;
    const now = performance.now();
    if (S.phase === 'countdown') {
      const left = startLocal - now;
      const n = Math.max(1, Math.ceil(left / 1000));
      if (left > 0 && n !== lastCountN) {
        lastCountN = n;
        const el = $('ty-count-n');
        el.textContent = String(n);
        el.classList.remove('ty-go');
        void el.offsetWidth;
        el.classList.add('ty-go');
        WBG.sound.play('countdown');
      }
      if (left <= 0) goLive();
    } else if (S.phase === 'play') {
      if (!running && !finished && !spectator && now >= startLocal) goLive();
      const left = Math.max(0, endLocal - now);
      $('ty-time').textContent = String(Math.ceil(left / 1000));
      if (running && left <= 0) finishRun(false);
      if (running) updateLive();
    }
  }

  function goLive() {
    $('ty-count').hidden = true;
    if (spectator || finished || running || S.mine?.done) return;
    running = true;
    startLocal = Math.min(startLocal, performance.now());
    WBG.sound.play('go');
    input.focus({ preventScroll: true });
    if (document.activeElement !== input) showFocusHint();
    $('ty-hint').textContent = '';
  }

  /* ---------------------------------------------------------------- results */
  function pbKey() { return `wbg.typing.pb.${S.language}.${S.duration}.${S.source}`; }

  function chartSvg(series, pb) {
    if (!series.length) return '';
    const W = 320; const H = 120; const pad = { l: 28, r: 8, t: 8, b: 18 };
    const max = Math.max(10, ...series, pb || 0) * 1.1;
    const x = (i) => pad.l + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - pad.l - pad.r));
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${pad.l},${H - pad.b} ${pts} ${x(series.length - 1).toFixed(1)},${H - pad.b}`;
    const ticks = [0, 0.5, 1].map((f) => max * f / 1.1);
    return `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="${esc(t('typing.chart'))}">
      ${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.1)"/><text x="${pad.l - 4}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#8c95b8">${Math.round(v)}</text>`).join('')}
      ${pb ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(pb).toFixed(1)}" y2="${y(pb).toFixed(1)}" stroke="#f59e0b" stroke-dasharray="4 3" stroke-opacity=".8"/>` : ''}
      <polygon points="${area}" fill="rgba(129,140,248,.16)"/>
      <polyline points="${pts}" fill="none" stroke="#a5b4fc" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(series[series.length - 1]).toFixed(1)}" r="3.2" fill="#c7d2fe"/>
      <text x="${W - pad.r}" y="${H - 4}" text-anchor="end" font-size="9" fill="#8c95b8">${esc(t('typing.secondsShort', { n: series.length }))}</text>
    </svg>`;
  }

  function showResults() {
    if (resultsShown || !S.results) return;
    resultsShown = true;
    const res = S.results;
    const mine = res.find((r) => r.id === myId);
    $('ty-res-eyebrow').textContent = t('typing.resultsHead', { sec: S.duration });
    $('ty-res-me').hidden = !mine;
    if (mine) {
      let pb = null;
      const saved = Number(WBG.store.get(pbKey(), '0'));
      let isPb = false;
      if (!mine.dq) {
        pb = saved > 0 ? saved : null;
        if (mine.wpm > saved) { WBG.store.set(pbKey(), String(mine.wpm)); isPb = saved > 0; }
      }
      $('ty-r-wpm').textContent = mine.dq ? '-' : fmt(mine.wpm, 1);
      $('ty-r-acc').textContent = `${fmt(mine.acc, 1)}%`;
      $('ty-r-raw').textContent = fmt(mine.raw);
      $('ty-r-con').textContent = `${mine.consistency}%`;
      $('ty-r-chars').textContent = fmt(mine.correct);
      $('ty-r-err').textContent = fmt(mine.errors);
      const pbEl = $('ty-r-pb');
      if (mine.dq) { pbEl.textContent = t('typing.dq'); pbEl.className = 'mt-3 text-center text-sm font-semibold text-rose-300'; }
      else if (isPb) { pbEl.textContent = t('typing.pb.new', { wpm: fmt(mine.wpm, 1), old: fmt(saved, 1) }); pbEl.className = 'mt-3 text-center text-sm font-semibold text-amber-300'; }
      else if (pb) { pbEl.textContent = t('typing.pb.best', { wpm: fmt(pb, 1) }); pbEl.className = 'mt-3 text-center text-sm font-semibold text-slate-300'; }
      else { pbEl.textContent = t('typing.pb.first'); pbEl.className = 'mt-3 text-center text-sm font-semibold text-slate-300'; }
      $('ty-chart').innerHTML = chartSvg(mine.series || [], pb);
      $('ty-chart').hidden = !(mine.series || []).length;
      WBG.sound.play(isPb || (res.length > 1 && mine.rank === 1) ? 'win' : 'coin');
    }
    $('ty-res-rows').replaceChildren(...res.map((r) => {
      const li = document.createElement('li');
      const isMe = r.id === myId;
      li.className = `flex items-center gap-2.5 rounded-xl px-3 py-2 ${isMe ? 'bg-brand-500/15 ring-1 ring-brand-400/40' : 'bg-white/5'}`;
      li.innerHTML = `<span class="w-5 text-center text-sm font-bold text-slate-400 tabular-nums">${r.rank}</span>${WBG.avatar(r.name, 'size-7 shrink-0')}
        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-white">${esc(r.name)}</span>
        <span class="text-right"><span class="block text-base font-extrabold text-white tabular-nums">${r.dq ? '-' : fmt(r.wpm, 1)}</span><span class="block text-[11px] ${r.dq ? 'text-rose-300' : 'text-slate-400'}">${r.dq ? esc(t('typing.note.dq')) : `${fmt(r.acc, 1)}%`}</span></span>`;
      return li;
    }));
    $('ty-results').hidden = false;
  }

  /* ---------------------------------------------------------------- socket */
  socket.on('typing-progress', (m) => {
    for (const p of m.players) {
      if (p.id === myId && running) continue; // my own lane is driven locally
      progress.set(p.id, p);
      paintLane(p.id);
    }
  });

  socket.on('typing-state', (s) => {
    const prevPhase = S?.phase;
    S = s;
    const key = `${s.text.length}:${s.text.slice(0, 24)}:${s.language}`;
    if (builtFor !== key) {
      builtFor = key;
      words = s.text.split(' ');
      committed = []; cur = ''; idx = 0; ks = 0; mistakes = 0; finished = false; running = false; resultsShown = false; lastSent = '';
      progress = new Map();
      buildText();
      buildLanes();
      // restore my own typing after a reload
      if (s.mine && s.mine.typed) {
        const parts = s.mine.typed.split(' ');
        cur = parts.pop();
        committed = parts;
        idx = parts.length;
        ks = s.mine.ks; mistakes = s.mine.mistakes;
        words.forEach((_, i) => paintWord(i));
        layout();
      }
    }
    if (s.mine?.done) finished = true;
    for (const p of s.progress || []) { if (!(p.id === myId && running)) progress.set(p.id, p); }
    const lanesNow = $('ty-lanes').children.length;
    if (lanesNow !== s.players.length) buildLanes(); else for (const p of s.players) paintLane(p.id);

    $('ty-meta').textContent = `${t(`typing.src.${s.source}`)} - ${t(`typing.lang.${s.language}`)}`;
    $('ty-stage').classList.toggle('opacity-70', spectator);
    if (spectator) input.disabled = true;

    $('ty-count').hidden = s.phase !== 'countdown';
    if (s.phase === 'wait') {
      $('ty-time').textContent = String(s.duration);
      $('ty-hint').textContent = t('typing.hint.wait');
    } else if (s.phase === 'countdown') {
      startLocal = performance.now() + s.startIn;
      endLocal = startLocal + s.duration * 1000;
      $('ty-time').textContent = String(s.duration);
      $('ty-hint').textContent = spectator ? t('typing.hint.spec') : t('typing.hint.ready');
      if (!spectator) input.focus({ preventScroll: true });
    } else if (s.phase === 'play') {
      endLocal = performance.now() + s.timeLeft;
      startLocal = endLocal - s.duration * 1000;
      if (spectator) $('ty-hint').textContent = t('typing.hint.spec');
    } else if (s.phase === 'over') {
      running = false;
      $('ty-time').textContent = '0';
      showResults();
    }
    if (s.phase === 'over' && spectator) $('ty-hint').textContent = '';
    updateLive();
  });

  $('ty-stage').addEventListener('pointerdown', () => { if (running) input.focus(); });

  WBG.gameReady('typing-page-loaded');
})();
