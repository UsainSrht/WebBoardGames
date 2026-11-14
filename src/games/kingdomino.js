/**
 * Kingdomino (runs inside the GameRoom Durable Object).
 *
 * Real rules: a row of dominoes is revealed, players place their king on one of them in
 * the order the previous row dictates, then place the domino they took last round into
 * their own kingdom. Score = sum of (squares x crowns) for every connected property, plus
 * the optional Middle Kingdom (+10) and Harmony (+5) bonuses.
 *
 * Coordinates are relative to the castle, which sits at (0, 0). A placement is the anchor
 * cell of the left half plus a rotation 0..3 (the right half lies at anchor + ROT[rot]).
 */

export const TERRAINS = ['farm', 'forest', 'water', 'plains', 'swamp', 'mine'];
export const COLORS = ['red', 'blue', 'green', 'yellow'];

export const PICK_MS = 20000;
export const PLACE_MS = 30000;
export const AUTO_MS = 500;       // players who left are auto-played after this short pause
export const DISCARD_MS = 1800;   // pause so everyone can see a discarded tile
export const START_FALLBACK_MS = 8000;
export const FINISH_DELAY_MS = 25000;

// number, [leftType, leftCrowns], [rightType, rightCrowns], image asset
export const TILE_TABLE = [
  [1, ['farm', 0], ['farm', 0], '1'], [2, ['farm', 0], ['farm', 0], '1'],
  [3, ['forest', 0], ['forest', 0], '3'], [4, ['forest', 0], ['forest', 0], '3'],
  [5, ['forest', 0], ['forest', 0], '3'], [6, ['forest', 0], ['forest', 0], '3'],
  [7, ['water', 0], ['water', 0], '8'], [8, ['water', 0], ['water', 0], '8'], [9, ['water', 0], ['water', 0], '8'],
  [10, ['plains', 0], ['plains', 0], '10'], [11, ['plains', 0], ['plains', 0], '10'],
  [12, ['swamp', 0], ['swamp', 0], '12'],
  [13, ['farm', 0], ['forest', 0], '13'], [14, ['farm', 0], ['water', 0], '14'],
  [15, ['farm', 0], ['plains', 0], '15'], [16, ['farm', 0], ['swamp', 0], '16'],
  [17, ['forest', 0], ['water', 0], '17'], [18, ['forest', 0], ['plains', 0], '18'],
  [19, ['farm', 1], ['forest', 0], '19'], [20, ['farm', 1], ['water', 0], '20'],
  [21, ['farm', 1], ['plains', 0], '21'], [22, ['farm', 1], ['swamp', 0], '22'],
  [23, ['farm', 1], ['mine', 0], '23'],
  [24, ['forest', 1], ['farm', 0], '24'], [25, ['forest', 1], ['farm', 0], '24'],
  [26, ['forest', 1], ['farm', 0], '24'], [27, ['forest', 1], ['farm', 0], '24'],
  [28, ['forest', 1], ['water', 0], '28'], [29, ['forest', 1], ['plains', 0], '29'],
  [30, ['water', 1], ['farm', 0], '30'], [31, ['water', 1], ['farm', 0], '30'],
  [32, ['water', 1], ['forest', 0], '32'], [33, ['water', 1], ['forest', 0], '32'],
  [34, ['water', 1], ['forest', 0], '32'], [35, ['water', 1], ['forest', 0], '32'],
  [36, ['farm', 0], ['plains', 1], '36'], [37, ['water', 0], ['plains', 1], '37'],
  [38, ['farm', 0], ['swamp', 1], '38'], [39, ['plains', 0], ['swamp', 1], '39'],
  [40, ['mine', 1], ['farm', 0], '40'],
  [41, ['farm', 0], ['plains', 2], '41'], [42, ['water', 0], ['plains', 2], '42'],
  [43, ['farm', 0], ['swamp', 2], '43'], [44, ['plains', 0], ['swamp', 2], '44'],
  [45, ['mine', 2], ['farm', 0], '45'],
  [46, ['swamp', 0], ['mine', 2], '46'], [47, ['swamp', 0], ['mine', 2], '46'],
  [48, ['farm', 0], ['mine', 3], '48']
];

export const TILES = {};
for (const [number, [lt, lc], [rt, rc], asset] of TILE_TABLE) {
  TILES[number] = { number, l: [lt, lc], r: [rt, rc], a: asset };
}

/** Offset of the right half relative to the left half, per rotation. */
export const ROT = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const key = (r, c) => `${r},${c}`;

