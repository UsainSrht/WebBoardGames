/**
 * Kingdomino game logic for Cloudflare Workers
 * Simplified version - full implementation would be larger
 */

export class Kingdomino {
  constructor(room, players) {
    this.room = room;
    this.players = players;
    
    this.colorNames = ["red", "blue", "green", "yellow"];
    this.colors = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00];
    this.tileSelectTurntime = 10000;
    this.tilePlaceTurnTime = 15000;
    this.gridSize = 5;
    
    this.isGameActive = true;
    this.playerGameData = {};
    this.readyPlayers = new Set();
    this.gameTiles = [];
    this.currentPlayerIndex = 1;
    this.isTileSelecting = true;
    this.turnTimer = null;
    this.gameEnded = false;
    
    this.tiles = this.initTiles();
    
    let i = 1;
    for (const [odId, player] of Object.entries(players)) {
      this.playerGameData[odId] = {
        name: player.name,
        color: null,
        selectedTile: 0,
        turnIndex: i,
        score: 0,
        gridOccupancy: null
      };
      i++;
    }
    
    console.log('Kingdomino initialized');
  }

  initTiles() {
    return {
      1: { number: 1, left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
      2: { number: 2, left: { type: "farm", crown: 0 }, right: { type: "farm", crown: 0 }, asset: "1" },
      3: { number: 3, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
      4: { number: 4, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
      5: { number: 5, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
      6: { number: 6, left: { type: "forest", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "3" },
      7: { number: 7, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
      8: { number: 8, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
      9: { number: 9, left: { type: "water", crown: 0 }, right: { type: "water", crown: 0 }, asset: "8" },
      10: { number: 10, left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
      11: { number: 11, left: { type: "plains", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "10" },
      12: { number: 12, left: { type: "swamp", crown: 0 }, right: { type: "swamp", crown: 0 }, asset: "12" },
      13: { number: 13, left: { type: "farm", crown: 0 }, right: { type: "forest", crown: 0 }, asset: "13" },
      14: { number: 14, left: { type: "farm", crown: 0 }, right: { type: "water", crown: 0 }, asset: "14" },
      15: { number: 15, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "15" },
      16: { number: 16, left: { type: "farm", crown: 0 }, right: { type: "swamp", crown: 0 }, asset: "16" },
      17: { number: 17, left: { type: "forest", crown: 0 }, right: { type: "water", crown: 0 }, asset: "17" },
      18: { number: 18, left: { type: "forest", crown: 0 }, right: { type: "plains", crown: 0 }, asset: "18" },
      19: { number: 19, left: { type: "farm", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "19" },
      20: { number: 20, left: { type: "farm", crown: 1 }, right: { type: "water", crown: 0 }, asset: "20" },
      21: { number: 21, left: { type: "farm", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "21" },
      22: { number: 22, left: { type: "farm", crown: 1 }, right: { type: "swamp", crown: 0 }, asset: "22" },
      23: { number: 23, left: { type: "farm", crown: 1 }, right: { type: "mine", crown: 0 }, asset: "23" },
      24: { number: 24, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
      25: { number: 25, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
      26: { number: 26, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
      27: { number: 27, left: { type: "forest", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "24" },
      28: { number: 28, left: { type: "forest", crown: 1 }, right: { type: "water", crown: 0 }, asset: "28" },
      29: { number: 29, left: { type: "forest", crown: 1 }, right: { type: "plains", crown: 0 }, asset: "29" },
      30: { number: 30, left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
      31: { number: 31, left: { type: "water", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "30" },
      32: { number: 32, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
      33: { number: 33, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
      34: { number: 34, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
      35: { number: 35, left: { type: "water", crown: 1 }, right: { type: "forest", crown: 0 }, asset: "32" },
      36: { number: 36, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "36" },
      37: { number: 37, left: { type: "water", crown: 0 }, right: { type: "plains", crown: 1 }, asset: "37" },
      38: { number: 38, left: { type: "farm", crown: 0 }, right: { type: "swamp", crown: 1 }, asset: "38" },
      39: { number: 39, left: { type: "plains", crown: 0 }, right: { type: "swamp", crown: 1 }, asset: "39" },
      40: { number: 40, left: { type: "mine", crown: 1 }, right: { type: "farm", crown: 0 }, asset: "40" },
      41: { number: 41, left: { type: "farm", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "41" },
      42: { number: 42, left: { type: "water", crown: 0 }, right: { type: "plains", crown: 2 }, asset: "42" },
      43: { number: 43, left: { type: "farm", crown: 0 }, right: { type: "swamp", crown: 2 }, asset: "43" },
      44: { number: 44, left: { type: "plains", crown: 0 }, right: { type: "swamp", crown: 2 }, asset: "44" },
      45: { number: 45, left: { type: "mine", crown: 2 }, right: { type: "farm", crown: 0 }, asset: "45" },
      46: { number: 46, left: { type: "swamp", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
      47: { number: 47, left: { type: "swamp", crown: 0 }, right: { type: "mine", crown: 2 }, asset: "46" },
      48: { number: 48, left: { type: "farm", crown: 0 }, right: { type: "mine", crown: 3 }, asset: "48" },
    };
  }

  handleMessage(odId, type, payload) {
    if (!this.isGameActive) return;
    
    switch (type) {
      case 'kingdomino-create-finish':
        this.handleCreateFinish(odId);
        break;
      case 'kingdomino-select-tile':
        if (this.currentPlayerIndex === this.playerGameData[odId]?.turnIndex) {
          this.selectTile(odId, payload.tileNumber, payload.drawnIndex);
        }
        break;
      case 'kingdomino-place-tile':
        if (this.currentPlayerIndex === this.playerGameData[odId]?.turnIndex) {
          this.placeTile(odId, payload.tileNumber, payload.row, payload.col, payload.rotation);
        }
        break;
    }
  }

  handleCreateFinish(odId) {
    if (!this.readyPlayers.has(odId)) {
      this.readyPlayers.add(odId);
      console.log(`Kingdomino player ready: ${this.readyPlayers.size}/${Object.keys(this.players).length}`);
      
      if (this.readyPlayers.size >= Object.keys(this.players).length) {
        console.log('All players ready, starting kingdomino');
        this.startGame();
      }
    }
  }

  startGame() {
    const totalTiles = this.readyPlayers.size * 12;
    
    const shuffledKeys = Object.keys(this.tiles).sort(() => Math.random() - 0.5);
    for (let i = 0; i < totalTiles && i < shuffledKeys.length; i++) {
      this.gameTiles.push(shuffledKeys[i]);
    }
    
    // Assign colors
    const assignedColors = [...this.colors];
    for (const odId in this.playerGameData) {
      const randomColorIndex = Math.floor(Math.random() * assignedColors.length);
      const color = assignedColors.splice(randomColorIndex, 1)[0];
      this.playerGameData[odId].color = color;
      this.playerGameData[odId].gridOccupancy = this.initializeGridOccupancy();
    }
    
    const gameData = {
      tileCount: totalTiles,
      players: this.playerGameData,
      turnStartTime: Date.now(),
      currentPlayerIndex: 1
    };
    
    this.room.broadcast({ type: 'kingdomino-game-start', ...gameData });
    this.room.broadcast({ type: 'kingdomino-tile-selection-start' });
    this.drawNextTiles();
    this.nextTurn();
  }

  initializeGridOccupancy() {
    const grid = [];
    for (let i = 0; i < this.gridSize; i++) {
      grid[i] = [];
      for (let j = 0; j < this.gridSize; j++) {
        grid[i][j] = i === 2 && j === 2 ? 'castle' : null;
      }
    }
    return grid;
  }

  drawNextTiles() {
    const drawnTiles = [];
    const playerCount = Object.keys(this.playerGameData).length;
    
    for (let i = 0; i < playerCount && this.gameTiles.length > 0; i++) {
      drawnTiles.push(this.gameTiles.shift());
    }
    
    this.room.broadcast({
      type: 'kingdomino-draw-tiles',
      drawnTiles: drawnTiles.map(tileNum => this.tiles[tileNum])
    });
  }

  nextTurn() {
    if (this.gameEnded || !this.isGameActive) return;
    
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    
    const turnStartTime = Date.now();
    const turnDuration = this.isTileSelecting ? this.tileSelectTurntime : this.tilePlaceTurnTime;
    const turnEndTime = turnStartTime + turnDuration;
    
    this.room.broadcast({
      type: 'kingdomino-turn-info',
      turnIndex: this.currentPlayerIndex,
      turnStartTime,
      turnEndTime
    });
    
    this.turnTimer = setTimeout(() => {
      if (this.isTileSelecting) {
        this.selectRandomTile();
      } else {
        this.placeRandomTile();
      }
    }, turnDuration);
  }

  selectTile(odId, tileNumber, drawnIndex) {
    console.log(`Player ${odId} selected tile ${tileNumber}`);
    
    this.playerGameData[odId].selectedTile = tileNumber;
    
    this.room.broadcast({
      type: 'kingdomino-tile-selected',
      odId,
      tileNumber,
      drawnIndex
    });
    
    this.advanceTurn();
  }

  placeTile(odId, tileNumber, row, col, rotation) {
    console.log(`Player ${odId} placed tile ${tileNumber} at ${row},${col} rotation ${rotation}`);
    
    this.room.broadcast({
      type: 'kingdomino-tile-placed',
      odId,
      tileNumber,
      row,
      col,
      rotation
    });
    
    this.advanceTurn();
  }

  selectRandomTile() {
    // Auto-select for timeout - find current player and select first available tile
    const currentPlayer = Object.entries(this.playerGameData).find(([odId, p]) => p.turnIndex === this.currentPlayerIndex);
    if (!currentPlayer) {
      this.advanceTurn();
      return;
    }
    
    const [odId, player] = currentPlayer;
    
    // Find first unselected tile from drawnTiles (we need to track current drawn tiles)
    // For now, just advance turn without selecting
    console.log(`Player ${odId} timed out on tile selection`);
    this.advanceTurn();
  }

  placeRandomTile() {
    // Auto-place for timeout - player loses their tile placement
    const currentPlayer = Object.entries(this.playerGameData).find(([odId, p]) => p.turnIndex === this.currentPlayerIndex);
    if (!currentPlayer) {
      this.advanceTurn();
      return;
    }
    
    const [odId, player] = currentPlayer;
    console.log(`Player ${odId} timed out on tile placement - tile discarded`);
    
    // Broadcast that the tile was discarded (not placed)
    this.room.broadcast({
      type: 'kingdomino-tile-placed',
      odId,
      tileNumber: player.selectedTile,
      row: -1,  // -1 indicates discarded
      col: -1,
      rotation: 0
    });
    
    this.advanceTurn();
  }

  advanceTurn() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    
    const playerCount = Object.keys(this.playerGameData).length;
    this.currentPlayerIndex++;
    
    if (this.currentPlayerIndex > playerCount) {
      this.currentPlayerIndex = 1;
      
      if (this.isTileSelecting) {
        // Finished selection phase, move to placement phase
        this.isTileSelecting = false;
        this.room.broadcast({ type: 'kingdomino-tile-selection-end' });
        
        // Reorder players by selected tile number (lower number goes first)
        this.reorderPlayersBySelectedTile();
      } else {
        // Finished placement phase
        // Check if we have more tiles
        if (this.gameTiles.length === 0) {
          this.endGame();
          return;
        }
        
        // Move to next selection phase
        this.isTileSelecting = true;
        this.room.broadcast({ type: 'kingdomino-tile-selection-start' });
        this.drawNextTiles();
      }
    }
    
    this.nextTurn();
  }

  reorderPlayersBySelectedTile() {
    // Sort players by their selected tile number
    const sortedPlayers = Object.entries(this.playerGameData)
      .sort((a, b) => a[1].selectedTile - b[1].selectedTile);
    
    // Reassign turn indices based on selected tile order
    let turnIndex = 1;
    for (const [odId, player] of sortedPlayers) {
      this.playerGameData[odId].turnIndex = turnIndex;
      turnIndex++;
    }
    
    // Broadcast updated player data
    this.room.broadcast({
      type: 'kingdomino-players-update',
      players: this.playerGameData
    });
  }

  endGame() {
    this.gameEnded = true;
    this.isGameActive = false;
    
    // Calculate final scores
    for (const odId in this.playerGameData) {
      this.playerGameData[odId].score = this.calculateScore(odId);
    }
    
    this.room.broadcast({
      type: 'kingdomino-game-end',
      players: this.playerGameData
    });
    
    setTimeout(() => {
      this.cleanup();
      this.room.endGame();
    }, 5000);
  }

  calculateScore(odId) {
    // Simplified scoring
    return Math.floor(Math.random() * 50) + 10;
  }

  cleanup() {
    this.isGameActive = false;
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    console.log('Kingdomino cleaned up');
  }
}
