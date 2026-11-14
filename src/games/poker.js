/**
 * No-limit Texas Hold'em tournament (play money, 2-8 players).
 *
 * Options (see config.js):
 *   chips     starting stack
 *   blinds    'small/big' at the first level
 *   blindUp   minutes between blind levels (0 = never)
 *   turnTime  seconds per decision
 *
 * Rules chosen: the button moves to the next player still in; heads-up the button is the small blind, acts first
 * before the flop and last after it. A raise must be at least the previous raise (and the big blind); a short all-in
 * does not reopen the betting for players who already acted (unless short all-ins add up to a full raise).
 * Uncalled bets are returned, side pots follow the all-ins, the odd chip goes to the first winner left of the button.
 * Everyone who reaches the showdown shows their hand (no mucking); folded hands are never revealed.
 * Timeout: check if free, otherwise fold; two timeouts in a row sit the player out until they press "I'm back".
 * Ranking: reverse order of elimination; players knocked out in the same hand rank by chips at the start of it.
 *
 * Messages: client -> 'poker-page-loaded', 'poker-action' { action: fold|check|call|raise|allin, amount }, 'poker-sitin'.
 * Server -> 'poker-state' (a full snapshot per viewer: hole cards only for their owner or once shown).
 */
import { evaluate, handMessage, makeDeck, shuffle, buildPots } from './poker-eval.js';

const START_FALLBACK_MS = 7000;
const DEAL_MS = 1600;
const STREET_MS = 900;
const RUNOUT_MS = 1900;
const SHOWDOWN_MS = 6500;
const POT_EXTRA_MS = 1500;
const UNCONTESTED_MS = 3200;
const AUTO_MS = 700;
const FINISH_DELAY_MS = 25000;
const LOG_LIMIT = 40;

const LADDERS = {
  10: [10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000],
  25: [25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000],
  50: [50, 75, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000]
};

/** Small blind of every level for a starting small blind (big blind is always double). */
export function blindLevels(startSb) {
  const ladder = LADDERS[startSb] || LADDERS[25];
  return ladder.map((sb) => ({ sb, bb: sb * 2 }));
}

function levelAt(levels, i) {
  if (i < levels.length) return levels[i];
  const sb = Math.round((levels[levels.length - 1].sb * 1.5 ** (i - levels.length + 1)) / 100) * 100;
  return { sb, bb: sb * 2 };
}

