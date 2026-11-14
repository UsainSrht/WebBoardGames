/**
 * Dice (Farkle): six dice, push your luck.
 *
 * On your turn you roll six dice, set aside at least one scoring die or combination and then either
 * bank the turn score or roll the rest. A roll without any scoring die is a Farkle (the turn score is
 * lost). Setting aside all six dice is "hot dice": you get six fresh dice and keep going.
 *
 * The server is authoritative: the client sends the dice indices it wants to set aside together with the
 * action ('dice-roll' / 'dice-bank' with { keep: [indices] }) and the server validates every selected die.
 */

export const TURN_MS = 45000;
export const FARKLE_PAUSE_MS = 2600;
export const BANK_PAUSE_MS = 1700;
const START_FALLBACK_MS = 7000;
const START_DELAY_MS = 700;
const FARKLE_PENALTY = 1000;
const MAX_STRIKES = 3;

/* ------------------------------------------------------------------ scoring */

const tripleBase = (face) => (face === 1 ? 1000 : face * 100);

/**
 * Score a selection of dice values where every die has to contribute.
 * Returns { valid, score }. An empty selection is invalid.
 */
export function scoreSelection(values) {
  const n = values.length;
  if (!n || n > 6) return { valid: false, score: 0 };
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) {
    if (!Number.isInteger(v) || v < 1 || v > 6) return { valid: false, score: 0 };
    counts[v]++;
  }

  let best = -1;

  // Face by face: singles of 1 and 5, three or more of a kind.
  let faceScore = 0;
  let ok = true;
  for (let f = 1; f <= 6; f++) {
    const c = counts[f];
    if (!c) continue;
    if (c >= 3) faceScore += tripleBase(f) * 2 ** (c - 3);
    else if (f === 1) faceScore += 100 * c;
    else if (f === 5) faceScore += 50 * c;
    else { ok = false; break; }
  }
  if (ok) best = faceScore;

  if (n === 6) {
    const present = counts.slice(1).filter(Boolean).sort((a, b) => b - a);
    const key = present.join('');
    if (key === '111111') best = Math.max(best, 1500);        // straight
    if (key === '222') best = Math.max(best, 1500);           // three pairs
    if (key === '42') best = Math.max(best, 1500);            // four of a kind plus a pair
    if (key === '33') best = Math.max(best, 2500);            // two triplets
  }

  return best < 0 ? { valid: false, score: 0 } : { valid: true, score: best };
}

/** True if at least one die of the roll can be set aside. */
export function hasScoring(values) {
  return bestScoring(values).score > 0;
}

/**
 * The highest scoring valid subset of a roll. Returns { indices, score } (indices ascending).
 * Ties go to the smaller set so that more dice stay in play.
 */
export function bestScoring(values) {
  const n = values.length;
  let best = { indices: [], score: 0 };
  for (let mask = 1; mask < (1 << n); mask++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const { valid, score } = scoreSelection(idx.map(i => values[i]));
    if (!valid) continue;
    if (score > best.score || (score === best.score && idx.length < best.indices.length)) {
      best = { indices: idx, score };
    }
  }
  return best;
}

/* --------------------------------------------------------------------- game */

export class Dice {
  constructor(room, players, options = {}, rng = Math.random) {
    this.room = room;
    this.rng = rng;
    this.isGameActive = true;
    this.target = Number(options.target) || 4000;
    this.opening = Number(options.opening) || 0;

    const ids = Object.keys(players);
    // Random seating order.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.order = ids;
    this.data = {};
    for (const id of ids) {
      this.data[id] = { name: players[id].name, banked: 0, strikes: 0, opened: false, left: false, finalTurn: false };
    }

    this.phase = 'waiting';      // waiting | roll | pick | busy | over
    this.turnIdx = -1;
    this.turn = null;            // odId whose turn it is
    this.turnNo = 0;
    this.dice = [];              // [{ v, held }]
    this.turnScore = 0;
    this.deadline = 0;
    this.event = null;           // last notable thing: { kind, by, points, seq }
    this.eventSeq = 0;
    this.rollSeq = 0;
    this.rolled = [];            // indices rolled most recently
    this.finalTrigger = null;    // player who reached the target
    this.loaded = new Set();
    this.fastStart = false;
    this.timer = null;
    this.startTimer = setTimeout(() => this.start(), START_FALLBACK_MS);
  }

  /* ------------------------------------------------------------- lifecycle */