/** One player's kingdom. */
export class Board {
  constructor(size) {
    this.size = size;
    this.cells = new Map(); // "r,c" -> { r, c, t, k, n }
    this.discards = 0;
    this.doms = [];         // [{ n, r, c, rot }] in the order placed
  }

  at(r, c) {
    if (r === 0 && c === 0) return 'castle';
    return this.cells.get(key(r, c)) || null;
  }

  /** Bounding box of the castle and every square. */
  extents() {
    let minR = 0, maxR = 0, minC = 0, maxC = 0;
    for (const { r, c } of this.cells.values()) {
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    return { minR, maxR, minC, maxC };
  }

  /** Squares of the tile for a placement, or null when it is illegal. */
  placementCells(tile, r, c, rot) {
    if (!tile || !Number.isInteger(r) || !Number.isInteger(c) || !Number.isInteger(rot)) return null;
    const off = ROT[rot];
    if (!off) return null;
    const a = { r, c, t: tile.l[0], k: tile.l[1], n: tile.number };
    const b = { r: r + off[0], c: c + off[1], t: tile.r[0], k: tile.r[1], n: tile.number };
    for (const h of [a, b]) {
      if (this.at(h.r, h.c)) return null;
    }
    const e = this.extents();
    const minR = Math.min(e.minR, a.r, b.r), maxR = Math.max(e.maxR, a.r, b.r);
    const minC = Math.min(e.minC, a.c, b.c), maxC = Math.max(e.maxC, a.c, b.c);
    if (maxR - minR + 1 > this.size || maxC - minC + 1 > this.size) return null;

    const matches = (h, other) => DIRS.some(([dr, dc]) => {
      const nr = h.r + dr, nc = h.c + dc;
      if (nr === other.r && nc === other.c) return false;
      const cell = this.at(nr, nc);
      return cell === 'castle' || (cell && cell.t === h.t);
    });
    if (!matches(a, b) && !matches(b, a)) return null;
    return [a, b];
  }

  canPlace(tile, r, c, rot) {
    return !!this.placementCells(tile, r, c, rot);
  }

  /** Every legal [r, c, rot]. */
  legal(tile) {
    const out = [];
    const s = this.size;
    for (let r = -s; r <= s; r++) {
      for (let c = -s; c <= s; c++) {
        for (let rot = 0; rot < 4; rot++) {
          if (this.canPlace(tile, r, c, rot)) out.push([r, c, rot]);
        }
      }
    }
    return out;
  }

  place(tile, r, c, rot) {
    const cells = this.placementCells(tile, r, c, rot);
    if (!cells) return false;
    for (const h of cells) this.cells.set(key(h.r, h.c), h);
    this.doms.push({ n: tile.number, r, c, rot });
    return true;
  }

  /** Connected same-terrain properties: [{ type, squares, crowns }]. */
  properties() {
    const seen = new Set();
    const out = [];
    for (const start of this.cells.values()) {
      if (seen.has(key(start.r, start.c))) continue;
      let squares = 0, crowns = 0;
      const stack = [start];
      seen.add(key(start.r, start.c));
      while (stack.length) {
        const cur = stack.pop();
        squares++;
        crowns += cur.k;
        for (const [dr, dc] of DIRS) {
          const nxt = this.cells.get(key(cur.r + dr, cur.c + dc));
          if (nxt && nxt.t === start.t && !seen.has(key(nxt.r, nxt.c))) {
            seen.add(key(nxt.r, nxt.c));
            stack.push(nxt);
          }
        }
      }
      out.push({ type: start.t, squares, crowns });
    }
    return out;
  }

  /** Full score breakdown. */
  score(bonuses = true) {
    const props = this.properties();
    const base = props.reduce((sum, p) => sum + p.squares * p.crowns, 0);
    const largest = props.reduce((m, p) => Math.max(m, p.squares), 0);
    const crowns = props.reduce((sum, p) => sum + p.crowns, 0);
    const e = this.extents();
    const complete = this.cells.size + 1 === this.size * this.size
      && e.maxR - e.minR + 1 === this.size && e.maxC - e.minC + 1 === this.size;
    const middle = bonuses && e.minR === -e.maxR && e.minC === -e.maxC;
    const harmony = bonuses && complete && this.discards === 0;
    return {
      base, largest, crowns,
      middle: middle ? 10 : 0,
      harmony: harmony ? 5 : 0,
      total: base + (middle ? 10 : 0) + (harmony ? 5 : 0)
    };
  }
}

export class Kingdomino {
  constructor(room, players, options = {}) {
    this.room = room;
    this.players = players;
    this.rng = typeof options.rng === 'function' ? options.rng : Math.random;
    this.size = Number(options.size) === 7 ? 7 : 5;
    this.bonuses = options.bonuses !== 'off';

    const ids = Object.keys(players);
    const n = ids.length;
    this.draftSize = n === 3 ? 3 : 4;
    this.kingsEach = Math.max(1, Math.floor(this.draftSize / Math.max(1, n)));
    const used = n === 2 ? 24 : n === 3 ? 36 : 48;
    const pile = this.shuffle(Object.keys(TILES).map(Number)).slice(0, used);
    this.rows = [];
    for (let i = 0; i + this.draftSize <= pile.length; i += this.draftSize) {
      this.rows.push(pile.slice(i, i + this.draftSize).sort((a, b) => a - b));
    }
    this.rowIndex = 0;

    const colors = this.shuffle([...COLORS]);
    this.order = ids; // seating order
    this.pl = {};
    ids.forEach((id, i) => {
      this.pl[id] = {
        id, name: players[id].name, color: colors[i % colors.length],
        board: new Board(this.size), left: false
      };
    });

    this.phase = 'wait'; // wait | play | over
    this.round = 0;
    this.cur = null;     // row being picked from: [{ tile, owner }]
    this.prev = null;    // row being placed:      [{ tile, owner, placed }]
    this.steps = [];
    this.stepIdx = -1;
    this.stage = null;   // 'place' | 'pick'
    this.legalList = [];
    this.deadline = 0;
    this.stageMs = 0;
    this.timer = null;
    this.startTimer = null;
    this.finalRows = null;
    this.notices = [];
    this.noticeId = 0;
    this.seq = 0;
    this.ready = new Set();
    this.active = true;

    this.startTimer = setTimeout(() => this.start(), START_FALLBACK_MS);
  }

  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // ------------------------------------------------------------------ messaging

