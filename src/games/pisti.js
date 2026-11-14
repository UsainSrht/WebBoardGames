/**
 * Pisti (2-4 players), the Turkish card game. Every player has a private hand; the server sends each
 * viewer their own 'pisti-state' snapshot (hidden cards, the deck and other hands never leave the server).
 *
 * Options (see config.js):
 *   target    0 = one deal through the whole deck, otherwise play deals until a player / team reaches that score
 *   teams     'on' with four players = 2 vs 2, partners sit opposite and pool their cards and points
 *   turnTime  seconds per turn
 *
 * Rules implemented (standard Turkish Pisti):
 *   - 52 cards. Four cards go to the middle (only the top one is face up; if it is a Jack it is swapped for a
 *     non-Jack from the deck), then four to each player. When all hands are empty four more are dealt to each.
 *     48 cards divide exactly for 2, 3 and 4 players (6, 4 and 3 hands of four).
 *   - Play one card on the pile. A card of the same rank as the top card, or a Jack, captures the whole pile.
 *     A Jack does not capture an empty pile.
 *   - Capturing a pile of exactly one card with a matching rank is a Pisti (10 points); a Jack on a lone Jack is a
 *     double Pisti (20). A Jack on a lone non-Jack card is an ordinary capture.
 *   - Per deal: 2 of clubs = 2, 10 of diamonds = 3, each Ace = 1, each Jack = 1, most captured cards = 3 (nobody
 *     on a tie), plus the Pisti bonuses. Whoever captured last takes the cards left in the middle.
 *   - Leavers are played for by the server (lowest value card) so the seat keeps its points; when fewer than two
 *     people are still in the game the remaining one wins.
 */

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['s', 'h', 'd', 'c'];
const HAND_SIZE = 4;
const NEXT_DEAL_MS = 9000;
const FINISH_DELAY_MS = 3200;
const RETURN_TO_LOBBY_MS = 25000;
const START_FALLBACK_MS = 8000;
const BOT_MS = 900;
const TARGETS = [0, 101, 151];
const TURN_TIMES = [20, 30, 45];

