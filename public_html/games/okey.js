await WBG.i18n.load('okey');
const R = await import('/games/okey-rules.js');

const $ = (id) => document.getElementById(id);
const myId = localStorage.getItem('userId');
const spectator = WBG.isSpectator;
const ROW = 12;
const SLOTS = 24;
const COL = ['#b97700', '#1d4ed8', '#1f2937', '#dc2626'];
const SHAPE = [
  (c) => `<circle cx="20" cy="44" r="3.6" fill="${c}"/>`,
  (c) => `<path d="M20 39.8l4 4.2-4 4.2-4-4.2z" fill="${c}"/>`,
  (c) => `<rect x="16.6" y="40.6" width="6.8" height="6.8" rx="1.2" fill="${c}"/>`,
  (c) => `<path d="M20 40l4.3 7.4h-8.6z" fill="${c}"/>`
];

let state = null;
let prev = null;
let pending = null;      // a state that arrived while dragging
let slots = new Array(SLOTS).fill(null);
const sel = new Set();
let deadlineLocal = 0;
let nextHandLocal = 0;
let lastTick = -1;
let drag = null;
let seenSeq = -1;
let finishCache = { key: '', list: [] };

socket.off('okey-state');
const timer = setInterval(tick, 200);
WBG.onTeardown(() => { clearInterval(timer); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); });

/* ------------------------------------------------------------------ tiles */
const colourName = (c) => WBG.t(`okey.colour.${c}`);

function tileLabel(x) {
  if (x.f) return WBG.t('okey.tile.fake');
  return WBG.t('okey.tile', { colour: colourName(x.c), n: x.v });
}

/** SVG face of a tile. x = { c, v } | { f: 1 }; joker draws the gold okey frame. */
function tileSvg(x, joker) {
  let face;
  if (x.f) {
    face = `<circle cx="20" cy="28" r="12" fill="none" stroke="#0f766e" stroke-width="2.4"/>
      <path d="M20 14l3.2 10.2L33.5 28l-10.3 3.8L20 42l-3.200-10.200L6.500 28l10.300-3.800z" fill="#0f766e"/>
      <circle cx="20" cy="28" r="3" fill="#fffdf4"/>`;
  } else {
    const col = COL[x.c];
    const two = x.v >= 10;
    face = `<text x="20" y="${two ? 34 : 35}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-weight="800" font-size="${two ? 23 : 28}" fill="${col}" ${two ? 'textLength="30" lengthAdjust="spacingAndGlyphs"' : ''}>${x.v}</text>${SHAPE[x.c](col)}`;
  }
  const frame = joker
    ? `<rect x="1.8" y="1.8" width="36.4" height="52.4" rx="5.5" fill="none" stroke="#f59e0b" stroke-width="2.6"/>
       <path d="M8 9.600l1.100 2.300 2.500.4-1.800 1.800.4 2.500L8 15.300l-2.200 1.300.4-2.500-1.800-1.800 2.500-.4z" fill="#f59e0b"/>`
    : '';
  return `<svg viewBox="0 0 40 56" aria-hidden="true"><rect x=".8" y=".8" width="38.4" height="54.4" rx="6" fill="url(#okey-ivory)" stroke="#b9a77d" stroke-width="1.2"/>${face}${frame}</svg>`;
}

function backSvg() {
  return '<svg viewBox="0 0 40 56" aria-hidden="true"><rect x=".8" y=".8" width="38.4" height="54.4" rx="6" fill="url(#okey-back)" stroke="#a5b4fc" stroke-width="1.2"/><rect x="5" y="5" width="30" height="46" rx="3.5" fill="none" stroke="#a5b4fc" stroke-opacity=".5"/></svg>';
}

/** A tile element. `real` is the actual tile; on the table `rep` is what a joker stands for. */
function tileEl(x, { joker = false, cls = '' } = {}) {
  const el = document.createElement('div');
  el.className = `otile ${cls}`;
  el.dataset.id = x.id;
  el.innerHTML = tileSvg(x, joker);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', joker ? `${tileLabel(x)} (${WBG.t('okey.label.okey')})` : tileLabel(x));
  return el;
}

const jokerOf = (t) => state && !t.f && R.isJoker(t, state.okey);

/** Real tile of a table entry { id, c, v, j, f }. */
const realOfMeld = (m) => (m.f ? { id: m.id, f: 1 } : m.j ? { id: m.id, c: state.okey.c, v: state.okey.v } : { id: m.id, c: m.c, v: m.v });