export class Poker {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());
    this.setT = extra.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearT = extra.clearTimeout || ((h) => clearTimeout(h));

    this.startStack = [1000, 2000, 5000].includes(Number(options.chips)) ? Number(options.chips) : 2000;
    const sb0 = Number(String(options.blinds || '25/50').split('/')[0]);
    this.levels = blindLevels(sb0);
    this.blindUpMs = [5, 10].includes(Number(options.blindUp)) ? Number(options.blindUp) * 60000 : 0;
    const tt = Number(options.turnTime);
    this.turnMs = (Number.isFinite(tt) && tt >= 3 && tt <= 300 ? tt : 30) * 1000;

    this.seats = Object.entries(players).map(([id, p]) => ({
      id, name: p.name, chips: this.startStack, bet: 0, total: 0, folded: false, allIn: false, out: false,
      left: false, sittingOut: false, timeouts: 0, hole: [], acted: false, shown: false, handStart: this.startStack
    }));

    this.timers = {};
    this.loaded = new Set();
    this.started = false;
    this.stage = 'lobby'; // lobby | bet | pause | over
    this.inHand = false;
    this.handNo = 0;
    this.level = 0;
    this.pendingUp = false;
    this.levelStartAt = 0;
    this.button = -1;
    this.sbIdx = -1;
    this.bbIdx = -1;
    this.street = 'preflop';
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastFullBet = 0;
    this.turn = null;
    this.deadline = 0;
    this.result = null;
    this.log = [];
    this.logSeq = 0;
    this.elims = [];
    this.elimSeq = 0;

    this.schedule('start', () => this.begin(), START_FALLBACK_MS);
  }

  // ----------------------------------------------------------------- helpers

  get blinds() { return levelAt(this.levels, this.level); }

  schedule(name, fn, ms) {
    this.clearTimer(name);
    this.timers[name] = this.setT(() => { this.timers[name] = null; if (this.isGameActive) fn(); }, ms);
  }

  clearTimer(name) {
    if (this.timers[name]) this.clearT(this.timers[name]);
    this.timers[name] = null;
  }

  seat(id) { return this.seats.find((s) => s.id === id); }
  idx(id) { return this.seats.findIndex((s) => s.id === id); }
  say(k, p) { this.log.push({ n: ++this.logSeq, k, p: p || {} }); if (this.log.length > LOG_LIMIT) this.log.shift(); }

  /** Seats that still own chips or are still in the current hand. */
  alive() { return this.seats.filter((s) => !s.out && !s.left && (s.chips > 0 || (this.inHand && !s.folded))); }
  contenders() { return this.seats.filter((s) => !s.out && !s.folded && s.hole.length); }
  actors() { return this.seats.filter((s) => !s.folded && !s.allIn && !s.out && s.hole.length); }

  nextIdx(from, pred) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      if (pred(this.seats[i])) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ flow

  begin() {
    if (this.started || !this.isGameActive) return;
    this.started = true;
    this.clearTimer('start');
    this.levelStartAt = this.now();
    this.startHand();
  }

  startHand() {
    if (!this.isGameActive) return;
    this.clearTimer('turn');
    this.inHand = false;
    const playing = this.seats.filter((s) => !s.out && !s.left && s.chips > 0);
    if (playing.length < 2) return this.finish();

    this.handNo++;
    if (this.pendingUp) {
      this.pendingUp = false;
      this.level++;
      this.levelStartAt = this.now();
      this.say('poker.log.level', { sb: this.blinds.sb, bb: this.blinds.bb });
    }
    if (this.blindUpMs && !this.pendingUp && this.now() - this.levelStartAt >= this.blindUpMs) {
      this.pendingUp = true;
      const nx = levelAt(this.levels, this.level + 1);
      this.say('poker.log.levelSoon', { sb: nx.sb, bb: nx.bb });
    }

    for (const s of this.seats) {
      s.bet = 0; s.total = 0; s.allIn = false; s.acted = false; s.shown = false; s.hole = [];
      s.folded = s.out || s.left || s.chips <= 0;
      s.handStart = s.chips;
    }
    this.result = null;
    this.board = [];
    this.street = 'preflop';
    this.inHand = true;

    const inIdx = (s) => !s.out && !s.left && s.chips > 0;
    if (this.button < 0) {
      const ids = this.seats.map((s, i) => (inIdx(s) ? i : -1)).filter((i) => i >= 0);
      this.button = ids[Math.floor(this.rng() * ids.length)];
    } else this.button = this.nextIdx(this.button, inIdx);

    if (playing.length === 2) {
      this.sbIdx = this.button;
      this.bbIdx = this.nextIdx(this.button, inIdx);
    } else {
      this.sbIdx = this.nextIdx(this.button, inIdx);
      this.bbIdx = this.nextIdx(this.sbIdx, inIdx);
    }
    const { sb, bb } = this.blinds;
    this.say('poker.log.hand', { n: this.handNo });
    this.commit(this.seats[this.sbIdx], sb);
    this.commit(this.seats[this.bbIdx], bb);
    this.say('poker.log.sb', { name: this.seats[this.sbIdx].name, n: this.seats[this.sbIdx].bet });
    this.say('poker.log.bb', { name: this.seats[this.bbIdx].name, n: this.seats[this.bbIdx].bet });
    this.currentBet = bb;
    this.minRaise = bb;
    this.lastFullBet = bb;

    this.deck = shuffle(makeDeck(), this.rng);
    for (let round = 0; round < 2; round++) {
      let i = this.sbIdx;
      for (let k = 0; k < this.seats.length; k++) {
        const s = this.seats[i];
        if (!s.folded) s.hole.push(this.deck.pop());
        i = (i + 1) % this.seats.length;
      }
    }

    this.stage = 'pause';
    this.turn = null;
    this.broadcast();
    this.schedule('pace', () => this.beginBetting(this.bbIdx), DEAL_MS);
  }

  commit(s, amount) {
    const pay = Math.max(0, Math.min(amount, s.chips));
    s.chips -= pay; s.bet += pay; s.total += pay;
    if (s.chips === 0) s.allIn = true;
    return pay;
  }

  needsAction(s) {
    if (s.folded || s.allIn || s.out || !s.hole.length) return false;
    if (s.acted && s.bet >= this.currentBet) return false;
    if (s.bet >= this.currentBet && this.actors().length <= 1) return false;
    return true;
  }

  canRaise(s) {
    if (s.acted) return false;
    return this.actors().some((o) => o !== s);
  }

  /** Start a betting round with the first player after fromIdx who has something to decide. */
  beginBetting(fromIdx) {
    const i = this.nextIdx(fromIdx, (s) => this.needsAction(s));
    if (i < 0) return this.endRound();
    this.setTurn(i);
  }

  setTurn(i) {
    const s = this.seats[i];
    this.turn = s.id;
    this.stage = 'bet';
    const auto = s.sittingOut || s.left;
    const ms = auto ? AUTO_MS : this.turnMs;
    this.deadline = this.now() + ms;
    this.schedule('turn', () => this.onTimeout(s.id), ms);
    this.broadcast();
  }

  onTimeout(id) {
    if (this.stage !== 'bet' || this.turn !== id) return;
    const s = this.seat(id);
    const free = s.bet >= this.currentBet;
    if (!s.sittingOut) {
      s.timeouts++;
      this.say(free ? 'poker.log.autoCheck' : 'poker.log.autoFold', { name: s.name });
      if (s.timeouts >= 2) { s.sittingOut = true; this.say('poker.log.sitout', { name: s.name }); }
    }
    this.apply(s, free ? 'check' : 'fold');
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive) return;
    const s = this.seat(odId);
    if (!s) return;
    const data = payload && typeof payload === 'object' ? payload : {};
    switch (type) {
      case 'poker-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.started && this.loaded.size >= this.seats.length) this.begin();
        return;
      case 'poker-action': return this.act(s, data.action, data.amount);
      case 'poker-sitin':
        if (s.sittingOut) { s.sittingOut = false; s.timeouts = 0; this.broadcast(); }
        return;
    }
  }

  err(id, k, p) {
    const ws = this.room.getWsByUserId(id);
    if (ws) this.room.send(ws, { type: 'error', message: { k, p: p || {} } });
  }

  /** Validate and run a player's action. */
  act(s, type, amount) {
    if (this.stage !== 'bet' || this.turn !== s.id) return this.err(s.id, 'poker.err.notTurn');
    const toCall = this.currentBet - s.bet;
    if (type === 'fold' || type === 'check' || type === 'call') {
      if (type === 'check' && toCall > 0) return this.err(s.id, 'poker.err.cantCheck');
      if (type === 'call' && toCall <= 0) return this.err(s.id, 'poker.err.cantCall');
    } else if (type === 'raise' || type === 'allin') {
      const maxTo = s.bet + s.chips;
      if (type === 'allin') { amount = maxTo; type = 'raise'; }
      amount = Number(amount);
      if (!Number.isInteger(amount) || amount <= 0) return this.err(s.id, 'poker.err.badAmount');
      if (maxTo > this.currentBet) {
        if (!this.canRaise(s)) return this.err(s.id, 'poker.err.cantRaise');
        if (amount > maxTo) return this.err(s.id, 'poker.err.badAmount');
        if (amount <= this.currentBet) return this.err(s.id, 'poker.err.badAmount');
        if (amount < maxTo && amount - this.currentBet < this.minRaise) {
          return this.err(s.id, 'poker.err.minRaise', { n: this.currentBet + this.minRaise });
        }
      } else {
        // not enough chips to raise: this is just an all-in call
        type = 'call';
      }
    } else return this.err(s.id, 'poker.err.badAction');

    s.timeouts = 0;
    if (s.sittingOut) s.sittingOut = false;
    this.apply(s, type, amount);
  }

  apply(s, type, amount) {
    this.clearTimer('turn');
    const toCall = this.currentBet - s.bet;
    switch (type) {
      case 'fold':
        s.folded = true;
        this.say('poker.log.fold', { name: s.name });
        break;
      case 'check':
        s.acted = true;
        this.say('poker.log.check', { name: s.name });
        break;
      case 'call': {
        const pay = this.commit(s, toCall);
        s.acted = true;
        this.say(s.allIn ? 'poker.log.callAllIn' : 'poker.log.call', { name: s.name, n: pay });
        break;
      }
      case 'raise': {
        this.commit(s, amount - s.bet);
        const size = amount - this.currentBet;
        const opening = this.currentBet === 0;
        let reopen = false;
        if (size >= this.minRaise) {
          this.minRaise = size;
          this.lastFullBet = amount;
          reopen = true;
        } else if (amount - this.lastFullBet >= this.minRaise) {
          this.minRaise = amount - this.lastFullBet;
          this.lastFullBet = amount;
          reopen = true;
        }
        this.currentBet = amount;
        if (reopen) for (const o of this.seats) if (o !== s) o.acted = false;
        s.acted = true;
        this.say(s.allIn ? 'poker.log.raiseAllIn' : opening ? 'poker.log.bet' : 'poker.log.raise', { name: s.name, n: amount });
        break;
      }
    }
    this.advance(s);
  }

  advance(from) {
    if (this.contenders().length === 1) return this.awardUncontested();
    this.turn = null;
    const i = this.nextIdx(this.idx(from.id), (s) => this.needsAction(s));
    if (i < 0) return this.endRound();
    this.setTurn(i);
  }

  /** Return uncalled chips, collect the bets and move to the next street or the showdown. */
  endRound() {
    this.clearTimer('turn');
    this.turn = null;
    let top = null;
    for (const s of this.seats) if (!top || s.total > top.total) top = s;
    if (top && top.bet > 0) {
      const second = Math.max(0, ...this.seats.filter((s) => s !== top).map((s) => s.total));
      const refund = Math.min(top.bet, top.total - second);
      if (refund > 0) {
        top.chips += refund; top.bet -= refund; top.total -= refund;
        this.say('poker.log.returned', { name: top.name, n: refund });
      }
    }
    for (const s of this.seats) { s.bet = 0; s.acted = false; }
    this.currentBet = 0;
    this.minRaise = this.blinds.bb;
    this.lastFullBet = 0;

    if (this.street === 'river') return this.showdown();
    if (this.actors().length <= 1) this.revealAll(); // nothing left to decide: the hands are turned up
    this.dealStreet();
    this.stage = 'pause';
    this.broadcast();
    if (this.actors().length >= 2) this.schedule('pace', () => this.beginBetting(this.button), STREET_MS);
    else this.schedule('pace', () => this.endRound(), RUNOUT_MS);
  }

  dealStreet() {
    this.deck.pop(); // burn
    const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.street];
    const count = next === 'flop' ? 3 : 1;
    for (let k = 0; k < count; k++) this.board.push(this.deck.pop());
    this.street = next;
    this.say('poker.log.' + next, {});
  }

  revealAll() {
    for (const s of this.contenders()) s.shown = true;
  }

  // ----------------------------------------------------------------- results

  awardUncontested() {
    this.clearTimer('turn');
    this.clearTimer('pace');
    this.turn = null;
    const winner = this.contenders()[0];
    // everything goes to the last player standing (their own uncalled chips included)
    const pot = this.seats.reduce((n, s) => n + s.total, 0);
    winner.chips += pot;
    this.say('poker.log.winFold', { name: winner.name, n: pot });
    this.result = {
      uncontested: true,
      pots: [{ amount: pot, winners: [{ id: winner.id, amount: pot }], hand: null }],
      shown: {}
    };
    this.endHandPause(UNCONTESTED_MS);
  }

  showdown() {
    this.turn = null;
    this.revealAll();
    const live = this.contenders();
    const shown = {};
    const evals = {};
    for (const s of live) {
      const ev = evaluate([...s.hole, ...this.board]);
      evals[s.id] = ev;
      shown[s.id] = { hole: s.hole, best: ev.best, cat: ev.key, hand: handMessage(ev) };
    }
    const pots = buildPots(this.seats.map((s) => ({ id: s.id, total: s.total, folded: s.folded })));
    const out = [];
    for (const pot of pots) {
      const eligible = pot.eligible.filter((id) => evals[id]);
      const pool = eligible.length ? eligible : live.map((s) => s.id);
      let best = -1;
      for (const id of pool) best = Math.max(best, evals[id].score);
      const winners = pool.filter((id) => evals[id].score === best);
      // odd chips go to the first winner left of the button
      const order = winners.slice().sort((a, b) => this.clockwise(this.idx(a)) - this.clockwise(this.idx(b)));
      const share = Math.floor(pot.amount / order.length);
      let odd = pot.amount - share * order.length;
      const paid = order.map((id) => {
        const amount = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        this.seat(id).chips += amount;
        return { id, amount };
      });
      out.push({ amount: pot.amount, winners: paid, hand: handMessage(evals[order[0]]), eligible: pot.eligible });
    }
    for (const p of out) {
      for (const w of p.winners) {
        this.say(p.winners.length > 1 ? 'poker.log.split' : 'poker.log.win', { name: this.seat(w.id).name, n: w.amount, hand: p.hand });
      }
    }
    this.result = { uncontested: false, pots: out, shown };
    this.endHandPause(SHOWDOWN_MS + POT_EXTRA_MS * (out.length - 1));
  }

  clockwise(i) {
    const n = this.seats.length;
    return (((i - this.button - 1) % n) + n) % n;
  }

  endHandPause(ms) {
    for (const s of this.seats) { s.total = 0; s.bet = 0; }
    this.currentBet = 0;
    this.inHand = false;
    this.stage = 'pause';

    // knocked out players
    const busted = this.seats.filter((s) => !s.out && !s.left && s.chips === 0);
    if (busted.length) {
      this.elimSeq++;
      for (const s of busted) {
        s.out = true;
        this.elims.push({ id: s.id, seq: this.elimSeq, start: s.handStart, hand: this.handNo, left: false });
        this.say('poker.log.out', { name: s.name });
      }
    }
    this.broadcast();
    const stillIn = this.seats.filter((s) => !s.out && !s.left && s.chips > 0).length;
    this.schedule('pace', () => (stillIn < 2 ? this.finish() : this.startHand()), ms);
  }

  finish() {
    if (this.stage === 'over') return;
    this.stage = 'over';
    this.inHand = false;
    this.clearTimer('turn');
    this.clearTimer('pace');
    this.clearTimer('start');
    this.turn = null;
    const winners = this.seats.filter((s) => !s.out && !s.left && s.chips > 0);
    const losers = this.elims.slice().sort((a, b) => b.seq - a.seq || b.start - a.start);
    const rows = [];
    winners.forEach((s) => rows.push({ id: s.id, name: s.name, score: s.chips, rank: 1, note: { k: 'poker.note.winner', p: { n: s.chips } } }));
    let rank = winners.length;
    let prev = null;
    losers.forEach((e, i) => {
      const key = `${e.seq}:${e.start}`;
      if (key !== prev) rank = winners.length + i + 1;
      prev = key;
      rows.push({
        id: e.id, name: this.seat(e.id).name, score: 0, rank,
        note: { k: e.left ? 'poker.note.left' : 'poker.note.out', p: { n: e.hand } }
      });
    });
    this.broadcast();
    const top = winners[0];
    this.room.finishGame({
      title: top ? { k: 'poker.finish.title', p: { name: top.name } } : { k: 'poker.finish.none' },
      subtitle: { k: 'poker.finish.sub', p: { n: this.handNo } },
      rows,
      delayMs: FINISH_DELAY_MS
    });
  }

  // ----------------------------------------------------------------- leaving

  onPlayerLeft(odId) {
    const s = this.seat(odId);
    if (!s || s.left) return;
    const wasTurn = this.turn === odId && this.stage === 'bet';
    s.left = true;
    s.sittingOut = true;
    if (!s.out) {
      this.elimSeq++;
      this.elims.push({ id: s.id, seq: this.elimSeq, start: s.handStart, hand: this.handNo, left: true });
    }
    s.out = true;
    s.chips = 0;
    this.say('poker.log.left', { name: s.name });
    if (this.stage === 'over') return this.broadcast();
    if (this.inHand && !s.folded) {
      s.folded = true;
      if (this.contenders().length === 1) return this.awardUncontested();
      if (wasTurn) { this.clearTimer('turn'); return this.advance(s); }
    }
    if (!this.inHand && this.started && this.stage === 'pause') {
      const stillIn = this.seats.filter((x) => !x.out && !x.left && x.chips > 0).length;
      if (stillIn < 2 && !this.timers.pace) return this.finish();
    }
    if (!this.started && this.seats.filter((x) => !x.left).length < 2) { this.begin(); return; }
    this.broadcast();
  }

  // --------------------------------------------------------------- snapshots

  levelInfo() {
    const nx = levelAt(this.levels, this.level + 1);
    const cur = this.blinds;
    return {
      level: this.level + 1,
      sb: cur.sb, bb: cur.bb,
      next: { sb: nx.sb, bb: nx.bb },
      soon: this.pendingUp,
      inMs: this.blindUpMs && this.started && !this.pendingUp ? Math.max(0, this.levelStartAt + this.blindUpMs - this.now()) : null
    };
  }

  stateFor(viewerId) {
    const me = viewerId ? this.seat(viewerId) : null;
    const timeLeft = this.stage === 'bet' ? Math.max(0, this.deadline - this.now()) : 0;
    const pot = this.seats.reduce((n, s) => n + s.total - s.bet, 0);
    const players = this.seats.map((s, i) => {
      const reveal = s.shown && !s.folded;
      const own = me === s && s.hole.length > 0;
      return {
        id: s.id, name: s.name, chips: s.chips, bet: s.bet, folded: s.folded && s.hole.length > 0,
        allIn: s.allIn && s.hole.length > 0 && !s.folded, out: s.out, left: s.left, sittingOut: s.sittingOut,
        hasCards: s.hole.length > 0 && !s.folded,
        hole: own || reveal ? s.hole : null,
        dealer: this.button >= 0 && i === this.button && !s.out, sb: this.inHand && i === this.sbIdx, bb: this.inHand && i === this.bbIdx
      };
    });
    const out = {
      type: 'poker-state',
      you: viewerId,
      handNo: this.handNo,
      stage: this.stage,
      street: this.street,
      inHand: this.inHand,
      board: this.board,
      pot,
      pots: this.inHand && this.seats.some((s) => s.allIn && !s.folded) ? buildPots(this.seats.map((s) => ({ id: s.id, total: s.total, folded: s.folded }))) : [],
      players,
      turn: this.turn,
      timeLeft,
      turnMs: this.turnMs,
      blinds: this.levelInfo(),
      result: this.result,
      log: this.log,
      myHand: null,
      legal: null
    };
    if (me && me.hole.length && !me.folded && this.inHand) {
      out.myHand = handMessage(evaluate([...me.hole, ...this.board]));
    }
    if (me && this.stage === 'bet' && this.turn === me.id) {
      const maxTo = me.bet + me.chips;
      const canRaise = maxTo > this.currentBet && this.canRaise(me);
      out.legal = {
        toCall: Math.min(this.currentBet - me.bet, me.chips),
        canCheck: me.bet >= this.currentBet,
        canRaise,
        minTo: Math.min(this.currentBet + this.minRaise, maxTo),
        maxTo,
        currentBet: this.currentBet
      };
    }
    return out;
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: the public table only. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, spectator: true });
  }

  broadcast() {
    for (const s of this.seats) if (!s.left) this.sendState(s.id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  cleanup() {
    this.isGameActive = false;
    for (const name of Object.keys(this.timers)) this.clearTimer(name);
  }
}
