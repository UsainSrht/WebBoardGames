/**
 * Hamsterball game logic for Cloudflare Workers
 */

export class Hamsterball {
  constructor(room, players) {
    this.room = room;
    this.players = players;
    
    this.playerGameData = {};
    this.readyPlayers = new Set();
    this.gameLoop = null;
    this.isGameActive = true;
    
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
    
    console.log('Hamsterball initialized');
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive) return;
    
    switch (type) {
      case 'hamsterball-ready':
        this.handleReady(odId);
        break;
      case 'hamsterball-move':
        this.handleMove(odId, payload);
        break;
    }
  }

  handleReady(odId) {
    if (!this.readyPlayers.has(odId)) {
      this.readyPlayers.add(odId);
      console.log(`Hamsterball player ready: ${this.readyPlayers.size}/${Object.keys(this.players).length}`);
      
      if (this.readyPlayers.size >= Object.keys(this.players).length) {
        console.log('All players ready, starting hamsterball');
        this.startGame();
      }
    }
  }

  handleMove(odId, { vx, vy }) {
    if (!this.playerGameData[odId]) return;
    
    this.playerGameData[odId].vx = Number(vx) || 0;
    this.playerGameData[odId].vy = Number(vy) || 0;
  }

  startGame() {
    // Send init to each player with their ID
    for (const odId in this.playerGameData) {
      const ws = this.room.getWsByUserId(odId);
      if (ws) {
        this.room.send(ws, {
          type: 'init',
          id: odId,
          players: this.playerGameData
        });
      }
    }
    
    // Start physics loop at 30 FPS
    if (!this.gameLoop) {
      this.gameLoop = setInterval(() => {
        if (!this.isGameActive) {
          this.cleanup();
          return;
        }
        this.updateGame();
        this.room.broadcast({
          type: 'state',
          players: this.playerGameData,
          plateTilt: this.calculatePlateTilt()
        });
      }, 1000 / 30);
    }
  }

  updateGame() {
    const plateTilt = this.calculatePlateTilt();
    const gravityForce = 0.5;
    
    // Apply movement
    for (const id in this.playerGameData) {
      const p = this.playerGameData[id];
      
      // Add plate tilt as a force
      p.vx += Math.sin(plateTilt.z) * gravityForce;
      p.vy += Math.sin(plateTilt.x) * gravityForce;
      
      // Apply friction
      p.vx *= 0.98;
      p.vy *= 0.98;
      
      // Apply movement
      p.x += p.vx * 5;
      p.y += p.vy * 5;
    }
    
    // Handle collisions
    this.handleCollisions();
    
    // Boundary checks and respawn
    for (const id in this.playerGameData) {
      const p = this.playerGameData[id];
      
      const distanceFromCenter = Math.sqrt(p.x * p.x + p.y * p.y);
      if (distanceFromCenter > 200) {
        p.hearts -= 1;
        
        // Respawn in center
        p.x = Math.random() * 40 - 20;
        p.y = Math.random() * 40 - 20;
        p.vx = 0;
        p.vy = 0;
        
        if (p.hearts <= 0) {
          const ws = this.room.getWsByUserId(id);
          if (ws) {
            this.room.send(ws, { type: 'gameOver' });
          }
        }
      }
    }
  }

  handleCollisions() {
    const playerIds = Object.keys(this.playerGameData);
    
    for (let i = 0; i < playerIds.length; i++) {
      for (let j = i + 1; j < playerIds.length; j++) {
        const p1 = this.playerGameData[playerIds[i]];
        const p2 = this.playerGameData[playerIds[j]];
        
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = p1.radius + p2.radius;
        
        if (distance < minDistance && distance > 0) {
          const nx = dx / distance;
          const ny = dy / distance;
          
          const overlap = minDistance - distance;
          const separationX = nx * overlap * 0.5;
          const separationY = ny * overlap * 0.5;
          
          p1.x -= separationX;
          p1.y -= separationY;
          p2.x += separationX;
          p2.y += separationY;
          
          const dvx = p2.vx - p1.vx;
          const dvy = p2.vy - p1.vy;
          const dvn = dvx * nx + dvy * ny;
          
          if (dvn > 0) continue;
          
          const impulse = dvn * 0.8;
          const impulseX = impulse * nx;
          const impulseY = impulse * ny;
          
          p1.vx += impulseX;
          p1.vy += impulseY;
          p2.vx -= impulseX;
          p2.vy -= impulseY;
        }
      }
    }
  }

  calculatePlateTilt() {
    if (Object.keys(this.playerGameData).length === 0) {
      return { x: 0, z: 0 };
    }
    
    let totalX = 0, totalY = 0, totalMass = 0;
    
    for (const playerId in this.playerGameData) {
      const player = this.playerGameData[playerId];
      const mass = 1;
      
      totalX += player.x * mass;
      totalY += player.y * mass;
      totalMass += mass;
    }
    
    if (totalMass > 0) {
      const centerX = totalX / totalMass;
      const centerY = totalY / totalMass;
      
      const maxTilt = 0.15;
      const plateRadius = 200;
      
      const tiltFactorX = Math.max(-1, Math.min(1, centerY / plateRadius));
      const tiltFactorZ = Math.max(-1, Math.min(1, -centerX / plateRadius));
      
      return {
        x: tiltFactorX * maxTilt,
        z: tiltFactorZ * maxTilt
      };
    }
    
    return { x: 0, z: 0 };
  }

  cleanup() {
    this.isGameActive = false;
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    console.log('Hamsterball cleaned up');
  }
}
