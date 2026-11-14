/**
 * Papaz Kacti ("Pass the King", the Turkish Old Maid) for 2-8 players.
 *
 * Options (see config.js):
 *   rounds    number of hands (1 / 3 / 5); the loser of each hand scores a loss
 *   turnTime  seconds per turn
 *
 * Deck: a standard 52-card deck with three of the four kings removed (K of hearts, diamonds and
 * clubs). The remaining king of spades is the Papaz (49 cards). All cards are dealt as evenly as
 * possible. Everybody first lays down every pair of equal rank (regardless of suit; with three of a
 * kind one pair goes and one card stays). Play goes in seat order: on your turn you draw one card,
 * face down, picked by you from the hand of the NEXT player in seat order (the player to your left),
 * and the turn then passes to that player. If the card pairs with one in your hand the pair is laid
 * down. A player with no cards left is safe and out of the hand; the last player holding the Papaz
 * loses the hand. Ranking after all hands: fewest losses first, ties share the rank.
 *
 * Privacy: you only ever see your own cards and the number of cards of the others. The drawing
 * player picks a slot index; the server decides which card that is. The target may shuffle their own
 * hand once per turn. A drawn card is inserted at a random place in the drawer's hand, and is only
 * visible to the drawer and the player it came from (or publicly when it forms a pair).
 *
 * Leavers: their cards leave the game. If they held the Papaz it passes to a random player still in
 * the hand, and for every rank left with an odd number of cards one card is removed from a random
 * holder so that the last player always ends up holding only the Papaz.
 */
import { buildDeck, shuffle, pub, failTo } from './card-utils.js';

const START_FALLBACK_MS = 6000;
const REVEAL_MS = 6500;
const LAST_REVEAL_MS = 4500;
const RETURN_TO_LOBBY_MS = 25000;
const LOG_KEEP = 40;
const EVENTS_KEEP = 14;

export const isPapaz = (c) => c.r === 'K';

/** 49 cards: the full deck minus K of hearts, diamonds and clubs. */
export function buildPapazDeck() {
  return buildDeck().filter(c => !(c.r === 'K' && c.s !== 's'));
}

/** Split a hand into pairs of equal rank and the cards that remain. */
export function splitPairs(hand) {
  const byRank = new Map();
  for (const c of hand) {
    if (!byRank.has(c.r)) byRank.set(c.r, []);
    byRank.get(c.r).push(c);
  }
  const pairs = [];
  const left = new Set(hand.map(c => c.id));
  for (const cards of byRank.values()) {
    for (let i = 0; i + 1 < cards.length; i += 2) {
      pairs.push([cards[i], cards[i + 1]]);
      left.delete(cards[i].id);
      left.delete(cards[i + 1].id);
    }
  }
  return { pairs, rest: hand.filter(c => left.has(c.id)) };
}

