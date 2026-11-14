/**
 * Okey (2-4 players, Turkish tile game). Server-authoritative: racks and the stock are private.
 *
 * Options (see config.js):
 *   mode      'classic' (finish by completing 14 tiles) | '101' (open with 101 points, play on the table)
 *   rounds    classic only: number of hands (1 / 3 / 5); points add up
 *   turnTime  seconds per turn
 *
 * Flow of a turn: draw one tile (from the stock or the previous player's discard), then discard one tile onto your own
 * pile. The dealer holds 15 tiles and starts by discarding. The rules (groups, jokers, scoring helpers) are in
 * okey-rules.js, which the browser also loads.
 *
 * Classic: a hand is won by discarding the last tile so that the other 14 form valid groups, or seven pairs. Points:
 * 1 for a normal finish, 2 for pairs, doubled when the finishing tile is the okey (so 1 / 2 / 2 / 4). A hand whose
 * stock runs out is a draw. Rank by points over all hands.
 *
 * 101: nobody wins by completing the rack at once. You must first open by laying groups worth at least 101 points, or
 * five pairs; afterwards you may lay down more groups and add tiles to any group on the table. Whoever empties their
 * rack ends the hand; the others get penalty points for the tiles left (okey tile 101, fake okey = the okey's value,
 * never opened = 202). The match ends when somebody reaches 101 penalty points; the lowest total wins.
 */
import {
  buildTiles, shuffle, okeyOf, isJoker, effOf, penaltyValue, arrangeGroup, isPair, winKind, classicPoints
} from './okey-rules.js';

export const ROW = 12;
export const SLOTS = ROW * 2;
const START_FALLBACK_MS = 8000;
const NEXT_HAND_MS = 11000;
const FINISH_DELAY_MS = 5000;
const RETURN_TO_LOBBY_MS = 25000;
const MATCH_LIMIT = 101;
const UNOPENED_PENALTY = 202;
const MIN_PAIRS = 5;
const MAX_GROUPS = 8;

