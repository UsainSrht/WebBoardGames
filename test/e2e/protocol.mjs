import assert from 'node:assert/strict';

// End-to-end protocol test. Start the app first (npm run dev) and run: npm run test:e2e
const PORT = process.env.PORT || 8787;
const HTTP = `http://127.0.0.1:${PORT}`;
let n = 0;

function client(room, name) {
  const odId = `${name.toLowerCase()}-${String(++n).padStart(8, '0')}`;
  const secret = ('secret-' + name).padEnd(24, 'x');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}`);
  const msgs = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    if (m.type === 'request-user-id') ws.send(JSON.stringify({ type: 'send-user-id', odId, name, secret }));
    waiters.forEach(w => w(m));
  };
  const wait = (type, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const hit = [...msgs].reverse().find(m => m.type === type && pred(m));
    if (hit) return res(hit);
    const t = setTimeout(() => rej(new Error(`timeout ${type} (${name}); got ${[...new Set(msgs.map(m => m.type))]}`)), ms);
    waiters.push((m) => { if (m.type === type && pred(m)) { clearTimeout(t); res(m); } });
  });
  const next = (type, pred = () => true, ms = 4000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout next ${type} (${name})`)), ms);
    waiters.push((m) => { if (m.type === type && pred(m)) { clearTimeout(t); res(m); } });
  });
  const send = (type, p = {}) => ws.send(JSON.stringify({ type, ...p }));
  const stateWith = (pred) => wait('room-state', pred);
  return { ws, msgs, wait, next, send, id: odId, stateWith, name };
}

async function room(code, names, hostSpectates = false) {
  const cs = names.map((nm) => client(code, nm));
  for (const c of cs) await c.wait('connect-user');
  cs[0].send('join-room', { spectate: hostSpectates });
  await cs[0].stateWith((s) => s.players.length === 1);
  for (const c of cs.slice(1)) {
    c.send('join-room', {});
    await c.stateWith((s) => s.players.some(p => p.id === c.id));
  }
  return cs;
}

