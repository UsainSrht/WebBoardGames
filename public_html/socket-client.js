/**
 * Socket Client - WebSocket wrapper to replace Socket.IO
 * Provides a similar API to Socket.IO for easy migration
 */

class SocketClient {
  constructor(options = {}) {
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;
    this.eventHandlers = new Map();
    this.oneTimeHandlers = new Map();
    this.anyHandlers = [];
    this.pendingMessages = [];
    this.roomCode = null;
    this.autoConnect = options.autoConnect !== false;
    this.id = null; // Socket ID equivalent
    this.reconnectTimer = null;
    this.connectionTimeout = null;
    this.connectionTimeoutMs = options.connectionTimeout || 10000;
    
    // Auto-connect to lobby by default (like Socket.IO)
    if (this.autoConnect) {
      // Get room from URL if on game page
      const params = new URLSearchParams(window.location.search);
      const room = params.get('room') || 'lobby';
      this.connect(room);
    }
  }

  /**
   * Connect to a room via WebSocket
   * @param {string} roomCode - The room code to connect to
   */
  connect(roomCode = 'lobby') {
    // If already connected to same room, do nothing
    if (this.connected && this.roomCode === roomCode) {
      return this;
    }
    
    // If already trying to connect, don't start another connection
    if (this.connecting && this.roomCode === roomCode) {
      return this;
    }
    
    // Clear any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Clear any pending connection timeout
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    // If connected to different room, disconnect first
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try {
        oldWs.onclose = null; // Prevent triggering reconnect
        oldWs.onerror = null;
        oldWs.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    
    this.roomCode = roomCode;
    this.connecting = true;
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomCode)}`;
    
    console.log(`[SocketClient] Connecting to ${wsUrl}`);
    this.trigger('connecting');
    
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[SocketClient] Failed to create WebSocket:', err);
      this.connecting = false;
      this.scheduleReconnect();
      return this;
    }
    
    // Set connection timeout
    this.connectionTimeout = setTimeout(() => {
      if (this.connecting && this.ws) {
        console.log('[SocketClient] Connection timeout');
        this.ws.close();
      }
    }, this.connectionTimeoutMs);
    
    this.ws.onopen = () => {
      console.log('[SocketClient] Connected');
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      this.connected = true;
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.id = 'ws-' + Math.random().toString(36).substr(2, 9);
      this.trigger('connect');
      
      // Send any pending messages
      while (this.pendingMessages.length > 0) {
        const msg = this.pendingMessages.shift();
        try {
          this.ws.send(msg);
        } catch (err) {
          console.error('[SocketClient] Failed to send pending message:', err);
        }
      }
    };
    
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (err) {
        console.error('[SocketClient] Failed to parse message:', err);
      }
    };
    
    this.ws.onclose = (event) => {
      console.log('[SocketClient] Disconnected', event.code, event.reason);
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      
      if (wasConnected) {
        this.trigger('disconnect', event.reason);
      }
      
      // Attempt reconnection
      this.scheduleReconnect();
    };
    
    this.ws.onerror = (event) => {
      console.error('[SocketClient] WebSocket error:', event);
      // WebSocket error events don't contain useful info, just log connection failed
      this.trigger('error', 'Connection error');
    };
    
    return this;
  }
  
  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }
    
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[SocketClient] Max reconnection attempts reached');
      this.trigger('reconnect_failed');
      return;
    }
    
    this.reconnectAttempts++;
    
    // Exponential backoff with jitter
    const baseDelay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay + jitter, this.maxReconnectDelay);
    
    console.log(`[SocketClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.trigger('reconnecting', { attempt: this.reconnectAttempts, delay });
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.roomCode);
    }, delay);
  }
  
  /**
   * Reset reconnection counter (call after successful operations)
   */
  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
  }

  /**
   * Handle incoming message and trigger appropriate handlers
   */
  handleMessage(data) {
    const { type, ...payload } = data;
    
    // Call any handlers first (like Socket.IO's onAny)
    this.anyHandlers.forEach(handler => {
      handler(type, payload);
    });
    
    // Handle one-time handlers
    if (this.oneTimeHandlers.has(type)) {
      const handlers = this.oneTimeHandlers.get(type);
      handlers.forEach(handler => this.callHandler(handler, type, payload));
      this.oneTimeHandlers.delete(type);
    }
    
    // Handle regular event handlers
    if (this.eventHandlers.has(type)) {
      const handlers = this.eventHandlers.get(type);
      handlers.forEach(handler => this.callHandler(handler, type, payload));
    }
  }

  /**
   * Call handler with appropriate arguments based on payload structure
   */
  callHandler(handler, type, payload) {
    // If payload has 'args' array, spread them (for positional args)
    if (payload.args && Array.isArray(payload.args)) {
      handler(...payload.args);
    }
    // If payload has single 'value', pass it directly
    else if (payload.value !== undefined) {
      handler(payload.value);
    }
    // If payload is empty object, call with no args
    else if (Object.keys(payload).length === 0) {
      handler();
    }
    // Otherwise, pass the payload object directly for destructuring
    else {
      handler(payload);
    }
  }

  /**
   * Register a handler for all events (like Socket.IO onAny)
   * @param {Function} handler - Handler function(eventName, ...args)
   */
  onAny(handler) {
    this.anyHandlers.push(handler);
    return this;
  }

  /**
   * Remove an onAny handler
   */
  offAny(handler) {
    const index = this.anyHandlers.indexOf(handler);
    if (index !== -1) {
      this.anyHandlers.splice(index, 1);
    }
    return this;
  }

  /**
   * Register an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return this;
  }

  /**
   * Register a one-time event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  once(event, handler) {
    if (!this.oneTimeHandlers.has(event)) {
      this.oneTimeHandlers.set(event, []);
    }
    this.oneTimeHandlers.get(event).push(handler);
    return this;
  }

  /**
   * Remove an event handler
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function (optional, removes all if not provided)
   */
  off(event, handler) {
    if (handler && this.eventHandlers.has(event)) {
      const handlers = this.eventHandlers.get(event);
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    } else {
      this.eventHandlers.delete(event);
    }
    return this;
  }

  /**
   * Emit an event to the server
   * @param {string} event - Event name
   * @param  {...any} args - Event arguments
   */
  emit(event, ...args) {
    // Build payload - preserve positional arguments for Socket.IO compatibility
    let payload = {};
    
    if (args.length === 0) {
      // No arguments
      payload = {};
    } else if (args.length === 1) {
      const arg = args[0];
      if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
        // Single object argument - merge into payload
        payload = arg;
      } else {
        // Single primitive or array
        payload = { value: arg };
      }
    } else {
      // Multiple arguments - store as args array
      payload = { args: args };
    }
    
    const message = JSON.stringify({ type: event, ...payload });
    
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      // Queue message for when connection is established
      this.pendingMessages.push(message);
    }
    
    return this;
  }

  /**
   * Trigger local event handlers
   */
  trigger(event, ...args) {
    if (this.eventHandlers.has(event)) {
      this.eventHandlers.get(event).forEach(handler => handler(...args));
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect() {
    // Clear any pending timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
    
    // Prevent automatic reconnection
    this.reconnectAttempts = this.maxReconnectAttempts;
    
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnect trigger
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
    return this;
  }
  
  /**
   * Force reconnect - resets attempts and tries immediately
   */
  forceReconnect() {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect(this.roomCode);
    return this;
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection latency via ping
   * @param {Function} callback - Callback with latency in ms
   */
  ping(callback) {
    if (!this.isConnected()) {
      callback(null);
      return;
    }
    
    const start = Date.now();
    const handler = () => {
      const latency = Date.now() - start;
      callback(latency);
    };
    
    this.once('pong', handler);
    this.emit('ping');
  }
}

// Compatibility layer: Create a global 'io' function like Socket.IO
window.io = function(url, options = {}) {
  // Extract room from URL if present, otherwise use 'lobby'
  const socket = new SocketClient(options);
  
  // Auto-connect is deferred - call socket.connect(roomCode) to connect
  // For backwards compatibility, we'll connect to lobby by default
  // The app should call socket.connect(roomCode) when joining a room
  
  return socket;
};

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SocketClient };
}