export class Okey {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());
    this.timing = {
      start: extra.startDelay ?? START_FALLBACK_MS,
      hand: extra.handDelay ?? NEXT_HAND_MS,
      finish: extra.finishDelay ?? FINISH_DELAY_MS
    };

    this.mode = options.mode === '101' ? '101' : 'classic';
    this.rounds = this.mode === 'classic' && [1, 3, 5].includes(Number(options.rounds)) ? Number(options.rounds) : 1;
    this.turnMs = ([30, 45, 60, 90].includes(Number(options.turnTime)) ? Number(options.turnTime) : 45) * 1000;

    this.names = {};
    this.scores = {};
    this.order = Object.keys(players);
    for (const [id, p] of Object.entries(players)) { this.names[id] = p.name; this.scores[id] = 0; }

    this.round = 0;
    this.phase = 'play'; // play | handOver | over
    this.timer = null;
    this.handTimer = null;
    this.finishTimer = null;
    this.deadline = 0;
    this.nextHandAt = 0;
    this.running = false;
    this.loaded = new Set();
    this.seq = 0;
    this.last = null;
    this.result = null;
    this.log = null;

    this.dealHand();
    this.timer = setTimeout(() => this.begin(), this.timing.start);
  }

  // ------------------------------------------------------------------- deal

  dealHand() {
    this.round++;
    this.tileList = buildTiles();
    this.tiles = Object.fromEntries(this.tileList.map(t => [t.id, t]));
    const stock = shuffle(this.tileList.map(t => t.id), this.rng);
    // The indicator is a real tile, never a fake okey.
    const at = stock.findIndex(id => !this.tiles[id].f);
    this.indicator = this.tiles[stock.splice(at, 1)[0]];
    this.okey = okeyOf(this.indicator);
    this.stock = stock;

    this.dealer = this.order[(this.round - 1) % this.order.length];
    this.racks = {};
    this.arr = {};
    this.piles = {};
    this.opened = {};
    this.drawn = {};
    for (const id of this.order) {
      this.racks[id] = this.stock.splice(-(id === this.dealer ? 15 : 14));
      this.arr[id] = new Array(SLOTS).fill(null);
      this.piles[id] = [];
      this.opened[id] = null; // null | 'groups' | 'pairs'
      this.syncArrange(id);
    }
    this.table = [];
    this.meldSeq = 0;
    this.turn = this.dealer;
    this.stage = 'discard'; // the dealer starts by discarding
    this.result = null;
    this.last = null;
    this.phase = 'play';
    this.log = { k: 'okey.log.deal', p: { name: this.names[this.dealer] } };
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    this.running = true;
    this.startTurnTimer();
    this.broadcastState();
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.racks[odId]) return;
    if (!payload || typeof payload !== 'object') payload = {};
    switch (type) {
      case 'okey-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.running && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'okey-arrange': return this.arrange(odId, payload.slots);
      case 'okey-draw': return this.draw(odId, payload.from);
      case 'okey-discard': return this.discard(odId, payload.tile, false);
      case 'okey-finish': return this.discard(odId, payload.tile, true);
      case 'okey-open': return this.open(odId, payload);
      case 'okey-add': return this.addToMeld(odId, payload);
    }
  }

  fail(odId, k, p) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'error', message: p ? { k, p } : { k } });
  }

  canAct(odId, stage) {
    return this.running && this.phase === 'play' && this.turn === odId && (!stage || this.stage === stage);
  }

  /** Where the tile order of a rack is stored so a reload restores the player's own layout. */
  syncArrange(odId) {
    const rack = new Set(this.racks[odId]);
    const slots = this.arr[odId];
    const seen = new Set();
    for (let i = 0; i < slots.length; i++) {
      const id = slots[i];
      if (id !== null && (!rack.has(id) || seen.has(id))) slots[i] = null;
      else if (id !== null) seen.add(id);
    }
    for (const id of this.racks[odId]) {
      if (seen.has(id)) continue;
      let at = -1;
      for (let i = slots.length - 1; i >= 0; i--) if (slots[i] !== null) { at = i; break; }
      const target = at + 1 < slots.length && slots[at + 1] === null ? at + 1 : slots.indexOf(null);
      slots[target] = id;
      seen.add(id);
    }
  }

  arrange(odId, slots) {
    if (!Array.isArray(slots) || slots.length !== SLOTS) return;
    const rack = new Set(this.racks[odId]);
    const next = new Array(SLOTS).fill(null);
    const seen = new Set();
    for (let i = 0; i < SLOTS; i++) {
      const id = slots[i];
      if (id === null || id === undefined) continue;
      if (!Number.isInteger(id) || !rack.has(id) || seen.has(id)) continue;
      next[i] = id;
      seen.add(id);
    }
    this.arr[odId] = next;
    this.syncArrange(odId);
  }

  prevPlayer(odId) {
    const n = this.order.length;
    return this.order[(this.order.indexOf(odId) - 1 + n) % n];
  }

  nextPlayer(odId) {
    return this.order[(this.order.indexOf(odId) + 1) % this.order.length];
  }

  // ------------------------------------------------------------------ rules

  draw(odId, from) {
    if (!this.canAct(odId, 'draw')) return;
    if (from === 'stock') {
      if (this.stock.length === 0) return this.endHand(null);
      return this.takeTile(odId, this.stock.pop(), 'stock');
    }
    if (from === 'discard') {
      const prev = this.prevPlayer(odId);
      const pile = this.piles[prev];
      if (prev === odId || !pile || pile.length === 0) return this.fail(odId, 'okey.err.noDiscard');
      return this.takeTile(odId, pile.pop(), 'discard');
    }
  }

  takeTile(odId, id, from) {
    this.racks[odId].push(id);
    this.syncArrange(odId);
    this.drawn[odId] = id;
    this.stage = 'discard';
    this.last = { seq: ++this.seq, kind: from === 'stock' ? 'draw-stock' : 'draw-discard', by: odId };
    this.log = { k: from === 'stock' ? 'okey.log.drewStock' : 'okey.log.drewDiscard', p: { name: this.names[odId] } };
    this.broadcastState();
  }

  /** Discard (or finish) with a tile. `finish` demands that this discard wins the hand (classic). */
  discard(odId, tileId, finish) {
    if (!this.canAct(odId, 'discard')) return;
    const rack = this.racks[odId];
    if (!Number.isInteger(tileId) || !rack.includes(tileId)) return this.fail(odId, 'okey.err.notYours');
    const left = rack.filter(id => id !== tileId);

    let kind = null;
    if (this.mode === 'classic' && left.length === 14) {
      kind = winKind(left.map(id => this.tiles[id]), this.okey);
    }
    if (finish && !kind) return this.fail(odId, 'okey.err.notWinning');

    this.removeFromRack(odId, tileId);
    this.piles[odId].push(tileId);
    this.drawn[odId] = null;
    this.last = { seq: ++this.seq, kind: 'discard', by: odId, tile: tileId };

    if (kind) return this.endHand(odId, { kind, tile: tileId });
    if (this.mode === '101' && this.racks[odId].length === 0) return this.endHand(odId, { tile: tileId });

    this.log = { k: 'okey.log.discard', p: { name: this.names[odId] } };
    this.advanceTurn(odId);
  }

  removeFromRack(odId, id) {
    this.racks[odId] = this.racks[odId].filter(x => x !== id);
    this.arr[odId] = this.arr[odId].map(x => (x === id ? null : x));
  }

  advanceTurn(from) {
    this.turn = this.nextPlayer(from);
    this.stage = 'draw';
    if (this.stock.length === 0) return this.endHand(null);
    this.startTurnTimer();
    this.broadcastState();
  }

  /** 101: lay down groups (opening needs 101 points or five pairs). */
  open(odId, payload) {
    if (this.mode !== '101' || !this.canAct(odId, 'discard')) return;
    const has = new Set(this.racks[odId]);
    const seen = new Set();
    const readIds = (arr, min, max) => {
      if (!Array.isArray(arr) || arr.length < min || arr.length > max) return null;
      const out = [];
      for (const x of arr) {
        if (!Number.isInteger(x) || !has.has(x) || seen.has(x)) return null;
        seen.add(x);
        out.push(x);
      }
      return out;
    };
    const { groups, pairs } = payload;
    if ((groups === undefined) === (pairs === undefined)) return this.fail(odId, 'okey.err.badMove');

    if (pairs !== undefined) {
      if (this.opened[odId]) return this.fail(odId, 'okey.err.pairsOnlyToOpen');
      if (!Array.isArray(pairs) || pairs.length > 7) return this.fail(odId, 'okey.err.badMove');
      const list = pairs.map(p => readIds(p, 2, 2));
      if (list.some(p => !p)) return this.fail(odId, 'okey.err.badMove');
      if (list.length < MIN_PAIRS) return this.fail(odId, 'okey.err.openPairs', { n: MIN_PAIRS });
      for (const [a, b] of list) {
        if (!isPair(this.tiles[a], this.tiles[b], this.okey)) return this.fail(odId, 'okey.err.badPair');
      }
      this.opened[odId] = 'pairs';
      for (const [a, b] of list) {
        const x = effOf(this.tiles[a], this.okey) || effOf(this.tiles[b], this.okey) || { c: this.okey.c, v: this.okey.v };
        this.placeMeld(odId, 'pair', [a, b].map(id => this.meldTile(id, x.c, x.v)));
      }
      this.afterLay(odId, 'pairs', list.flat(), { n: list.length });
      return;
    }

    if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS) return this.fail(odId, 'okey.err.badMove');
    const lists = groups.map(g => readIds(g, 3, 14));
    if (lists.some(g => !g)) return this.fail(odId, 'okey.err.badMove');
    const arranged = lists.map(g => arrangeGroup(g.map(id => this.tiles[id]), this.okey));
    if (arranged.some(a => !a)) return this.fail(odId, 'okey.err.badGroup');
    const total = arranged.reduce((s, a) => s + a.points, 0);
    if (!this.opened[odId] && total < MATCH_LIMIT) return this.fail(odId, 'okey.err.openTotal', { n: total, need: MATCH_LIMIT });
    this.opened[odId] = this.opened[odId] || 'groups';
    for (const a of arranged) this.placeMeld(odId, a.kind, a.slots.map(s => this.meldTile(s.id, s.c, s.v)));
    this.afterLay(odId, 'groups', lists.flat(), { n: total });
  }

  meldTile(id, c, v) {
    const t = this.tiles[id];
    return { id, c, v, ...(t.f ? { f: 1 } : isJoker(t, this.okey) ? { j: 1 } : {}) };
  }

  placeMeld(odId, kind, tiles) {
    this.table.push({ id: ++this.meldSeq, owner: odId, kind, tiles });
  }

  afterLay(odId, what, ids, p) {
    for (const id of ids) this.removeFromRack(odId, id);
    this.last = { seq: ++this.seq, kind: 'lay', by: odId };
    this.log = { k: what === 'pairs' ? 'okey.log.openedPairs' : 'okey.log.laid', p: { name: this.names[odId], ...p } };
    if (this.racks[odId].length === 0) return this.endHand(odId, {});
    this.broadcastState();
  }

  /** 101: add tiles to a group on the table (yours or another player's). */
  addToMeld(odId, payload) {
    if (this.mode !== '101' || !this.canAct(odId, 'discard')) return;
    if (!this.opened[odId]) return this.fail(odId, 'okey.err.notOpened');
    const meld = this.table.find(m => m.id === payload.meld);
    if (!meld || meld.kind === 'pair') return this.fail(odId, 'okey.err.badMove');
    const ids = payload.tiles;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 13) return this.fail(odId, 'okey.err.badMove');
    const has = new Set(this.racks[odId]);
    const seen = new Set();
    for (const id of ids) {
      if (!Number.isInteger(id) || !has.has(id) || seen.has(id)) return this.fail(odId, 'okey.err.badMove');
      seen.add(id);
    }
    const all = [...meld.tiles.map(t => this.tiles[t.id]), ...ids.map(id => this.tiles[id])];
    const a = arrangeGroup(all, this.okey);
    if (!a) return this.fail(odId, 'okey.err.cantAdd');
    meld.kind = a.kind;
    meld.tiles = a.slots.map(s => this.meldTile(s.id, s.c, s.v));
    for (const id of ids) this.removeFromRack(odId, id);
    this.last = { seq: ++this.seq, kind: 'add', by: odId };
    this.log = { k: 'okey.log.added', p: { name: this.names[odId], owner: this.names[meld.owner] || '' } };
    if (this.racks[odId].length === 0) return this.endHand(odId, {});
    this.broadcastState();
  }

  // ------------------------------------------------------------------ timer

  startTurnTimer() {
    clearTimeout(this.timer);
    this.deadline = this.now() + this.turnMs;
    const who = this.turn;
    this.timer = setTimeout(() => this.onTimeout(who), this.turnMs);
  }

  /** Out of time: draw from the stock and discard the rightmost tile that is not the okey. */
  onTimeout(who) {
    if (!this.isGameActive || this.phase !== 'play' || this.turn !== who) return;
    if (this.stage === 'draw') {
      if (this.stock.length === 0) return this.endHand(null);
      this.racks[who].push(this.stock.pop());
      this.syncArrange(who);
      this.stage = 'discard';
    }
    const rack = this.racks[who];
    if (rack.length === 0) return;
    let pick = null;
    const slots = this.arr[who];
    for (let i = slots.length - 1; i >= 0 && pick === null; i--) {
      if (slots[i] !== null && !isJoker(this.tiles[slots[i]], this.okey)) pick = slots[i];
    }
    if (pick === null) pick = rack[rack.length - 1];
    this.removeFromRack(who, pick);
    this.piles[who].push(pick);
    this.drawn[who] = null;
    this.last = { seq: ++this.seq, kind: 'discard', by: who, tile: pick };
    this.log = { k: 'okey.log.timeout', p: { name: this.names[who] } };
    if (this.mode === '101' && this.racks[who].length === 0) return this.endHand(who, { tile: pick });
    this.advanceTurn(who);
  }

  // ---------------------------------------------------------------- scoring

  /** End the hand. winner null = the stock ran out. */
  endHand(winner, info = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'handOver';
    const gains = {};
    const hands = {};
    for (const id of this.order) hands[id] = this.racks[id].map(t => this.tiles[t]);
    let kind = 'draw';

    if (this.mode === 'classic') {
      for (const id of this.order) gains[id] = 0;
      if (winner) {
        kind = info.kind === 'pairs' ? 'pairs' : 'normal';
        const pts = classicPoints(info.kind, this.tiles[info.tile], this.okey);
        const okeyFinish = isJoker(this.tiles[info.tile], this.okey);
        gains[winner] = pts;
        this.scores[winner] += pts;
        kind = okeyFinish ? (kind === 'pairs' ? 'pairs-okey' : 'okey') : kind;
      }
    } else {
      kind = winner ? 'out' : 'draw';
      for (const id of this.order) {
        if (id === winner) { gains[id] = 0; continue; }
        gains[id] = this.opened[id] ? this.racks[id].reduce((s, t) => s + penaltyValue(this.tiles[t], this.okey), 0) : UNOPENED_PENALTY;
        this.scores[id] += gains[id];
      }
    }

    this.result = { winner: winner || null, kind, gains, hands, tile: info.tile ?? null, opened: { ...this.opened } };
    this.log = winner ? { k: 'okey.log.handWon', p: { name: this.names[winner] } } : { k: 'okey.log.handDraw' };

    const over = this.mode === 'classic'
      ? this.round >= this.rounds
      : this.order.some(id => this.scores[id] >= MATCH_LIMIT);

    if (over) {
      this.phase = 'over';
      this.broadcastState();
      this.finishTimer = setTimeout(() => { this.finishTimer = null; this.finish(); }, this.timing.finish);
      return;
    }
    this.nextHandAt = this.now() + this.timing.hand;
    this.broadcastState();
    this.handTimer = setTimeout(() => {
      this.handTimer = null;
      if (!this.isGameActive) return;
      this.dealHand();
      this.startTurnTimer();
      this.broadcastState();
    }, this.timing.hand);
  }

  /** Standings: classic by points (high first), 101 by penalty (low first). Ties share a rank. */
  standings() {
    const classic = this.mode === 'classic';
    const ids = [...this.order].sort((a, b) => (classic ? this.scores[b] - this.scores[a] : this.scores[a] - this.scores[b]));
    let rank = 0;
    let prev = null;
    return ids.map((id, i) => {
      if (this.scores[id] !== prev) rank = i + 1;
      prev = this.scores[id];
      return { id, name: this.names[id], rank, score: this.scores[id], note: { k: classic ? 'okey.note.points' : 'okey.note.penalty', p: { n: this.scores[id] } } };
    });
  }

  finish() {
    if (!this.isGameActive) return;
    const rows = this.standings();
    const winners = rows.filter(r => r.rank === 1);
    const classic = this.mode === 'classic';
    this.room.finishGame({
      title: winners.length === 1 ? { k: 'okey.finish.wins', p: { name: winners[0].name } } : { k: 'okey.finish.tie' },
      subtitle: classic ? { k: 'okey.finish.classic', p: { n: this.rounds } } : { k: 'okey.finish.m101', p: { n: MATCH_LIMIT } },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  // --------------------------------------------------------------- snapshots

  stateFor(odId) {
    const mine = odId && this.racks[odId];
    const play = this.running && this.phase === 'play';
    const pub = (t) => t;
    return {
      type: 'okey-state',
      you: odId,
      mode: this.mode,
      rounds: this.rounds,
      limit: MATCH_LIMIT,
      round: this.round,
      phase: this.phase,
      players: this.order.map(id => ({
        id,
        name: this.names[id],
        count: this.racks[id].length,
        score: this.scores[id],
        opened: this.opened[id],
        pile: this.piles[id].map(t => pub(this.tiles[t]))
      })),
      dealer: this.dealer,
      indicator: this.indicator,
      okey: this.okey,
      stock: this.stock.length,
      turn: this.turn,
      stage: this.stage,
      takeFrom: this.order.length > 1 ? this.prevPlayer(this.turn) : null,
      timeLeft: play ? Math.max(0, this.deadline - this.now()) : 0,
      turnMs: this.turnMs,
      rack: mine ? this.racks[odId].map(t => this.tiles[t]) : [],
      slots: mine ? this.arr[odId] : [],
      drawn: mine ? this.drawn[odId] ?? null : null,
      table: this.table,
      last: this.last,
      result: this.phase === 'play' ? null : this.result,
      nextHandIn: this.phase === 'handOver' ? Math.max(0, this.nextHandAt - this.now()) : 0,
      log: this.log
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: everything public, never a rack. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, spectator: true });
  }

  broadcastState() {
    for (const id of this.order) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  // ------------------------------------------------------------------ leaving

  onPlayerLeft(odId) {
    if (!this.racks[odId]) return;
    // their tiles go back to the bottom of the stock
    this.stock.unshift(...this.racks[odId]);
    const idx = this.order.indexOf(odId);
    const wasTurn = this.turn === odId;
    delete this.racks[odId];
    delete this.arr[odId];
    delete this.piles[odId];
    this.order.splice(idx, 1);
    this.log = { k: 'okey.log.left', p: { name: this.names[odId] } };

    if (this.phase === 'over') return this.broadcastState();
    if (this.order.length < 2) {
      clearTimeout(this.timer);
      clearTimeout(this.handTimer);
      this.timer = this.handTimer = null;
      this.phase = 'over';
      this.broadcastState();
      if (this.order.length === 1) {
        const id = this.order[0];
        this.room.finishGame({
          title: { k: 'okey.finish.wins', p: { name: this.names[id] } },
          subtitle: { k: 'okey.finish.left' },
          rows: [{ id, name: this.names[id], rank: 1, score: this.scores[id], note: { k: 'okey.note.default' } }],
          delayMs: 15000
        });
      }
      return;
    }
    if (this.dealer === odId) this.dealer = this.order[idx % this.order.length];
    if (this.phase === 'handOver') return this.broadcastState();
    if (wasTurn) {
      this.turn = this.order[idx % this.order.length];
      this.stage = 'draw';
      if (this.stock.length === 0) return this.endHand(null);
      this.startTurnTimer();
    }
    this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.handTimer);
    clearTimeout(this.finishTimer);
    this.timer = this.handTimer = this.finishTimer = null;
  }
}