  start() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (!this.isGameActive || this.phase !== 'waiting') return;
    this.nextTurn();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
  }

  handleMessage(odId, type, payload = {}) {
    if (!this.isGameActive || !this.data[odId]) return;

    switch (type) {
      case 'dice-page-loaded': {
        this.loaded.add(odId);
        this.sendState(odId);
        if (this.phase === 'waiting' && !this.fastStart && this.loaded.size >= this.activeIds().length) {
          this.fastStart = true;
          clearTimeout(this.startTimer);
          this.startTimer = setTimeout(() => this.start(), START_DELAY_MS);
        }
        return;
      }
      case 'dice-roll': return this.onRoll(odId, payload.keep);
      case 'dice-bank': return this.onBank(odId, payload.keep);
    }
  }

  onPlayerLeft(odId) {
    const d = this.data[odId];
    if (!d || d.left) return;
    d.left = true;
    if (!this.isGameActive) return;

    const alive = this.activeIds();
    if (alive.length <= 1) {
      clearTimeout(this.timer);
      this.finish('Last player standing');
      return;
    }
    if (this.turn === odId && this.phase !== 'busy' && this.phase !== 'over') {
      clearTimeout(this.timer);
      this.dice = [];
      this.turnScore = 0;
      this.setEvent('left', odId, 0);
      this.advance();
    } else {
      this.broadcastState();
    }
  }

  spectatorSync(odId) {
    this.sendState(odId);
  }

  /* --------------------------------------------------------------- helpers */

  activeIds() {
    return this.order.filter(id => !this.data[id].left);
  }

  nextActiveAfter(idx) {
    for (let step = 1; step <= this.order.length; step++) {
      const i = (idx + step) % this.order.length;
      if (!this.data[this.order[i]].left) return this.order[i];
    }
    return null;
  }

  roll() {
    return 1 + Math.floor(this.rng() * 6);
  }

  setEvent(kind, by, points = 0, extra = {}) {
    this.event = { kind, by, points, seq: ++this.eventSeq, ...extra };
  }

  snapshot() {
    return {
      type: 'dice-state',
      phase: this.phase,
      turn: this.turn,
      turnNo: this.turnNo,
      dice: this.dice.map(d => ({ v: d.v, held: d.held })),
      turnScore: this.turnScore,
      deadline: this.deadline,
      now: Date.now(),
      event: this.event,
      rollSeq: this.rollSeq,
      rolled: this.rolled,
      target: this.target,
      opening: this.opening,
      finalRound: !!this.finalTrigger,
      finalTrigger: this.finalTrigger,
      players: this.order.map(id => ({
        id,
        name: this.data[id].name,
        banked: this.data[id].banked,
        strikes: this.data[id].strikes,
        opened: this.data[id].opened || this.opening === 0,
        left: this.data[id].left,
        finalDone: this.data[id].finalTurn
      }))
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.snapshot());
  }

  broadcastState() {
    const msg = this.snapshot();
    this.room.broadcast(msg);
  }

  err(odId, message) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'dice-error', message });
  }

  /** Validate a client selection against the unheld dice. Returns { indices, score } or null. */
  checkKeep(keep) {
    if (!Array.isArray(keep) || keep.length === 0 || keep.length > 6) return null;
    const seen = new Set();
    for (const i of keep) {
      if (!Number.isInteger(i) || i < 0 || i >= this.dice.length || seen.has(i) || this.dice[i].held) return null;
      seen.add(i);
    }
    const indices = [...seen].sort((a, b) => a - b);
    const res = scoreSelection(indices.map(i => this.dice[i].v));
    if (!res.valid) return null;
    return { indices, score: res.score };
  }

  /* ----------------------------------------------------------------- turns */

  nextTurn() {
    clearTimeout(this.timer);
    const prevIdx = this.turnIdx;
    const next = prevIdx < 0 ? this.activeIds()[0] : this.nextActiveAfter(prevIdx);
    if (!next) return this.finish('Game over');

    // The last round ends when play reaches somebody who has already had their final turn.
    if (this.finalTrigger && this.data[next].finalTurn) return this.finish();

    this.turnIdx = this.order.indexOf(next);
    this.turn = next;
    this.turnNo++;
    this.phase = 'roll';
    this.dice = [];
    this.turnScore = 0;
    this.rolled = [];
    this.armTimer();
    this.broadcastState();
  }

  /** Move on after a turn ended (farkle, bank or leave). */
  advance() {
    clearTimeout(this.timer);
    if (this.activeIds().length <= 1) return this.finish('Last player standing');
    this.nextTurn();
  }

  armTimer() {
    clearTimeout(this.timer);
    this.deadline = Date.now() + TURN_MS;
    this.timer = setTimeout(() => this.onTimeout(), TURN_MS);
  }

  pause(ms) {
    clearTimeout(this.timer);
    this.deadline = 0;
    this.phase = 'busy';
    this.timer = setTimeout(() => this.advance(), ms);
  }

  onTimeout() {
    if (!this.isGameActive || (this.phase !== 'roll' && this.phase !== 'pick')) return;
    const id = this.turn;
    if (this.phase === 'pick') {
      const free = this.dice.map((d, i) => ({ d, i })).filter(x => !x.d.held);
      const best = bestScoring(free.map(x => x.d.v));
      if (best.score > 0) {
        const keep = best.indices.map(k => free[k].i);
        if (this.bank(id, keep)) return;
      }
    }
    this.doFarkle(id, true);
  }

  onRoll(odId, keep) {
    if (odId !== this.turn) return this.err(odId, 'It is not your turn');
    if (this.phase === 'roll') {
      // First roll of a turn: nothing to set aside.
      this.dice = Array.from({ length: 6 }, () => ({ v: this.roll(), held: false }));
      this.afterRoll(this.dice.map((_, i) => i), false);
      return;
    }
    if (this.phase !== 'pick') return;

    const chosen = this.checkKeep(keep);
    if (!chosen) return this.err(odId, 'Set aside only scoring dice');

    this.turnScore += chosen.score;
    for (const i of chosen.indices) this.dice[i].held = true;
    let hot = false;
    if (this.dice.every(d => d.held)) {
      hot = true;
      for (const d of this.dice) d.held = false;
    }
    const rolled = [];
    this.dice.forEach((d, i) => {
      if (!d.held) { d.v = this.roll(); rolled.push(i); }
    });
    this.afterRoll(rolled, hot);
  }

  afterRoll(rolled, hot) {
    this.rolled = rolled;
    this.rollSeq++;
    const free = this.dice.filter(d => !d.held).map(d => d.v);
    if (!hasScoring(free)) {
      return this.doFarkle(this.turn, false);
    }
    this.phase = 'pick';
    if (hot) this.setEvent('hot-dice', this.turn, this.turnScore);
    this.armTimer();
    this.broadcastState();
  }

  doFarkle(odId, timeout) {
    const d = this.data[odId];
    const lost = this.turnScore;
    d.strikes++;
    let penalty = 0;
    if (d.strikes >= MAX_STRIKES) {
      penalty = Math.min(FARKLE_PENALTY, d.banked);
      d.banked -= penalty;
      d.strikes = 0;
      this.setEvent('triple-farkle', odId, lost, { penalty, timeout });
    } else {
      this.setEvent('farkle', odId, lost, { timeout });
    }
    this.turnScore = 0;
    if (this.finalTrigger) d.finalTurn = true;
    this.pause(FARKLE_PAUSE_MS);
    this.broadcastState();
  }

  onBank(odId, keep) {
    if (odId !== this.turn) return this.err(odId, 'It is not your turn');
    if (this.phase !== 'pick') return;
    this.bank(odId, keep, true);
  }

  /** Bank the turn. Returns true on success. `report` sends an error to the player on failure. */
  bank(odId, keep, report = false) {
    const chosen = this.checkKeep(keep);
    if (!chosen) {
      if (report) this.err(odId, 'Set aside only scoring dice');
      return false;
    }
    const d = this.data[odId];
    const total = this.turnScore + chosen.score;
    if (!d.opened && this.opening > 0 && total < this.opening) {
      if (report) this.err(odId, `You need ${this.opening} in one turn to get on the board`);
      return false;
    }
    for (const i of chosen.indices) this.dice[i].held = true;
    this.turnScore = total;
    d.banked += total;
    d.opened = true;
    d.strikes = 0;
    if (this.finalTrigger) d.finalTurn = true;
    this.setEvent('bank', odId, total);

    if (!this.finalTrigger && d.banked >= this.target) {
      this.finalTrigger = odId;
      d.finalTurn = true;
      this.event.reached = true;
    }
    this.pause(BANK_PAUSE_MS);
    this.broadcastState();
    return true;
  }

  /* ---------------------------------------------------------------- ending */

  finish(subtitleOverride) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.phase = 'over';
    this.turn = null;
    this.deadline = 0;
    this.broadcastState();

    const stay = this.order.filter(id => !this.data[id].left).sort((a, b) => this.data[b].banked - this.data[a].banked);
    const gone = this.order.filter(id => this.data[id].left).sort((a, b) => this.data[b].banked - this.data[a].banked);
    const rows = [];
    let rank = 0;
    let prev = null;
    stay.forEach((id, i) => {
      if (this.data[id].banked !== prev) { rank = i + 1; prev = this.data[id].banked; }
      rows.push({ id, name: this.data[id].name, score: this.data[id].banked, rank, note: '' });
    });
    gone.forEach(id => {
      rows.push({ id, name: this.data[id].name, score: this.data[id].banked, rank: rows.length + 1, note: 'Left the game' });
    });

    const winners = rows.filter(r => r.rank === 1 && !r.note);
    const title = winners.length > 1
      ? `Tie: ${winners.map(w => w.name).join(' and ')}`
      : `${winners[0]?.name || 'Nobody'} wins`;
    const subtitle = subtitleOverride
      || (winners[0] ? `${winners[0].score.toLocaleString('en-US')} points, target ${this.target.toLocaleString('en-US')}` : 'Farkle');
    this.room.finishGame({ title, subtitle, rows, delayMs: 20000 });
  }
}
