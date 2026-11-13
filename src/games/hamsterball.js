/**
 * Hamsterball game logic (runs inside the GameRoom Durable Object).
 *
 * Players push balls around a tilting plate. Falling off costs a heart;
 * players with no hearts left are eliminated. The last player standing wins
 * (a solo game ends when the player is eliminated).
 */

const TICK_MS = 1000 / 30;
const PLATE_RADIUS = 200;
const MAX_INPUT = 2; // client sends [-1, 1], doubled while boosting
const RETURN_TO_LOBBY_MS = 6000;

export class Hamsterball {
  constructor(room, players) {
    this.room = room;
    this.players = players;

    this.playerGameData = {};
    this.readyPlayers = new Set();
    this.gameLoop = null;
    this.endTimer = null;
    this.isGameActive = true;
    this.started = false;
    this.finished = false;
    this.initialCount = Object.keys(players).length;

    let i = 1;
    for (const [odId, player] of Object.entries(players)) {
      this.playerGameData[odId] = {
        name: player.name,
        x: Math.random() * 100 - 50,
        y: Math.random() * 100 - 50,
        vx: 0,
        vy: 0,
        hearts: 3,
        turnIndex: i,
        radius: 15
      };
      i++;
    }
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.players[odId]) return;

    switch (type) {
      case 'hamsterball-ready':
        return this.handleReady(odId);
      case 'hamsterball-move':
        return this.handleMove(odId, payload);
    }
  }

  handleReady(odId) {
    if (this.readyPlayers.has(odId)) {
      // Page reload mid-game: resend the current state to that player.
      if (!this.started) return;
      const ws = this.room.getWsByUserId(odId);
      if (!ws) return;
      this.room.send(ws, { type: 'init', id: odId, players: this.playerGameData });
      if (!this.playerGameData[odId]) this.room.send(ws, { type: 'gameOver' });
      return;
    }

    this.readyPlayers.add(odId);
    if (this.readyPlayers.size >= Object.keys(this.players).length) {
      this.startGame();
    }
  }

  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'init', id: null, spectator: true, players: this.playerGameData });
  }

  handleMove(odId, { vx, vy }) {
    const p = this.playerGameData[odId];
    if (!p) return; // eliminated

    const clamp = (v) => Math.max(-MAX_INPUT, Math.min(MAX_INPUT, Number(v) || 0));
    p.vx = clamp(vx);
    p.vy = clamp(vy);
  }

  startGame() {
    if (this.started) return;
    this.started = true;

    for (const odId in this.playerGameData) {
      const ws = this.room.getWsByUserId(odId);
      if (ws) {
        this.room.send(ws, { type: 'init', id: odId, players: this.playerGameData });
      }
    }

    this.gameLoop = setInterval(() => {
      if (!this.isGameActive) return this.cleanup();
      this.updateGame();
      this.room.broadcast({
        type: 'state',
        players: this.playerGameData,
        plateTilt: this.calculatePlateTilt()
      });
    }, TICK_MS);
  }

  updateGame() {
    const plateTilt = this.calculatePlateTilt();
    const gravityForce = 0.5;

    for (const id in this.playerGameData) {
      const p = this.playerGameData[id];

      p.vx += Math.sin(plateTilt.z) * gravityForce;
      p.vy += Math.sin(plateTilt.x) * gravityForce;

      p.vx *= 0.98;
      p.vy *= 0.98;

      p.x += p.vx * 5;
      p.y += p.vy * 5;
    }

    this.handleCollisions();

    for (const id of Object.keys(this.playerGameData)) {
      const p = this.playerGameData[id];
      if (Math.hypot(p.x, p.y) <= PLATE_RADIUS) continue;

      p.hearts -= 1;
      if (p.hearts > 0) {
        // Respawn near the centre.
        p.x = Math.random() * 40 - 20;
        p.y = Math.random() * 40 - 20;
        p.vx = 0;
        p.vy = 0;
      } else {
        this.eliminate(id);
      }
    }

    this.checkGameEnd();
  }

  eliminate(odId) {
    delete this.playerGameData[odId];

    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'gameOver' });
    this.room.broadcast({ type: 'removePlayer', odId });
  }

  checkGameEnd() {
    if (this.finished) return;

    const alive = Object.keys(this.playerGameData).length;
    const over = this.initialCount > 1 ? alive <= 1 : alive === 0;
    if (!over) return;

    this.finished = true;
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.endTimer = setTimeout(() => this.room.endGame(), RETURN_TO_LOBBY_MS);
  }

  /** A player left the room: take their ball off the plate. */
  onPlayerLeft(odId) {
    if (!this.playerGameData[odId]) return;
    delete this.playerGameData[odId];
    this.room.broadcast({ type: 'removePlayer', odId });
    this.checkGameEnd();
  }

  handleCollisions() {
    const ids = Object.keys(this.playerGameData);

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p1 = this.playerGameData[ids[i]];
        const p2 = this.playerGameData[ids[j]];

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distance = Math.hypot(dx, dy);
        const minDistance = p1.radius + p2.radius;

        if (distance >= minDistance || distance === 0) continue;

        const nx = dx / distance;
        const ny = dy / distance;

        const overlap = minDistance - distance;
        p1.x -= nx * overlap * 0.5;
        p1.y -= ny * overlap * 0.5;
        p2.x += nx * overlap * 0.5;
        p2.y += ny * overlap * 0.5;

        const dvn = (p2.vx - p1.vx) * nx + (p2.vy - p1.vy) * ny;
        if (dvn > 0) continue; // already separating

        const impulse = dvn * 0.8;
        p1.vx += impulse * nx;
        p1.vy += impulse * ny;
        p2.vx -= impulse * nx;
        p2.vy -= impulse * ny;
      }
    }
  }

  calculatePlateTilt() {
    const players = Object.values(this.playerGameData);
    if (players.length === 0) return { x: 0, z: 0 };

    const centerX = players.reduce((sum, p) => sum + p.x, 0) / players.length;
    const centerY = players.reduce((sum, p) => sum + p.y, 0) / players.length;

    const maxTilt = 0.15;
    const clamp = (v) => Math.max(-1, Math.min(1, v));

    return {
      x: clamp(centerY / PLATE_RADIUS) * maxTilt,
      z: clamp(-centerX / PLATE_RADIUS) * maxTilt
    };
  }

  cleanup() {
    this.isGameActive = false;
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    clearTimeout(this.endTimer);
    this.endTimer = null;
  }
}
