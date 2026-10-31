/**
 * GameRoom Durable Object
 * Handles WebSocket connections, lobby state and the running game for a single room.
 */

import { RockPaperScissors } from '../games/rock-paper-scissors.js';
import { Kingdomino } from '../games/kingdomino.js';
import { Hamsterball } from '../games/hamsterball.js';
import { Dice } from '../games/dice.js';
import { Uno } from '../games/uno.js';
import { Chess } from '../games/chess.js';
import { GAME_CONFIGS, MAX_ROOM_PLAYERS } from '../games/config.js';

const GAME_CLASSES = {
  'rock-paper-scissors': RockPaperScissors,
  'kingdomino': Kingdomino,
  'hamsterball': Hamsterball,
  'dice': Dice,
  'uno': Uno,
  'chess': Chess
};

const RECONNECT_GRACE_MS = 10000;
const MAX_MESSAGE_BYTES = 4096;
const MAX_CHAT_LENGTH = 200;
const CHAT_COOLDOWN_MS = 400;
const NAME_RE = /^[\p{L}\p{N} _.\-]{3,16}$/u;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.sessions = new Map();          // WebSocket -> { odId, name, ws, lastChat }
    this.players = new Map();           // odId -> { odId, name }
    this.secrets = new Map();           // odId -> sha256(secret); proves identity on reconnect
    this.kickedPlayers = new Set();
    this.readyPlayers = new Set();
    this.disconnectTimers = new Map();  // odId -> timeout handle
    this.host = null;
    this.started = false;
    this.selectedGame = null;
    this.gameInstance = null;
    this.created = Date.now();

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('roomState');
      if (stored) {
        this.players = new Map(stored.players || []);
        this.secrets = new Map(stored.secrets || []);
        this.kickedPlayers = new Set(stored.kickedPlayers || []);
        this.host = stored.host ?? null;
        this.selectedGame = stored.selectedGame ?? null;
        this.created = stored.created || Date.now();
        // A game cannot survive a Durable Object restart (state lives in memory),
        // so always come back in the lobby.
        this.started = false;
        this.readyPlayers = new Set();
      }
    });
  }

  // ---------------------------------------------------------------- HTTP / WS

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        exists: this.players.size > 0,
        playerCount: this.players.size,
        started: this.started,
        game: this.selectedGame
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket();
    }

    return new Response('Expected WebSocket', { status: 426 });
  }

  handleWebSocket() {
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    ws.accept();

    const session = { odId: null, name: null, ws, lastChat: 0, closed: false };
    this.sessions.set(ws, session);

    this.send(ws, { type: 'request-user-id' });

    ws.addEventListener('message', async (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) {
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        this.send(ws, { type: 'error', message: 'Invalid message format' });
        return;
      }
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

      try {
        await this.handleMessage(ws, session, data);
      } catch (err) {
        console.error('Error handling message:', err);
        this.send(ws, { type: 'error', message: 'Server error' });
      }
    });

    const onClose = () => this.handleDisconnect(ws, session);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  async handleMessage(ws, session, data) {
    const { type, ...payload } = data;

    switch (type) {
      case 'send-user-id':
        return this.handleSendUserId(ws, session, payload);
      case 'submit-name':
        return this.handleSubmitName(ws, session, payload);
      case 'join-room':
        return this.handleJoinRoom(ws, session);
      case 'ping':
        return this.send(ws, { type: 'pong' });
      case 'request-back-to-lobby':
        // Client failed to load the game UI; let it fall back to the lobby view.
        return this.send(ws, { type: 'back-to-lobby' });
    }

    // Everything below requires an identified session.
    if (!session.odId) return;

    switch (type) {
      case 'create-room':
        return this.handleJoinRoom(ws, session);
      case 'chat-message':
        return this.handleChatMessage(session, payload);
      case 'select-game':
        return this.handleSelectGame(ws, session, payload);
      case 'toggle-ready':
        return this.handleToggleReady(session);
      case 'kick-player':
        return this.handleKickPlayer(ws, session, payload);
      case 'leave-room':
        return this.handleLeaveRoom(session);
      default:
        // Game-specific messages are only accepted from people in the room.
        if (this.gameInstance && this.players.has(session.odId)) {
          this.gameInstance.handleMessage(session.odId, type, payload);
        }
    }
  }

  // ------------------------------------------------------------------ Identity

  async handleSendUserId(ws, session, payload) {
    let odId = payload.odId ?? payload.value;
    const name = payload.name;
    const secret = payload.secret;

    if (typeof odId !== 'string' || !ID_RE.test(odId)) {
      odId = crypto.randomUUID();
    }

    // Prove ownership of an existing identity so ids leaked via the player list can't be hijacked.
    const secretHash = typeof secret === 'string' && SECRET_RE.test(secret) ? await sha256Hex(secret) : null;
    const knownHash = this.secrets.get(odId);
    if (knownHash && knownHash !== secretHash) {
      odId = crypto.randomUUID();
    }
    if (secretHash && !this.secrets.has(odId)) {
      this.secrets.set(odId, secretHash);
      await this.saveState();
    }

    session.odId = odId;
    this.cancelDisconnectTimer(odId);

    const existing = this.players.get(odId);
    session.name = existing?.name || (this.isValidName(name) ? name.trim() : null);

    this.send(ws, {
      type: 'connect-user',
      odId,
      name: session.name,
      inRoom: !!existing
    });

    if (existing) {
      // Returning player (socket reconnect): resync lobby state.
      this.sendRoomData(ws);
    }
  }

  isValidName(name) {
    return typeof name === 'string' && NAME_RE.test(name.trim());
  }

  isNameTaken(name, odId) {
    const lower = name.toLowerCase();
    for (const player of this.players.values()) {
      if (player.odId !== odId && player.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  async handleSubmitName(ws, session, { name, isInGame }) {
    if (!session.odId) return;

    if (!this.isValidName(name)) {
      this.send(ws, { type: 'error', message: 'Nickname must be 3-16 letters, numbers, spaces, "_", "-" or "."' });
      this.send(ws, { type: 'request-nickname', taken: true });
      return;
    }
    name = name.trim();

    if (this.isNameTaken(name, session.odId)) {
      this.send(ws, { type: 'error', message: 'Name already taken in this room' });
      this.send(ws, { type: 'request-nickname', taken: true });
      return;
    }

    session.name = name;

    const player = this.players.get(session.odId);
    if (player) {
      player.name = name;
      await this.saveState();
      this.broadcastPlayerList();
    }

    if (isInGame) {
      this.send(ws, {
        type: 'connect-user',
        odId: session.odId,
        name: session.name,
        inRoom: !!player
      });
    }
  }

  // ---------------------------------------------------------------------- Lobby

  async handleJoinRoom(ws, session) {
    if (!session.name) {
      this.send(ws, { type: 'request-nickname' });
      return;
    }

    const isMember = this.players.has(session.odId);

    if (this.kickedPlayers.has(session.odId)) {
      this.send(ws, { type: 'error', message: 'You have been kicked from this room!' });
      this.send(ws, { type: 'you-got-kicked' });
      return;
    }

    if (this.started && !isMember) {
      this.send(ws, { type: 'error', message: 'Room already started' });
      return;
    }

    if (!isMember) {
      if (this.players.size >= MAX_ROOM_PLAYERS) {
        this.send(ws, { type: 'error', message: 'Room is full' });
        return;
      }
      if (this.isNameTaken(session.name, session.odId)) {
        this.send(ws, { type: 'error', message: 'Name already taken in this room' });
        this.send(ws, { type: 'request-nickname', taken: true });
        return;
      }
    }

    if (!this.host || this.players.size === 0) {
      this.host = session.odId;
    }

    this.players.set(session.odId, { odId: session.odId, name: session.name });
    await this.saveState();

    if (!isMember) {
      this.broadcast({ type: 'player-joined', name: session.name });
    }
    this.broadcastPlayerList();
    this.sendRoomData(ws);

    if (this.started) {
      // Page reload in the middle of a game: load the game UI again.
      this.send(ws, { type: 'game-started', game: this.selectedGame });
    } else {
      // Show current ready states to the (re)joining client.
      for (const odId of this.readyPlayers) {
        this.send(ws, { type: 'ready-state', odId, isReady: true });
      }
    }
  }

  handleChatMessage(session, { message }) {
    if (!this.players.has(session.odId)) return;
    if (typeof message !== 'string') return;

    const now = Date.now();
    if (now - session.lastChat < CHAT_COOLDOWN_MS) return;
    session.lastChat = now;

    const text = message.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    this.broadcast({ type: 'chat-message', message: text, name: session.name });
  }

  async handleSelectGame(ws, session, { game }) {
    if (this.host !== session.odId) {
      return this.send(ws, { type: 'error', message: 'You are not the host of this room' });
    }
    if (this.started) {
      return this.send(ws, { type: 'error', message: 'A game is already running' });
    }

    const gameConfig = Object.hasOwn(GAME_CONFIGS, game) ? GAME_CONFIGS[game] : null;
    if (!gameConfig) {
      return this.send(ws, { type: 'error', message: 'Invalid game selected' });
    }
    if (!gameConfig.available) {
      return this.send(ws, { type: 'error', message: `${gameConfig.name} is not available yet` });
    }

    this.selectedGame = game;
    this.readyPlayers.clear();
    await this.saveState();

    this.broadcast({
      type: 'game-selected',
      game,
      min: gameConfig.min,
      max: gameConfig.max,
      name: gameConfig.name
    });

    for (const odId of this.players.keys()) {
      this.broadcast({ type: 'ready-state', odId, isReady: false });
    }
  }

  async handleToggleReady(session) {
    if (!this.players.has(session.odId) || this.started) return;

    const isReady = !this.readyPlayers.has(session.odId);
    if (isReady) this.readyPlayers.add(session.odId);
    else this.readyPlayers.delete(session.odId);

    await this.saveState();
    this.broadcast({ type: 'ready-state', odId: session.odId, isReady });

    await this.maybeStartGame();
  }

  async maybeStartGame() {
    if (this.started || !this.selectedGame) return;

    const { min, max } = GAME_CONFIGS[this.selectedGame];
    const readyCount = this.readyPlayers.size;
    if (readyCount >= min && readyCount <= max && readyCount === this.players.size) {
      await this.startGame();
    } else if (readyCount === this.players.size && this.players.size > max) {
      this.broadcast({ type: 'error', message: `${GAME_CONFIGS[this.selectedGame].name} supports at most ${max} players` });
    }
  }

  async handleKickPlayer(ws, session, { kickedUserId }) {
    if (this.host !== session.odId) {
      return this.send(ws, { type: 'error', message: 'You are not the host of this room!' });
    }
    if (kickedUserId === session.odId) {
      return this.send(ws, { type: 'error', message: 'You cannot kick yourself' });
    }
    const kicked = this.players.get(kickedUserId);
    if (!kicked) {
      return this.send(ws, { type: 'error', message: 'Player not in room!' });
    }

    this.kickedPlayers.add(kickedUserId);
    this.broadcast({ type: 'player-kicked', name: kicked.name });

    const kickedWs = this.getWsByUserId(kickedUserId);
    if (kickedWs) this.send(kickedWs, { type: 'you-got-kicked' });

    await this.removePlayer(kickedUserId, { announce: false });
  }

  async handleLeaveRoom(session) {
    if (!this.players.has(session.odId)) return;
    await this.removePlayer(session.odId);
  }

  /**
   * Remove a player from the room, migrate the host if needed and
   * reset the room once it is empty.
   */
  async removePlayer(odId, { announce = true } = {}) {
    const player = this.players.get(odId);
    if (!player) return;

    this.cancelDisconnectTimer(odId);
    this.players.delete(odId);
    this.readyPlayers.delete(odId);
    this.secrets.delete(odId);

    if (this.players.size === 0) {
      await this.resetRoom();
      return;
    }

    if (this.host === odId) {
      this.host = this.players.keys().next().value;
      this.broadcast({ type: 'host-changed', host: this.host });
    }

    await this.saveState();

    if (announce) this.broadcast({ type: 'player-left', name: player.name });
    this.broadcastPlayerList();

    if (this.gameInstance?.onPlayerLeft) {
      this.gameInstance.onPlayerLeft(odId);
    }

    // The remaining players may all be ready now.
    await this.maybeStartGame();
  }

  async resetRoom() {
    if (this.gameInstance) {
      this.gameInstance.cleanup?.();
      this.gameInstance = null;
    }
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();

    this.players.clear();
    this.readyPlayers.clear();
    this.kickedPlayers.clear();
    this.secrets.clear();
    this.host = null;
    this.started = false;
    this.selectedGame = null;
    await this.state.storage.deleteAll();
  }

  // ---------------------------------------------------------------- Connection

  handleDisconnect(ws, session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(ws);

    const { odId } = session;
    if (!odId || !this.players.has(odId)) return;
    // Another tab/socket of the same player is still connected.
    if (this.getWsByUserId(odId)) return;

    this.cancelDisconnectTimer(odId);
    const timer = setTimeout(async () => {
      this.disconnectTimers.delete(odId);
      if (this.getWsByUserId(odId)) return;
      await this.removePlayer(odId);
    }, RECONNECT_GRACE_MS);
    this.disconnectTimers.set(odId, timer);
  }

  cancelDisconnectTimer(odId) {
    const timer = this.disconnectTimers.get(odId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(odId);
    }
  }

  // ---------------------------------------------------------------------- Games

  async startGame() {
    const GameClass = GAME_CLASSES[this.selectedGame];
    if (!GameClass) {
      this.broadcast({ type: 'error', message: 'Game not implemented yet' });
      return;
    }

    this.started = true;
    await this.saveState();

    this.broadcast({ type: 'game-started', game: this.selectedGame });
    this.gameInstance = new GameClass(this, Object.fromEntries(this.players));
  }

  async endGame() {
    if (this.gameInstance) {
      this.gameInstance.cleanup?.();
      this.gameInstance = null;
    }
    this.started = false;
    this.selectedGame = null;
    this.readyPlayers.clear();
    await this.saveState();

    this.broadcast({ type: 'back-to-lobby' });
  }

  // -------------------------------------------------------------------- Helpers

  send(ws, data) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // socket closed between the check and the send
      }
    }
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of this.sessions.keys()) {
      if (ws.readyState === 1) {
        try {
          ws.send(message);
        } catch {
          // ignore dead sockets; close handler will clean up
        }
      }
    }
  }

  broadcastPlayerList() {
    this.broadcast({ type: 'player-list', players: this.playerList() });
  }

  playerList() {
    return Array.from(this.players.values(), p => ({ [p.name]: p.odId }));
  }

  sendRoomData(ws) {
    const gameConfig = this.selectedGame ? GAME_CONFIGS[this.selectedGame] : null;
    this.send(ws, {
      type: 'send-room-data',
      players: this.playerList(),
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
      if (session.odId === odId && ws.readyState === 1) return ws;
    }
    return null;
  }

  async saveState() {
    await this.state.storage.put('roomState', {
      players: Array.from(this.players.entries()),
      secrets: Array.from(this.secrets.entries()),
      kickedPlayers: Array.from(this.kickedPlayers),
      host: this.host,
      selectedGame: this.selectedGame,
      created: this.created
    });
  }
}