// ---------------------------------------------------------- roles + host powers
{
  const [a, b, c] = await room('ROLE01', ['Host', 'Bob', 'Cat'], true);
  const s = await a.stateWith((st) => st.players.length === 3);
  assert.equal(s.host, a.id);
  assert.equal(s.players.find(p => p.id === a.id).spectator, true, 'host joined as spectator');
  assert.equal(s.players.find(p => p.id === b.id).spectator, false);
  // a non-host cannot join as spectator even if asking
  const d = client('ROLE01', 'Dan');
  await d.wait('connect-user');
  d.send('join-room', { spectate: true });
  const sd = await d.stateWith((st) => st.players.some(p => p.id === d.id));
  assert.equal(sd.players.find(p => p.id === d.id).spectator, false, 'only host may spectate');
  d.send('leave-room');
  await a.stateWith((st) => st.players.length === 3);

  // non-host cannot pick game / start / kick
  b.send('select-game', { game: 'chess' });
  await b.wait('error');
  b.send('start-game');
  await b.next('error');
  b.send('kick-player', { kickedUserId: c.id });
  await b.next('error');

  // host picks chess; blocker none for 2 players
  a.send('select-game', { game: 'chess' });
  const picked = await a.stateWith((st) => st.game === 'chess');
  assert.equal(picked.blocker, null);

  // ready flow ignores the spectating host
  b.send('toggle-ready');
  c.send('toggle-ready');
  await a.wait('game-started');
  a.send('spectate-ready');
  const cs = await a.wait('chess-state');
  assert.equal(cs.legal.length, 20);
  assert.ok([b.id, c.id].includes(cs.white) && [b.id, c.id].includes(cs.black), 'only players are seated');

  // players cannot end the game, host can
  b.send('end-game');
  await b.next('error');
  a.send('end-game');
  await b.wait('back-to-lobby');
  console.log('roles + chess spectator OK');

  // force start dice with host (spectator) -> b only ready; start-game ignores ready
  a.send('select-game', { game: 'dice' });
  await a.stateWith((st) => st.game === 'dice');
  a.send('start-game');
  await b.wait('game-started', () => true);
  a.send('spectate-ready');
  const ds = await a.wait('dice-state');
  assert.equal(Object.keys(ds.players).length, 2, 'host not in dice players');

  // restart
  const before = b.msgs.filter(m => m.type === 'game-started').length;
  a.send('restart-game');
  await b.next('game-started');
  assert.equal(b.msgs.filter(m => m.type === 'game-started').length, before + 1);
  a.send('end-game');
  await a.wait('back-to-lobby');
  console.log('dice force-start + restart OK');

  // uno spectator view has no hand
  a.send('select-game', { game: 'uno' });
  await a.stateWith((st) => st.game === 'uno');
  a.send('start-game');
  await a.next('game-started');
  a.send('spectate-ready');
  const us = await a.wait('uno-state');
  assert.deepEqual(us.hand, []);
  assert.equal(us.players.length, 2);
  b.send('uno-page-loaded'); c.send('uno-page-loaded');
  const ub = await b.wait('uno-state', (m) => m.deadline > 0);
  assert.equal(ub.hand.length, 7);
  a.send('end-game');
  await a.wait('back-to-lobby');
  console.log('uno spectator OK');

  // hamsterball spectator init
  a.send('select-game', { game: 'hamsterball' });
  await a.stateWith((st) => st.game === 'hamsterball');
  a.send('start-game');
  await a.next('game-started');
  a.send('spectate-ready');
  const init = await a.wait('init');
  assert.equal(init.id, null);
  assert.equal(init.spectator, true);
  a.send('end-game');
  await a.wait('back-to-lobby');
  console.log('hamsterball spectator OK');

  // transfer host + kick
  a.send('transfer-host', { id: b.id });
  const th = await a.stateWith((st) => st.host === b.id);
  assert.equal(th.players.find(p => p.id === a.id).spectator, false, 'old host regains a seat');
  b.send('kick-player', { kickedUserId: c.id });
  await c.wait('you-got-kicked');
  const after = await b.stateWith((st) => st.players.length === 2);
  assert.ok(!after.players.some(p => p.id === c.id));
  // a kicked player cannot come back
  const c2 = client('ROLE01', 'Cat');
  c.ws.close();
  console.log('transfer host + kick OK');
}

// ---------------------------------------------------- kingdomino replay for host view
{
  const [h, p] = await room('KING01', ['Boss', 'Pia'], true);
  h.send('select-game', { game: 'kingdomino' });
  await h.stateWith((s) => s.game === 'kingdomino');
  p.send('toggle-ready');
  await h.wait('game-started');
  p.send('kingdomino-create-finish');
  await p.wait('kingdomino-game-start');
  await p.wait('kingdomino-draw-tiles');
  // host view loads late and replays the log
  h.send('spectate-ready');
  const start = await h.wait('kingdomino-game-start');
  assert.equal(Object.keys(start.players).length, 1);
  await h.wait('kingdomino-draw-tiles');
  await h.wait('kingdomino-turn-info');
  // a player reload also replays
  const before = p.msgs.filter(m => m.type === 'kingdomino-game-start').length;
  p.send('kingdomino-create-finish');
  await p.next('kingdomino-game-start');
  assert.equal(p.msgs.filter(m => m.type === 'kingdomino-game-start').length, before + 1);
  console.log('kingdomino replay OK');
}

// ---------------------------------------------------- misc API
{
  const info = await (await fetch(`${HTTP}/api/room/check?code=KING01`)).json();
  assert.equal(info.exists, true);
  assert.equal(info.started, true);
  const none = await (await fetch(`${HTTP}/api/room/check?code=ZZZZZZ`)).json();
  assert.equal(none.exists, false);
  const games = await (await fetch(`${HTTP}/api/games`)).json();
  assert.equal(games.chess.icon, 'chess');
  assert.ok(!/[^\x00-\x7F]/.test(JSON.stringify(games)), 'no emoji in game catalogue');
  console.log('API OK');
}
console.log('ALL OK');
process.exit(0);