export function buildDeck() {
  const cards = [];
  for (let s = 0; s < SUITS.length; s++) {
    for (let r = 0; r < RANKS.length; r++) cards.push({ id: s * RANKS.length + r, rank: RANKS[r], suit: SUITS[s] });
  }
  return cards;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Points a captured card is worth by itself. */
export function cardPoints(card) {
  if (card.rank === '2' && card.suit === 'c') return 2;
  if (card.rank === '10' && card.suit === 'd') return 3;
  if (card.rank === 'A' || card.rank === 'J') return 1;
  return 0;
}

/** What playing `card` on `pile` does. pisti: 0 none, 1 pisti, 2 double pisti. */
export function resolvePlay(pile, card) {
  const top = pile[pile.length - 1];
  if (!top) return { capture: false, pisti: 0 };
  const match = card.rank === top.rank;
  const capture = match || card.rank === 'J';
  const pisti = capture && match && pile.length === 1 ? (card.rank === 'J' ? 2 : 1) : 0;
  return { capture, pisti };
}

/**
 * Score one deal. `captured` maps unit id -> cards, `bonus` maps unit id -> { pisti, double } counts.
 * The most-cards bonus goes to a strict maximum only.
 */
export function scoreDeal(captured, bonus = {}) {
  const ids = Object.keys(captured);
  const counts = ids.map(id => captured[id].length);
  const max = Math.max(0, ...counts);
  const leaders = ids.filter(id => captured[id].length === max);
  return ids.map(id => {
    const cards = captured[id];
    const club2 = cards.filter(c => c.rank === '2' && c.suit === 'c').length * 2;
    const diamond10 = cards.filter(c => c.rank === '10' && c.suit === 'd').length * 3;
    const aces = cards.filter(c => c.rank === 'A').length;
    const jacks = cards.filter(c => c.rank === 'J').length;
    const most = max > 0 && leaders.length === 1 && leaders[0] === id ? 3 : 0;
    const pisti = bonus[id]?.pisti || 0;
    const double = bonus[id]?.double || 0;
    const total = club2 + diamond10 + aces + jacks + most + pisti * 10 + double * 20;
    return { id, cards: cards.length, club2, diamond10, aces, jacks, most, pisti, double, total };
  });
}

export class Pisti {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.rng = extra.rng || Math.random;
    this.now = extra.now || (() => Date.now());

    const target = Number(options.target);
    this.target = TARGETS.includes(target) ? target : 0;
    const secs = Number(options.turnTime);
    this.turnMs = (TURN_TIMES.includes(secs) ? secs : 30) * 1000;

    this.order = Object.keys(players);
    this.names = {};
    for (const [id, p] of Object.entries(players)) this.names[id] = p.name;
    this.teams = options.teams === 'on' && this.order.length === 4;

    // Scoring units: players, or two teams (seats 0+2 against 1+3, partners sit opposite).
    this.units = this.teams
      ? [{ id: 't0', members: [this.order[0], this.order[2]] }, { id: 't1', members: [this.order[1], this.order[3]] }]
      : this.order.map(id => ({ id, members: [id] }));
    this.unitOf = {};
    for (const u of this.units) for (const m of u.members) this.unitOf[m] = u.id;
    this.scores = Object.fromEntries(this.units.map(u => [u.id, 0]));
    this.stats = Object.fromEntries(this.order.map(id => [id, { pisti: 0, cards: 0 }]));

    this.left = new Set();
    this.deal = 0;
    this.phase = 'play'; // play | dealOver | over
    this.timer = null;
    this.finishTimer = null;
    this.deadline = 0;
    this.nextDealAt = 0;
    this.loaded = new Set();
    this.running = false;
    this.playSeq = 0;
    this.finished = false;

    this.startDeal();
    this.timer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  // ------------------------------------------------------------------ deals

  startDeal() {
    this.deal++;
    this.deck = shuffle(buildDeck(), this.rng);
    this.pile = this.deck.splice(0, 4);
    // The face up card is never a Jack.
    if (this.pile[3].rank === 'J') {
      const i = this.deck.findIndex(c => c.rank !== 'J');
      [this.pile[3], this.deck[i]] = [this.deck[i], this.pile[3]];
    }
    this.hands = {};
    for (const id of this.order) this.hands[id] = [];
    this.handNo = 0;
    this.dealHands();
    this.captured = Object.fromEntries(this.units.map(u => [u.id, []]));
    this.bonus = Object.fromEntries(this.units.map(u => [u.id, { pisti: 0, double: 0 }]));
    this.lastCapturer = null;
    this.lastPlay = null;
    this.dealResult = null;
    this.phase = 'play';
    this.turn = this.order[(this.deal - 1) % this.order.length];
  }

  dealHands() {
    this.handNo++;
    for (const id of this.order) this.hands[id].push(...this.deck.splice(0, HAND_SIZE));
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    this.running = true;
    clearTimeout(this.timer);
    this.startTurnTimer();
    this.broadcastState();
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.hands[odId]) return;
    payload = payload && typeof payload === 'object' ? payload : {};
    switch (type) {
      case 'pisti-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.running && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'pisti-play': return this.play(odId, payload.cardId);
    }
  }

  fail(odId, k) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'error', message: { k } });
  }

  canAct(odId) {
    return this.running && this.phase === 'play' && this.turn === odId && !this.finished;
  }

  play(odId, rawId) {
    if (!this.hands[odId]) return;
    if (!this.running || this.phase !== 'play' || this.finished) return;
    if (this.turn !== odId) return this.fail(odId, 'pisti.err.notYourTurn');
    const cardId = typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^\d{1,2}$/.test(rawId) ? Number(rawId) : -1;
    const hand = this.hands[odId];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return this.fail(odId, 'pisti.err.badCard');
    this.commitPlay(odId, idx);
  }

  commitPlay(odId, idx) {
    const hand = this.hands[odId];
    const [card] = hand.splice(idx, 1);
    const { capture, pisti } = resolvePlay(this.pile, card);
    this.pile.push(card);
    const size = this.pile.length;
    const unit = this.unitOf[odId];
    if (capture) {
      this.captured[unit].push(...this.pile);
      this.stats[odId].cards += size;
      this.pile = [];
      this.lastCapturer = odId;
      if (pisti === 1) this.bonus[unit].pisti++;
      if (pisti === 2) this.bonus[unit].double++;
      if (pisti) this.stats[odId].pisti++;
    }
    this.lastPlay = { seq: ++this.playSeq, by: odId, card, capture, pisti, size };

    if (this.order.every(id => this.hands[id].length === 0)) {
      if (this.deck.length === 0) return this.endDeal();
      this.dealHands();
    }
    this.turn = this.nextPlayer(odId);
    this.startTurnTimer();
    this.broadcastState();
  }

  nextPlayer(odId) {
    return this.order[(this.order.indexOf(odId) + 1) % this.order.length];
  }

  // ------------------------------------------------------------------ timer

  startTurnTimer() {
    clearTimeout(this.timer);
    const who = this.turn;
    const ms = this.left.has(who) ? BOT_MS : this.turnMs;
    this.deadline = this.now() + ms;
    this.timer = setTimeout(() => this.onTimeout(who), ms);
  }

  onTimeout(who) {
    if (!this.isGameActive || this.phase !== 'play' || this.turn !== who || this.finished) return;
    this.commitPlay(who, this.autoPick(this.hands[who]));
  }

  /** Lowest value card: nothing scoring first, a capture breaks ties, then the lowest rank. */
  autoPick(hand) {
    let best = 0;
    let bestKey = null;
    const less = (x, y) => { for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] < y[k]; return false; };
    hand.forEach((c, i) => {
      const key = [cardPoints(c), resolvePlay(this.pile, c).capture ? 0 : 1, RANKS.indexOf(c.rank), c.id];
      if (!bestKey || less(key, bestKey)) { best = i; bestKey = key; }
    });
    return best;
  }

  // ---------------------------------------------------------------- scoring

  endDeal() {
    clearTimeout(this.timer);
    this.timer = null;
    let sweep = null;
    if (this.pile.length && this.lastCapturer) {
      const unit = this.unitOf[this.lastCapturer];
      sweep = { by: this.lastCapturer, n: this.pile.length };
      this.captured[unit].push(...this.pile);
      this.stats[this.lastCapturer].cards += this.pile.length;
      this.pile = [];
    }
    const rows = scoreDeal(this.captured, this.bonus);
    for (const r of rows) this.scores[r.id] += r.total;
    this.dealResult = { deal: this.deal, units: rows, sweep };

    const reached = this.units.some(u => this.scores[u.id] >= this.target);
    if (this.target === 0 || reached) {
      this.phase = 'over';
      this.broadcastState();
      this.finishTimer = setTimeout(() => this.finish(null, false), FINISH_DELAY_MS);
      return;
    }
    this.phase = 'dealOver';
    this.nextDealAt = this.now() + NEXT_DEAL_MS;
    this.broadcastState();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isGameActive) return;
      this.startDeal();
      this.startTurnTimer();
      this.broadcastState();
    }, NEXT_DEAL_MS);
  }

  unitLabel(u) {
    return u.members.map(m => this.names[m]).join(' & ');
  }

  finish(forcedWinnerUnit, forfeit) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearTimeout(this.finishTimer);
    this.timer = this.finishTimer = null;
    this.phase = 'over';
    const sorted = [...this.units].sort((a, b) => {
      if (forcedWinnerUnit) {
        if (a.id === forcedWinnerUnit) return -1;
        if (b.id === forcedWinnerUnit) return 1;
      }
      return this.scores[b.id] - this.scores[a.id];
    });
    const rows = [];
    let rank = 0;
    let prevScore = null;
    sorted.forEach((u, i) => {
      const s = this.scores[u.id];
      if (i === 0 || s !== prevScore || (forcedWinnerUnit && i === 1)) rank = i + 1;
      prevScore = s;
      for (const m of u.members) {
        rows.push({
          id: m,
          name: this.names[m],
          score: s,
          rank,
          note: { k: 'pisti.fin.note', p: { pisti: this.stats[m].pisti, cards: this.stats[m].cards } }
        });
      }
    });
    const top = rows.filter(r => r.rank === 1);
    const topUnits = new Set(top.map(r => this.unitOf[r.id]));
    const title = topUnits.size > 1
      ? { k: 'pisti.fin.tie' }
      : this.teams
        ? { k: 'pisti.fin.titleTeam', p: { names: this.unitLabel(this.units.find(u => u.id === [...topUnits][0])) } }
        : { k: 'pisti.fin.title', p: { name: top[0].name } };
    this.broadcastState();
    this.room.finishGame({
      title,
      subtitle: forfeit ? { k: 'pisti.fin.sub.left' } : this.target ? { k: 'pisti.fin.sub.target', p: { n: this.target } } : { k: 'pisti.fin.sub.one' },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  // --------------------------------------------------------------- snapshots

  stateFor(odId) {
    const timeLeft = this.running && this.phase === 'play' ? Math.max(0, this.deadline - this.now()) : 0;
    const top = this.pile[this.pile.length - 1] || null;
    return {
      type: 'pisti-state',
      you: odId,
      hand: (odId && this.hands[odId]) || [],
      players: this.order.map(id => ({
        id,
        name: this.names[id],
        count: this.hands[id].length,
        unit: this.unitOf[id],
        left: this.left.has(id),
        pisti: this.stats[id].pisti
      })),
      units: this.units.map(u => ({
        id: u.id,
        members: u.members,
        score: this.scores[u.id],
        captured: this.captured[u.id].length,
        pisti: this.bonus[u.id].pisti,
        double: this.bonus[u.id].double
      })),
      teams: this.teams,
      turn: this.turn,
      top,
      pileSize: this.pile.length,
      deckCount: this.deck.length,
      phase: this.phase,
      deal: this.deal,
      handNo: this.handNo,
      target: this.target,
      lastPlay: this.lastPlay,
      dealResult: this.dealResult,
      nextDealIn: this.phase === 'dealOver' ? Math.max(0, this.nextDealAt - this.now()) : 0,
      timeLeft,
      turnMs: this.turnMs
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: everything public, never a hand. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, hand: [], spectator: true });
  }

  broadcastState() {
    for (const id of this.order) if (!this.left.has(id)) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  // ------------------------------------------------------------------ leaving

  onPlayerLeft(odId) {
    if (!this.hands[odId] || this.left.has(odId) || this.finished) return;
    this.left.add(odId);
    const humans = this.order.filter(id => !this.left.has(id));
    if (humans.length < 2) {
      if (this.phase === 'over') return this.finish(null, false);
      if (humans.length === 1) return this.finish(this.unitOf[humans[0]], true);
      this.cleanup();
      return;
    }
    if (this.phase === 'play' && this.running && this.turn === odId) this.startTurnTimer();
    this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.finishTimer);
    this.timer = this.finishTimer = null;
  }
}