  handleMessage(odId, type, payload) {
    if (!this.active || !this.pl[odId]) return;
    payload = payload && typeof payload === 'object' ? payload : {};
    switch (type) {
      case 'kingdomino-ready': return this.onReady(odId);
      case 'kingdomino-pick': return this.onPick(odId, payload);
      case 'kingdomino-place': return this.onPlace(odId, payload);
    }
  }

  onReady(odId) {
    if (this.phase === 'wait') {
      this.ready.add(odId);
      this.sendState(odId);
      const waiting = this.order.filter(id => !this.pl[id].left && !this.ready.has(id));
      if (waiting.length === 0) this.start();
      return;
    }
    this.sendState(odId);
    this.sendLegal(odId);
  }

  spectatorSync(odId) {
    this.sendState(odId);
  }

  sendTo(odId, msg) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, msg);
  }

  sendState(odId) {
    this.sendTo(odId, this.snapshot());
  }

  sendLegal(odId) {
    if (this.phase !== 'play' || this.stage !== 'place') return;
    const step = this.steps[this.stepIdx];
    if (!step || step.odId !== odId) return;
    this.sendTo(odId, { type: 'kingdomino-legal', tile: step.place, seq: this.seq, list: this.legalList });
  }

  reject(odId, message) {
    this.sendTo(odId, { type: 'kingdomino-reject', message });
  }

  notice(kind, extra = {}) {
    this.notices.push({ id: ++this.noticeId, kind, ...extra });
    if (this.notices.length > 8) this.notices.shift();
  }

  /** Spectators are not players; broadcast reaches everybody including them. */
  push() {
    this.seq++;
    this.room.broadcast(this.snapshot());
  }

  slotView(s) {
    const t = TILES[s.tile];
    return { tile: t.number, l: t.l, r: t.r, a: t.a, owner: s.owner || null, placed: s.placed || null };
  }

  snapshot() {
    const step = this.steps[this.stepIdx];
    const players = this.order.map(id => {
      const p = this.pl[id];
      const sc = p.board.score(this.bonuses);
      return {
        id, name: p.name, color: p.color, left: p.left,
        score: this.phase === 'over' ? sc.total : sc.base, base: sc.base, largest: sc.largest, crowns: sc.crowns,
        middle: sc.middle, harmony: sc.harmony, discards: p.board.discards,
        doms: p.board.doms.map(d => ({ ...d, a: TILES[d.n].a })),
        cells: [...p.board.cells.values()].map(c => ({ r: c.r, c: c.c, t: c.t, k: c.k, n: c.n }))
      };
    });
    return {
      type: 'kingdomino-state',
      seq: this.seq,
      phase: this.phase,
      size: this.size,
      bonuses: this.bonuses,
      round: this.round,
      rounds: this.rows.length + 1,
      tilesLeft: Math.max(0, this.rows.length - this.rowIndex) * this.draftSize,
      draftSize: this.draftSize,
      players,
      cur: this.cur ? this.cur.map(s => this.slotView(s)) : null,
      prev: this.prev ? this.prev.map(s => this.slotView(s)) : null,
      steps: this.steps.map((s, i) => ({ id: s.odId, place: s.place, pick: s.pick, done: i < this.stepIdx })),
      stepIdx: this.stepIdx,
      actor: this.phase === 'play' && step ? step.odId : null,
      stage: this.phase === 'play' ? this.stage : null,
      tile: this.phase === 'play' && this.stage === 'place' && step ? step.place : null,
      deadline: this.deadline,
      duration: this.stageMs,
      now: Date.now(),
      notices: this.notices,
      final: this.finalRows
    };
  }

  // ------------------------------------------------------------------ flow

  start() {
    if (this.phase !== 'wait' || !this.active) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.phase = 'play';
    this.round = 1;
    this.cur = this.revealRow();
    this.notice('reveal', { round: 1 });
    // Kings are placed on the first row in random order.
    const kings = [];
    for (let k = 0; k < this.kingsEach; k++) kings.push(...this.order);
    this.steps = this.shuffle(kings).slice(0, this.draftSize).map(odId => ({ odId, place: null, pick: true }));
    this.enterStep(0);
  }

  revealRow() {
    const row = this.rows[this.rowIndex++];
    return row.map(tile => ({ tile, owner: null }));
  }

  endRound() {
    if (!this.cur && this.round > 1) return this.finish();
    this.prev = this.cur;
    this.cur = this.rowIndex < this.rows.length ? this.revealRow() : null;
    this.round++;
    const hasPick = !!this.cur;
    this.steps = [...this.prev]
      .sort((a, b) => a.tile - b.tile)
      .map(s => ({ odId: s.owner, place: s.tile, pick: hasPick }));
    if (hasPick) this.notice('reveal', { round: this.round });
    else this.notice('final');
    this.enterStep(0);
  }

  enterStep(i) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.active) return;
    if (i >= this.steps.length) return this.endRound();
    this.stepIdx = i;
    const step = this.steps[i];
    if (step.place !== null) this.enterPlace(step);
    else this.enterPick(step);
  }

  armTimer(odId, ms, fn) {
    const left = this.pl[odId].left;
    const wait = left ? AUTO_MS : ms;
    this.stageMs = wait;
    this.deadline = Date.now() + wait;
    this.timer = setTimeout(() => { this.timer = null; fn(); }, wait);
  }

  enterPlace(step) {
    this.stage = 'place';
    const board = this.pl[step.odId].board;
    this.legalList = board.legal(TILES[step.place]);
    if (this.legalList.length === 0) {
      board.discards++;
      this.markPlaced(step.place, 'discarded');
      this.notice('discard', { odId: step.odId, tile: step.place });
      this.stageMs = DISCARD_MS;
      this.deadline = Date.now() + DISCARD_MS;
      this.push();
      this.timer = setTimeout(() => { this.timer = null; this.afterPlace(step); }, DISCARD_MS);
      return;
    }
    this.armTimer(step.odId, PLACE_MS, () => this.autoPlace(step));
    this.push();
    this.sendLegal(step.odId);
  }

  enterPick(step) {
    this.stage = 'pick';
    this.legalList = [];
    this.armTimer(step.odId, PICK_MS, () => this.autoPick(step));
    this.push();
  }

  markPlaced(tile, how) {
    const slot = (this.prev || []).find(s => s.tile === tile);
    if (slot) slot.placed = how;
  }

  afterPlace(step) {
    if (step.pick && this.cur) this.enterPick(step);
    else this.enterStep(this.stepIdx + 1);
  }

  // ------------------------------------------------------------------ actions

  onPick(odId, p) {
    const step = this.steps[this.stepIdx];
    if (this.phase !== 'play' || this.stage !== 'pick' || !step || step.odId !== odId) {
      return this.reject(odId, { k: 'kingdomino.err.notPick' });
    }
    if (!this.pickTile(odId, Number(p.tile), false)) this.reject(odId, { k: 'kingdomino.err.unavailable' });
  }

  pickTile(odId, tile, auto) {
    const slot = this.cur && this.cur.find(s => s.tile === tile && !s.owner);
    if (!slot) return false;
    slot.owner = odId;
    clearTimeout(this.timer);
    this.timer = null;
    this.notice('pick', { odId, tile, auto });
    // Pick is the last part of a step; move on.
    this.enterStep(this.stepIdx + 1);
    return true;
  }

  autoPick(step) {
    const free = this.cur.filter(s => !s.owner);
    if (!free.length) return this.enterStep(this.stepIdx + 1);
    const slot = free[Math.floor(this.rng() * free.length)];
    this.pickTile(step.odId, slot.tile, true);
  }

  onPlace(odId, p) {
    const step = this.steps[this.stepIdx];
    if (this.phase !== 'play' || this.stage !== 'place' || !step || step.odId !== odId || step.place === null) {
      return this.reject(odId, { k: 'kingdomino.err.notPlace' });
    }
    if (Number(p.tile) !== step.place) return this.reject(odId, { k: 'kingdomino.err.wrongTile' });
    if (!this.placeTile(step, p.r, p.c, p.rot, false)) this.reject(odId, { k: 'kingdomino.err.cannotPlace' });
  }

  placeTile(step, r, c, rot, auto) {
    const board = this.pl[step.odId].board;
    if (!board.place(TILES[step.place], r, c, rot)) return false;
    clearTimeout(this.timer);
    this.timer = null;
    this.markPlaced(step.place, 'placed');
    this.notice('place', { odId: step.odId, tile: step.place, r, c, rot, auto });
    this.legalList = [];
    // Show the placement, then continue (pick or next step).
    if (step.pick && this.cur) {
      this.afterPlace(step);
    } else {
      this.push();
      this.enterStep(this.stepIdx + 1);
    }
    return true;
  }

  autoPlace(step) {
    const list = this.legalList;
    if (!list.length) return this.afterPlace(step);
    const [r, c, rot] = list[Math.floor(this.rng() * list.length)];
    this.placeTile(step, r, c, rot, true);
  }

  onPlayerLeft(odId) {
    const p = this.pl[odId];
    if (!p || p.left) return;
    p.left = true;
    if (this.phase === 'wait') {
      if (this.order.every(id => this.pl[id].left || this.ready.has(id))) this.start();
      return;
    }
    if (this.phase !== 'play') return;
    this.notice('left', { odId });
    const step = this.steps[this.stepIdx];
    if (step && step.odId === odId && this.timer && this.stage !== null) {
      // Replace the running timer with a short auto-play one (discard pauses keep theirs).
      const discarding = this.stage === 'place' && this.legalList.length === 0;
      if (!discarding) {
        clearTimeout(this.timer);
        this.timer = null;
        this.armTimer(odId, 0, () => (this.stage === 'place' ? this.autoPlace(step) : this.autoPick(step)));
      }
    }
    this.push();
  }

  // ------------------------------------------------------------------ end

  standings() {
    const rows = this.order.map(id => {
      const p = this.pl[id];
      const sc = p.board.score(this.bonuses);
      return { id, name: p.name, color: p.color, score: sc.total, largest: sc.largest, crowns: sc.crowns, sc };
    });
    rows.sort((a, b) => b.score - a.score || b.largest - a.largest || b.crowns - a.crowns);
    let rank = 0;
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      const tied = prev && prev.score === r.score && prev.largest === r.largest && prev.crowns === r.crowns;
      if (!tied) rank = i + 1;
      r.rank = rank;
    });
    return rows;
  }

  finish() {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'over';
    this.stage = null;
    this.deadline = 0;
    this.stageMs = 0;
    const rows = this.standings();
    this.finalRows = rows.map(r => ({
      id: r.id, name: r.name, rank: r.rank, score: r.score, largest: r.largest, crowns: r.crowns,
      base: r.sc.base, middle: r.sc.middle, harmony: r.sc.harmony
    }));
    this.notice('over');
    this.push();
    const winners = rows.filter(r => r.rank === 1);
    const title = winners.length === 1
      ? { k: 'kingdomino.title.wins', p: { name: winners[0].name } }
      : { k: 'kingdomino.title.tie', p: { names: winners.map(w => w.name).join(', ') } };
    this.room.finishGame({
      title,
      subtitle: { k: 'kingdomino.sub' },
      rows: rows.map(r => {
        const bonus = r.sc.middle + r.sc.harmony;
        const note = bonus
          ? { k: 'kingdomino.note.bonus', p: { n: r.largest, bonus } }
          : { k: 'kingdomino.note.largest', p: { n: r.largest } };
        return { id: r.id, name: r.name, score: r.score, rank: r.rank, note };
      }),
      delayMs: FINISH_DELAY_MS
    });
  }

  cleanup() {
    this.active = false;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
  }
}
