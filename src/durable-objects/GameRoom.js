/**
 * GameRoom Durable Object
 * One instance per room: WebSocket sessions, lobby, roles and the running game.
 *
 * Roles
 *  - player:    takes part in games
 *  - spectator: only the host can choose this ("host view"); watches and manages
 *               the room (pick/start/restart/end games, kick, hand over host) without playing
 *
 * The lobby is synchronised with a single idempotent `room-state` message that is
 * pushed after every change, so clients never have to merge partial updates.
 */

import { RockPaperScissors } from '../games/rock-paper-scissors.js';
import { Kingdomino } from '../games/kingdomino.js';
import { Hamsterball } from '../games/hamsterball.js';
import { Dice } from '../games/dice.js';
import { Uno } from '../games/uno.js';
import { Chess } from '../games/chess.js';
import { GAME_CONFIGS, MAX_ROOM_PLAYERS, sanitizeOptions } from '../games/config.js';

const GAME_CLASSES = {
  'rock-paper-scissors': RockPaperScissors,
  'kingdomino': Kingdomino,
  'hamsterball': Hamsterball,
  'dice': Dice,
  'uno': Uno,
  'chess': Chess
};

const LOBBY_GRACE_MS = 60 * 1000;       // phones sleep / tabs switch; don't drop people quickly
const GAME_GRACE_MS = 3 * 60 * 1000;
const IDLE_ROOM_TTL_MS = 3 * 60 * 60 * 1000;
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

    this.sessions = new Map();          // WebSocket -> { odId, name, ws, lastChat, closed }
    this.players = new Map();           // odId -> { odId, name, spectator }
    this.secrets = new Map();           // odId -> sha256(secret); proves identity on reconnect
    this.kickedPlayers = new Set();
    this.readyPlayers = new Set();
    this.disconnectTimers = new Map();  // odId -> timeout handle
    this.host = null;
    this.started = false;
    this.selectedGame = null;
    this.gameInstance = null;
    this.gameOptions = {};              // game id -> chosen options (host editable in the lobby)
    this.finishTimer = null;            // pending return to the lobby after a game ended
    this.results = null;                // last 'game-over' payload while its overlay is showing
    this.created = Date.now();

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('roomState');
      if (stored) {
        this.players = new Map((stored.players || []).map(([id, p]) => [id, { spectator: false, ...p }]));
        this.secrets = new Map(stored.secrets || []);
        this.kickedPlayers = new Set(stored.kickedPlayers || []);
        this.host = stored.host ?? null;
        this.selectedGame = stored.selectedGame ?? null;
        this.gameOptions = stored.gameOptions || {};
        this.created = stored.created || Date.now();
        // A game lives in memory and cannot survive a restart: come back in the lobby.
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
        playerCount: this.activePlayers().length,
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
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return;
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

    // Workers do not answer a client's close frame on their own: without this the
    // browser sits in CLOSING forever and never notices it should reconnect.
    ws.addEventListener('close', (event) => {
      try {
        const code = event.code === 1005 || event.code === 1006 || !event.code ? 1000 : event.code;
        ws.close(code, 'closing');
      } catch {
        // already closed
      }
      this.handleDisconnect(ws, session);
    });
    ws.addEventListener('error', () => this.handleDisconnect(ws, session));
  }

  async handleMessage(ws, session, data) {
    const { type, ...payload } = data;

    switch (type) {
      case 'send-user-id': return this.handleSendUserId(ws, session, payload);
      case 'submit-name': return this.handleSubmitName(ws, session, payload);
      case 'join-room': return this.handleJoinRoom(ws, session, payload);
      case 'ping': return this.send(ws, { type: 'pong' });
      case 'request-back-to-lobby': return this.send(ws, { type: 'back-to-lobby' });
    }

    if (!session.odId) return;

    switch (type) {
      case 'chat-message': return this.handleChatMessage(session, payload);
      case 'select-game': return this.handleSelectGame(ws, session, payload);
      case 'set-options': return this.handleSetOptions(ws, session, payload);
      case 'toggle-ready': return this.handleToggleReady(session);
      case 'set-role': return this.handleSetRole(ws, session, payload);
      case 'start-game': return this.handleStartGame(ws, session);
      case 'end-game': return this.handleEndGame(ws, session);
      case 'restart-game': return this.handleRestartGame(ws, session);
      case 'transfer-host': return this.handleTransferHost(ws, session, payload);
      case 'kick-player': return this.handleKickPlayer(ws, session, payload);
      case 'leave-room': return this.handleLeaveRoom(session);
      case 'spectate-ready': return this.handleSpectateReady(session);
      default:
        // Game-specific messages are only accepted from people who are playing.
        if (this.gameInstance && this.isActive(session.odId)) {
          this.gameInstance.handleMessage(session.odId, type, payload);
        }
    }
  }

  // ------------------------------------------------------------------ Identity

  async handleSendUserId(ws, session, payload) {
    let odId = payload.odId ?? payload.value;
    const { name, secret } = payload;

    if (typeof odId !== 'string' || !ID_RE.test(odId)) odId = crypto.randomUUID();

    // Prove ownership of an existing identity so ids seen in the player list can't be hijacked.
    const secretHash = typeof secret === 'string' && SECRET_RE.test(secret) ? await sha256Hex(secret) : null;
    const knownHash = this.secrets.get(odId);
    if (knownHash && knownHash !== secretHash) odId = crypto.randomUUID();
    if (secretHash && !this.secrets.has(odId)) {
      this.secrets.set(odId, secretHash);
      await this.saveState();
    }

    session.odId = odId;
    this.cancelDisconnectTimer(odId);

    const existing = this.players.get(odId);
    session.name = existing?.name || (this.isValidName(name) ? name.trim() : null);

    this.send(ws, { type: 'connect-user', odId, name: session.name, inRoom: !!existing });

    if (existing) this.pushState(); // returning player: resync everyone (online flag changes)
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
      this.send(ws, { type: 'error', message: 'That name is already taken in this room' });
      this.send(ws, { type: 'request-nickname', taken: true });
      return;
    }

    session.name = name;

    const player = this.players.get(session.odId);
    if (player) {
      player.name = name;
      await this.saveState();
      this.pushState();
    }

    if (isInGame) {
      this.send(ws, { type: 'connect-user', odId: session.odId, name, inRoom: !!player });
    }
  }

  // --------------------------------------------------------------------- Roles

  activePlayers() {
    return Array.from(this.players.values()).filter(p => !p.spectator);
  }

  isActive(odId) {
    const p = this.players.get(odId);
    return !!p && !p.spectator;
  }

  spectatorIds() {
    return Array.from(this.players.values()).filter(p => p.spectator).map(p => p.odId);
  }

  isHost(odId) {
    return this.host === odId;
  }

  requireHost(ws, session) {
    if (!this.isHost(session.odId)) {
      this.send(ws, { type: 'error', message: 'Only the host can do that' });
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------- Lobby

  async handleJoinRoom(ws, session, { spectate } = {}) {
    if (!session.name) {
      this.send(ws, { type: 'request-nickname' });
      return;
    }

    const existing = this.players.get(session.odId);

    if (this.kickedPlayers.has(session.odId)) {
      this.send(ws, { type: 'error', message: 'You have been removed from this room' });
      this.send(ws, { type: 'you-got-kicked' });
      return;
    }
    if (this.started && !existing) {
      this.send(ws, { type: 'error', message: 'This room already started a game' });
      this.send(ws, { type: 'join-failed', reason: 'started' });
      return;
    }

    if (!existing) {
      if (this.activePlayers().length >= MAX_ROOM_PLAYERS) {
        this.send(ws, { type: 'error', message: 'This room is full' });
        this.send(ws, { type: 'join-failed', reason: 'full' });
        return;
      }
      if (this.isNameTaken(session.name, session.odId)) {
        this.send(ws, { type: 'error', message: 'That name is already taken in this room' });
        this.send(ws, { type: 'request-nickname', taken: true });
        return;
      }
    }

    const becomesHost = !this.host || this.players.size === 0;
    if (becomesHost) this.host = session.odId;

    // Only the host may choose the spectator ("host view") role when entering.
    const spectator = existing ? existing.spectator : (becomesHost && spectate === true);

    this.players.set(session.odId, { odId: session.odId, name: session.name, spectator });
    await this.saveState();

    if (!existing) this.broadcast({ type: 'player-joined', name: session.name });
    this.pushState();

    if (this.started) {
      // Page reload in the middle of a game: load the game UI again.
      this.send(ws, { type: 'game-started', game: this.selectedGame });
      if (this.results) this.send(ws, this.results);
    }
  }

  async handleSetRole(ws, session, { spectator }) {
    const me = this.players.get(session.odId);
    if (!me || this.started) {
      return this.send(ws, { type: 'error', message: 'Roles can only be changed in the lobby' });
    }

    const wantSpectator = spectator === true;
    if (wantSpectator && !this.isHost(session.odId)) {
      return this.send(ws, { type: 'error', message: 'Only the host can use host view' });
    }
    if (!wantSpectator && me.spectator && this.activePlayers().length >= MAX_ROOM_PLAYERS) {
      return this.send(ws, { type: 'error', message: 'This room is full' });
    }
    if (me.spectator === wantSpectator) return;

    me.spectator = wantSpectator;
    this.readyPlayers.delete(session.odId);
    await this.saveState();
    this.pushState();
    await this.maybeStartGame();
  }

  handleChatMessage(session, { message }) {
    if (!this.players.has(session.odId) || typeof message !== 'string') return;

    const now = Date.now();
    if (now - session.lastChat < CHAT_COOLDOWN_MS) return;
    session.lastChat = now;

    const text = message.trim().slice(0, MAX_CHAT_LENGTH);
    if (!text) return;

    this.broadcast({ type: 'chat-message', message: text, name: session.name, odId: session.odId, at: now });
  }

  async handleSelectGame(ws, session, { game }) {
    if (!this.requireHost(ws, session)) return;
    if (this.started) return this.send(ws, { type: 'error', message: 'A game is already running' });

    const config = Object.hasOwn(GAME_CONFIGS, game) ? GAME_CONFIGS[game] : null;
    if (!config) return this.send(ws, { type: 'error', message: 'Invalid game selected' });
    if (!config.available) return this.send(ws, { type: 'error', message: `${config.name} is not available yet` });

    this.selectedGame = game;
    this.readyPlayers.clear();
    await this.saveState();
    this.pushState();
  }

  optionsFor(game) {
    return sanitizeOptions(game, this.gameOptions[game]);
  }

  async handleSetOptions(ws, session, { game, options }) {
    if (!this.requireHost(ws, session)) return;
    if (this.started || !Object.hasOwn(GAME_CONFIGS, game)) return;
    this.gameOptions[game] = sanitizeOptions(game, { ...this.optionsFor(game), ...(options || {}) });
    await this.saveState();
    this.pushState();
  }

  async handleToggleReady(session) {
    if (!this.isActive(session.odId) || this.started) return;

    if (this.readyPlayers.has(session.odId)) this.readyPlayers.delete(session.odId);
    else this.readyPlayers.add(session.odId);

    this.pushState();
    await this.maybeStartGame();
  }

  /** Why the current selection can't start, or null when it can. */
  startBlocker() {
    if (!this.selectedGame) return 'Pick a game first';
    const { min, max, name } = GAME_CONFIGS[this.selectedGame];
    const count = this.activePlayers().length;
    if (count < min) return `${name} needs at least ${min} player${min === 1 ? '' : 's'}`;
    if (count > max) return `${name} supports at most ${max} players`;
    return null;
  }

  async maybeStartGame() {
    if (this.started || this.startBlocker()) return;
    const actives = this.activePlayers();
    if (actives.length > 0 && actives.every(p => this.readyPlayers.has(p.odId))) {
      await this.startGame();
    }
  }

  async handleStartGame(ws, session) {
    if (!this.requireHost(ws, session)) return;
    if (this.started) return;
    const blocker = this.startBlocker();
    if (blocker) return this.send(ws, { type: 'error', message: blocker });
    await this.startGame();
  }

  async handleEndGame(ws, session) {
    if (!this.requireHost(ws, session)) return;
    if (!this.started) return;
    this.broadcast({ type: 'system-message', message: 'The host ended the game.' });
    await this.endGame();
  }

  async handleRestartGame(ws, session) {
    if (!this.requireHost(ws, session)) return;
    if (!this.started) return;
    if (this.startBlocker()) {
      this.broadcast({ type: 'system-message', message: 'Not enough players to restart.' });
      return this.endGame();
    }
    this.broadcast({ type: 'system-message', message: 'The host restarted the game.' });
    this.clearResults();
    this.gameInstance?.cleanup?.();
    this.gameInstance = null;
    await this.startGame();
  }

  async handleTransferHost(ws, session, { id }) {
    if (!this.requireHost(ws, session)) return;
    const target = this.players.get(id);
    if (!target || id === session.odId) return this.send(ws, { type: 'error', message: 'Pick another player' });

    const old = this.players.get(session.odId);
    this.host = id;
    // A spectator is only meaningful for the host; hand the old host a seat again.
    if (old?.spectator && !this.started) old.spectator = false;

    await this.saveState();
    this.broadcast({ type: 'system-message', message: `${target.name} is now the host.` });
    this.pushState();
  }

  async handleKickPlayer(ws, session, { kickedUserId }) {
    if (!this.requireHost(ws, session)) return;
    if (kickedUserId === session.odId) {
      return this.send(ws, { type: 'error', message: 'You cannot kick yourself' });
    }
    const kicked = this.players.get(kickedUserId);
    if (!kicked) return this.send(ws, { type: 'error', message: 'Player not in room' });

    this.kickedPlayers.add(kickedUserId);
    this.broadcast({ type: 'player-kicked', name: kicked.name });

    const kickedWs = this.getWsByUserId(kickedUserId);
    if (kickedWs) this.send(kickedWs, { type: 'you-got-kicked' });

    await this.removePlayer(kickedUserId, { announce: false });
  }

  async handleLeaveRoom(session) {
    if (this.players.has(session.odId)) await this.removePlayer(session.odId);
  }

  handleSpectateReady(session) {
    const me = this.players.get(session.odId);
    if (me?.spectator && this.gameInstance) {
      this.gameInstance.spectatorSync?.(session.odId);
    }
  }

  /** Remove a member, migrate the host if needed and reset the room once it is empty. */
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
      const next = this.activePlayers()[0] || this.players.values().next().value;
      this.host = next.odId;
      // A hosting-only spectator who leaves must not leave the room without a seat for the new host.
      this.broadcast({ type: 'system-message', message: `${next.name} is now the host.` });
    }

    await this.saveState();
    if (announce) this.broadcast({ type: 'player-left', name: player.name });
    this.pushState();

    this.gameInstance?.onPlayerLeft?.(odId);

    if (this.started && this.activePlayers().length === 0) {
      await this.endGame();
      return;
    }
    await this.maybeStartGame();
  }

  async resetRoom() {
    this.clearResults();
    this.gameInstance?.cleanup?.();
    this.gameInstance = null;
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();

    this.players.clear();
    this.readyPlayers.clear();
    this.kickedPlayers.clear();
    this.secrets.clear();
    this.host = null;
    this.started = false;
    this.selectedGame = null;
    this.gameOptions = {};
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }

  // ---------------------------------------------------------------- Connection

  handleDisconnect(ws, session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(ws);

    const { odId } = session;
    if (!odId || !this.players.has(odId)) return;
    if (this.getWsByUserId(odId)) return; // another tab of the same player is still open

    this.pushState(); // show them as offline

    this.cancelDisconnectTimer(odId);
    const timer = setTimeout(async () => {
      this.disconnectTimers.delete(odId);
      if (this.getWsByUserId(odId)) return;
      await this.removePlayer(odId);
    }, this.started ? GAME_GRACE_MS : LOBBY_GRACE_MS);
    this.disconnectTimers.set(odId, timer);
  }

  cancelDisconnectTimer(odId) {
    const timer = this.disconnectTimers.get(odId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(odId);
    }
  }

  /** Abandoned rooms (everybody gone, process evicted) are wiped after a while. */
  async alarm() {
    if (this.sessions.size === 0) {
      await this.resetRoom();
    } else {
      await this.state.storage.setAlarm(Date.now() + IDLE_ROOM_TTL_MS);
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
    this.readyPlayers.clear();
    await this.saveState();
    this.pushState();

    this.broadcast({ type: 'game-started', game: this.selectedGame });
    const players = Object.fromEntries(this.activePlayers().map(p => [p.odId, { odId: p.odId, name: p.name }]));
    this.clearResults();
    this.gameInstance = new GameClass(this, players, this.optionsFor(this.selectedGame));
  }

  /**
   * Called by a game when it is over. Shows the standings to everybody and returns the
   * room to the lobby after `delayMs` (the host can restart or end earlier).
   * rows: [{ id, name, score?, rank, note? }] ordered best first.
   */
  finishGame({ title = 'Game over', subtitle = '', rows = [], delayMs = 20000 } = {}) {
    clearTimeout(this.finishTimer);
    this.results = { type: 'game-over', game: this.selectedGame, title, subtitle, rows, returnAt: Date.now() + delayMs };
    this.broadcast(this.results);
    this.finishTimer = setTimeout(() => { this.finishTimer = null; this.endGame(); }, delayMs);
  }

  clearResults() {
    clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.results = null;
  }

  async endGame() {
    this.clearResults();
    this.gameInstance?.cleanup?.();
    this.gameInstance = null;
    this.started = false;
    this.selectedGame = null;
    this.readyPlayers.clear();
    await this.saveState();

    this.broadcast({ type: 'back-to-lobby' });
    this.pushState();
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
          // dead socket; the close handler cleans up
        }
      }
    }
  }

  roomState() {
    const config = this.selectedGame ? GAME_CONFIGS[this.selectedGame] : null;
    return {
      type: 'room-state',
      host: this.host,
      started: this.started,
      game: this.selectedGame,
      gameName: config?.name ?? null,
      gameMin: config?.min ?? null,
      gameMax: config?.max ?? null,
      options: this.selectedGame ? this.optionsFor(this.selectedGame) : null,
      blocker: this.startBlocker(),
      players: Array.from(this.players.values(), p => ({
        id: p.odId,
        name: p.name,
        spectator: p.spectator,
        ready: this.readyPlayers.has(p.odId),
        online: !!this.getWsByUserId(p.odId),
        host: p.odId === this.host
      }))
    };
  }

  pushState() {
    this.broadcast(this.roomState());
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
      gameOptions: this.gameOptions,
      created: this.created
    });
    await this.state.storage.setAlarm(Date.now() + IDLE_ROOM_TTL_MS);
  }
}