/* ------------------------------------------------------------------ rack */
const rackTiles = () => (state ? state.rack : []);
const byId = () => new Map(rackTiles().map((t) => [t.id, t]));

function segments() {
  const map = byId();
  const out = [];
  for (let r = 0; r < 2; r++) {
    let cur = [];
    for (let i = 0; i <= ROW; i++) {
      const id = i < ROW ? slots[r * ROW + i] : null;
      if (id !== null && map.has(id)) cur.push(map.get(id));
      else { if (cur.length) out.push(cur); cur = []; }
    }
  }
  return out;
}

/** Groups and pairs the current layout would lay down (only the selected ones if something is selected). */
function layout() {
  const okey = state.okey;
  const groups = [];
  const pairs = [];
  let total = 0;
  const only = (seg) => sel.size === 0 || seg.every((t) => sel.has(t.id));
  const marks = new Map();
  for (const seg of segments()) {
    const a = R.arrangeGroup(seg, okey);
    if (a) {
      for (const t of seg) marks.set(t.id, 'grp');
      if (only(seg)) { groups.push(seg.map((t) => t.id)); total += a.points; }
      continue;
    }
    if (seg.length >= 2 && seg.length % 2 === 0) {
      let ok = true;
      for (let i = 0; i < seg.length; i += 2) if (!R.isPair(seg[i], seg[i + 1], okey)) ok = false;
      if (ok) {
        for (const t of seg) marks.set(t.id, 'prs');
        if (only(seg)) for (let i = 0; i < seg.length; i += 2) pairs.push([seg[i].id, seg[i + 1].id]);
      }
    }
  }
  return { groups, pairs, total, marks };
}

function finishers() {
  if (state.mode !== 'classic' || state.rack.length !== 15) return [];
  const key = state.rack.map((t) => t.id).sort((a, b) => a - b).join(',') + `|${state.okey.c}.${state.okey.v}`;
  if (finishCache.key !== key) finishCache = { key, list: R.finishingDiscards(state.rack, state.okey) };
  return finishCache.list;
}

const myTurn = () => !!state && !spectator && state.turn === myId && state.phase === 'play';
const canDraw = () => myTurn() && state.stage === 'draw';
const canDiscard = () => myTurn() && state.stage === 'discard';

function renderRack() {
  const map = byId();
  const { marks } = state && !spectator ? layout() : { marks: new Map() };
  const fin = canDiscard() ? new Set(finishers().map((f) => f.id).slice(0, 1)) : new Set();
  const cells = [];
  for (let i = 0; i < SLOTS; i++) {
    const cell = document.createElement('div');
    cell.className = 'okey-slot';
    cell.dataset.slot = i;
    const id = slots[i];
    if (id !== null && map.has(id)) {
      const t = map.get(id);
      const cls = [sel.has(id) ? 'sel' : '', marks.get(id) || '', fin.has(id) ? 'fin' : '', state.drawn === id && prev && state.phase === 'play' && canDiscard() ? 'fresh' : ''].join(' ');
      const el = tileEl(t, { joker: jokerOf(t), cls });
      el.addEventListener('pointerdown', (e) => beginDrag(e, { kind: 'tile', id, el }));
      cell.appendChild(el);
    }
    cells.push(cell);
  }
  $('okey-rack').replaceChildren(...cells);
}

function commitSlots(send = true) {
  renderRack();
  renderActions();
  if (send && !spectator) socket.emit('okey-arrange', { slots });
}

function moveTo(id, slot) {
  const from = slots.indexOf(id);
  if (from === -1 || slot < 0 || slot >= SLOTS || from === slot) return;
  const other = slots[slot];
  slots[slot] = id;
  slots[from] = other;
  WBG.sound.play('click');
  commitSlots();
}

function moveSelected(slot) {
  const ids = slots.filter((x) => x !== null && sel.has(x));
  if (!ids.length) return;
  if (ids.length === 1) { moveTo(ids[0], slot); sel.clear(); return commitSlots(false); }
  const next = slots.map((x) => (x !== null && sel.has(x) ? null : x));
  let s = slot;
  for (const id of ids) {
    while (s < SLOTS && next[s] !== null) s++;
    if (s >= SLOTS) { WBG.sound.play('error'); return; }
    next[s++] = id;
  }
  slots = next;
  sel.clear();
  WBG.sound.play('click');
  commitSlots();
}

