/**
 * GameRoom Durable Object
 * Handles WebSocket connections and game state for a single room
 */

import { RockPaperScissors } from '../games/rock-paper-scissors.js';
import { Kingdomino } from '../games/kingdomino.js';
import { Hamsterball } from '../games/hamsterball.js';

const GAME_CONFIGS = {
  "rock-paper-scissors": { min: 2, max: 12, name: "Rock Paper Scissors", icon: "🪨" },
  "dice": { min: 2, max: 12, name: "Dice", icon: "🎲" },
  "kingdomino": { min: 1, max: 4, name: "Kingdomino", icon: "👑" },
  "uno": { min: 2, max: 10, name: "Uno", icon: "🃏" },
  "hamsterball": { min: 1, max: 12, name: "Hamsterball", icon: "🐹" },
  "chess": { min: 2, max: 2, name: "Chess", icon: "♟️" }
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    // WebSocket sessions
    this.sessions = new Map(); // Map<WebSocket, SessionData>
    
    // Room state
    this.players = new Map(); // Map<odId, PlayerData>
    this.kickedPlayers = new Set();
    this.readyPlayers = new Set();
    this.host = null;
    this.started = false;
    this.selectedGame = null;
    this.gameInstance = null;
    this.created = Date.now();
    
    // Load state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('roomState');
      if (stored) {
        this.players = new Map(stored.players || []);
        this.kickedPlayers = new Set(stored.kickedPlayers || []);
        this.readyPlayers = new Set(stored.readyPlayers || []);
        this.host = stored.host;
        this.started = stored.started || false;
        this.selectedGame = stored.selectedGame;
        this.created = stored.created || Date.now();
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // Internal status check
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        exists: this.players.size > 0 || this.host !== null,
        playerCount: this.players.size,
        started: this.started,
        game: this.selectedGame
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    return new Response('Expected WebSocket', { status: 426 });
  }

  handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  handleSession(ws) {
    ws.accept();

    const session = {
      odId: null,
      name: null,
      ws: ws
    };
    this.sessions.set(ws, session);

    // Request user identification
    this.send(ws, { type: 'request-user-id' });

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(ws, session, data);
      } catch (err) {
        console.error('Error handling message:', err);
        this.send(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.addEventListener('close', () => {
      this.handleDisconnect(ws, session);
    });

    ws.addEventListener('error', () => {
      this.handleDisconnect(ws, session);
    });
  }

  async handleMessage(ws, session, data) {
    const { type, ...payload } = data;

    switch (type) {
      case 'send-user-id':
        await this.handleSendUserId(ws, session, payload);
        break;

      case 'submit-name':
        await this.handleSubmitName(ws, session, payload);
        break;

      case 'create-room':
        await this.handleCreateRoom(ws, session);
        break;

      case 'join-room':
        await this.handleJoinRoom(ws, session);
        break;

      case 'chat-message':
        this.handleChatMessage(session, payload);
        break;

      case 'select-game':
        await this.handleSelectGame(session, payload);
        break;

      case 'toggle-ready':
        await this.handleToggleReady(session);
        break;

      case 'kick-player':
        await this.handleKickPlayer(session, payload);
        break;

      case 'leave-room':
        await this.handleLeaveRoom(ws, session);
        break;

      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      default:
        // Forward to game instance if exists
        if (this.gameInstance && this.gameInstance.handleMessage) {
          this.gameInstance.handleMessage(session.odId, type, payload);
        }
    }
  }

  async handleSendUserId(ws, session, payload) {
    // Handle both object and value payloads
    let odId, name;
    if (payload.value !== undefined) {
      // Old format: just the ID as a value
      odId = payload.value;
      name = null;
    } else {
      // New format: { odId, name }
      odId = payload.odId;
      name = payload.name;
    }
    
    console.log(`handleSendUserId called with odId=${odId}, name=${name}`);
    if (!odId) {
      odId = crypto.randomUUID();
    }
    session.odId = odId;
    
    // Get existing player data if any, or use the name sent from client
    const existingPlayer = this.players.get(odId);
    session.name = existingPlayer?.name || name || null;
    console.log(`session.name set to: ${session.name}, existingPlayer=${JSON.stringify(existingPlayer)}`);

    this.send(ws, {
      type: 'connect-user',
      odId: odId,
      name: session.name,
      inRoom: this.players.has(odId)
    });
  }

  async handleSubmitName(ws, session, { name, isInGame }) {
    // Check if name is already taken in this room
    for (const [_, player] of this.players) {
      if (player.name === name && player.odId !== session.odId) {
        this.send(ws, { type: 'error', message: 'Name already taken in this room' });
        this.send(ws, { type: 'request-user-id' });
        return;
      }
    }

    session.name = name;
    
    // Update player data if they're in the room
    if (this.players.has(session.odId)) {
      const player = this.players.get(session.odId);
      player.name = name;
      await this.saveState();
    }

    if (isInGame) {
      this.send(ws, {
        type: 'connect-user',
        odId: session.odId,
        name: session.name,
        inRoom: this.players.has(session.odId)
      });
    }
  }

  async handleCreateRoom(ws, session) {
    if (!session.name) {
      this.send(ws, { type: 'request-nickname' });
      return;
    }

    this.host = session.odId;
    this.created = Date.now();
    await this.saveState();

    console.log(`Room created by ${session.name} (${session.odId})`);
  }

  async handleJoinRoom(ws, session) {
    console.log(`handleJoinRoom called, session=${JSON.stringify({odId: session.odId, name: session.name})}`);
    console.log(`Current players in room: ${JSON.stringify([...this.players.entries()])}`);
    
    if (!session.name) {
      console.log('No session.name, requesting nickname');
      this.send(ws, { type: 'request-nickname' });
      return;
    }

    if (this.started && !this.players.has(session.odId)) {
      this.send(ws, { type: 'error', message: 'Room already started' });
      return;
    }

    if (this.kickedPlayers.has(session.odId)) {
      this.send(ws, { type: 'error', message: 'You have been kicked from this room!' });
      return;
    }

    // If no host, this player becomes the host (first player to join creates the room)
    if (!this.host) {
      this.host = session.odId;
      console.log(`Room created by ${session.name} (${session.odId})`);
    }

    // Add or update player in the room
    this.players.set(session.odId, {
      odId: session.odId,
      name: session.name
    });

    await this.saveState();

    // Notify everyone
    this.broadcast({ type: 'player-joined', name: session.name });
    this.broadcastPlayerList();
    this.sendRoomData(ws);

    console.log(`${session.name} joined room, total players: ${this.players.size}`);
  }

  handleChatMessage(session, { message }) {
    if (!this.players.has(session.odId)) return;

    this.broadcast({
      type: 'chat-message',
      message: message,
      name: session.name
    });
  }

  async handleSelectGame(session, { game }) {
    if (this.host !== session.odId) {
      this.send(this.getWsByUserId(session.odId), { 
        type: 'error', 
        message: 'You are not the host of this room' 
      });
      return;
    }

    const gameConfig = GAME_CONFIGS[game];
    if (!gameConfig) {
      this.send(this.getWsByUserId(session.odId), { 
        type: 'error', 
        message: 'Invalid game selected' 
      });
      return;
    }

    this.selectedGame = game;
    this.readyPlayers.clear();
    await this.saveState();

    this.broadcast({
      type: 'game-selected',
      game: game,
      min: gameConfig.min,
      max: gameConfig.max,
      name: gameConfig.name
    });

    // Reset all ready states
    for (const [odId] of this.players) {
      this.broadcast({ type: 'ready-state', odId: odId, isReady: false });
    }
  }

  async handleToggleReady(session) {
    if (!this.players.has(session.odId)) return;

    let isReady;
    if (this.readyPlayers.has(session.odId)) {
      this.readyPlayers.delete(session.odId);
      isReady = false;
    } else {
      this.readyPlayers.add(session.odId);
      isReady = true;
    }

    await this.saveState();
    this.broadcast({ type: 'ready-state', odId: session.odId, isReady: isReady });

    // Check if we can start the game
    if (this.selectedGame) {
      const gameConfig = GAME_CONFIGS[this.selectedGame];
      const readyCount = this.readyPlayers.size;
      const playerCount = this.players.size;

      if (readyCount >= gameConfig.min && 
          readyCount <= gameConfig.max && 
          readyCount === playerCount) {
        await this.startGame();
      }
    }
  }

  async handleKickPlayer(session, { kickedUserId }) {
    if (this.host !== session.odId) {
      this.send(this.getWsByUserId(session.odId), { 
        type: 'error', 
        message: 'You are not the host of this room!' 
      });
      return;
    }

    if (!this.players.has(kickedUserId)) {
      this.send(this.getWsByUserId(session.odId), { 
        type: 'error', 
        message: 'Player not in room!' 
      });
      return;
    }

    const kickedPlayer = this.players.get(kickedUserId);
    this.kickedPlayers.add(kickedUserId);
    this.players.delete(kickedUserId);
    this.readyPlayers.delete(kickedUserId);
    await this.saveState();

    this.broadcast({ type: 'player-kicked', name: kickedPlayer.name });
    this.broadcastPlayerList();

    // Notify the kicked player
    const kickedWs = this.getWsByUserId(kickedUserId);
    if (kickedWs) {
      this.send(kickedWs, { type: 'you-got-kicked' });
    }
  }

  async handleLeaveRoom(ws, session) {
    if (!session.odId || !this.players.has(session.odId)) return;

    const player = this.players.get(session.odId);
    this.players.delete(session.odId);
    this.readyPlayers.delete(session.odId);
    await this.saveState();

    this.broadcast({ type: 'player-left', name: player.name });
    this.broadcastPlayerList();
  }

  handleDisconnect(ws, session) {
    this.sessions.delete(ws);

    if (session.odId && this.players.has(session.odId)) {
      const player = this.players.get(session.odId);
      
      // Give a grace period for reconnection
      setTimeout(async () => {
        // Check if they reconnected
        const stillConnected = Array.from(this.sessions.values())
          .some(s => s.odId === session.odId);
        
        if (!stillConnected) {
          this.players.delete(session.odId);
          this.readyPlayers.delete(session.odId);
          await this.saveState();
          
          this.broadcast({ type: 'player-left', name: player.name });
          this.broadcastPlayerList();
        }
      }, 10000);
    }
  }

  async startGame() {
    console.log(`Starting game ${this.selectedGame}`);
    this.started = true;
    await this.saveState();

    this.broadcast({ type: 'game-started', game: this.selectedGame });

    // Create game instance
    const players = Object.fromEntries(this.players);
    
    switch (this.selectedGame) {
      case 'rock-paper-scissors':
        this.gameInstance = new RockPaperScissors(this, players);
        break;
      case 'kingdomino':
        this.gameInstance = new Kingdomino(this, players);
        break;
      case 'hamsterball':
        this.gameInstance = new Hamsterball(this, players);
        break;
      default:
        console.log(`Game ${this.selectedGame} not implemented yet`);
    }
  }

  async endGame() {
    console.log('Game ended');
    this.started = false;
    this.gameInstance = null;
    this.readyPlayers.clear();
    await this.saveState();

    this.broadcast({ type: 'back-to-lobby' });
  }

  // Helper methods
  send(ws, data) {
    if (ws && ws.readyState === 1) { // 1 = OPEN
      ws.send(JSON.stringify(data));
    }
  }

  broadcast(data, excludeUserId = null) {
    const message = JSON.stringify(data);
    for (const [ws, session] of this.sessions) {
      if (excludeUserId && session.odId === excludeUserId) continue;
      if (ws.readyState === 1) { // 1 = OPEN
        ws.send(message);
      }
    }
  }

  broadcastPlayerList() {
    const playerList = Array.from(this.players.values()).map(p => ({
      [p.name]: p.odId
    }));
    this.broadcast({ type: 'player-list', players: playerList });
  }

  sendRoomData(ws) {
    const gameConfig = this.selectedGame ? GAME_CONFIGS[this.selectedGame] : null;
    this.send(ws, {
      type: 'send-room-data',
      players: Array.from(this.players.values()).map(p => ({ [p.name]: p.odId })),
      host: this.host,
      started: this.started,
      game: this.selectedGame,
      gameMin: gameConfig?.min,
      gameMax: gameConfig?.max,
      gameName: gameConfig?.name
    });
  }

  getWsByUserId(odId) {
    for (const [ws, session] of this.sessions) {
      if (session.odId === odId) return ws;
    }
    return null;
  }

  async saveState() {
    await this.state.storage.put('roomState', {
      players: Array.from(this.players.entries()),
      kickedPlayers: Array.from(this.kickedPlayers),
      readyPlayers: Array.from(this.readyPlayers),
      host: this.host,
      started: this.started,
      selectedGame: this.selectedGame,
      created: this.created
    });
  }
}
