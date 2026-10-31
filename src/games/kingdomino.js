/**
 * Kingdomino game logic (runs inside the GameRoom Durable Object).
 *
 * Simplified two-phase variant used by the client:
 *   1. Selection phase – in turn order each player claims one of the drawn tiles.
 *   2. Placement phase – in order of the claimed tile numbers (lowest first) each
 *      player places their tile on their 5x5 grid (castle in the centre).
 * Final score = sum over every connected same-terrain property of (size x crowns).
 */

const GRID_SIZE = 5;
const CASTLE = 'castle';
const TILE_SELECT_MS = 10000;
const TILE_PLACE_MS = 15000;
const LEFT_PLAYER_TURN_MS = 400;
const RETURN_TO_LOBBY_MS = 8000;

const COLORS = [0xff0000, 0x0000ff, 0x00ff00, 0xffff00];

// number, [leftType, leftCrowns], [rightType, rightCrowns], image asset
const TILE_TABLE = [
  [1, ['farm', 0], ['farm', 0], '1'], [2, ['farm', 0], ['farm', 0], '1'],
  [3, ['forest', 0], ['forest', 0], '3'], [4, ['forest', 0], ['forest', 0], '3'],
  [5, ['forest', 0], ['forest', 0], '3'], [6, ['forest', 0], ['forest', 0], '3'],
  [7, ['water', 0], ['water', 0], '8'], [8, ['water', 0], ['water', 0], '8'], [9, ['water', 0], ['water', 0], '8'],
  [10, ['plains', 0], ['plains', 0], '10'], [11, ['plains', 0], ['plains', 0], '10'],
  [12, ['swamp', 0], ['swamp', 0], '12'],
  [13, ['farm', 0], ['forest', 0], '13'], [14, ['farm', 0], ['water', 0], '14'],
  [15, ['farm', 0], ['plains', 0], '15'], [16, ['farm', 0], ['swamp', 0], '16'],
  [17, ['forest', 0], ['water', 0], '17'], [18, ['forest', 0], ['plains', 0], '18'],
  [19, ['farm', 1], ['forest', 0], '19'], [20, ['farm', 1], ['water', 0], '20'],
  [21, ['farm', 1], ['plains', 0], '21'], [22, ['farm', 1], ['swamp', 0], '22'],
  [23, ['farm', 1], ['mine', 0], '23'],
  [24, ['forest', 1], ['farm', 0], '24'], [25, ['forest', 1], ['farm', 0], '24'],
  [26, ['forest', 1], ['farm', 0], '24'], [27, ['forest', 1], ['farm', 0], '24'],
  [28, ['forest', 1], ['water', 0], '28'], [29, ['forest', 1], ['plains', 0], '29'],
  [30, ['water', 1], ['farm', 0], '30'], [31, ['water', 1], ['farm', 0], '30'],
  [32, ['water', 1], ['forest', 0], '32'], [33, ['water', 1], ['forest', 0], '32'],
  [34, ['water', 1], ['forest', 0], '32'], [35, ['water', 1], ['forest', 0], '32'],
  [36, ['farm', 0], ['plains', 1], '36'], [37, ['water', 0], ['plains', 1], '37'],
  [38, ['farm', 0], ['swamp', 1], '38'], [39, ['plains', 0], ['swamp', 1], '39'],
  [40, ['mine', 1], ['farm', 0], '40'],
  [41, ['farm', 0], ['plains', 2], '41'], [42, ['water', 0], ['plains', 2], '42'],
  [43, ['farm', 0], ['swamp', 2], '43'], [44, ['plains', 0], ['swamp', 2], '44'],
  [45, ['mine', 2], ['farm', 0], '45'],
  [46, ['swamp', 0], ['mine', 2], '46'], [47, ['swamp', 0], ['mine', 2], '46'],
  [48, ['farm', 0], ['mine', 3], '48']
];