function fill(order, gapBetween = [], splitLast = false) {
  const next = new Array(SLOTS).fill(null);
  let pos = 0;
  for (const [pi, part] of order.entries()) {
    const need = part.length;
    const rowLeft = ROW - (pos % ROW);
    if (need <= ROW && need > rowLeft && pos < ROW && !(splitLast && pi === order.length - 1)) pos = ROW; // keep a group on one row
    for (const id of part) { if (pos < SLOTS) next[pos++] = id; }
    if (gapBetween.length && pos % ROW !== 0 && pos < SLOTS) pos++;
  }
  return next;
}

function sortRack(by) {
  const tiles = [...state.rack];
  const key = (t) => (t.f ? [9, 0] : jokerOf(t) ? [9, 1] : by === 'colour' ? [t.c, t.v] : [t.v, t.c]);
  tiles.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; });
  slots = fill([tiles.map((t) => t.id)]);
  sel.clear();
  WBG.sound.play('deal');
  commitSlots();
}

function autoGroup() {
  if (state.rack.length === 0) return;
  const res = R.solveGroups(state.rack, state.okey);
  const map = byId();
  const rest = (res ? res.rest : state.rack.map((t) => t.id)).map((id) => map.get(id))
    .sort((a, b) => (a.f ? 9 : a.c) - (b.f ? 9 : b.c) || (a.v || 0) - (b.v || 0)).map((t) => t.id);
  const groups = res ? res.groups : [];
  let next = fill([...groups, rest], [1], true);
  if (next.filter((x) => x !== null).length !== state.rack.length) next = fill([[...groups.flat(), ...rest]]);
  slots = next;
  sel.clear();
  WBG.sound.play('deal');
  commitSlots();
}

/* ------------------------------------------------------------ drag + tap */
function beginDrag(e, info) {
  if (e.button > 0 || spectator && info.kind === 'tile') return;
  drag = { ...info, sx: e.clientX, sy: e.clientY, active: false, ghost: null, pointer: e.pointerId };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function targetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('[data-slot],[data-drop],[data-meld],#okey-rack') : null;
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.pointer) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 7) return;
    drag.active = true;
    const r = drag.el.getBoundingClientRect();
    const g = drag.el.cloneNode(true);
    g.className = 'okey-ghost';
    g.style.width = `${r.width}px`;
    g.style.height = `${r.height}px`;
    document.body.appendChild(g);
    drag.ghost = g;
    drag.el.style.opacity = '0.25';
  }
  e.preventDefault?.();
  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;
  document.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
  const t = targetAt(e.clientX, e.clientY);
  if (t && t.id !== 'okey-rack') t.classList.add('over');
}

function onUp(e) {
  if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointer)) return;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
  const d = drag;
  drag = null;
  document.querySelectorAll('.over').forEach((n) => n.classList.remove('over'));
  d.ghost?.remove();
  if (d.el) d.el.style.opacity = '';
  if (e.type === 'pointercancel') { flushPending(); return; }
  if (!d.active) { onTap(d); flushPending(); return; }
  const t = targetAt(e.clientX, e.clientY);
  if (t) onDrop(d, t);
  flushPending();
}

function flushPending() {
  if (pending) { const s = pending; pending = null; applyState(s); } else if (state) { renderRack(); renderActions(); }
}

function onTap(d) {
  if (d.kind === 'stock') return drawStock();
  if (d.kind === 'take') return drawDiscard();
  if (d.kind === 'tile') {
    if (sel.has(d.id)) sel.delete(d.id); else sel.add(d.id);
    WBG.sound.play('click');
    renderRack();
    renderActions();
    renderTable();
  }
}

function onDrop(d, t) {
  if (d.kind === 'tile') {
    if (t.dataset.slot !== undefined) return moveTo(d.id, Number(t.dataset.slot));
    if (t.dataset.drop === 'discard') return doDiscard(d.id);
    if (t.dataset.meld !== undefined) {
      const ids = sel.has(d.id) && sel.size > 1 ? [...sel] : [d.id];
      return doAdd(Number(t.dataset.meld), ids);
    }
    return;
  }
  const onRack = t.dataset.slot !== undefined || t.id === 'okey-rack';
  if (!onRack) return;
  if (d.kind === 'stock') drawStock(); else if (d.kind === 'take') drawDiscard();
}

