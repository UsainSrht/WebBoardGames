/**
 * Cloudflare Worker entry point
 * Handles WebSocket connections for multiplayer games
 */

export { GameRoom } from './durable-objects/GameRoom.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // WebSocket upgrade requests go to Durable Objects
    if (url.pathname === '/ws') {
      return handleWebSocket(request, env);
    }
    
    // API endpoints
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }
    
    // Static files are handled by [assets] in wrangler.toml
    // The ASSETS binding is automatically available when assets directory is configured
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    
    // Fallback for when ASSETS is not available
    return new Response('Not Found', { status: 404 });
  }
};

async function handleWebSocket(request, env) {
  const url = new URL(request.url);
  const roomCode = url.searchParams.get('room') || 'lobby';
  
  // Get the Durable Object for this room
  const id = env.GAME_ROOMS.idFromName(roomCode);
  const room = env.GAME_ROOMS.get(id);
  
  // Forward the WebSocket request to the Durable Object
  return room.fetch(request);
}

async function handleAPI(request, env, url) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // API: Get game configurations
  if (url.pathname === '/api/games') {
    const gameDatas = {
      "rock-paper-scissors": { min: 2, max: 12, name: "Rock Paper Scissors", icon: "🪨" },
      "dice": { min: 2, max: 12, name: "Dice", icon: "🎲" },
      "kingdomino": { min: 1, max: 4, name: "Kingdomino", icon: "👑" },
      "uno": { min: 2, max: 10, name: "Uno", icon: "🃏" },
      "hamsterball": { min: 1, max: 12, name: "Hamsterball", icon: "🐹" },
      "chess": { min: 2, max: 2, name: "Chess", icon: "♟️" }
    };
    return new Response(JSON.stringify(gameDatas), { headers });
  }

  // API: Check if room exists
  if (url.pathname === '/api/room/check') {
    const roomCode = url.searchParams.get('code');
    if (!roomCode) {
      return new Response(JSON.stringify({ error: 'Room code required' }), { 
        status: 400, headers 
      });
    }
    
    const id = env.GAME_ROOMS.idFromName(roomCode);
    const room = env.GAME_ROOMS.get(id);
    
    // Ask the Durable Object if it exists and has players
    const response = await room.fetch(new Request('http://internal/status'));
    const data = await response.json();
    
    return new Response(JSON.stringify(data), { headers });
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { 
    status: 404, headers 
  });
}