function buildTiles() {
  const tiles = {};
  for (const [number, [lt, lc], [rt, rc], asset] of TILE_TABLE) {
    tiles[number] = {
      number,
      left: { type: lt, crown: lc },
      right: { type: rt, crown: rc },
      asset
    };
  }
  return tiles;
}

/** Offset of the second half of a tile relative to its anchor cell, per rotation. */
const ROTATION_OFFSETS = {
  0: [0, 1],
  90: [1, 0],
  180: [0, -1],
  270: [-1, 0]
};

export class Kingdomino {
  constructor(room, players) {
    this.room = room;
    this.players = players;

    this.isGameActive = true;
    this.gameEnded = false;
    this.started = false;
    this.readyPlayers = new Set();
    this.gameTiles = [];       // draw pile (tile numbers)
    this.drawn = [];           // tiles on offer this round (sorted by number)
    this.taken = new Map();    // tile number -> odId that claimed it
    this.placed = new Set();   // odIds that already placed this round
    this.leftPlayers = new Set();
    this.currentPlayerIndex = 1;
    this.isTileSelecting = true;
    this.turnTimer = null;
    this.endTimer = null;

    this.tiles = buildTiles();
    this.playerGameData = {};
    this.grids = {};           // odId -> 5x5 grid of CASTLE | {type, crown} | null

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
  }

  // ----------------------------------------------------------------- Messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.playerGameData[odId]) return;