/* ---------------------------------------------------------------- actions */
function drawStock() {
  if (!canDraw()) return WBG.sound.play('error');
  socket.emit('okey-draw', { from: 'stock' });
}
function drawDiscard() {
  if (!canDraw()) return WBG.sound.play('error');
  socket.emit('okey-draw', { from: 'discard' });
}
function doDiscard(id) {
  if (!canDiscard() || !state.rack.some((t) => t.id === id)) return WBG.sound.play('error');
  sel.clear();
  socket.emit('okey-discard', { tile: id });
}
function doAdd(meld, ids) {
  if (!canDiscard()) return WBG.sound.play('error');
  sel.clear();
  socket.emit('okey-add', { meld, tiles: ids });
}

$('okey-discard').addEventListener('click', () => { if (sel.size === 1) doDiscard([...sel][0]); });
$('okey-finish').addEventListener('click', () => {
  const best = finishers()[0];
  if (best) { sel.clear(); socket.emit('okey-finish', { tile: best.id }); }
});
$('okey-open').addEventListener('click', () => {
  const l = layout();
  if (state.players.find((p) => p.id === myId)?.opened) {
    if (l.groups.length) { sel.clear(); socket.emit('okey-open', { groups: l.groups }); }
  } else if (l.total >= state.limit && l.groups.length) { sel.clear(); socket.emit('okey-open', { groups: l.groups }); }
  else if (l.pairs.length >= 5) { sel.clear(); socket.emit('okey-open', { pairs: l.pairs }); }
});
$('okey-sort-colour').addEventListener('click', () => state && sortRack('colour'));
$('okey-sort-number').addEventListener('click', () => state && sortRack('number'));
$('okey-group').addEventListener('click', () => state && autoGroup());
$('okey-pile-close').addEventListener('click', () => { $('okey-pile-view').hidden = true; });
$('okey-pile-view').addEventListener('click', (e) => { if (e.target === $('okey-pile-view')) $('okey-pile-view').hidden = true; });
$('okey-stock').addEventListener('pointerdown', (e) => beginDrag(e, { kind: 'stock', el: $('okey-stock-art') }));

function renderActions() {
  if (!state) return;
  const me = state.players.find((p) => p.id === myId);
  const discard = canDiscard();
  const l = !spectator && state.mode === '101' && discard ? layout() : null;
  const fin = discard ? finishers() : [];
  $('okey-discard').hidden = !(discard && sel.size === 1);
  $('okey-finish').hidden = !(fin.length > 0);
  const opened = !!me?.opened;
  let showOpen = false;
  if (l) {
    if (opened) {
      showOpen = l.groups.length > 0;
      $('okey-open-label').textContent = WBG.t('okey.btn.lay');
      $('okey-total').hidden = true;
    } else {
      const okGroups = l.total >= state.limit && l.groups.length > 0;
      const okPairs = l.pairs.length >= 5;
      showOpen = okGroups || okPairs;
      $('okey-open-label').textContent = okPairs && !okGroups ? WBG.t('okey.btn.openPairs') : WBG.t('okey.btn.open');
      const total = $('okey-total');
      total.hidden = false;
      total.textContent = l.pairs.length && !l.groups.length
        ? WBG.t('okey.pairsTotal', { n: l.pairs.length, need: 5 })
        : WBG.t('okey.total', { n: l.total, need: state.limit });
      total.className = `chip ${okGroups || okPairs ? 'chip-success' : 'chip-brand'}`;
    }
  } else $('okey-total').hidden = true;
  $('okey-open').hidden = !showOpen;
  $('okey-addhint').hidden = !(discard && state.mode === '101' && opened && sel.size > 0 && state.table.some((m) => m.kind !== 'pair'));
  $('okey-sort-colour').disabled = $('okey-sort-number').disabled = $('okey-group').disabled = spectator || !state.rack.length;
}

