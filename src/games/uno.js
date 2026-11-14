/**
 * Uno (2-10 players). Hands are private: every player gets their own 'uno-state'.
 *
 * Options (see config.js):
 *   target    0 = a single round, otherwise play rounds until someone reaches that many points
 *   stacking  'on': a +2 can be answered with a +2 (and a +4 with a +4) instead of drawing
 *   unoCall   'on': you must press UNO on your second to last card, or anyone can catch you
 *   turnTime  seconds per turn
 *
 * Other rules: a drawn card may be played immediately, otherwise the turn passes; Reverse acts
 * as Skip with two players; the round winner scores the cards left in everybody's hands.
 */

const COLORS = ['red', 'yellow', 'green', 'blue'];
const HAND_SIZE = 7;
const START_FALLBACK_MS = 8000;
const UNO_WINDOW_MS = 3500;
const NEXT_ROUND_MS = 7000;
const RETURN_TO_LOBBY_MS = 25000;

// Dictionary keys (public_html/i18n/uno.json) for colour and card names; literal so tests can scan them.
const COLOR_KEYS = { red: 'uno.color.red', yellow: 'uno.color.yellow', green: 'uno.color.green', blue: 'uno.color.blue' };
const CARD_KEYS = {
  num: 'uno.card.num', skip: 'uno.card.skip', reverse: 'uno.card.reverse', draw2: 'uno.card.draw2',
  wild: 'uno.card.wild', wild4: 'uno.card.wild4'
};

/** A translatable description of a card ("red 5", "Wild +4 (blue)"); `chosen` is the colour picked for a wild. */
export function cardMsg(card, chosen) {
  const color = card.color === 'wild' ? chosen : card.color;
  const p = { color: { k: COLOR_KEYS[color] } };
  if (card.color === 'wild') return { k: CARD_KEYS[card.value], p };
  if (/^d$/.test(card.value)) return { k: CARD_KEYS.num, p: { ...p, n: card.value } };
  return { k: CARD_KEYS[card.value], p };
}

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

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Penalty points of a card left in hand. */
export function cardPoints(card) {
  if (/^\d$/.test(card.value)) return Number(card.value);
  return card.color === 'wild' ? 50 : 20;
}

export class Uno {
  constructor(room, players, options = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.rng = Math.random;
    this.now = () => Date.now();

    this.target = Number(options.target) || 0;
    this.stacking = options.stacking === 'on';
    this.unoCall = options.unoCall !== 'off';
    this.turnMs = (Number(options.turnTime) || 30) * 1000;

    this.names = {};
    this.scores = {};
    this.order = Object.keys(players);
    for (const [id, p] of Object.entries(players)) { this.names[id] = p.name; this.scores[id] = 0; }

    this.round = 0;
    this.phase = 'play'; // play | roundOver | over
    this.timer = null;
    this.unoTimer = null;
    this.nextRoundAt = 0;
    this.deadline = 0;
    this.loaded = new Set();
    this.running = false;
    this.playSeq = 0;
    this.lastPlay = null;
    this.roundResult = null;
    this.exposed = null;     // { id, until } a player on one card who has not called UNO yet
    this.preCalled = null;   // player who pressed UNO before playing their second to last card

    this.dealRound();
    this.timer = setTimeout(() => this.begin(), START_FALLBACK_MS);
  }

  get top() { return this.discard[this.discard.length - 1]; }

  // ----------------------------------------------------------------- rounds

  dealRound() {
    this.round++;
    this.deck = shuffle(buildDeck(), this.rng);
    this.discard = [];
    this.hands = {};
    for (const id of this.order) this.hands[id] = this.deck.splice(0, HAND_SIZE);

    // The first up-card is always a plain number card.
    const idx = this.deck.findIndex(c => /^\d$/.test(c.value));
    this.discard.push(this.deck.splice(idx, 1)[0]);
    this.color = this.top.color;

    this.dir = 1;
    this.turn = this.order[(this.round - 1) % this.order.length];
    this.pending = null;       // card id drawn this turn that may still be played
    this.pendingDraw = 0;      // stacked penalty cards the current player faces
    this.pendingType = null;   // 'draw2' | 'wild4'
    this.exposed = null;
    this.preCalled = null;
    this.lastPlay = null;
    this.roundResult = null;
    this.phase = 'play';
    this.log = [{ k: 'uno.log.start', p: { round: this.round, name: this.names[this.turn] } }];
  }