    switch (type) {
      case 'kingdomino-create-finish':
        return this.handleCreateFinish(odId);
      case 'kingdomino-select-tile':
        if (this.started && this.isTileSelecting && this.isTurnOf(odId)) {
          this.selectTile(odId, Number(payload.tileNumber));
        }
        return;
      case 'kingdomino-place-tile':
        if (this.started && !this.isTileSelecting && this.isTurnOf(odId)) {
          this.placeTile(odId, Number(payload.tileNumber), payload.row, payload.col, payload.rotation);
        }
        return;
    }
  }

  isTurnOf(odId) {
    return this.playerGameData[odId].turnIndex === this.currentPlayerIndex;
  }

  playerOnTurn() {
    for (const [odId, p] of Object.entries(this.playerGameData)) {
      if (p.turnIndex === this.currentPlayerIndex) return odId;
    }
    return null;
  }

  handleCreateFinish(odId) {
    if (this.readyPlayers.has(odId)) return;
    this.readyPlayers.add(odId);
    if (this.readyPlayers.size >= Object.keys(this.players).length) {
      this.startGame();
    }
  }

  // --------------------------------------------------------------------- Setup

  startGame() {
    if (this.started) return;
    this.started = true;

    const playerCount = Object.keys(this.playerGameData).length;
    const totalTiles = playerCount * 12;

    const keys = Object.keys(this.tiles).map(Number);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    this.gameTiles = keys.slice(0, totalTiles);

    const colors = [...COLORS];
    for (const odId in this.playerGameData) {
      const color = colors.splice(Math.floor(Math.random() * colors.length), 1)[0];
      this.playerGameData[odId].color = color;
      this.grids[odId] = this.createGrid();
      this.playerGameData[odId].gridOccupancy = this.occupancyOf(this.grids[odId]);
    }

    this.room.broadcast({
      type: 'kingdomino-game-start',
      tileCount: totalTiles,
      players: this.playerGameData,
      turnStartTime: Date.now(),
      currentPlayerIndex: 1
    });
    this.room.broadcast({ type: 'kingdomino-tile-selection-start' });
    this.drawNextTiles();
    this.nextTurn();
  }

  createGrid() {
    return Array.from({ length: GRID_SIZE }, (_, r) =>
      Array.from({ length: GRID_SIZE }, (_, c) => (r === 2 && c === 2 ? CASTLE : null)));
  }

  occupancyOf(grid) {
    return grid.map(row => row.map(cell => (cell === null ? null : cell === CASTLE ? CASTLE : cell.tile)));
  }

  drawNextTiles() {
    const count = Object.keys(this.playerGameData).length;
    this.drawn = this.gameTiles.splice(0, count).sort((a, b) => a - b);
    this.taken.clear();
    this.placed.clear();
    for (const p of Object.values(this.playerGameData)) p.selectedTile = 0;

    this.room.broadcast({
      type: 'kingdomino-draw-tiles',
      drawnTiles: this.drawn.map(n => this.tiles[n])
    });
  }

  // --------------------------------------------------------------------- Turns

  nextTurn() {
    if (this.gameEnded || !this.isGameActive) return;
    clearTimeout(this.turnTimer);

    const odId = this.playerOnTurn();
    const left = odId && this.leftPlayers.has(odId);
    const duration = left
      ? LEFT_PLAYER_TURN_MS
      : this.isTileSelecting ? TILE_SELECT_MS : TILE_PLACE_MS;
    const turnStartTime = Date.now();

    this.room.broadcast({
      type: 'kingdomino-turn-info',
      turnIndex: this.currentPlayerIndex,
      turnStartTime,
      turnEndTime: turnStartTime + duration
    });

    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.isTileSelecting) this.selectRandomTile();
      else this.placeRandomTile();
    }, duration);
  }

  advanceTurn() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;

    const playerCount = Object.keys(this.playerGameData).length;
    this.currentPlayerIndex++;

    if (this.currentPlayerIndex > playerCount) {
      this.currentPlayerIndex = 1;

      if (this.isTileSelecting) {
        this.isTileSelecting = false;
        this.room.broadcast({ type: 'kingdomino-tile-selection-end' });
        this.reorderPlayersBySelectedTile();
      } else {
        if (this.gameTiles.length === 0) {
          return this.endGame();
        }
        this.isTileSelecting = true;
        this.room.broadcast({ type: 'kingdomino-tile-selection-start' });
        this.drawNextTiles();
      }
    }

    this.nextTurn();
  }

  // ----------------------------------------------------------------- Selection

  selectTile(odId, tileNumber) {
    const drawnIndex = this.drawn.indexOf(tileNumber);
    if (drawnIndex === -1 || this.taken.has(tileNumber)) return;
    if (this.playerGameData[odId].selectedTile) return;

    this.taken.set(tileNumber, odId);
    this.playerGameData[odId].selectedTile = tileNumber;

    this.room.broadcast({ type: 'kingdomino-tile-selected', odId, tileNumber, drawnIndex });
    this.advanceTurn();
  }

  selectRandomTile() {
    const odId = this.playerOnTurn();
    if (!odId) return this.advanceTurn();

    const free = this.drawn.filter(n => !this.taken.has(n));
    if (free.length === 0) return this.advanceTurn();

    this.selectTile(odId, free[Math.floor(Math.random() * free.length)]);
  }

  reorderPlayersBySelectedTile() {
    const sorted = Object.entries(this.playerGameData)
      .sort((a, b) => a[1].selectedTile - b[1].selectedTile);
    sorted.forEach(([odId], i) => {
      this.playerGameData[odId].turnIndex = i + 1;
    });
    this.room.broadcast({ type: 'kingdomino-players-update', players: this.playerGameData });
  }

  // ----------------------------------------------------------------- Placement

  placeTile(odId, tileNumber, row, col, rotation) {
    const player = this.playerGameData[odId];
    if (!player.selectedTile || player.selectedTile !== tileNumber || this.placed.has(odId)) return;

    row = Number(row);
    col = Number(col);
    rotation = Number(rotation) || 0;

    const cells = this.placementCells(this.grids[odId], row, col, rotation);
    if (!cells) {
      const ws = this.room.getWsByUserId(odId);
      if (ws) this.room.send(ws, { type: 'error', message: 'Invalid tile placement' });
      return;
    }

    const tile = this.tiles[tileNumber];
    const grid = this.grids[odId];
    grid[cells[0].r][cells[0].c] = { ...tile.left, tile: tileNumber };
    grid[cells[1].r][cells[1].c] = { ...tile.right, tile: tileNumber };
    player.gridOccupancy = this.occupancyOf(grid);
    this.placed.add(odId);

    this.room.broadcast({ type: 'kingdomino-tile-placed', odId, tileNumber, row, col, rotation });
    this.advanceTurn();
  }

  /**
   * Returns the two grid cells [left, right] a tile would occupy,
   * or null if the placement is illegal.
   */
  placementCells(grid, row, col, rotation) {
    const offset = ROTATION_OFFSETS[rotation];
    if (!offset || !Number.isInteger(row) || !Number.isInteger(col)) return null;

    const a = { r: row, c: col };
    const b = { r: row + offset[0], c: col + offset[1] };

    for (const { r, c } of [a, b]) {
      if (r < 0 || r >= GRID_SIZE || c < 0 || c >= GRID_SIZE) return null;
      if (grid[r][c] !== null) return null;
    }

    const touchesGrid = [a, b].some(({ r, c }) =>
      [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dr, dc]) => {
        const nr = r + dr, nc = c + dc;
        const isOwnHalf = (nr === a.r && nc === a.c) || (nr === b.r && nc === b.c);
        return !isOwnHalf && nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE && grid[nr][nc] !== null;
      }));

    return touchesGrid ? [a, b] : null;
  }

  placeRandomTile() {
    // Timed out: the tile is discarded.
    const odId = this.playerOnTurn();
    if (!odId) return this.advanceTurn();

    const player = this.playerGameData[odId];
    if (player.selectedTile && !this.placed.has(odId)) {
      this.placed.add(odId);
      this.room.broadcast({
        type: 'kingdomino-tile-placed',
        odId,
        tileNumber: player.selectedTile,
        row: -1, // -1 marks a discarded tile
        col: -1,
        rotation: 0
      });
    }
    this.advanceTurn();
  }

  // ------------------------------------------------------------------- Scoring

  calculateScore(odId) {
    const grid = this.grids[odId];
    if (!grid) return 0;

    const seen = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(false));
    let total = 0;

    for (let r = 0; r < GRID_SIZE; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        const cell = grid[r][c];
        if (!cell || cell === CASTLE || seen[r][c]) continue;

        let size = 0;
        let crowns = 0;
        const stack = [[r, c]];
        seen[r][c] = true;

        while (stack.length) {
          const [cr, cc] = stack.pop();
          size++;
          crowns += grid[cr][cc].crown;
          for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nr = cr + dr, nc = cc + dc;
            if (nr < 0 || nr >= GRID_SIZE || nc < 0 || nc >= GRID_SIZE || seen[nr][nc]) continue;
            const next = grid[nr][nc];
            if (next && next !== CASTLE && next.type === cell.type) {
              seen[nr][nc] = true;
              stack.push([nr, nc]);
            }
          }
        }
        total += size * crowns;
      }
    }
    return total;
  }

  endGame() {
    this.gameEnded = true;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;

    for (const odId in this.playerGameData) {
      this.playerGameData[odId].score = this.calculateScore(odId);
    }

    this.room.broadcast({ type: 'kingdomino-game-end', players: this.playerGameData });

    const ranking = Object.values(this.playerGameData)
      .sort((a, b) => b.score - a.score)
      .map((p, i) => `${i + 1}. ${p.name}: ${p.score}`)
      .join(' | ');
    this.room.broadcast({ type: 'system-message', message: `Kingdomino results - ${ranking}` });

    this.endTimer = setTimeout(() => this.room.endGame(), RETURN_TO_LOBBY_MS);
  }

  /** A player left the room: their turns are skipped quickly, their grid still scores. */
  onPlayerLeft(odId) {
    if (this.playerGameData[odId]) this.leftPlayers.add(odId);
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.turnTimer);
    clearTimeout(this.endTimer);
    this.turnTimer = null;
    this.endTimer = null;
  }
}
