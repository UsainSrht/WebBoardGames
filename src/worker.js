/**
 * Cloudflare Worker entry point.
 * Routes WebSocket connections to per-room Durable Objects and serves a small JSON API.
 * Static files are served by the [assets] binding (see wrangler.toml).
 */

import { GAME_CONFIGS } from './games/config.js';

export { GameRoom } from './durable-objects/GameRoom.js';

const ROOM_CODE_RE = /^[A-Z0-9]{1,16}$/;

function normalizeRoomCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return handleWebSocket(request, env, url);
    }

    if (url.pathname === '/robots.txt') return robotsTxt(url.origin);
    if (url.pathname === '/sitemap.xml') return sitemapXml(url.origin);

    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      const isHome = url.pathname === '/' || url.pathname === '/index.html';
      if (isHome && request.method === 'GET' && response.headers.get('Content-Type')?.includes('text/html')) {
        return absolutizeUrls(response, url.origin);
      }
      return response;
    }
    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Canonical / Open Graph tags need absolute URLs. The HTML marks them with
 * `data-abs` and uses site-relative values, so the same build works on any domain.
 */
function absolutizeUrls(response, origin) {
  const fix = (attr) => ({
    element(el) {
      const value = el.getAttribute(attr);
      if (value) el.setAttribute(attr, new URL(value, origin).href);
    }
  });
  return new HTMLRewriter()
    .on('link[data-abs]', fix('href'))
    .on('meta[data-abs]', fix('content'))
    .transform(response);
}

function robotsTxt(origin) {
  const body = ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /ws', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

function sitemapXml(origin) {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
  });
}

function getRoomStub(env, roomCode) {
  return env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomCode));
}

async function handleWebSocket(request, env, url) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const roomCode = url.searchParams.has('room')
    ? normalizeRoomCode(url.searchParams.get('room'))
    : 'LOBBY';
  if (!roomCode) {
    return new Response('Invalid room code', { status: 400 });
  }

  return getRoomStub(env, roomCode).fetch(request);
}

async function handleAPI(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (url.pathname === '/api/games') {
    return json(GAME_CONFIGS);
  }

  if (url.pathname === '/api/room/check') {
    const roomCode = normalizeRoomCode(url.searchParams.get('code'));
    if (!roomCode) {
      return json({ error: 'Valid room code required' }, 400);
    }
    const response = await getRoomStub(env, roomCode).fetch(new Request('http://internal/status'));
    return json(await response.json());
  }

  return json({ error: 'Not found' }, 404);
}
