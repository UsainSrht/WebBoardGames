export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const roomCode = url.searchParams.get('code');
  
  if (!roomCode) {
    return new Response(JSON.stringify({ error: 'Room code required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const id = env.GAME_ROOMS.idFromName(roomCode);
  const room = env.GAME_ROOMS.get(id);
  
  const response = await room.fetch(new Request('http://internal/status'));
  const data = await response.json();
  
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
