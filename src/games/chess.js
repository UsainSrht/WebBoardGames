/**
 * Chess (2 players). The server owns the board, the clocks and every rule.
 * Clients receive a full snapshot ('chess-state') after every change.
 *
 * Options: clock = 'none' | '<minutes>+<increment seconds>' (e.g. '10+0', '15+10').
 */

import {
  initialState, legalMoves, applyMove, inCheck, insufficientMaterial,
  positionKey, squareName, squareIndex, toSan
} from './chess-engine.js';

const RETURN_TO_LOBBY_MS = 30000;
const START_FALLBACK_MS = 8000;

/** How a game ended -> the dictionary key of its description ("By checkmate", "Draw by agreement", ...). */
export const REASON_KEYS = {
  checkmate: 'chess.reason.checkmate',
  resignation: 'chess.reason.resignation',
  timeout: 'chess.reason.timeout',
  agreement: 'chess.reason.agreement',
  timeoutInsufficient: 'chess.reason.timeoutInsufficient',
  stalemate: 'chess.reason.stalemate',
  insufficient: 'chess.reason.insufficient',
  fiftyMove: 'chess.reason.fiftyMove',
  threefold: 'chess.reason.threefold',
  left: 'chess.reason.left'
};

export function parseClock(value) {
  const m = /^(\d+)\+(\d+)$/.exec(String(value));
  if (!m) return null;
  return { base: Number(m[1]) * 60000, inc: Number(m[2]) * 1000 };
}

export class Chess {
  constructor(room, players, options = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.endTimer = null;
    this.flagTimer = null;
    this.startTimer = null;
    this.now = () => Date.now(); // overridable in tests

    const ids = Object.keys(players);
    if (Math.random() < 0.5) ids.reverse();
    this.white = ids[0];
    this.black = ids[1];

    this.state = initialState();
    this.lastMove = null;
    this.result = null; // { winner: odId|null, reason }
    this.drawOffer = null; // 'w' | 'b' | null
    this.seen = new Map([[positionKey(this.state), 1]]);
    this.history = [];   // [{ from, to, san }]
    this.moves = legalMoves(this.state);

    this.clockCfg = parseClock(options.clock ?? '10+0');
    this.remaining = this.clockCfg ? { w: this.clockCfg.base, b: this.clockCfg.base } : null;
    this.running = null; // colour whose clock is ticking
    this.tickAt = 0;
    this.loaded = new Set();

    // The clock starts once both players have the board open (or after a short fallback).
    this.startTimer = setTimeout(() => this.startClock(), START_FALLBACK_MS);
  }

  // ----------------------------------------------------------------- clocks