  begin() {
    if (this.running || !this.isGameActive) return;
    this.running = true;
    this.startTurnTimer();
    this.broadcastState();
  }

  // --------------------------------------------------------------- messages

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
      case 'uno-call': return this.call(odId);
      case 'uno-catch': return this.catchPlayer(odId);
    }
  }

  // ------------------------------------------------------------------ rules

  matches(card) {
    return card.color === 'wild' || card.color === this.color || card.value === this.top.value;
  }

  /** Can the player on turn play this card right now? */
  canPlay(card) {
    if (this.pendingDraw > 0) return this.stacking && card.value === this.pendingType;
    if (this.pending !== null) return card.id === this.pending && this.matches(card);
    return this.matches(card);
  }

  playableIds(odId) {
    if (!this.running || this.phase !== 'play' || this.turn !== odId) return [];
    return this.hands[odId].filter(c => this.canPlay(c)).map(c => c.id);
  }

  canAct(odId) {
    return this.running && this.phase === 'play' && this.turn === odId;
  }

  fail(odId, message) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'error', message });
  }

  /** Any action by someone other than the exposed player closes the catch window. */
  settleExposure(actor) {
    if (this.exposed && this.exposed.id !== actor) this.clearExposure();
    else if (this.exposed && this.exposed.id === actor) this.clearExposure();
  }

  clearExposure() {
    this.exposed = null;
    clearTimeout(this.unoTimer);
    this.unoTimer = null;
  }

  play(odId, cardId, color) {
    if (!this.canAct(odId)) return;
    const hand = this.hands[odId];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const card = hand[idx];

    if (!this.canPlay(card)) {
      return this.fail(odId, this.pendingDraw > 0 ? { k: 'uno.err.stack', p: { type: this.pendingType === 'draw2' ? '+2' : '+4' } } : { k: 'uno.err.cantPlay' });
    }
    if (card.color === 'wild' && !COLORS.includes(color)) return this.fail(odId, { k: 'uno.err.chooseColor' });

    this.settleExposure(odId);
    hand.splice(idx, 1);
    this.discard.push(card);
    this.color = card.color === 'wild' ? color : card.color;
    this.pending = null;
    this.lastPlay = { by: odId, card, seq: ++this.playSeq };

    const name = this.names[odId];
    this.log = [{ k: 'uno.log.played', p: { name, card: cardMsg(card, this.color) } }];

    const next = this.nextPlayer(odId, 1);
    let steps = 1;
    switch (card.value) {
      case 'skip':
        steps = 2;
        this.log.push({ k: 'uno.log.skipped', p: { name: this.names[next] } });
        break;
      case 'reverse':
        this.dir *= -1;
        if (this.order.length === 2) steps = 2;
        break;
      case 'draw2':
      case 'wild4': {
        const n = card.value === 'draw2' ? 2 : 4;
        if (this.stacking) {
          this.pendingDraw += n;
          this.pendingType = card.value;
          this.log.push({ k: 'uno.log.mustStack', p: { name: this.names[next], n: this.pendingDraw } });
        } else {
          this.drawCards(next, n);
          steps = 2;
          this.log.push({ k: 'uno.log.draws', p: { name: this.names[next], n } });
        }
        break;
      }
    }

    if (hand.length === 0) return this.winRound(odId);

    if (hand.length === 1) {
      this.log.push({ k: 'uno.log.oneLeft', p: { name } });
      if (this.unoCall && this.preCalled !== odId) {
        this.exposed = { id: odId, until: this.now() + UNO_WINDOW_MS };
        clearTimeout(this.unoTimer);
        this.unoTimer = setTimeout(() => {
          this.unoTimer = null;
          if (this.exposed?.id === odId) { this.exposed = null; this.broadcastState(); }
        }, UNO_WINDOW_MS);
      }
    }
    this.preCalled = null;

    this.turn = this.nextPlayer(odId, steps);
    this.nextTurn();
  }

  draw(odId) {
    if (!this.canAct(odId) || this.pending !== null) return;
    this.settleExposure(odId);

    if (this.pendingDraw > 0) {
      const n = this.pendingDraw;
      this.drawCards(odId, n);
      this.pendingDraw = 0;
      this.pendingType = null;
      this.log = [{ k: 'uno.log.draws', p: { name: this.names[odId], n } }];
      this.turn = this.nextPlayer(odId, 1);
      return this.nextTurn();
    }

    const [card] = this.drawCards(odId, 1);
    if (!card) return this.pass(odId, true);

    if (this.matches(card)) {
      this.pending = card.id;
      this.log = [{ k: 'uno.log.drew', p: { name: this.names[odId] } }];
      this.startTurnTimer();
      this.broadcastState();
    } else {
      this.log = [{ k: 'uno.log.drewPassed', p: { name: this.names[odId] } }];
      this.turn = this.nextPlayer(odId, 1);
      this.nextTurn();
    }
  }

  pass(odId, force = false) {
    if (!this.canAct(odId) || (this.pending === null && !force)) return;
    this.settleExposure(odId);
    this.pending = null;
    this.log = [{ k: 'uno.log.passed', p: { name: this.names[odId] } }];
    this.turn = this.nextPlayer(odId, 1);
    this.nextTurn();
  }

  /** UNO! Press it on your last-but-one card (before or right after playing it). */
  call(odId) {
    if (!this.unoCall || this.phase !== 'play') return;
    if (this.exposed?.id === odId) {
      this.clearExposure();
      this.log = [{ k: 'uno.log.saysUno', p: { name: this.names[odId] } }];
      this.broadcastState();
    } else if (this.turn === odId && this.hands[odId].length === 2) {
      this.preCalled = odId;
      this.log = [{ k: 'uno.log.saysUno', p: { name: this.names[odId] } }];
      this.broadcastState();
    }
  }

  catchPlayer(odId) {
    const ex = this.exposed;
    if (!ex || ex.id === odId || this.phase !== 'play' || this.now() > ex.until) return;
    this.clearExposure();
    this.drawCards(ex.id, 2);
    this.log = [{ k: 'uno.log.caught', p: { name: this.names[odId], victim: this.names[ex.id] } }];
    this.broadcastState();
  }

  drawCards(odId, n) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        const keep = this.discard.pop();
        this.deck = shuffle(this.discard, this.rng);
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
    this.preCalled = null;
    this.startTurnTimer();
    this.broadcastState();
  }

  startTurnTimer() {
    clearTimeout(this.timer);
    this.deadline = this.now() + this.turnMs;
    const who = this.turn;
    this.timer = setTimeout(() => this.onTimeout(who), this.turnMs);
  }

  onTimeout(who) {
    if (!this.isGameActive || this.phase !== 'play' || this.turn !== who) return;
    if (this.pending !== null) return this.pass(who);
    if (this.pendingDraw > 0) return this.draw(who);
    // out of time: draw one card and move on
    this.settleExposure(who);
    this.drawCards(who, 1);
    this.log = [{ k: 'uno.log.timeout', p: { name: this.names[who] } }];
    this.turn = this.nextPlayer(who, 1);
    this.nextTurn();
  }

  // ----------------------------------------------------------------- scoring

  winRound(winner) {
    clearTimeout(this.timer);
    this.clearExposure();
    this.phase = 'roundOver';

    let points = 0;
    const left = {};
    for (const id of this.order) {
      if (id === winner) continue;
      const hand = this.hands[id].reduce((s, c) => s + cardPoints(c), 0);
      left[id] = hand;
      points += hand;
    }
    this.scores[winner] += points;
    this.roundResult = { winner, points, left };
    this.log = [{ k: 'uno.log.roundWon', p: { name: this.names[winner], points } }];

    const gameOver = this.target === 0 || this.scores[winner] >= this.target;
    if (gameOver) {
      this.phase = 'over';
      this.broadcastState();
      return this.finish(winner, left);
    }

    this.nextRoundAt = this.now() + NEXT_ROUND_MS;
    this.broadcastState();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isGameActive) return;
      this.dealRound();
      this.startTurnTimer();
      this.broadcastState();
    }, NEXT_ROUND_MS);
  }

  finish(winner, left) {
    // Single round: rank by the cards left in hand. Longer games: by total score.
    const ids = [...this.order];
    const score = (id) => (this.target === 0 ? (id === winner ? 1e9 : -left[id]) : this.scores[id]);
    ids.sort((a, b) => score(b) - score(a));
    let rank = 0;
    let prev = null;
    const rows = ids.map((id, i) => {
      const s = score(id);
      if (s !== prev) rank = i + 1;
      prev = s;
      return {
        id,
        name: this.names[id],
        rank,
        score: this.target === 0 ? (id === winner ? this.scores[winner] : 0) : this.scores[id],
        note: id === winner ? { k: 'uno.note.last' } : { k: 'uno.note.left', p: { n: this.hands[id].length, points: left[id] } }
      };
    });
    this.room.finishGame({
      title: { k: 'uno.title.wins', p: { name: this.names[winner] } },
      subtitle: this.target ? { k: 'uno.sub.target', p: { n: this.target } } : { k: 'uno.sub.round' },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  // --------------------------------------------------------------- snapshots

  stateFor(odId) {
    const timeLeft = this.running && this.phase === 'play' ? Math.max(0, this.deadline - this.now()) : 0;
    return {
      type: 'uno-state',
      you: odId,
      hand: this.hands[odId] || [],
      playable: odId ? this.playableIds(odId) : [],
      players: this.order.map(id => ({ id, name: this.names[id], count: this.hands[id].length, score: this.scores[id] })),
      turn: this.turn,
      dir: this.dir,
      top: this.top,
      color: this.color,
      deckCount: this.deck.length,
      pending: this.pending,
      pendingDraw: this.pendingDraw,
      pendingType: this.pendingType,
      phase: this.phase,
      round: this.round,
      target: this.target,
      stacking: this.stacking,
      unoCall: this.unoCall,
      uno: this.exposed ? { id: this.exposed.id, left: Math.max(0, this.exposed.until - this.now()) } : null,
      lastPlay: this.lastPlay,
      roundResult: this.roundResult,
      nextRoundIn: this.phase === 'roundOver' ? Math.max(0, this.nextRoundAt - this.now()) : 0,
      timeLeft,
      turnMs: this.turnMs,
      log: this.log
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: everything public, never a hand. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, hand: [], playable: [], spectator: true });
  }

  broadcastState() {
    for (const id of this.order) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  // ------------------------------------------------------------------ leaving

  onPlayerLeft(odId) {
    if (!this.hands[odId]) return;
    this.deck.unshift(...this.hands[odId]);
    delete this.hands[odId];
    const wasTurn = this.turn === odId;
    const next = wasTurn ? this.nextPlayer(odId, 1) : this.turn;
    this.order.splice(this.order.indexOf(odId), 1);
    if (this.exposed?.id === odId) this.clearExposure();
    this.log = [{ k: 'uno.log.left', p: { name: this.names[odId] } }];

    if (this.phase !== 'play') return this.broadcastState();
    if (this.order.length < 2) {
      if (this.order.length === 1) {
        // the remaining player wins by default
        this.scores[this.order[0]] += 0;
        this.phase = 'over';
        this.broadcastState();
        clearTimeout(this.timer);
        this.room.finishGame({
          title: { k: 'uno.title.wins', p: { name: this.names[this.order[0]] } },
          subtitle: { k: 'uno.sub.allLeft' },
          rows: [{ id: this.order[0], name: this.names[this.order[0]], rank: 1, score: this.scores[this.order[0]] }],
          delayMs: 15000
        });
      }
      return;
    }
    if (wasTurn) {
      this.turn = next;
      this.pendingDraw = 0;
      this.pendingType = null;
      this.nextTurn();
    } else {
      this.broadcastState();
    }
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.unoTimer);
    this.timer = this.unoTimer = null;
  }
}