/* ----------------------------------------------------------------- render */
function renderPlayers() {
  const takeId = canDraw() ? state.takeFrom : null;
  const mine = (id) => id === myId;
  $('okey-players').replaceChildren(...state.players.map((p) => {
    const li = document.createElement('li');
    const turn = p.id === state.turn && state.phase === 'play';
    li.className = `min-w-0 flex-1 rounded-2xl border px-2 py-1.5 transition ${turn ? 'border-emerald-400/70 bg-emerald-500/12' : 'border-white/8 bg-white/4'}`;
    li.dataset.pid = p.id;
    const top = p.pile[p.pile.length - 1];
    const take = takeId === p.id && p.pile.length > 0;
    const wasTop = prev?.players.find((x) => x.id === p.id)?.pile.length;
    const pileEl = document.createElement('button');
    pileEl.className = `okey-pile relative block h-[2.7rem] w-[1.95rem] shrink-0 rounded-md ${take ? 'okey-take' : ''} ${!top ? 'border border-dashed border-white/20' : ''}`;
    pileEl.style.touchAction = take ? 'none' : 'manipulation';
    if (mine(p.id) && !spectator) pileEl.dataset.drop = 'discard';
    pileEl.setAttribute('aria-label', WBG.t('okey.pile.title', { name: p.name }));
    if (top) {
      const t = tileEl(top, { joker: !top.f && R.isJoker(top, state.okey), cls: `ro ${wasTop !== undefined && p.pile.length > wasTop ? 'lift' : ''}` });
      pileEl.appendChild(t);
    }
    if (p.pile.length > 1) {
      const n = document.createElement('span');
      n.className = 'absolute -right-1 -bottom-1 grid min-w-4 place-items-center rounded-full bg-ink-900 px-1 text-[10px] font-bold text-slate-200 ring-1 ring-white/20';
      n.textContent = p.pile.length;
      pileEl.appendChild(n);
    }
    if (take) pileEl.addEventListener('pointerdown', (e) => beginDrag(e, { kind: 'take', el: pileEl }));
    else pileEl.addEventListener('click', () => {
      if (mine(p.id) && canDiscard() && sel.size === 1) return doDiscard([...sel][0]);
      openPile(p);
    });
    const dealer = p.id === state.dealer && state.round >= 1 ? `<span class="chip px-1.5 py-0 text-[10px]">${WBG.esc(WBG.t('okey.role.dealer'))}</span>` : '';
    const opened = p.opened ? `<span class="chip chip-success px-1.5 py-0 text-[10px]">${WBG.esc(WBG.t(p.opened === 'pairs' ? 'okey.player.pairs' : 'okey.player.opened'))}</span>` : '';
    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    info.innerHTML = `<p class="truncate text-xs font-semibold text-white">${WBG.esc(p.name)}${mine(p.id) ? ` <span class="font-normal text-slate-400">${WBG.esc(WBG.t('okey.label.you'))}</span>` : ''}</p>
      <p class="mt-0.5 flex items-center gap-1 text-[11px] text-slate-300 tabular-nums">${WBG.icon('tiles', 'size-3.5')}${p.count}<span class="ml-1 font-bold text-brand-300">${p.score}</span></p>
      <p class="mt-0.5 flex flex-wrap gap-0.5">${opened}${dealer}</p>`;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-1.5';
    row.append(info, pileEl);
    li.appendChild(row);
    return li;
  }));
}

function openPile(p) {
  $('okey-pile-title').textContent = WBG.t('okey.pile.title', { name: p.name });
  const box = $('okey-pile-tiles');
  if (!p.pile.length) { box.innerHTML = `<p class="text-sm text-slate-400">${WBG.esc(WBG.t('okey.pile.empty'))}</p>`; }
  else {
    box.replaceChildren(...p.pile.map((t) => {
      const w = document.createElement('div');
      w.className = 'h-[3.9rem] w-[2.8rem]';
      w.appendChild(tileEl(t, { joker: !t.f && R.isJoker(t, state.okey), cls: 'ro' }));
      return w;
    }));
  }
  $('okey-pile-view').hidden = false;
}

