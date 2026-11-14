/**
 * Go Fish (2-6 players), standard 52-card deck.
 *
 * Options (see config.js):
 *   hand      'auto' = 7 cards with 2-3 players and 5 with 4+, or force 5 / 7
 *   turnTime  seconds per turn
 *
 * Rules: on your turn you ask one opponent (who must hold cards) for a rank you hold. If they have
 * it they hand over ALL cards of that rank and you ask again. Otherwise "Go fish": you draw one card
 * from the pond (stock); if it is the rank you asked for you show it and keep playing, else the turn
 * passes. Four cards of a rank are laid down as a book at once. A player with an empty hand draws a
 * fresh hand (the starting hand size) from the stock when it is their turn, or is skipped when the
 * stock is empty. The game ends when all 13 books are made; most books wins, ties share the rank.
 * A leaving player's cards are shuffled back into the stock (their books stay out of play).
 *
 * Privacy: every player gets their own 'gofish-state'; others only see hand sizes. A drawn card is
 * never revealed unless it matched the asked rank.
 */
import { RANKS, buildDeck, shuffle, sortHand, pub, failTo } from './card-utils.js';

const START_FALLBACK_MS = 6000;
const RETURN_TO_LOBBY_MS = 25000;
const LOG_KEEP = 40;
const EVENTS_KEEP = 14;