  startClock() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    if (!this.remaining || this.running || this.result || !this.isGameActive) return;
    this.running = this.state.turn;
    this.tickAt = this.now();
    this.armFlag();
    this.room.broadcast(this.snapshot());
  }

  /** Bring the running clock up to date. */
  settle() {
    if (!this.running) return;
    const t = this.now();
    this.remaining[this.running] = Math.max(0, this.remaining[this.running] - (t - this.tickAt));
    this.tickAt = t;
  }

  armFlag() {
    clearTimeout(this.flagTimer);
    this.flagTimer = null;
    if (!this.running || this.result) return;
    this.flagTimer = setTimeout(() => this.checkFlag(), Math.max(50, this.remaining[this.running] + 30));
  }

  checkFlag() {
    if (!this.running || this.result || !this.isGameActive) return;
    this.settle();
    if (this.remaining[this.running] > 0) return this.armFlag();
    const loser = this.running;
    const winnerColor = loser === 'w' ? 'b' : 'w';
    if (this.cannotMate(winnerColor)) this.finish(null, 'timeoutInsufficient');
    else this.finish(winnerColor === 'w' ? this.white : this.black, 'timeout');
  }

  /** True when \`color\` only has a bare king / lone minor piece (a flag fall is then a draw). */
  cannotMate(color) {
    const own = this.state.b.filter(p => p && (color === 'w' ? p === p.toUpperCase() : p === p.toLowerCase()) && p.toUpperCase() !== 'K');
    if (own.length === 0) return true;
    return own.length === 1 && 'BN'.includes(own[0].toUpperCase());
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || (odId !== this.white && odId !== this.black)) return;
    const color = odId === this.white ? 'w' : 'b';

    switch (type) {
      case 'chess-page-loaded': {
        this.loaded.add(odId);
        const ws = this.room.getWsByUserId(odId);
        if (ws) this.room.send(ws, this.snapshot());
        if (this.loaded.size >= 2) this.startClock();
        return;
      }
      case 'chess-move':
        return this.handleMove(odId, payload);
      case 'chess-resign':
        if (!this.result) this.finish(color === 'w' ? this.black : this.white, 'resignation');
        return;
      case 'chess-offer-draw':
        if (this.result || this.drawOffer) return;
        this.drawOffer = color;
        this.room.broadcast(this.snapshot());
        return;
      case 'chess-accept-draw':
        if (!this.result && this.drawOffer && this.drawOffer !== color) this.finish(null, 'agreement');
        return;
      case 'chess-decline-draw':
        if (!this.result && this.drawOffer && this.drawOffer !== color) {
          this.drawOffer = null;
          this.room.broadcast(this.snapshot());
        }
    }
  }

  handleMove(odId, { from, to, promotion }) {
    if (this.result) return;
    const color = odId === this.white ? 'w' : 'b';
    if (color !== this.state.turn) return;

    const f = squareIndex(from), t = squareIndex(to);
    const promo = typeof promotion === 'string' && 'qrbn'.includes(promotion.toLowerCase()) ? promotion.toLowerCase() : 'q';
    const move = this.moves.find(m => m.from === f && m.to === t && (!m.promo || m.promo === promo));
    if (!move) {
      const ws = this.room.getWsByUserId(odId);
      if (ws) {
        this.room.send(ws, { type: 'error', message: { k: 'chess.err.illegal' } });
        this.room.send(ws, this.snapshot());
      }
      return;
    }

    // Clock: charge the mover and add the increment.
    if (this.running) {
      this.settle();
      if (this.remaining[color] <= 0) return this.checkFlag();
      this.remaining[color] += this.clockCfg.inc;
    } else if (this.remaining && this.history.length >= 2) {
      this.running = color; // should not happen, but never leave the clock stopped mid-game
    }

    const san = toSan(this.state, move, this.moves);
    const mover = this.state.turn;
    this.state = applyMove(this.state, move);
    this.lastMove = { from: squareName(move.from), to: squareName(move.to) };
    this.history.push({ ...this.lastMove, san });
    this.moves = legalMoves(this.state);
    this.drawOffer = null; // any move declines a pending offer

    if (this.running) {
      this.running = this.state.turn;
      this.tickAt = this.now();
    }

    const key = positionKey(this.state);
    const count = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, count);

    if (this.moves.length === 0) {
      if (inCheck(this.state)) this.finish(mover === 'w' ? this.white : this.black, 'checkmate');
      else this.finish(null, 'stalemate');
    } else if (insufficientMaterial(this.state.b)) {
      this.finish(null, 'insufficient');
    } else if (this.state.half >= 100) {
      this.finish(null, 'fiftyMove');
    } else if (count >= 3) {
      this.finish(null, 'threefold');
    } else {
      this.armFlag();
      this.room.broadcast(this.snapshot());
    }
  }

  // --------------------------------------------------------------- snapshot

  snapshot() {
    this.settle();
    return {
      type: 'chess-state',
      board: this.state.b.map(p => p || '.').join(''),
      turn: this.state.turn,
      white: this.white,
      black: this.black,
      names: {
        [this.white]: this.players[this.white].name,
        [this.black]: this.players[this.black].name
      },
      lastMove: this.lastMove,
      check: inCheck(this.state),
      legal: this.result ? [] : this.moves.map(m => ({ from: squareName(m.from), to: squareName(m.to), promo: m.promo || null })),
      moves: this.history.map(h => h.san),
      moveCount: this.history.length,
      drawOffer: this.drawOffer,
      clock: this.remaining
        ? { w: Math.round(this.remaining.w), b: Math.round(this.remaining.b), running: this.running, inc: this.clockCfg.inc, base: this.clockCfg.base }
        : null,
      now: this.now(),
      result: this.result
    };
  }

  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.snapshot());
  }

  finish(winner, reason) {
    if (this.result) return;
    this.settle();
    this.running = null;
    clearTimeout(this.flagTimer);
    clearTimeout(this.startTimer);
    this.result = { winner, reason };
    this.room.broadcast(this.snapshot());

    const name = (id) => this.players[id].name;
    const row = (id, rank, score) => ({ id, name: name(id), score, rank });
    const rows = winner
      ? [row(winner, 1, '1'), row(winner === this.white ? this.black : this.white, 2, '0')]
      : [row(this.white, 1, '1/2'), row(this.black, 1, '1/2')];
    this.room.finishGame({
      title: winner ? { k: 'chess.title.wins', p: { name: name(winner) } } : { k: 'chess.title.draw' },
      subtitle: { k: REASON_KEYS[reason] || 'chess.reason.checkmate' },
      rows,
      delayMs: RETURN_TO_LOBBY_MS
    });
  }

  onPlayerLeft(odId) {
    if (this.result || (odId !== this.white && odId !== this.black)) return;
    this.finish(odId === this.white ? this.black : this.white, 'left');
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.flagTimer);
    clearTimeout(this.startTimer);
    clearTimeout(this.endTimer);
    this.flagTimer = this.startTimer = this.endTimer = null;
  }
}