function renderTable() {
  const wrap = $('okey-table-wrap');
  wrap.hidden = state.mode !== '101';
  if (state.mode !== '101') return;
  $('okey-table-empty').hidden = state.table.length > 0;
  const me = state.players.find((p) => p.id === myId);
  const picked = [...sel].map((id) => state.rack.find((t) => t.id === id)).filter(Boolean);
  const adding = canDiscard() && !!me?.opened && picked.length > 0;
  const names = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
  $('okey-table').replaceChildren(...state.table.map((m) => {
    const box = document.createElement('div');
    const fits = adding && m.kind !== 'pair' && !!R.arrangeGroup([...m.tiles.map(realOfMeld), ...picked], state.okey);
    box.className = `okey-meld rounded-xl border p-1.5 ${fits ? 'cursor-pointer border-emerald-400/70 bg-emerald-500/10' : 'border-white/10 bg-black/15'}`;
    box.dataset.meld = m.id;
    box.setAttribute('aria-label', WBG.t('okey.meld.of', { name: names[m.owner] || '' }));
    const row = document.createElement('div');
    row.className = 'flex gap-0.5';
    for (const x of m.tiles) {
      const w = document.createElement('div');
      w.className = 'h-[2.6rem] w-[1.85rem]';
      w.appendChild(tileEl(x.f ? { id: x.id, f: 1 } : { id: x.id, c: x.c, v: x.v }, { joker: !!x.j, cls: 'ro' }));
      row.appendChild(w);
    }
    const cap = document.createElement('p');
    cap.className = 'mt-1 truncate text-[10px] text-slate-400';
    cap.textContent = names[m.owner] || '';
    box.append(row, cap);
    if (fits) box.addEventListener('click', () => doAdd(m.id, picked.map((t) => t.id)));
    return box;
  }));
}

function statusText() {
  if (state.phase !== 'play') return WBG.tr(state.log);
  if (spectator || state.turn !== myId) {
    const p = state.players.find((x) => x.id === state.turn);
    return WBG.t('okey.status.waiting', { name: p ? p.name : '' });
  }
  if (state.stage === 'draw') return WBG.t('okey.status.yourDraw');
  return state.rack.length === 15 && state.players.every((p) => p.pile.length === 0) && state.dealer === myId ? WBG.t('okey.status.yourFirst') : WBG.t('okey.status.yourDiscard');
}

function renderResult() {
  const show = (state.phase === 'handOver' || state.phase === 'over') && state.result;
  $('okey-result').hidden = !show;
  if (!show) return;
  const r = state.result;
  const classic = state.mode === 'classic';
  $('okey-result-eyebrow').textContent = classic ? WBG.t('okey.round', { n: state.round, total: state.rounds }) : WBG.t('okey.round101', { n: state.round, limit: state.limit });
  const win = state.players.find((p) => p.id === r.winner);
  $('okey-result-title').textContent = win ? WBG.t('okey.result.wins', { name: win.name }) : WBG.t('okey.result.draw');
  $('okey-result-rows').replaceChildren(...[...state.players].sort((a, b) => (a.id === r.winner ? -1 : b.id === r.winner ? 1 : classic ? b.score - a.score : a.score - b.score)).map((p) => {
    const li = document.createElement('li');
    const isWin = p.id === r.winner;
    li.className = `rounded-xl px-3 py-2 ${isWin ? 'bg-amber-500/12 ring-1 ring-amber-400/40' : 'bg-white/5'}`;
    const gain = r.gains[p.id] ?? 0;
    const gainText = classic ? (gain ? WBG.t('okey.result.points', { n: gain }) : '') : (gain ? WBG.t('okey.result.penalty', { n: gain }) : WBG.t('okey.result.none'));
    const kind = isWin ? `<span class="chip chip-warn">${WBG.esc(WBG.t(`okey.kind.${r.kind}`))}</span>` : '';
    li.innerHTML = `<div class="flex items-center gap-2">${WBG.avatar(p.name, 'size-7 text-xs')}
      <span class="min-w-0 flex-1 truncate text-sm font-semibold text-white">${WBG.esc(p.name)}</span>${kind}
      <span class="text-xs font-semibold ${classic ? 'text-emerald-300' : 'text-rose-300'}">${WBG.esc(gainText)}</span>
      <span class="w-10 text-right text-sm font-bold text-brand-300 tabular-nums" title="${WBG.esc(WBG.t('okey.result.total'))}">${p.score}</span></div>`;
    const tiles = r.hands[p.id] || [];
    if (tiles.length) {
      const row = document.createElement('div');
      row.className = 'mt-1.5 flex flex-wrap gap-0.5';
      for (const t of tiles) {
        const w = document.createElement('div');
        w.className = 'h-[2.3rem] w-[1.65rem]';
        w.appendChild(tileEl(t, { joker: !t.f && R.isJoker(t, state.okey), cls: 'ro' }));
        row.appendChild(w);
      }
      li.appendChild(row);
    }
    return li;
  }));
  nextHandLocal = performance.now() + state.nextHandIn;
}