export class GoFish {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());

    this.turnMs = (Number(options.turnTime) || 30) * 1000;
    this.order = Object.keys(players);
    this.names = {};
    for (const [id, p] of Object.entries(players)) this.names[id] = p.name;

    const n = this.order.length;
    const forced = Number(options.hand);
    this.handSize = forced === 5 || forced === 7 ? forced : (n <= 3 ? 7 : 5);

    this.phase = 'play'; // play | over
    this.running = false;
    this.timer = null;
    this.startTimer = null;
    this.deadline = 0;
    this.turn = null;
    this.loaded = new Set();
    this.log = [];
    this.events = [];
    this.seq = 0;
    this.logId = 0;
    this.goneBooks = 0;
    this.books = {};
    this.hands = {};

    this.stock = shuffle(buildDeck(), this.rng);
    for (const id of this.order) {
      this.hands[id] = this.stock.splice(0, this.handSize);
      this.books[id] = [];
    }
    for (const id of this.order) this.layBooks(id);
    this.pushLog('gofish.msg.dealt', { n: this.handSize });
    this.startTimer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  // ----------------------------------------------------------------- helpers

  rankMsg(r, n = 2) { return { k: `gofish.rank.${r}`, p: { n } }; }

  pushLog(k, p = {}) {
    this.log.push({ id: ++this.logId, k, p });
    if (this.log.length > LOG_KEEP * 2) this.log.splice(0, this.log.length - LOG_KEEP);
  }

  pushEvent(ev) {
    this.events.push({ seq: ++this.seq, ...ev });
    if (this.events.length > EVENTS_KEEP * 2) this.events.splice(0, this.events.length - EVENTS_KEEP);
  }

  totalBooks() {
    return this.goneBooks + this.order.reduce((s, id) => s + this.books[id].length, 0);
  }

  targets(id) { return this.order.filter(o => o !== id && this.hands[o].length > 0); }

  /** Lay down every complete set of four in the player's hand. */
  layBooks(id) {
    let made = 0;
    for (const r of RANKS) {
      const same = this.hands[id].filter(c => c.r === r);
      if (same.length !== 4) continue;
      this.hands[id] = this.hands[id].filter(c => c.r !== r);
      this.books[id].push(r);
      made++;
      this.pushLog('gofish.msg.book', { name: this.names[id], rank: this.rankMsg(r) });
      this.pushEvent({ t: 'book', who: id, rank: r });
    }
    return made;
  }

  /** An empty-handed player draws a new hand from the stock when it is their turn. */
  ensureHand(id) {
    let guard = 0;
    while (this.hands[id].length === 0 && this.stock.length > 0 && guard++ < 4) {
      const n = Math.min(this.handSize, this.stock.length);
      this.hands[id].push(...this.stock.splice(0, n));
      this.pushLog('gofish.msg.refill', { name: this.names[id], n });
      this.pushEvent({ t: 'refill', who: id, n });
      this.layBooks(id);
    }
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.hands[odId] || typeof type !== 'string') return;
    switch (type) {
      case 'gofish-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.running && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'gofish-ask': {
        const p = payload && typeof payload === 'object' ? payload : {};
        return this.ask(odId, p.target, p.rank);
      }
    }
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.running = true;
    if (this.totalBooks() >= 13) return this.finish();
    const n = this.order.length;
    const start = Math.floor(this.rng() * n);
    this.nextTurn(this.order[(start - 1 + n) % n]);
  }

  // ------------------------------------------------------------------ rules

  ask(odId, target, rank) {
    if (!this.running || this.phase !== 'play' || this.turn !== odId) return;
    if (typeof target !== 'string' || target === odId || !this.hands[target]) return failTo(this.room, odId, { k: 'gofish.err.target' });
    if (this.hands[target].length === 0) return failTo(this.room, odId, { k: 'gofish.err.emptyTarget' });
    if (typeof rank !== 'string' || !RANKS.includes(rank) || !this.hands[odId].some(c => c.r === rank)) {
      return failTo(this.room, odId, { k: 'gofish.err.rank' });
    }
    clearTimeout(this.timer);
    this.timer = null;
    const name = this.names[odId];
    this.pushLog('gofish.msg.ask', { name, target: this.names[target], rank: this.rankMsg(rank) });
    this.pushEvent({ t: 'ask', who: odId, target, rank });

    const given = this.hands[target].filter(c => c.r === rank);
    if (given.length) {
      this.hands[target] = this.hands[target].filter(c => c.r !== rank);
      this.hands[odId].push(...given);
      this.pushLog('gofish.msg.give', { name: this.names[target], to: name, n: given.length, rank: this.rankMsg(rank, given.length) });
      this.pushEvent({ t: 'give', from: target, to: odId, rank, n: given.length });
      this.layBooks(odId);
      return this.afterAction(odId, true);
    }

    this.pushLog('gofish.msg.goFish', { name: this.names[target] });
    this.pushEvent({ t: 'gofish', who: target, asker: odId, rank });
    if (this.stock.length === 0) {
      this.pushLog('gofish.msg.stockEmpty', {});
      return this.afterAction(odId, false);
    }
    const card = this.stock.shift();
    this.hands[odId].push(card);
    const lucky = card.r === rank;
    if (lucky) {
      this.pushLog('gofish.msg.lucky', { name, rank: this.rankMsg(rank, 1) });
      this.pushEvent({ t: 'fish', who: odId, lucky: true, rank, card: pub(card), left: this.stock.length });
    } else {
      this.pushLog('gofish.msg.fished', { name });
      this.pushEvent({ t: 'fish', who: odId, lucky: false, left: this.stock.length });
    }
    this.layBooks(odId);
    return this.afterAction(odId, lucky);
  }

  /** After an ask resolves: finish, keep the turn (keep = true) or pass it. */
  afterAction(odId, keep) {
    if (this.totalBooks() >= 13) return this.finish();
    if (!keep) return this.nextTurn(odId);
    this.ensureHand(odId);
    if (this.totalBooks() >= 13) return this.finish();
    if (this.hands[odId].length === 0 || this.targets(odId).length === 0) return this.nextTurn(odId);
    this.startTurnTimer();
    this.broadcastState();
  }

  nextTurn(from) {
    const n = this.order.length;
    const idx = Math.max(0, this.order.indexOf(from));
    for (let i = 1; i <= n; i++) {
      const cand = this.order[(idx + i) % n];
      this.ensureHand(cand);
      if (this.totalBooks() >= 13) return this.finish();
      if (this.hands[cand].length > 0 && this.targets(cand).length > 0) {
        if (this.turn !== cand) this.pushEvent({ t: 'turn', who: cand });
        this.turn = cand;
        this.startTurnTimer();
        this.broadcastState();
        return;
      }
    }
    // Nobody can act (cannot happen with a consistent deck): end the game with what has been made.
    this.finish();
  }

  startTurnTimer() {
    clearTimeout(this.timer);
    this.deadline = this.now() + this.turnMs;
    const who = this.turn;
    this.timer = setTimeout(() => this.onTimeout(who), this.turnMs);
  }

  /** Out of time: ask a random opponent for a random rank from the hand. */
  onTimeout(who) {
    if (!this.isGameActive || this.phase !== 'play' || this.turn !== who || !this.hands[who]) return;
    const targets = this.targets(who);
    const hand = this.hands[who];
    if (!targets.length || !hand.length) return this.nextTurn(who);
    const target = targets[Math.floor(this.rng() * targets.length)];
    const rank = hand[Math.floor(this.rng() * hand.length)].r;
    this.pushLog('gofish.msg.timeout', { name: this.names[who] });
    this.ask(who, target, rank);
  }

  // ------------------------------------------------------------------ ending

  finish(reason) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'over';
    this.turn = null;
    this.broadcastState();
    const ids = [...this.order].sort((a, b) => this.books[b].length - this.books[a].length);
    let rank = 0;
    let prev = null;
    const rows = ids.map((id, i) => {
      const s = this.books[id].length;
      if (s !== prev) rank = i + 1;
      prev = s;
      return { id, name: this.names[id], rank, score: s, note: { k: 'gofish.msg.booksNote', p: { n: s } } };
    });
    const winners = rows.filter(r => r.rank === 1);
    const title = winners.length === 1
      ? { k: 'gofish.msg.wins', p: { name: winners[0].name } }
      : { k: 'gofish.msg.tie', p: { names: winners.map(w => w.name).join(', ') } };
    this.room.finishGame({
      title,
      subtitle: reason === 'left' ? { k: 'gofish.msg.everyoneLeft' } : { k: 'gofish.msg.allBooks' },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  // --------------------------------------------------------------- snapshots

  stateFor(odId) {
    const timeLeft = this.running && this.phase === 'play' ? Math.max(0, this.deadline - this.now()) : 0;
    return {
      type: 'gofish-state',
      you: odId,
      hand: odId && this.hands[odId] ? sortHand(this.hands[odId]).map(pub) : [],
      players: this.order.map(id => ({ id, name: this.names[id], count: this.hands[id].length, books: [...this.books[id]] })),
      stock: this.stock.length,
      turn: this.turn,
      phase: this.phase,
      handSize: this.handSize,
      timeLeft,
      turnMs: this.turnMs,
      seq: this.seq,
      log: this.log.slice(-LOG_KEEP),
      events: this.events.slice(-EVENTS_KEEP)
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: everything public, never a hand. */
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
    if (!this.hands[odId]) return;
    const wasTurn = this.turn === odId;
    this.stock.push(...this.hands[odId]);
    shuffle(this.stock, this.rng);
    this.goneBooks += this.books[odId].length;
    delete this.hands[odId];
    delete this.books[odId];
    const idx = this.order.indexOf(odId);
    this.order.splice(idx, 1);
    this.loaded.delete(odId);
    if (this.phase === 'over') return;
    this.pushLog('gofish.msg.left', { name: this.names[odId] });

    if (this.order.length < 2) {
      if (this.order.length === 1) return this.finish('left');
      clearTimeout(this.timer);
      return;
    }
    if (wasTurn) {
      clearTimeout(this.timer);
      this.timer = null;
      const from = this.order[(idx - 1 + this.order.length) % this.order.length];
      this.nextTurn(from);
    } else if (this.running) {
      this.broadcastState();
    }
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.timer = this.startTimer = null;
  }
}
