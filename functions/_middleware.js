import { GameRoom } from '../src/durable-objects/GameRoom.js';

// Re-export Durable Object
export { GameRoom };

// This middleware runs for all requests
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // WebSocket upgrade requests go to Durable Objects
  if (url.pathname === '/ws') {
    const roomCode = url.searchParams.get('room') || 'lobby';
    const id = env.GAME_ROOMS.idFromName(roomCode);
    const room = env.GAME_ROOMS.get(id);
    return room.fetch(request);
  }
  
  // Let Pages handle static files
  return context.next();
}