function render() {
  const classic = state.mode === 'classic';
  $('okey-indicator').replaceChildren(tileEl(state.indicator, { cls: 'ro' }));
  $('okey-okey').replaceChildren(tileEl({ id: -1, c: state.okey.c, v: state.okey.v }, { joker: true, cls: 'ro' }));
  $('okey-stock-art').innerHTML = backSvg();
  $('okey-stock-count').textContent = state.stock;
  $('okey-stock').disabled = false;
  $('okey-stock').classList.toggle('okey-take', canDraw());
  $('okey-stock').setAttribute('aria-label', WBG.t('okey.aria.stock', { n: state.stock }));
  $('okey-round').textContent = classic ? WBG.t('okey.round', { n: state.round, total: state.rounds }) : WBG.t('okey.round101', { n: state.round, limit: state.limit });
  $('okey-mode').textContent = WBG.t(classic ? 'okey.mode.classic' : 'okey.mode.m101');
  $('okey-spectator').hidden = !spectator;
  $('okey-status').textContent = statusText();
  renderPlayers();
  renderRack();
  renderTable();
  renderActions();
  renderResult();
  tick();
}

function applyState(s) {
  const first = !state;
  prev = state;
  state = s;
  deadlineLocal = performance.now() + s.timeLeft;
  // keep the local layout when only the order changed; otherwise the server layout (which includes new tiles)
  const ids = s.rack.map((t) => t.id).sort((a, b) => a - b).join(',');
  const mineIds = slots.filter((x) => x !== null).sort((a, b) => a - b).join(',');
  if (first || ids !== mineIds) slots = s.slots.length === SLOTS ? [...s.slots] : new Array(SLOTS).fill(null);
  for (const id of [...sel]) if (!s.rack.some((t) => t.id === id)) sel.delete(id);
  render();

  if (first) { seenSeq = s.last ? s.last.seq : -1; WBG.sound.play('deal'); return; }
  if (prev && prev.round !== s.round) { WBG.sound.play('deal'); seenSeq = -1; }
  if (s.last && s.last.seq !== seenSeq) {
    seenSeq = s.last.seq;
    if (s.last.kind === 'draw-stock' || s.last.kind === 'draw-discard') WBG.sound.play('card');
    else if (s.last.kind === 'discard') WBG.sound.play('place');
    else WBG.sound.play('coin');
  }
  if (!spectator && s.turn === myId && s.phase === 'play' && (prev.turn !== s.turn || prev.phase !== 'play')) { WBG.sound.play('turn'); WBG.haptic([30, 40, 30]); }
  if (s.phase !== 'play' && prev.phase === 'play') WBG.sound.play('reveal');
}

/* ------------------------------------------------------------------ timer */
function tick() {
  if (!state) return;
  const now = performance.now();
  if (state.phase === 'play' && deadlineLocal) {
    const left = Math.max(0, deadlineLocal - now);
    $('okey-bar').style.width = `${Math.min(100, (left / state.turnMs) * 100)}%`;
    const s = Math.ceil(left / 1000);
    if (myTurn() && s <= 5 && s > 0 && s !== lastTick) { lastTick = s; WBG.sound.play('tick'); }
  } else $('okey-bar').style.width = '0%';
  if (state.phase === 'handOver') {
    $('okey-result-next').textContent = WBG.t('okey.result.next', { n: Math.max(0, Math.ceil((nextHandLocal - now) / 1000)) });
  } else if (state.phase === 'over') $('okey-result-next').textContent = WBG.t('okey.result.last');
}

/* ------------------------------------------------------------------ rules */
const sec = (n, items) => ({ title: WBG.t(`okey.rules.s${n}.title`), items: items.map((i) => WBG.t(`okey.rules.s${n}.i${i}`)) });
WBG.setRules({
  title: WBG.t('okey.rules.title'),
  sections: [sec(1, [1, 2]), sec(2, [1, 2, 3]), sec(3, [1, 2]), sec(4, [1, 2, 3]), sec(5, [1, 2, 3, 4]), sec(6, [1])]
});

/* ----------------------------------------------------------------- socket */
socket.on('okey-state', (s) => {
  if (drag && drag.active) { pending = s; return; }
  try { applyState(s); } catch (err) { console.error('okey render', err && err.stack); }
});

WBG.gameReady('okey-page-loaded');
