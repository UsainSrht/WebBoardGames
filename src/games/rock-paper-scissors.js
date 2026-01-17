/**
 * Rock Paper Scissors game logic for Cloudflare Workers
 */

export class RockPaperScissors {
  constructor(room, players) {
    this.room = room; // Reference to GameRoom Durable Object
    this.players = players; // Map of player data
    
    this.countdown = 7;
    this.waitBeforeNewGame = 7;
    this.maxRounds = 3;
    
    this.round = 1;
    this.isGameActive = true;
    this.readyPlayers = new Set();
    this.playerGameData = {};
    
    // Initialize player game data
    for (const [odId, player] of Object.entries(players)) {
      this.playerGameData[odId] = {
        name: player.name,
        move: null,
        score: 0
      };
    }
    
    console.log('RockPaperScissors initialized');
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive) return;
    
    switch (type) {
      case 'rps-page-loaded':
        this.handlePageLoaded(odId);
        break;
      case 'rps-select-move':
        this.handleSelectMove(odId, payload.move);
        break;
    }
  }

  handlePageLoaded(odId) {
    if (!this.readyPlayers.has(odId)) {
      this.readyPlayers.add(odId);
      console.log(`Player ready: ${this.readyPlayers.size}/${Object.keys(this.players).length}`);
      
      if (this.readyPlayers.size >= Object.keys(this.players).length) {
        console.log('All players ready, starting game');
        this.startGame();
      }
    }
  }

  handleSelectMove(odId, move) {
    if (!this.playerGameData[odId]) return;
    
    console.log(`Player ${odId} selected: ${move}`);
    this.playerGameData[odId].move = move;
    
    // Notify the player their move was received
    const ws = this.room.getWsByUserId(odId);
    if (ws) {
      this.room.send(ws, { type: 'rps-move-selected', move });
    }
  }

  startGame() {
    if (!this.isGameActive) return;
    
    const countdownEndUnix = Date.now() + (this.countdown * 1000);
    
    this.room.broadcast({
      type: 'rps-game-started',
      countdownEndUnix
    });
    
    this.room.broadcast({
      type: 'update-scoreboard',
      playerGameData: this.playerGameData
    });
    
    // Schedule countdown end
    // Note: In Cloudflare Workers, we use alarms instead of setTimeout for long delays
    // For short delays, we can use the Durable Object's alarm API
    this.scheduleCountdownEnd();
  }

  scheduleCountdownEnd() {
    // In a real implementation, you'd use Durable Object alarms
    // For now, we'll rely on the client to signal when countdown ends
    // or use a worker alarm
    setTimeout(() => {
      this.countdownEnd();
    }, this.countdown * 1000);
  }

  countdownEnd() {
    if (!this.isGameActive) return;
    
    console.log('Countdown ended, processing moves');
    
    // Assign random moves to players who didn't select
    for (const odId in this.playerGameData) {
      if (!this.playerGameData[odId].move) {
        this.playerGameData[odId].move = this.getRandomMove();
      }
    }
    
    this.room.broadcast({
      type: 'rps-game-ended',
      playerGameData: this.playerGameData
    });
    
    this.processMoves();
    
    this.room.broadcast({
      type: 'update-scoreboard',
      playerGameData: this.playerGameData
    });
    
    this.round++;
    
    // Reset moves for next round
    for (const odId in this.playerGameData) {
      this.playerGameData[odId].move = null;
    }
    
    if (this.round > this.maxRounds) {
      console.log('Game ended');
      setTimeout(() => {
        this.cleanup();
        this.room.endGame();
      }, this.waitBeforeNewGame * 1000);
      return;
    }
    
    // Start next round
    setTimeout(() => {
      this.startGame();
    }, this.waitBeforeNewGame * 1000);
  }

  processMoves() {
    const keys = Object.keys(this.playerGameData);
    
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const odId1 = keys[i];
        const odId2 = keys[j];
        
        const move1 = this.playerGameData[odId1].move;
        const move2 = this.playerGameData[odId2].move;
        const winner = this.getWinner(move1, move2);
        
        if (winner === 1) {
          this.playerGameData[odId1].score++;
          this.playerGameData[odId2].score--;
        } else if (winner === 2) {
          this.playerGameData[odId2].score++;
          this.playerGameData[odId1].score--;
        }
      }
    }
  }

  getWinner(move1, move2) {
    if (move1 === move2) return 'draw';
    if (
      (move1 === 'rock' && move2 === 'scissors') ||
      (move1 === 'scissors' && move2 === 'paper') ||
      (move1 === 'paper' && move2 === 'rock')
    ) {
      return 1;
    }
    return 2;
  }

  getRandomMove() {
    const moves = ['rock', 'paper', 'scissors'];
    return moves[Math.floor(Math.random() * moves.length)];
  }

  cleanup() {
    this.isGameActive = false;
    console.log('RockPaperScissors cleaned up');
  }
}
