(() => {
  const $ = (id) => document.getElementById(id);
  const esc = WBG.esc;
  const myId = WBG.store.get('userId');
  const spectator = !!WBG.isSpectator;
  const READY = 'kingdomino-ready';
  const IMG = '/images/kingdomino/';
  const tileSrc = (a) => `${IMG}s/${a}.jpg`;
  const pawnSrc = (c) => `${IMG}pawn-${c}.png`;
  const ROT = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const TERRAIN = { farm: '#e0b13a', forest: '#3f7d3a', water: '#2f7fc4', plains: '#8cc152', swamp: '#d9a066', mine: '#6b625a' };
  const COLOR = { red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308' };
  const CROWN_SVG = '<svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 18.5h16M4.5 17L3 7.5l5 4 4-6.5 4 6.5 5-4L19.5 17z"/></svg>';

  let S = null;            // latest snapshot
  let legal = null;        // { tile, set: Set, list } for my placing step
  let rot = 0;
  let anchor = null;       // { r, c } of the left half
  let picked = null;       // tile number selected in the pick row
  let viewId = null;       // whose kingdom is on the big board
  let pinned = false;      // the viewer chose a board manually
  let sending = false;
  let recvAt = 0;
  let lastNotice = 0;
  let lastSecond = -1;
  let trayAngle = 0;
  let geom = null;
  let dragging = false;
  let dragMoved = false;
  const painted = new Map();

  const reduceMotion = () => document.documentElement.classList.contains('reduce-motion')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  for (const ev of ['kingdomino-state', 'kingdomino-legal', 'kingdomino-reject']) socket.off(ev);

  WBG.setRules({
    title: 'Kingdomino',
    sections: [
      { title: 'Goal', items: [
        'Build the highest scoring 5x5 (or 7x7) kingdom. The game ends when every domino has been placed.',
        'Each connected area of the same land type scores its number of squares times the crowns in it. Areas without crowns score nothing.'
      ] },
      { title: 'A round', items: [
        'A new row of dominoes is revealed, lowest number first. Players act in the order of the previous row: whoever owns the lowest tile goes first.',
        'On your turn first place the domino you took last round into your kingdom, then move your king onto one of the new dominoes. Picking last means acting first next round.',
        'The very first row has nothing to place: kings are set on it in random order. The last round is place-only.',
        'With 3 players 3 dominoes are drawn, otherwise 4. With 2 players everyone has two kings and acts twice per round.'
      ] },
      { title: 'Placing a domino', items: [
        'Both halves must lie on empty squares, and your kingdom must always fit inside the size x size area.',
        'At least one half must touch your castle or a square of the same land type. The castle matches every land type.',
        'Tap a square to preview the domino (green fits, red does not), rotate it, then press Place or tap the square again. On desktop you can hover and click, or drag the tile.',
        'A domino that fits nowhere is discarded automatically.'
      ] },
      { title: 'Bonuses', items: [
        'Middle Kingdom +10: your castle is in the exact centre of your kingdom.',
        'Harmony +5: a complete kingdom with no discarded domino.',
        'Ties are broken by the largest property, then by total crowns.'
      ] },
      { title: 'Time', items: [
        'You have 20 seconds to pick and 30 seconds to place. When time runs out the game plays for you. Players who leave are played automatically.'
      ] }
    ]
  });

  // ---------------------------------------------------------------- helpers
  function setHtml(el, markup) {
    if (painted.get(el) === markup) return false;
    painted.set(el, markup);
    el.innerHTML = markup;
    return true;
  }
  const player = (id) => S?.players.find((p) => p.id === id);
  const colorOf = (id) => player(id)?.color || 'red';
  const firstName = (name) => String(name || '').slice(0, 12);
  const iAmPlaying = () => !spectator && !!player(myId);
  const myPlace = () => !!S && S.phase === 'play' && S.actor === myId && S.stage === 'place' && !spectator;
  const myPick = () => !!S && S.phase === 'play' && S.actor === myId && S.stage === 'pick' && !spectator;
  const turnKey = (s) => (s && s.phase === 'play' && s.actor === myId ? `${s.round}.${s.stepIdx}.${s.stage}` : null);
  const tileInfo = (s, n) => [...(s.cur || []), ...(s.prev || [])].find((x) => x.tile === n);

  function describe(slot) {
    const half = (h) => `${h[0]}${h[1] ? ` with ${h[1]} crown${h[1] > 1 ? 's' : ''}` : ''}`;
    return `Tile ${slot.tile}: ${half(slot.l)} and ${half(slot.r)}`;
  }

  function animate(el, frames, opts) {
    if (!el || reduceMotion() || !el.animate) return;
    try { el.animate(frames, opts); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- state
  function onState(s) {
    const old = S;
    if (old && s.seq < old.seq) return;
    S = s;
    recvAt = performance.now();
    sending = false;

    const fx = old ? diff(old, s) : null;

    // who is on the big board
    const key = turnKey(s);
    const wasKey = turnKey(old);
    if (key && key !== wasKey) {
      picked = null;
      anchor = null;
      legal = null;
      viewId = myId;
      pinned = false;
      if (old) { WBG.sound.play('turn'); WBG.haptic(30); }
    }
    if (!key) {
      legal = null;
      anchor = null;
      if (!myPick()) picked = null;
    }
    if (picked !== null && !(s.cur || []).some((x) => x.tile === picked && !x.owner)) picked = null;
    if (!player(viewId)) { viewId = null; pinned = false; }
    if (!viewId) viewId = iAmPlaying() ? myId : (s.actor || s.players[0]?.id);
    if (!pinned && (spectator || !iAmPlaying()) && s.actor) viewId = s.actor;

    render();
    if (fx) playFx(fx);
    lastNotice = Math.max(lastNotice, ...s.notices.map((n) => n.id), 0);
  }

  function diff(old, s) {
    const fx = { reveal: [], pawns: [], doms: [], notices: [], scoreUp: false, over: false };
    if (s.cur && (!old.cur || old.cur[0]?.tile !== s.cur[0]?.tile)) fx.reveal = s.cur.map((x) => x.tile);
    const owned = new Map();
    for (const x of [...(old.cur || []), ...(old.prev || [])]) if (x.owner) owned.set(x.tile, x.owner);
    for (const x of [...(s.cur || []), ...(s.prev || [])]) if (x.owner && !owned.has(x.tile)) fx.pawns.push(x);
    for (const p of s.players) {
      const was = old.players.find((q) => q.id === p.id);
      const seen = new Set((was?.doms || []).map((d) => d.n));
      for (const d of p.doms) if (!seen.has(d.n)) fx.doms.push({ id: p.id, n: d.n });
      if (p.id === myId && was && p.score > was.score) fx.scoreUp = true;
    }
    fx.notices = s.notices.filter((n) => n.id > lastNotice);
    fx.over = old.phase !== 'over' && s.phase === 'over';
    return fx;
  }

  function playFx(fx) {
    fx.reveal.forEach((tile, i) => {
      WBG.sound.later('flip', i * 110);
      const el = $('kd-cur-row').querySelector(`[data-tile="${tile}"]`);
      animate(el, [
        { transform: 'perspective(500px) rotateY(90deg)', opacity: 0 },
        { transform: 'perspective(500px) rotateY(0deg)', opacity: 1 }
      ], { duration: 380, delay: i * 110, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
    });
    for (const x of fx.pawns) {
      WBG.sound.play(x.owner === myId ? 'click' : 'pop');
      const row = S.cur?.some((c) => c.tile === x.tile) ? $('kd-cur-row') : $('kd-prev-row');
      animate(row.querySelector(`[data-tile="${x.tile}"] .kd-pawn`), [
        { transform: 'translateY(-26px) scale(1.7)', opacity: 0 },
        { transform: 'translateY(2px) scale(0.95)', opacity: 1, offset: 0.7 },
        { transform: 'none', opacity: 1 }
      ], { duration: 420, easing: 'ease-out' });
    }
    for (const d of fx.doms) {
      WBG.sound.play('place');
      if (d.id === viewId) {
        const el = $('kd-board').querySelector(`.kd-dom[data-n="${d.n}"]`);
        if (el) {
          const base = el.style.transform;
          animate(el, [
            { transform: `${base} scale(1.4)`, opacity: 0 },
            { transform: `${base} scale(0.96)`, opacity: 1, offset: 0.7 },
            { transform: `${base} scale(1)`, opacity: 1 }
          ], { duration: 340, easing: 'ease-out' });
        }
      }
    }
    for (const n of fx.notices) {
      if (n.kind === 'discard') {
        WBG.sound.play('bump');
        const name = player(n.odId)?.name || 'A player';
        WBG.toast(n.odId === myId ? `Tile ${n.tile} fits nowhere and was discarded` : `${name} discarded tile ${n.tile}: no legal spot`, { type: 'info', icon: 'info' });
        animate($('kd-prev-row').querySelector(`[data-tile="${n.tile}"]`), [
          { transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' },
          { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }
        ], { duration: 360 });
      } else if (n.kind === 'place' && n.auto && n.odId === myId) {
        WBG.toast('Time ran out: your tile was placed for you', { type: 'info' });
      } else if (n.kind === 'pick' && n.auto && n.odId === myId) {
        WBG.toast('Time ran out: a tile was picked for you', { type: 'info' });
      } else if (n.kind === 'left') {
        WBG.toast(`${player(n.odId)?.name || 'A player'} left: their turns are played automatically`, { type: 'info' });
      }
    }
    if (fx.scoreUp) WBG.sound.later('coin', 260);
    if (fx.over) WBG.sound.play('notify');
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!S) return;
    renderDraft();
    renderBanner();
    renderPlayers();
    renderBoard();
    renderTray();
    tick();
  }

  function slotHtml(slot, o) {
    const pawn = slot.owner
      ? `<img class="kd-pawn" src="${pawnSrc(colorOf(slot.owner))}" alt="${esc(player(slot.owner)?.name || '')}'s king" title="${esc(player(slot.owner)?.name || '')}">`
      : '';
    let mark = '';
    if (slot.placed === 'placed') mark = `<span class="kd-mark">${WBG.icon('check', 'size-6')}</span>`;
    else if (slot.placed === 'discarded') mark = `<span class="kd-mark">${WBG.icon('x', 'size-7')}</span>`;
    return `<button type="button" class="kd-slot" data-tile="${slot.tile}" data-pick="${o.pick ? 1 : 0}" data-sel="${o.sel ? 1 : 0}"
      data-active="${o.active ? 1 : 0}" data-done="${slot.placed || ''}" aria-label="${esc(describe(slot))}" ${o.pick ? '' : 'tabindex="-1"'}>
      <img class="kd-tile" src="${tileSrc(slot.a)}" alt="" draggable="false" decoding="async">
      <span class="kd-no">${slot.tile}</span>${pawn}${mark}</button>`;
  }

  function renderDraft() {
    const prevLabel = $('kd-prev-label');
    const curLabel = $('kd-cur-label');
    const prevRow = $('kd-prev-row');
    const curRow = $('kd-cur-row');
    const n = S.draftSize;
    prevLabel.hidden = prevRow.hidden = !S.prev;
    curRow.hidden = !S.cur;
    if (S.cur) curLabel.hidden = false;
    curLabel.classList.toggle('mt-2', !!S.prev);

    if (S.prev) {
      setHtml(prevLabel, `${WBG.icon('hourglass', 'size-3.5')}<span>${S.cur ? 'Place in this order' : S.phase === 'over' ? 'Last row' : 'Final round: place only'}</span>`);
      prevRow.style.setProperty('--n', n);
      setHtml(prevRow, S.prev.map((s) => slotHtml(s, {
        active: S.phase === 'play' && S.stage === 'place' && S.tile === s.tile
      })).join(''));
    }
    if (S.cur) {
      const mine = myPick();
      const left = S.tilesLeft;
      const text = S.phase === 'over' ? '' : S.prev ? 'New row: pick one' : 'First row: choose your starting tiles';
      setHtml(curLabel, `${WBG.icon('target', 'size-3.5')}<span>${text}</span><span class="ml-auto font-medium tracking-normal text-slate-500 normal-case">${left} in the deck</span>`);
      curRow.style.setProperty('--n', n);
      setHtml(curRow, S.cur.map((s) => slotHtml(s, {
        pick: mine && !s.owner && !sending, sel: picked === s.tile
      })).join(''));
    } else {
      curLabel.hidden = true;
    }
  }

  function renderBanner() {
    const pawn = $('kd-banner-pawn');
    const text = $('kd-banner-text');
    const bar = $('kd-bar');
    let msg;
    let color = null;
    if (S.phase === 'wait') msg = 'Waiting for everyone to load...';
    else if (S.phase === 'over') {
      const top = S.final?.filter((r) => r.rank === 1) || [];
      msg = top.length === 1 ? `${top[0].name} wins` : top.length ? `Tie: ${top.map((t) => t.name).join(' and ')}` : 'Game over';
    } else {
      const a = player(S.actor);
      color = a?.color;
      const mine = S.actor === myId && !spectator;
      if (S.stage === 'place') msg = mine ? `Your turn: place tile ${S.tile}` : `${a?.name} is placing tile ${S.tile}`;
      else msg = mine ? 'Your turn: pick a tile' : `${a?.name} is picking a tile`;
      if (a?.left) msg += ' (left)';
    }
    text.textContent = msg;
    pawn.hidden = !color;
    if (color) pawn.src = pawnSrc(color);
    bar.style.background = color ? COLOR[color] : '#6366f1';

    const steps = S.phase === 'play' ? S.steps : [];
    $('kd-order').hidden = !steps.length;
    const orderHtml = steps.map((st, i) => {
      const p = player(st.id);
      const label = st.id === myId && !spectator ? 'You' : firstName(p?.name);
      return `<span class="kd-oc" data-done="${i < S.stepIdx ? 1 : 0}" data-active="${i === S.stepIdx ? 1 : 0}">
        <img src="${pawnSrc(p?.color || 'red')}" alt=""><span>${esc(label)}</span>${st.place ? `<span class="n">#${st.place}</span>` : ''}</span>`;
    }).join('');
    if (setHtml($('kd-order'), orderHtml)) {
      const act = $('kd-order').querySelector('[data-active="1"]');
      if (act) $('kd-order').scrollLeft = act.offsetLeft - $('kd-order').clientWidth / 2 + act.clientWidth / 2;
    }
  }

  function miniHtml(p) {
    const cells = new Map(p.cells.map((c) => [`${c.r},${c.c}`, c]));
    let minR = 0, maxR = 0, minC = 0, maxC = 0;
    for (const c of p.cells) {
      minR = Math.min(minR, c.r); maxR = Math.max(maxR, c.r);
      minC = Math.min(minC, c.c); maxC = Math.max(maxC, c.c);
    }
    minR -= 1; maxR += 1; minC -= 1; maxC += 1;
    const lim = S.size - 1;
    minR = Math.max(minR, -lim); maxR = Math.min(maxR, lim); minC = Math.max(minC, -lim); maxC = Math.min(maxC, lim);
    let out = '';
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (!r && !c) { out += '<b style="background:#e2e8f0"></b>'; continue; }
        const cell = cells.get(`${r},${c}`);
        out += cell
          ? `<b class="${cell.k ? (cell.k > 1 ? 'k k2' : 'k') : ''}" style="background:${TERRAIN[cell.t]}"></b>`
          : '<b style="background:rgb(255 255 255 / .05)"></b>';
      }
    }
    return `<div class="kd-mini" style="grid-template-columns:repeat(${maxC - minC + 1},9px)" aria-hidden="true">${out}</div>`;
  }

  function renderPlayers() {
    const list = $('kd-players-list');
    const html = S.players.map((p) => {
      const you = p.id === myId && !spectator;
      const active = S.phase === 'play' && p.id === S.actor;
      let extra = '';
      if (S.phase === 'over') {
        const bits = [];
        if (p.middle) bits.push('Middle +10');
        if (p.harmony) bits.push('Harmony +5');
        if (bits.length) extra = `<p class="mt-0.5 text-[11px] font-semibold text-amber-300">${bits.join('  ')}</p>`;
      }
      return `<button type="button" class="kd-pcard card-flat flex items-center gap-2.5 p-2" data-id="${esc(p.id)}" aria-pressed="${p.id === viewId}" aria-label="Show ${esc(p.name)}'s kingdom">
        ${miniHtml(p)}
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5 text-[13px] font-semibold text-white">
            <img src="${pawnSrc(p.color)}" class="size-5 shrink-0" alt="">
            <span class="truncate">${esc(p.name)}</span>${you ? '<span class="chip shrink-0 !px-1.5 !py-0">you</span>' : ''}
            ${active ? '<span class="dot shrink-0 animate-pulse-soft bg-amber-400"></span>' : ''}
          </span>
          <span class="block text-lg leading-tight font-extrabold text-white tabular-nums">${p.score}<span class="ml-1 text-[11px] font-medium text-slate-400">pts</span></span>
          <span class="flex items-center gap-2 text-[11px] text-slate-400"><span class="inline-flex items-center gap-0.5 text-amber-300">${CROWN_SVG}${p.crowns}</span><span>best ${p.largest}</span>${p.left ? '<span class="text-rose-300">left</span>' : ''}</span>
          ${extra}
        </span>
      </button>`;
    }).join('');
    setHtml(list, html);
  }

  // Board geometry: the view contains every square (plus legal spots) with one square of margin.
  function viewFor(p) {
    const lim = S.size - 1;
    let minR = 0, maxR = 0, minC = 0, maxC = 0;
    for (const c of p.cells) {
      minR = Math.min(minR, c.r); maxR = Math.max(maxR, c.r);
      minC = Math.min(minC, c.c); maxC = Math.max(maxC, c.c);
    }
    const ext = { minR, maxR, minC, maxC };
    let v = { ...ext };
    if (p.id === myId && legal) {
      for (const [r, c, k] of legal.list) {
        const r2 = r + ROT[k][0], c2 = c + ROT[k][1];
        v.minR = Math.min(v.minR, r, r2); v.maxR = Math.max(v.maxR, r, r2);
        v.minC = Math.min(v.minC, c, c2); v.maxC = Math.max(v.maxC, c, c2);
      }
    }
    v = { minR: Math.max(v.minR - 1, -lim), maxR: Math.min(v.maxR + 1, lim), minC: Math.max(v.minC - 1, -lim), maxC: Math.min(v.maxC + 1, lim) };
    return { ext, v };
  }

  function renderBoard() {
    const board = $('kd-board');
    const wrap = $('kd-board-wrap');
    const p = player(viewId);
    if (!p) return;
    const { ext, v } = viewFor(p);
    const cols = v.maxC - v.minC + 1;
    const rows = v.maxR - v.minR + 1;
    const W = Math.max(0, wrap.clientWidth - 4);
    const H = Math.max(0, wrap.clientHeight - 4);
    const cs = Math.max(18, Math.floor(Math.min(W / cols, H / rows, 84)));
    geom = { cs, minR: v.minR, minC: v.minC, cols, rows };
    board.style.width = `${cs * cols}px`;
    board.style.height = `${cs * rows}px`;

    const size = S.size;
    const allow = { minR: ext.maxR - size + 1, maxR: ext.minR + size - 1, minC: ext.maxC - size + 1, maxC: ext.minC + size - 1 };
    const px = (r, c) => `left:${(c - v.minC) * cs}px;top:${(r - v.minR) * cs}px`;
    let h = `<div class="kd-cells" style="grid-template-columns:repeat(${cols},${cs}px);grid-auto-rows:${cs}px">`;
    for (let r = v.minR; r <= v.maxR; r++) {
      for (let c = v.minC; c <= v.maxC; c++) {
        const off = r < allow.minR || r > allow.maxR || c < allow.minC || c > allow.maxC;
        h += `<i class="kd-cell${off ? ' kd-off' : ''}"></i>`;
      }
    }
    h += '</div>';

    h += `<div class="kd-castle" style="${px(0, 0)};width:${cs}px;height:${cs}px;box-shadow:0 0 0 2px ${COLOR[p.color]}, 0 3px 6px rgb(0 0 0 / .4)"><img src="${IMG}castle.png" alt="Castle" draggable="false"></div>`;

    for (const d of p.doms) {
      const meta = { a: d.a };
      h += domHtml(meta, d.r, d.c, d.rot, px, cs, `data-n="${d.n}"`, 'kd-dom');
    }

    const mine = p.id === myId && legal && myPlace();
    if (mine) {
      const meta = tileOf(S.tile);
      const rotLegal = new Set();
      for (const [r, c, k] of legal.list) if (k === rot) rotLegal.add(`${r},${c}`);
      for (const key of rotLegal) {
        const [r, c] = key.split(',').map(Number);
        if (anchor && anchor.r === r && anchor.c === c) continue;
        h += `<span class="kd-mk" style="${px(r, c)};width:${cs}px;height:${cs}px"><i></i></span>`;
      }
      if (anchor && meta) {
        const ok = legal.set.has(`${anchor.r},${anchor.c},${rot}`);
        h += domHtml(meta, anchor.r, anchor.c, rot, px, cs, '', 'kd-dom kd-prev');
        const r2 = anchor.r + ROT[rot][0], c2 = anchor.c + ROT[rot][1];
        for (const [r, c] of [[anchor.r, anchor.c], [r2, c2]]) {
          h += `<span class="kd-ov ${ok ? 'ok' : 'bad'}" style="${px(r, c)};width:${cs}px;height:${cs}px"></span>`;
        }
      }
    }
    setHtml(board, h);
    board.style.cursor = mine ? 'pointer' : 'default';
  }

  const tileCache = new Map();
  const tileOf = (n) => tileCache.get(n) || null;
  function remember(s) {
    for (const x of [...(s.cur || []), ...(s.prev || [])]) tileCache.set(x.tile, x);
  }

  function domHtml(meta, r, c, rotation, px, cs, attrs, cls) {
    return `<img class="${cls}" ${attrs} src="${tileSrc(meta.a)}" alt="" draggable="false" style="${px(r, c)};width:${cs * 2}px;height:${cs}px;transform-origin:25% 50%;transform:rotate(${rotation * 90}deg)">`;
  }

  function renderTray() {
    const tray = $('kd-tray');
    const tile = $('kd-tray-tile');
    const hint = $('kd-tray-hint');
    const rotateBtn = $('kd-rotate');
    const confirm = $('kd-confirm');
    tray.hidden = spectator || !iAmPlaying();
    if (tray.hidden) return;

    const place = myPlace();
    const pick = myPick();
    tile.hidden = !place;
    rotateBtn.hidden = !place;
    confirm.hidden = !(place || pick);

    if (place) {
      const meta = tileOf(S.tile);
      if (tile.dataset.tile !== String(S.tile) && meta) {
        tile.dataset.tile = String(S.tile);
        trayAngle = rot * 90;
        tile.style.cssText = 'width:4.4rem;height:4.4rem;display:grid;place-items:center';
        tile.innerHTML = `<img src="${tileSrc(meta.a)}" alt="Tile ${meta.tile}" draggable="false" style="width:4.4rem;height:2.2rem;border-radius:.35rem;box-shadow:0 0 0 1px rgb(0 0 0 / .5),0 4px 10px rgb(0 0 0 / .45);transition:transform .22s cubic-bezier(.2,.9,.3,1.2);transform:rotate(${trayAngle}deg)">`;
      }
      const img = tile.firstElementChild;
      if (img) img.style.transform = `rotate(${trayAngle}deg)`;
      const ok = anchor && legal && legal.set.has(`${anchor.r},${anchor.c},${rot}`);
      confirm.innerHTML = `${WBG.icon('check', 'size-5')}<span>Place</span>`;
      confirm.disabled = !ok || sending || !legal;
      if (!legal) hint.textContent = 'Loading placements...';
      else if (!anchor) hint.textContent = 'Tap a square to preview. Dots show where it fits. Rotate to turn the tile.';
      else if (ok) hint.textContent = 'Fits. Tap Place, or tap the square again.';
      else {
        const other = [0, 1, 2, 3].some((k) => legal.set.has(`${anchor.r},${anchor.c},${k}`));
        hint.textContent = other ? 'Does not fit like this. Try rotating.' : 'It cannot go there. Try another square.';
      }
    } else if (pick) {
      tile.dataset.tile = '';
      confirm.innerHTML = `${WBG.icon('check', 'size-5')}<span>Take tile</span>`;
      confirm.disabled = picked === null || sending;
      hint.textContent = picked === null ? 'Choose a domino from the new row. Tap it again to confirm.' : `Tile ${picked} selected. Tap it again or press Take tile.`;
    } else {
      tile.dataset.tile = '';
      if (S.phase === 'over') hint.textContent = 'Final kingdoms. Tap a player to look at their board.';
      else if (S.phase === 'wait') hint.textContent = 'The game starts once everyone has loaded.';
      else {
        const a = player(S.actor);
        const mineLater = S.steps.some((st, i) => i > S.stepIdx && st.id === myId);
        hint.textContent = `${a?.name || 'Someone'} is ${S.stage === 'place' ? 'placing' : 'picking'}.${mineLater ? ' You are up soon.' : ''}`;
      }
    }
  }

  // ---------------------------------------------------------------- clock
  function tick() {
    if (!S) return;
    const bar = $('kd-bar');
    const clock = $('kd-clock');
    if (S.phase !== 'play' || !S.deadline || !S.duration) {
      bar.style.width = '0';
      clock.hidden = true;
      return;
    }
    const remaining = Math.max(0, S.deadline - S.now - (performance.now() - recvAt));
    const frac = Math.min(1, remaining / S.duration);
    bar.style.width = `${(frac * 100).toFixed(1)}%`;
    const secs = Math.ceil(remaining / 1000);
    const mine = S.actor === myId && !spectator;
    clock.hidden = false;
    clock.textContent = `${secs}s`;
    clock.classList.toggle('chip-danger', secs <= 5 && mine);
    if (mine && secs <= 5 && secs > 0 && secs !== lastSecond) WBG.sound.play('tick');
    lastSecond = secs;
  }

  // ---------------------------------------------------------------- input
  function cellAt(clientX, clientY) {
    if (!geom) return null;
    const rect = $('kd-board').getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
    return { r: Math.floor(y / geom.cs) + geom.minR, c: Math.floor(x / geom.cs) + geom.minC };
  }

  function canInteract() { return myPlace() && !!legal && viewId === myId && !sending; }

  function setAnchor(cell, quiet) {
    if (!cell) return;
    if (anchor && anchor.r === cell.r && anchor.c === cell.c) return;
    anchor = cell;
    if (!quiet) {
      const ok = legal.set.has(`${cell.r},${cell.c},${rot}`);
      WBG.sound.play(ok ? 'click' : 'tick');
      WBG.haptic(8);
    }
    renderBoard();
    renderTray();
  }

  function commitPlace() {
    if (!canInteract() || !anchor) return;
    if (!legal.set.has(`${anchor.r},${anchor.c},${rot}`)) {
      WBG.sound.play('error');
      WBG.haptic([20, 40, 20]);
      return;
    }
    sending = true;
    WBG.haptic(18);
    socket.emit('kingdomino-place', { tile: S.tile, r: anchor.r, c: anchor.c, rot });
    renderTray();
  }

  function commitPick() {
    if (!myPick() || picked === null || sending) return;
    sending = true;
    WBG.haptic(18);
    socket.emit('kingdomino-pick', { tile: picked });
    render();
  }

  function doRotate() {
    if (!canInteract()) return;
    rot = (rot + 1) % 4;
    trayAngle += 90;
    WBG.sound.play('flip');
    WBG.haptic(8);
    renderBoard();
    renderTray();
  }

  $('kd-board').addEventListener('click', (e) => {
    if (!canInteract()) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    if (anchor && anchor.r === cell.r && anchor.c === cell.c) return commitPlace();
    setAnchor(cell);
  });
  $('kd-board').addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !canInteract()) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (cell) setAnchor(cell, true);
  });

  $('kd-rotate').addEventListener('click', doRotate);
  $('kd-confirm').addEventListener('click', () => (myPlace() ? commitPlace() : commitPick()));

  $('kd-cur-row').addEventListener('click', (e) => {
    const btn = e.target.closest('.kd-slot[data-pick="1"]');
    if (!btn || !myPick() || sending) return;
    const tile = Number(btn.dataset.tile);
    if (picked === tile) return commitPick();
    picked = tile;
    WBG.sound.play('click');
    WBG.haptic(8);
    renderDraft();
    renderTray();
  });

  $('kd-players-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.kd-pcard');
    if (!btn || !S) return;
    viewId = btn.dataset.id;
    pinned = true;
    WBG.sound.play('click');
    renderPlayers();
    renderBoard();
  });

  // drag the tray tile onto the board
  const trayTile = $('kd-tray-tile');
  trayTile.addEventListener('pointerdown', (e) => {
    if (!canInteract()) return;
    dragging = true;
    dragMoved = false;
    try { trayTile.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  trayTile.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (cell) { dragMoved = true; setAnchor(cell, true); }
  });
  const endDrag = () => { dragging = false; };
  trayTile.addEventListener('pointerup', endDrag);
  trayTile.addEventListener('pointercancel', endDrag);
  trayTile.addEventListener('click', () => { if (!dragMoved) doRotate(); dragMoved = false; });

  const onKey = (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'r' || e.key === 'R') doRotate();
    else if (e.key === 'Enter' && myPlace()) commitPlace();
  };
  document.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- sockets
  socket.on('kingdomino-state', (s) => { remember(s); onState(s); });

  socket.on('kingdomino-legal', (m) => {
    if (!S || S.tile !== m.tile || !myPlace()) return;
    const set = new Set(m.list.map(([r, c, k]) => `${r},${c},${k}`));
    legal = { tile: m.tile, list: m.list, set };
    // start with a rotation that has at least one legal spot
    if (!m.list.some(([, , k]) => k === rot)) rot = m.list[0] ? m.list[0][2] : 0;
    trayAngle = rot * 90;
    render();
  });

  socket.on('kingdomino-reject', (m) => {
    sending = false;
    WBG.sound.play('error');
    WBG.haptic([20, 40, 20]);
    WBG.toast(m.message || 'That move is not allowed', { type: 'error' });
    render();
  });

  const onConnect = () => WBG.gameReady(READY);
  socket.on('connect', onConnect);

  const ro = new ResizeObserver(() => { if (S) { renderBoard(); } });
  ro.observe($('kd-board-wrap'));
  const clockTimer = setInterval(tick, 100);

  WBG.onTeardown(() => {
    clearInterval(clockTimer);
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    socket.off('connect', onConnect);
  });

  render();
  WBG.gameReady(READY);
})();
