/**
 * Rock Paper Scissors game logic (runs inside the GameRoom Durable Object).
 *
 * Every round all players pick a move; each pair of players is then scored
 * (+1 for the winner, -1 for the loser). Players who don't pick get a random move.
 */

const MOVES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export class RockPaperScissors {
  constructor(room, players) {
    this.room = room;
    this.players = players;

    this.countdown = 7;          // seconds to choose a move
    this.waitBeforeNewGame = 7;  // seconds between rounds / before returning to lobby
    this.maxRounds = 3;

    this.round = 1;
    this.isGameActive = true;
    this.started = false;
    this.roundActive = false;
    this.countdownEndUnix = 0;
    this.timer = null;
    this.readyPlayers = new Set();
    this.playerGameData = {};

    for (const [odId, player] of Object.entries(players)) {
      this.playerGameData[odId] = { name: player.name, move: null, score: 0 };
    }
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.playerGameData[odId]) return;

    switch (type) {
      case 'rps-page-loaded':
        return this.handlePageLoaded(odId);
      case 'rps-select-move':
        return this.handleSelectMove(odId, payload.move);
    }
  }

  handlePageLoaded(odId) {
    if (this.readyPlayers.has(odId)) {
      // Page reload mid-game: resync this player only.
      if (!this.started) return;
      const ws = this.room.getWsByUserId(odId);
      if (!ws) return;
      this.room.send(ws, { type: 'update-scoreboard', playerGameData: this.publicData() });
      if (this.roundActive) this.room.send(ws, this.startedMessage());
      return;
    }

    this.readyPlayers.add(odId);
    if (this.readyPlayers.size >= Object.keys(this.players).length) {
      this.startRound();
    }
  }

  handleSelectMove(odId, move) {
    if (!this.roundActive || !MOVES.includes(move)) return;

    this.playerGameData[odId].move = move;

    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'rps-move-selected', move });
  }

  startedMessage() {
    return {
      type: 'rps-game-started',
      countdownEndUnix: this.countdownEndUnix,
      round: this.round,
      maxRounds: this.maxRounds
    };
  }

  /** Late-joining spectator (host view): current scoreboard and round. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (!ws || !this.started) return;
    this.room.send(ws, { type: 'update-scoreboard', playerGameData: this.publicData() });
    if (this.roundActive) this.room.send(ws, this.startedMessage());
  }

  /** Scoreboard payload that doesn't leak moves while a round is still running. */
  publicData() {
    if (!this.roundActive) return this.playerGameData;
    const data = {};
    for (const [id, p] of Object.entries(this.playerGameData)) {
      data[id] = { name: p.name, score: p.score, move: null };
    }
    return data;
  }

  startRound() {
    if (!this.isGameActive) return;

    this.started = true;
    this.roundActive = true;
    this.countdownEndUnix = Date.now() + this.countdown * 1000;

    this.room.broadcast(this.startedMessage());
    this.room.broadcast({ type: 'update-scoreboard', playerGameData: this.publicData() });

    this.schedule(() => this.endRound(), this.countdown * 1000);
  }

  schedule(fn, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  endRound() {
    if (!this.isGameActive) return;
    this.roundActive = false;

    for (const data of Object.values(this.playerGameData)) {
      if (!data.move) data.move = this.getRandomMove();
    }

    this.processMoves();

    // Moves (for the reveal animation) and the updated scores go out together.
    this.room.broadcast({
      type: 'rps-game-ended',
      playerGameData: this.playerGameData,
      round: this.round,
      maxRounds: this.maxRounds,
      final: this.round >= this.maxRounds
    });
    this.room.broadcast({ type: 'update-scoreboard', playerGameData: this.playerGameData });

    for (const data of Object.values(this.playerGameData)) data.move = null;

    this.round++;
    if (this.round > this.maxRounds) {
      this.schedule(() => this.room.endGame(), this.waitBeforeNewGame * 1000);
    } else {
      this.schedule(() => this.startRound(), this.waitBeforeNewGame * 1000);
    }
  }

  processMoves() {
    const ids = Object.keys(this.playerGameData);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.playerGameData[ids[i]];
        const b = this.playerGameData[ids[j]];
        const winner = this.getWinner(a.move, b.move);
        if (winner === 1) { a.score++; b.score--; }
        else if (winner === 2) { b.score++; a.score--; }
      }
    }
  }

  /** @returns {1|2|'draw'} */
  getWinner(move1, move2) {
    if (move1 === move2) return 'draw';
    return BEATS[move1] === move2 ? 1 : 2;
  }

  getRandomMove() {
    return MOVES[Math.floor(Math.random() * MOVES.length)];
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
