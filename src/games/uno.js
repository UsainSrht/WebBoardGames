/**
 * Uno (2-10 players). Hands are private: each player gets their own 'uno-state'.
 *
 * House rules: no stacking of +2/+4, a drawn card may be played immediately,
 * otherwise the player passes. Reverse acts as skip with two players.
 * First player to empty their hand wins.
 */

const COLORS = ['red', 'yellow', 'green', 'blue'];
const TURN_MS = 30000;
const START_FALLBACK_MS = 8000;
const RETURN_TO_LOBBY_MS = 12000;
const HAND_SIZE = 7;

export function buildDeck() {
  const cards = [];
  let id = 0;
  const add = (color, value) => cards.push({ id: id++, color, value });
  for (const color of COLORS) {
    add(color, '0');
    for (let n = 1; n <= 9; n++) { add(color, String(n)); add(color, String(n)); }
    for (const v of ['skip', 'reverse', 'draw2']) { add(color, v); add(color, v); }
  }
  for (let i = 0; i < 4; i++) { add('wild', 'wild'); add('wild', 'wild4'); }
  return cards;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Uno {
  constructor(room, players) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;

    this.names = {};
    this.order = Object.keys(players);
    for (const [id, p] of Object.entries(players)) this.names[id] = p.name;

    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.hands = {};
    for (const id of this.order) this.hands[id] = this.deck.splice(0, HAND_SIZE);

    // The first up-card is always a plain number card.
    let idx = this.deck.findIndex(c => /^\d$/.test(c.value));
    this.discard.push(this.deck.splice(idx, 1)[0]);
    this.color = this.top.color;

    this.dir = 1;
    this.turn = this.order[0];
    this.pending = null; // card id drawn this turn that may still be played
    this.winner = null;
    this.deadline = 0;
    this.timer = null;
    this.log = 'Game started';
    this.loaded = new Set();
    this.running = false;

    this.timer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  get top() { return this.discard[this.discard.length - 1]; }

  begin() {
    if (this.running || !this.isGameActive) return;
    this.running = true;
    this.startTurnTimer();
    this.broadcastState();
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.hands[odId]) return;

    switch (type) {
      case 'uno-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (!this.running && this.loaded.size >= this.order.length) this.begin();
        return;
      case 'uno-play': return this.play(odId, Number(payload.cardId), payload.color);
      case 'uno-draw': return this.draw(odId);
      case 'uno-pass': return this.pass(odId);
    }
  }

  isPlayable(card) {
    return card.color === 'wild' || card.color === this.color || card.value === this.top.value;
  }

  canAct(odId) {
    return this.running && !this.winner && this.turn === odId;
  }

  fail(odId, message) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'error', message });
  }

  play(odId, cardId, color) {
    if (!this.canAct(odId)) return;
    const hand = this.hands[odId];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const card = hand[idx];

    if (this.pending !== null && this.pending !== cardId) return this.fail(odId, 'You can only play the card you just drew');
    if (!this.isPlayable(card)) return this.fail(odId, "That card can't be played");
    if (card.color === 'wild' && !COLORS.includes(color)) return this.fail(odId, 'Choose a colour');

    hand.splice(idx, 1);
    this.discard.push(card);
    this.color = card.color === 'wild' ? color : card.color;
    this.pending = null;

    const name = this.names[odId];
    this.log = `${name} played ${this.describe(card)}`;

    if (hand.length === 0) return this.win(odId);

    let steps = 1;
    const victim = () => this.nextPlayer(odId, 1);
    switch (card.value) {
      case 'skip': steps = 2; this.log += ' - next player skipped'; break;
      case 'reverse':
        this.dir *= -1;
        if (this.order.length === 2) steps = 2;
        break;
      case 'draw2': this.drawCards(victim(), 2); steps = 2; this.log += ` - ${this.names[victim()]} draws 2`; break;
      case 'wild4': this.drawCards(victim(), 4); steps = 2; this.log += ` - ${this.names[victim()]} draws 4`; break;
    }
    if (hand.length === 1) this.log += ` - ${name} has UNO!`;

    this.turn = this.nextPlayer(odId, steps);
    this.nextTurn();
  }

  describe(card) {
    return card.color === 'wild' ? `${card.value === 'wild4' ? 'Wild +4' : 'Wild'} (${this.color})` : `${card.color} ${card.value}`;
  }

  draw(odId) {
    if (!this.canAct(odId) || this.pending !== null) return;
    const [card] = this.drawCards(odId, 1);
    if (!card) return this.pass(odId, true);

    if (this.isPlayable(card)) {
      this.pending = card.id;
      this.log = `${this.names[odId]} drew a card`;
      this.startTurnTimer();
      this.broadcastState();
    } else {
      this.log = `${this.names[odId]} drew a card and passed`;
      this.turn = this.nextPlayer(odId, 1);
      this.nextTurn();
    }
  }

  pass(odId, force = false) {
    if (!this.canAct(odId) || (this.pending === null && !force)) return;
    this.pending = null;
    this.log = `${this.names[odId]} passed`;
    this.turn = this.nextPlayer(odId, 1);
    this.nextTurn();
  }

  drawCards(odId, n) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        const keep = this.discard.pop();
        this.deck = shuffle(this.discard);
        this.discard = [keep];
      }
      const card = this.deck.pop();
      if (!card) break;
      this.hands[odId].push(card);
      drawn.push(card);
    }
    return drawn;
  }

  nextPlayer(from, steps) {
    const n = this.order.length;
    const i = this.order.indexOf(from);
    return this.order[(((i + this.dir * steps) % n) + n) % n];
  }

  nextTurn() {
    this.pending = null;
    this.startTurnTimer();
    this.broadcastState();
  }

  startTurnTimer() {
    clearTimeout(this.timer);
    this.deadline = Date.now() + TURN_MS;
    const who = this.turn;
    this.timer = setTimeout(() => {
      if (!this.isGameActive || this.winner || this.turn !== who) return;
      if (this.pending !== null) this.pass(who);
      else {
        // time out: draw one card and move on
        this.pending = null;
        this.drawCards(who, 1);
        this.log = `${this.names[who]} ran out of time and drew a card`;
        this.turn = this.nextPlayer(who, 1);
        this.nextTurn();
      }
    }, TURN_MS);
  }

  win(odId) {
    this.winner = odId;
    clearTimeout(this.timer);
    this.log = `${this.names[odId]} wins!`;
    this.broadcastState();
    this.timer = setTimeout(() => this.room.endGame(), RETURN_TO_LOBBY_MS);
  }

  stateFor(odId) {
    return {
      type: 'uno-state',
      you: odId,
      hand: this.hands[odId] || [],
      players: this.order.map(id => ({ id, name: this.names[id], count: this.hands[id].length })),
      turn: this.turn,
      dir: this.dir,
      top: this.top,
      color: this.color,
      deckCount: this.deck.length,
      pending: this.pending,
      winner: this.winner,
      deadline: this.running ? this.deadline : 0,
      log: this.log
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: everything public, no hand. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, hand: [], spectator: true });
  }

  broadcastState() {
    for (const id of this.order) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  onPlayerLeft(odId) {
    if (!this.hands[odId]) return;
    this.deck.unshift(...this.hands[odId]);
    delete this.hands[odId];
    const wasTurn = this.turn === odId;
    const next = wasTurn ? this.nextPlayer(odId, 1) : this.turn;
    this.order.splice(this.order.indexOf(odId), 1);
    this.log = `${this.names[odId]} left the game`;

    if (this.winner) return;
    if (this.order.length < 2) {
      if (this.order.length === 1) return this.win(this.order[0]);
      return;
    }
    if (wasTurn) { this.turn = next; this.nextTurn(); }
    else this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
