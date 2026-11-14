/**
 * Rock Paper Scissors for 2-12 players.
 *
 * Every round everybody picks in secret (8 seconds), then comes a "Rock, Paper, Scissors, SHOOT" beat and
 * all moves are revealed at once.
 *
 *  - points:      for each pair of players the winner of the pair gets +1. After the chosen number of rounds
 *                 the highest score wins; players tied for first play sudden-death rounds among themselves.
 *  - elimination: all surviving players throw. If exactly two different moves appear the players with the
 *                 losing move are out; one move or all three moves is a draw and the round is replayed.
 *                 The last player standing wins (with two players one decisive round ends the match).
 *
 * The server only ever sends a player their own pending pick; everybody else sees who has locked in.
 */

export const MOVES = ['rock', 'paper', 'scissors'];
export const CHOOSE_MS = 8000;
export const SHOOT_MS = 2600;
export const REVEAL_MS = 5200;
const START_FALLBACK_MS = 7000;
const START_DELAY_MS = 800;
const LOCKED_GRACE_MS = 500;
const HISTORY_LIMIT = 14;

const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** 1 if a beats b, -1 if b beats a, 0 for a draw. */
export function compare(a, b) {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

/**
 * Resolve one round. `throws` is { id: move }.
 * Returns { results: { id: { result: 'win'|'lose'|'draw', beat, lostTo } }, kinds: [distinct moves] }.
 * `beat` is how many opponents the player beat and `lostTo` how many beat them.
 */
export function resolveThrows(throws) {
  const ids = Object.keys(throws);
  const results = {};
  for (const id of ids) {
    let beat = 0;
    let lostTo = 0;
    for (const other of ids) {
      if (other === id) continue;
      const c = compare(throws[id], throws[other]);
      if (c > 0) beat++;
      else if (c < 0) lostTo++;
    }
    results[id] = { beat, lostTo, result: beat > 0 && lostTo === 0 ? 'win' : lostTo > 0 && beat === 0 ? 'lose' : 'draw' };
  }
  const kinds = [...new Set(Object.values(throws))];
  return { results, kinds };
}

export class RockPaperScissors {
  constructor(room, players, options = {}, rng = Math.random) {
    this.room = room;
    this.rng = rng;
    this.isGameActive = true;
    this.mode = options.mode === 'elimination' ? 'elimination' : 'points';
    this.rounds = [3, 5, 7].includes(Number(options.rounds)) ? Number(options.rounds) : 5;

    this.order = Object.keys(players);
    this.data = {};
    for (const id of this.order) {
      this.data[id] = {
        name: players[id].name, score: 0, alive: true, left: false, afk: 0,
        out: 0,             // elimination: round in which the player was knocked out
        wins: 0
      };
    }

    this.phase = 'waiting';     // waiting | choosing | shoot | reveal | over
    this.round = 0;             // rounds started (sudden-death rounds count on)
    this.sudden = false;
    this.suddenIds = null;      // sudden death: the tied leaders still playing
    this.contenders = [];       // ids throwing this round
    this.picks = {};            // id -> move (private until the reveal)
    this.afkNow = new Set();
    this.deadline = 0;
    this.reveal = null;
    this.history = [];
    this.loaded = new Set();
    this.fastStart = false;
    this.timer = null;
    this.startTimer = setTimeout(() => this.startRound(), START_FALLBACK_MS);
  }

  /* ------------------------------------------------------------- lifecycle */

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
  }

  handleMessage(odId, type, payload = {}) {
    if (!this.isGameActive || !this.data[odId]) return;

    if (type === 'rps-page-loaded') {
      this.loaded.add(odId);
      this.sendState(odId);
      if (this.phase === 'waiting' && !this.fastStart && this.loaded.size >= this.liveIds().length) {
        this.fastStart = true;
        clearTimeout(this.startTimer);
        this.startTimer = setTimeout(() => this.startRound(), START_DELAY_MS);
      }
      return;
    }

    if (type === 'rps-move') {
      if (this.phase !== 'choosing' || !this.contenders.includes(odId)) return;
      const move = payload.move;
      if (!MOVES.includes(move)) return;
      this.picks[odId] = move;
      this.afkNow.delete(odId);
      this.broadcastState();
      if (this.contenders.every(id => this.picks[id])) {
        // Everyone is in: shorten the wait.
        clearTimeout(this.timer);
        this.deadline = Date.now() + LOCKED_GRACE_MS;
        this.timer = setTimeout(() => this.beginShoot(), LOCKED_GRACE_MS);
      }
    }
  }

  onPlayerLeft(odId) {
    const d = this.data[odId];
    if (!d || d.left) return;
    d.left = true;
    if (this.mode === 'elimination' && d.alive) { d.alive = false; d.out = d.out || this.round || 1; }
    if (!this.isGameActive || this.phase === 'over') return;

    if (this.liveIds().length <= 1) {
      clearTimeout(this.timer);
      clearTimeout(this.startTimer);
      return this.finish('Last player standing');
    }
    if (this.phase === 'choosing') {
      this.contenders = this.contenders.filter(id => id !== odId);
      delete this.picks[odId];
      if (this.contenders.length && this.contenders.every(id => this.picks[id])) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.beginShoot(), LOCKED_GRACE_MS);
      }
    }
    this.broadcastState();
  }

  spectatorSync(odId) {
    this.sendState(odId);
  }

  /* --------------------------------------------------------------- helpers */

  liveIds() {
    return this.order.filter(id => !this.data[id].left);
  }

  pickRandom() {
    return MOVES[Math.floor(this.rng() * 3)];
  }

  snapshot(forId = null) {
    const phase = this.phase;
    return {
      type: 'rps-state',
      phase,
      mode: this.mode,
      round: this.round,
      rounds: this.rounds,
      sudden: this.sudden,
      deadline: this.deadline,
      now: Date.now(),
      contenders: this.contenders,
      players: this.order.map(id => ({
        id,
        name: this.data[id].name,
        score: this.data[id].score,
        alive: this.data[id].alive,
        left: this.data[id].left,
        afk: this.afkNow.has(id) || (phase === 'reveal' && !!this.reveal?.throws[id]?.afk),
        locked: phase === 'choosing' ? !!this.picks[id] : (phase === 'shoot' || phase === 'reveal') && this.contenders.includes(id)
      })),
      mine: forId && phase === 'choosing' ? (this.picks[forId] || null) : null,
      reveal: phase === 'reveal' || phase === 'over' ? this.reveal : null,
      history: this.history.slice(-HISTORY_LIMIT)
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.snapshot(odId));
  }

  /** Per-recipient send: only the owner of a pending pick gets to see it. */
  broadcastState() {
    for (const id of this.order) if (!this.data[id].left) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.sendState(id);
  }

  /* ----------------------------------------------------------------- rounds */

  startRound() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (!this.isGameActive || (this.phase !== 'waiting' && this.phase !== 'reveal')) return;

    this.round++;
    this.reveal = null;
    this.picks = {};
    this.afkNow = new Set();
    this.contenders = this.order.filter(id => !this.data[id].left && this.data[id].alive && this.inPlay(id));
    this.phase = 'choosing';
    this.deadline = Date.now() + CHOOSE_MS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.beginShoot(), CHOOSE_MS);
    this.broadcastState();
  }

  /** Points mode: during sudden death only the tied leaders play. */
  inPlay(id) {
    return !this.suddenIds || this.suddenIds.includes(id);
  }

  beginShoot() {
    if (!this.isGameActive || this.phase !== 'choosing') return;
    for (const id of this.contenders) {
      if (!this.picks[id]) {
        this.picks[id] = this.pickRandom();
        this.afkNow.add(id);
        this.data[id].afk++;
      }
    }
    this.phase = 'shoot';
    this.deadline = Date.now() + SHOOT_MS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.doReveal(), SHOOT_MS);
    this.broadcastState();
  }

  doReveal() {
    if (!this.isGameActive || this.phase !== 'shoot') return;
    const throws = {};
    for (const id of this.contenders) throws[id] = this.picks[id];
    const { results, kinds } = resolveThrows(throws);

    const rev = { round: this.round, sudden: this.sudden, throws: {}, outcome: 'draw', eliminated: [] };
    for (const id of this.contenders) {
      rev.throws[id] = { move: throws[id], result: results[id].result, delta: 0, afk: this.afkNow.has(id) };
      if (!this.afkNow.has(id)) this.data[id].afk = 0;
    }

    if (this.mode === 'points') {
      for (const id of this.contenders) {
        this.data[id].score += results[id].beat;
        rev.throws[id].delta = results[id].beat;
      }
      rev.outcome = kinds.length === 2 ? 'decisive' : kinds.length === 3 ? 'mixed' : 'draw';
    } else {
      if (kinds.length === 2) {
        rev.outcome = 'decisive';
        for (const id of this.contenders) {
          if (results[id].result === 'lose') {
            this.data[id].alive = false;
            this.data[id].out = this.round;
            rev.eliminated.push(id);
          }
        }
      } else {
        rev.outcome = 'draw';
        for (const id of this.contenders) rev.throws[id].result = 'draw';
      }
    }

    this.reveal = rev;
    this.history.push({
      round: this.round,
      sudden: this.sudden,
      outcome: rev.outcome,
      throws: Object.fromEntries(Object.entries(rev.throws).map(([id, t]) => [id, { move: t.move, result: t.result }]))
    });
    this.phase = 'reveal';
    this.deadline = Date.now() + REVEAL_MS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.afterReveal(), REVEAL_MS);
    this.broadcastState();
  }

  afterReveal() {
    if (!this.isGameActive || this.phase !== 'reveal') return;

    if (this.mode === 'elimination') {
      const alive = this.order.filter(id => this.data[id].alive && !this.data[id].left);
      if (alive.length <= 1) return this.finish();
      return this.startRound();
    }

    // Points: play the scheduled rounds, then sudden death among the tied leaders.
    const live = this.liveIds();
    const regularDone = !this.sudden && this.round >= this.rounds;
    if (this.sudden || regularDone) {
      const pool = this.sudden ? this.suddenIds.filter(id => !this.data[id].left) : live;
      const top = Math.max(...pool.map(id => this.data[id].score));
      const leaders = pool.filter(id => this.data[id].score === top);
      if (leaders.length === 1) return this.finish();
      this.sudden = true;
      this.suddenIds = leaders;
    }
    this.startRound();
  }

  /* ----------------------------------------------------------------- ending */

  finish(subtitleOverride) {
    if (this.phase === 'over') return;
    clearTimeout(this.timer);
    clearTimeout(this.startTimer);
    this.phase = 'over';
    this.deadline = 0;
    this.broadcastState();

    const live = this.liveIds();
    const gone = this.order.filter(id => this.data[id].left);
    let rows;
    if (this.mode === 'elimination') {
      const survivors = live.filter(id => this.data[id].alive);
      const out = live.filter(id => !this.data[id].alive);
      // Later elimination = better; same round shares the rank.
      const sortedOut = out.sort((a, b) => this.data[b].out - this.data[a].out);
      rows = [];
      survivors.forEach(id => rows.push({ id, name: this.data[id].name, score: this.data[id].out || this.round, rank: 1, note: 'Last one standing' }));
      let rank = survivors.length;
      let prev = null;
      sortedOut.forEach((id, i) => {
        if (this.data[id].out !== prev) { rank = survivors.length + i + 1; prev = this.data[id].out; }
        rows.push({ id, name: this.data[id].name, score: this.data[id].out, rank, note: `Out in round ${this.data[id].out}` });
      });
    } else {
      const sorted = live.sort((a, b) => this.data[b].score - this.data[a].score);
      rows = [];
      let rank = 0;
      let prev = null;
      sorted.forEach((id, i) => {
        if (this.data[id].score !== prev) { rank = i + 1; prev = this.data[id].score; }
        rows.push({ id, name: this.data[id].name, score: this.data[id].score, rank, note: '' });
      });
    }
    for (const id of gone) {
      rows.push({ id, name: this.data[id].name, score: this.data[id].score, rank: rows.length + 1, note: 'Left the game' });
    }

    const winners = rows.filter(r => r.rank === 1 && r.note !== 'Left the game');
    const title = winners.length === 1 ? `${winners[0].name} wins` : winners.length > 1 ? `${winners.map(w => w.name).join(' and ')} tie` : 'Game over';
    const subtitle = subtitleOverride || (this.mode === 'elimination'
      ? `Survived ${this.round} round${this.round === 1 ? '' : 's'}`
      : `${winners[0]?.score ?? 0} points after ${this.round} rounds`);
    this.room.finishGame({ title, subtitle, rows, delayMs: 20000 });
  }
}