export class Papaz {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());

    const r = Number(options.rounds);
    this.rounds = r === 1 || r === 3 || r === 5 ? r : 3;
    this.turnMs = (Number(options.turnTime) || 30) * 1000;

    this.order = Object.keys(players);
    this.names = {};
    this.losses = {};
    for (const [id, p] of Object.entries(players)) { this.names[id] = p.name; this.losses[id] = 0; }

    this.round = 0;
    this.phase = 'play'; // play | roundOver | over
    this.running = false;
    this.timer = null;
    this.startTimer = null;
    this.deadline = 0;
    this.nextAt = 0;
    this.turn = null;
    this.shuffled = false;
    this.loaded = new Set();
    this.log = [];
    this.events = [];
    this.seq = 0;
    this.logId = 0;
    this.result = null;
    this.removed = 0;
    this.hands = {};
    this.discards = {};

    this.dealRound();
    this.startTimer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  // ----------------------------------------------------------------- helpers

  pushLog(k, p = {}) {
    this.log.push({ id: ++this.logId, k, p });
    if (this.log.length > LOG_KEEP * 2) this.log.splice(0, this.log.length - LOG_KEEP);
  }

  pushEvent(ev) {
    this.events.push({ seq: ++this.seq, ...ev });
    if (this.events.length > EVENTS_KEEP * 2) this.events.splice(0, this.events.length - EVENTS_KEEP);
  }

  active() { return this.order.filter(id => this.hands[id].length > 0); }

  /** Next player after `id` in seat order who still holds cards. */
  nextActive(id) {
    const n = this.order.length;
    const idx = this.order.indexOf(id);
    for (let i = 1; i <= n; i++) {
      const cand = this.order[(idx + i) % n];
      if (cand !== id && this.hands[cand].length > 0) return cand;
    }
    return null;
  }

  /** The player the current turn player draws from. */
  target() { return this.turn ? this.nextActive(this.turn) : null; }

  // ------------------------------------------------------------------ rounds

  dealRound() {
    this.round++;
    this.result = null;
    this.phase = 'play';
    this.removed = 0;
    this.shuffled = false;
    const deck = shuffle(buildPapazDeck(), this.rng);
    const n = this.order.length;
    for (const id of this.order) { this.hands[id] = []; this.discards[id] = []; }
    deck.forEach((c, i) => this.hands[this.order[i % n]].push(c));
    for (const id of this.order) {
      const { pairs, rest } = splitPairs(this.hands[id]);
      this.discards[id].push(...pairs);
      this.hands[id] = rest;
    }
    this.pushLog('papaz.msg.dealt', { round: this.round, rounds: this.rounds });
    this.pushEvent({ t: 'deal', round: this.round });
    const first = this.order[(this.round - 1) % n];
    this.turn = this.hands[first].length ? first : this.nextActive(first);
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.running = true;
    this.startTurn();
  }

  /** Start the clock for the current turn, or end the hand when only one player is left. */
  startTurn() {
    if (this.phase !== 'play') return;
    const act = this.active();
    if (act.length <= 1) return this.endHand(act[0] || null);
    if (!this.turn || this.hands[this.turn].length === 0) this.turn = this.nextActive(this.turn || this.order[0]) || act[0];
    this.shuffled = false;
    this.pushEvent({ t: 'turn', who: this.turn });
    clearTimeout(this.timer);
    this.deadline = this.now() + this.turnMs;
    const who = this.turn;
    const round = this.round;
    this.timer = setTimeout(() => this.onTimeout(who, round), this.turnMs);
    this.broadcastState();
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.hands[odId] || typeof type !== 'string') return;
    switch (type) {
      case 'papaz-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.running && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'papaz-draw': {
        const p = payload && typeof payload === 'object' ? payload : {};
        return this.draw(odId, p.index);
      }
      case 'papaz-shuffle': return this.shuffleOwn(odId);
    }
  }

  draw(odId, index) {
    if (!this.running || this.phase !== 'play' || this.turn !== odId) return;
    const t = this.target();
    if (!t) return;
    if (!Number.isInteger(index) || index < 0 || index >= this.hands[t].length) return failTo(this.room, odId, { k: 'papaz.err.slot' });
    clearTimeout(this.timer);
    this.timer = null;

    const card = this.hands[t].splice(index, 1)[0];
    const mine = this.hands[odId];
    const matchIdx = mine.findIndex(c => c.r === card.r);
    let pair = null;
    if (matchIdx >= 0) {
      const match = mine.splice(matchIdx, 1)[0];
      pair = [match, card];
      this.discards[odId].push(pair);
    } else {
      mine.splice(Math.floor(this.rng() * (mine.length + 1)), 0, card);
    }
    this.pushLog('papaz.msg.draw', { name: this.names[odId], target: this.names[t] });
    this.pushEvent({ t: 'draw', from: t, to: odId, index, pair: pair ? pair.map(pub) : null, card: pub(card) });
    if (pair) this.pushLog('papaz.msg.pair', { name: this.names[odId] });

    for (const id of [t, odId]) {
      if (this.hands[id].length === 0) {
        this.pushLog('papaz.msg.safe', { name: this.names[id] });
        this.pushEvent({ t: 'safe', who: id });
      }
    }
    this.afterMove(odId);
  }

  afterMove(prevTurn) {
    const act = this.active();
    if (act.length <= 1) return this.endHand(act[0] || null);
    this.turn = this.nextActive(prevTurn);
    this.startTurn();
  }

  shuffleOwn(odId) {
    if (!this.running || this.phase !== 'play' || this.shuffled) return;
    if (this.target() !== odId || this.hands[odId].length < 2) return;
    this.shuffled = true;
    shuffle(this.hands[odId], this.rng);
    this.pushLog('papaz.msg.shuffled', { name: this.names[odId] });
    this.pushEvent({ t: 'shuffle', who: odId });
    this.broadcastState();
  }

  onTimeout(who, round) {
    if (!this.isGameActive || this.phase !== 'play' || this.turn !== who || round !== this.round || !this.hands[who]) return;
    const t = this.target();
    if (!t) return;
    this.pushLog('papaz.msg.timeout', { name: this.names[who] });
    this.draw(who, Math.floor(this.rng() * this.hands[t].length));
  }

  // ------------------------------------------------------------------ scoring

  endHand(loser) {
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'roundOver';
    this.turn = null;
    if (loser) this.losses[loser]++;
    const papaz = loser ? this.hands[loser].find(isPapaz) : null;
    this.result = { loser, round: this.round, card: papaz ? pub(papaz) : null };
    if (loser) {
      this.pushLog('papaz.msg.loser', { name: this.names[loser] });
      this.pushEvent({ t: 'papaz', who: loser });
    }
    const last = this.round >= this.rounds;
    const wait = last ? LAST_REVEAL_MS : REVEAL_MS;
    this.nextAt = this.now() + wait;
    this.broadcastState();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isGameActive) return;
      if (last) return this.finish();
      this.dealRound();
      this.startTurn();
    }, wait);
  }

  finish(reason) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'over';
    this.turn = null;
    this.broadcastState();
    const ids = [...this.order].sort((a, b) => this.losses[a] - this.losses[b]);
    let rank = 0;
    let prev = null;
    const rows = ids.map((id, i) => {
      const l = this.losses[id];
      if (l !== prev) rank = i + 1;
      prev = l;
      return { id, name: this.names[id], rank, score: Math.max(0, this.rounds - l), note: { k: 'papaz.msg.lossesNote', p: { n: l } } };
    });
    const most = Math.max(...ids.map(id => this.losses[id]));
    const losers = ids.filter(id => this.losses[id] === most);
    let title;
    if (reason === 'left') title = { k: 'papaz.msg.lastStanding', p: { name: this.names[ids[0]] } };
    else if (most === 0) title = { k: 'papaz.msg.noLoser' };
    else if (losers.length === 1) title = { k: 'papaz.msg.loserTitle', p: { name: this.names[losers[0]] } };
    else title = { k: 'papaz.msg.tieTitle', p: { names: losers.map(id => this.names[id]).join(', ') } };
    this.room.finishGame({
      title,
      subtitle: reason === 'left' ? { k: 'papaz.msg.everyoneLeft' } : { k: 'papaz.msg.rounds', p: { n: this.rounds } },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  // --------------------------------------------------------------- snapshots

  eventsFor(odId) {
    return this.events.slice(-EVENTS_KEEP).map((e) => {
      if (e.t !== 'draw') return e;
      const { card, ...rest } = e;
      return odId && (odId === e.from || odId === e.to) ? { ...rest, card } : rest;
    });
  }

  stateFor(odId) {
    const playing = this.running && this.phase === 'play';
    const target = this.phase === 'play' ? this.target() : null;
    return {
      type: 'papaz-state',
      you: odId,
      round: this.round,
      rounds: this.rounds,
      phase: this.phase,
      players: this.order.map(id => ({
        id,
        name: this.names[id],
        count: this.hands[id].length,
        losses: this.losses[id],
        discards: this.discards[id].map(pr => pr.map(pub))
      })),
      hand: odId && this.hands[odId] ? this.hands[odId].map(pub) : [],
      turn: this.turn,
      target,
      canShuffle: !!odId && playing && !this.shuffled && target === odId && this.hands[odId].length > 1,
      removed: this.removed,
      timeLeft: playing ? Math.max(0, this.deadline - this.now()) : 0,
      turnMs: this.turnMs,
      nextIn: this.phase === 'roundOver' ? Math.max(0, this.nextAt - this.now()) : 0,
      result: this.result,
      seq: this.seq,
      log: this.log.slice(-LOG_KEEP),
      events: this.eventsFor(odId)
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
    const papaz = this.hands[odId].find(isPapaz);
    delete this.hands[odId];
    delete this.discards[odId];
    delete this.losses[odId];
    const idx = this.order.indexOf(odId);
    this.order.splice(idx, 1);
    this.loaded.delete(odId);
    if (this.phase === 'over') return;
    this.pushLog('papaz.msg.left', { name: this.names[odId] });

    if (this.order.length < 2) {
      if (this.order.length === 1) return this.finish('left');
      clearTimeout(this.timer);
      return;
    }
    if (this.phase !== 'play') return this.broadcastState();

    // The Papaz stays with a real player, and ranks keep an even number of cards in play.
    const act = this.active();
    if (papaz && act.length) {
      const holder = act[Math.floor(this.rng() * act.length)];
      this.hands[holder].splice(Math.floor(this.rng() * (this.hands[holder].length + 1)), 0, papaz);
    }
    const byRank = new Map();
    for (const id of this.order) for (const c of this.hands[id]) {
      if (isPapaz(c)) continue;
      if (!byRank.has(c.r)) byRank.set(c.r, []);
      byRank.get(c.r).push({ id, card: c });
    }
    for (const list of byRank.values()) {
      if (list.length % 2 === 0) continue;
      const pick = list[Math.floor(this.rng() * list.length)];
      this.hands[pick.id] = this.hands[pick.id].filter(c => c.id !== pick.card.id);
      this.removed++;
      if (this.hands[pick.id].length === 0) this.pushLog('papaz.msg.safe', { name: this.names[pick.id] });
    }

    const left = this.active();
    if (left.length <= 1) return this.endHand(left[0] || null);
    if (!this.running) return;
    if (wasTurn) {
      this.turn = this.nextActive(this.order[(idx - 1 + this.order.length) % this.order.length]);
      this.startTurn();
    } else if (!this.turn || this.hands[this.turn].length === 0) {
      this.turn = this.nextActive(this.turn || this.order[0]);
      this.startTurn();
    } else {
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
