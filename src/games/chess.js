/**
 * Chess (2 players). The server owns the board and validates every move.
 * Clients receive the full state after each change ('chess-state').
 */

import {
  initialState, legalMoves, applyMove, inCheck, insufficientMaterial,
  positionKey, squareName, squareIndex
} from './chess-engine.js';

const RETURN_TO_LOBBY_MS = 20000;

export class Chess {
  constructor(room, players) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.endTimer = null;

    const ids = Object.keys(players);
    if (Math.random() < 0.5) ids.reverse();
    this.white = ids[0];
    this.black = ids[1];

    this.state = initialState();
    this.lastMove = null;
    this.result = null; // { winner: odId|null, reason }
    this.seen = new Map([[positionKey(this.state), 1]]);
    this.history = [];
    this.moves = legalMoves(this.state);
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || (odId !== this.white && odId !== this.black)) return;

    switch (type) {
      case 'chess-page-loaded': {
        const ws = this.room.getWsByUserId(odId);
        if (ws) this.room.send(ws, this.snapshot());
        return;
      }
      case 'chess-move':
        return this.handleMove(odId, payload);
      case 'chess-resign':
        if (!this.result) this.finish(odId === this.white ? this.black : this.white, 'resignation');
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
        this.room.send(ws, { type: 'error', message: 'Illegal move' });
        this.room.send(ws, this.snapshot());
      }
      return;
    }

    const mover = this.state.turn;
    this.state = applyMove(this.state, move);
    this.lastMove = { from: squareName(move.from), to: squareName(move.to) };
    this.history.push(this.lastMove);
    this.moves = legalMoves(this.state);

    const key = positionKey(this.state);
    const count = (this.seen.get(key) || 0) + 1;
    this.seen.set(key, count);

    if (this.moves.length === 0) {
      if (inCheck(this.state)) this.finish(mover === 'w' ? this.white : this.black, 'checkmate');
      else this.finish(null, 'stalemate');
    } else if (insufficientMaterial(this.state.b)) {
      this.finish(null, 'insufficient material');
    } else if (this.state.half >= 100) {
      this.finish(null, 'fifty-move rule');
    } else if (count >= 3) {
      this.finish(null, 'threefold repetition');
    } else {
      this.room.broadcast(this.snapshot());
    }
  }

  snapshot() {
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
      moveCount: this.history.length,
      result: this.result
    };
  }

  finish(winner, reason) {
    this.result = { winner, reason };
    this.room.broadcast(this.snapshot());
    this.endTimer = setTimeout(() => this.room.endGame(), RETURN_TO_LOBBY_MS);
  }

  onPlayerLeft(odId) {
    if (this.result || (odId !== this.white && odId !== this.black)) return;
    this.finish(odId === this.white ? this.black : this.white, 'opponent left');
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.endTimer);
    this.endTimer = null;
  }
}
