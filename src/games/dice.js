/**
 * Dice: every round each player rolls two dice (server-side). The highest total
 * scores a point (ties share it). Most points after the last round wins.
 */

const ROLL_MS = 15000;
const REVEAL_MS = 4000;
const START_FALLBACK_MS = 8000;
const RETURN_TO_LOBBY_MS = 10000;

const die = () => 1 + Math.floor(Math.random() * 6);

export class Dice {
  constructor(room, players) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;

    this.maxRounds = 5;
    this.round = 0;
    this.phase = 'waiting'; // waiting | rolling | reveal | over
    this.deadline = 0;
    this.timer = null;
    this.loaded = new Set();
    this.roundWinners = [];
    this.data = {};
    for (const [odId, p] of Object.entries(players)) {
      this.data[odId] = { name: p.name, score: 0, dice: null, total: null };
    }

    this.timer = setTimeout(() => this.startRound(), START_FALLBACK_MS);
  }

  handleMessage(odId, type) {
    if (!this.isGameActive || !this.data[odId]) return;

    if (type === 'dice-page-loaded') {
      this.loaded.add(odId);
      const ws = this.room.getWsByUserId(odId);
      if (ws) this.room.send(ws, this.snapshot());
      if (this.phase === 'waiting' && this.loaded.size >= Object.keys(this.data).length) {
        this.startRound();
      }
    } else if (type === 'dice-roll') {
      this.roll(odId);
    }
  }

  roll(odId) {
    const p = this.data[odId];
    if (this.phase !== 'rolling' || p.dice) return;

    p.dice = [die(), die()];
    p.total = p.dice[0] + p.dice[1];

    const rolled = Object.values(this.data).every(d => d.dice);
    if (rolled) this.resolveRound();
    else this.room.broadcast(this.snapshot());
  }

  startRound() {
    if (!this.isGameActive || this.phase === 'rolling') return;
    this.round++;
    this.phase = 'rolling';
    this.roundWinners = [];
    for (const d of Object.values(this.data)) { d.dice = null; d.total = null; }
    this.deadline = Date.now() + ROLL_MS;
    this.room.broadcast(this.snapshot());
    this.schedule(() => this.resolveRound(), ROLL_MS);
  }

  resolveRound() {
    if (this.phase !== 'rolling') return;

    for (const d of Object.values(this.data)) {
      if (!d.dice) { d.dice = [die(), die()]; d.total = d.dice[0] + d.dice[1]; } // auto-roll
    }
    const best = Math.max(...Object.values(this.data).map(d => d.total));
    this.roundWinners = Object.keys(this.data).filter(id => this.data[id].total === best);
    for (const id of this.roundWinners) this.data[id].score++;

    const last = this.round >= this.maxRounds;
    this.phase = last ? 'over' : 'reveal';
    this.deadline = Date.now() + (last ? RETURN_TO_LOBBY_MS : REVEAL_MS);
    this.room.broadcast(this.snapshot());

    this.schedule(() => (last ? this.room.endGame() : this.startRound()), last ? RETURN_TO_LOBBY_MS : REVEAL_MS);
  }

  schedule(fn, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
  }

  snapshot() {
    return {
      type: 'dice-state',
      round: this.round,
      maxRounds: this.maxRounds,
      phase: this.phase,
      deadline: this.deadline,
      roundWinners: this.roundWinners,
      players: this.data
    };
  }

  onPlayerLeft(odId) {
    if (!this.data[odId]) return;
    delete this.data[odId];
    if (Object.keys(this.data).length === 0) return;
    if (this.phase === 'rolling' && Object.values(this.data).every(d => d.dice)) this.resolveRound();
    else this.room.broadcast(this.snapshot());
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
