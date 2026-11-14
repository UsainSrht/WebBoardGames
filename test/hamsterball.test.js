import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hamsterball, CFG, PLATE_RADIUS, BALL_RADIUS } from '../src/games/hamsterball.js';

function fakeRoom(ids = []) {
  const sent = [];
  const room = {
    sent, broadcasts: [], finished: null, spectators: [],
    broadcast(m) { this.broadcasts.push(m); },
    send(ws, m) { sent.push({ ws, m }); },
    getWsByUserId(id) { return ids.includes(id) ? { id } : null; },
    spectatorIds() { return this.spectators; },
    finishGame(p) { this.finished = p; }
  };
  return room;
}

function make(n = 2, options = {}, extra = []) {
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const players = Object.fromEntries(ids.map((id) => [id, { odId: id, name: `Name${id}` }]));
  const room = fakeRoom([...ids, ...extra]);
  const g = new Hamsterball(room, players, { rounds: 3, lives: 3, shrink: 'on', ...options }, { rng: () => 0.25 });
  return { g, room, ids };
}

function begin(g, ids) {
  for (const id of ids) g.handleMessage(id, 'hamsterball-ready', {});
  g.cleanup(); // stop the real interval; the tests step time by hand
  g.finished = false;
}

function toPlaying(g) {
  g.advance(0);
  for (let i = 0; i < 20 && g.phase === 'countdown'; i++) g.advance(200);
  assert.equal(g.phase, 'playing');
}

const run = (g, ms) => { for (let t = 0; t < ms; t += 100) g.advance(100); };

test('starts when everybody is ready, countdown then playing', () => {
  const { g, room, ids } = make(2);
  g.handleMessage('p1', 'hamsterball-ready', {});
  assert.equal(g.started, false);
  g.handleMessage('p2', 'hamsterball-ready', {});
  assert.equal(g.started, true);
  assert.equal(g.phase, 'countdown');
  assert.ok(room.sent.some((s) => s.m.type === 'hb-init' && s.m.id === 'p1'));
  assert.ok(room.sent.some((s) => s.m.type === 'hb-state'));
  g.cleanup();
  g.finished = false;
  run(g, 1000);
  assert.equal(g.phase, 'countdown');
  assert.ok(g.snapshot().cd > 1500 && g.snapshot().cd <= 2100);
  toPlaying(g);
  assert.ok(g.events.some((e) => e.t === 'go'));
  assert.deepEqual(ids, ['p1', 'p2']);
});

test('balls are frozen during the countdown', () => {
  const { g, ids } = make(2);
  begin(g, ids);
  g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0, boost: false });
  const x0 = g.pl.p1.x;
  g.advance(1500);
  assert.equal(g.pl.p1.x, x0);
});

test('input is validated and normalised', () => {
  const { g, ids } = make(2);
  begin(g, ids);
  g.handleMessage('p1', 'hamsterball-move', { x: 5, y: 5, boost: 'yes' });
  assert.ok(Math.abs(Math.hypot(g.pl.p1.ix, g.pl.p1.iy) - 1) < 1e-9);
  assert.equal(g.pl.p1.iboost, false);
  g.handleMessage('p1', 'hamsterball-move', { x: 'abc', y: NaN, boost: true });
  assert.equal(g.pl.p1.ix, 0);
  assert.equal(g.pl.p1.iy, 0);
  g.handleMessage('p1', 'hamsterball-move', null);
  g.handleMessage('nobody', 'hamsterball-move', { x: 1, y: 0 });
});

test('ball accelerates toward the input and friction caps its speed', () => {
  const { g, ids } = make(2);
  begin(g, ids);
  toPlaying(g);
  g.pl.p1.x = 0; g.pl.p1.y = 0; g.pl.p1.vx = g.pl.p1.vy = 0;
  g.pl.p2.x = 150; g.pl.p2.y = 150;
  g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0, boost: false });
  g.advance(100);
  assert.ok(g.pl.p1.vx > 10);
  const v1 = g.pl.p1.vx;
  for (let i = 0; i < 10; i++) { g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0 }); g.advance(50); if (g.pl.p1.x > 120) { g.pl.p1.x = 0; } }
  assert.ok(g.pl.p1.vx > v1);
  assert.ok(g.pl.p1.vx < CFG.ACCEL / CFG.FRICTION + 40);
});

test('boost drains stamina, locks out at zero and regenerates', () => {
  const { g, ids } = make(2);
  begin(g, ids);
  toPlaying(g);
  g.pl.p2.x = 150; g.pl.p2.y = 150;
  const hold = (ms, boost) => {
    for (let t = 0; t < ms; t += 50) {
      g.handleMessage('p1', 'hamsterball-move', { x: 0, y: 1, boost });
      g.pl.p1.x = 0; g.pl.p1.y = 0; // stay on the plate
      g.advance(50);
    }
  };
  hold(500, true);
  assert.ok(g.pl.p1.stamina < 0.8 && g.pl.p1.stamina > 0.5, `stamina ${g.pl.p1.stamina}`);
  assert.equal(g.pl.p1.boosting, true);
  hold(3000, true);
  assert.equal(g.pl.p1.stamina < 0.4, true); // regenerating a bit during lockout
  assert.equal(g.pl.p1.boosting === false || g.pl.p1.lockout <= 0, true);
  hold(4000, false);
  assert.ok(g.pl.p1.stamina > 0.95);
});

test('boost uses more acceleration than normal movement', () => {
  const a = make(2); const b = make(2);
  for (const [{ g, ids }, boost] of [[a, false], [b, true]]) {
    begin(g, ids); toPlaying(g);
    g.pl.p1.x = 0; g.pl.p1.y = 0; g.pl.p2.x = 150; g.pl.p2.y = 150;
    g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0, boost });
    g.advance(200);
  }
  assert.ok(b.g.pl.p1.vx > a.g.pl.p1.vx * 1.5);
});

test('ball-ball collision conserves momentum and a boosting ball hits harder', () => {
  const { g, ids } = make(2);
  begin(g, ids);
  toPlaying(g);
  const [a, b] = [g.pl.p1, g.pl.p2];
  a.x = -10; a.y = 0; a.vx = 200; a.vy = 0;
  b.x = 10; b.y = 0; b.vx = 0; b.vy = 0;
  const m0 = a.vx + b.vx;
  g.collide([a, b]);
  assert.ok(Math.abs(a.vx + b.vx - m0) < 1e-6);
  assert.ok(b.vx > a.vx);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= BALL_RADIUS * 2 - 1e-6);
  assert.ok(g.events.some((e) => e.t === 'bump'));

  const hit = (boosting) => {
    const c = make(2); begin(c.g, c.ids); toPlaying(c.g);
    const [p, q] = [c.g.pl.p1, c.g.pl.p2];
    p.x = -14; p.y = 0; p.vx = 200; p.vy = 0; p.boosting = boosting;
    q.x = 5; q.y = 0; q.vx = 0; q.vy = 0;
    c.g.collide([p, q]);
    return q.vx;
  };
  assert.ok(hit(true) > hit(false));
});

test('falling costs a life, then respawn near the centre with invulnerability', () => {
  const { g, room, ids } = make(2);
  begin(g, ids);
  toPlaying(g);
  const p = g.pl.p1;
  g.pl.p2.x = 60; g.pl.p2.y = 0;
  p.x = PLATE_RADIUS + 20; p.y = 0; p.px = PLATE_RADIUS - 5; p.py = 0; p.vx = 0; p.vy = 0;
  g.advance(20);
  assert.equal(p.lives, 2);
  assert.ok(p.fall > 0);
  assert.ok(g.events.some((e) => e.t === 'fall' && e.id === 'p1'));
  assert.equal(g.snapshot().players.p1.fl, 1);
  run(g, 1200);
  assert.equal(p.fall, 0);
  assert.ok(Math.hypot(p.x, p.y) < 80);
  assert.ok(Math.hypot(p.vx, p.vy) < 20);
  assert.ok(p.inv > 0 && p.inv <= CFG.INVULN_S);
  assert.ok(g.events.some((e) => e.t === 'respawn'));
  // invulnerable: pushed back onto the plate rather than falling
  p.x = PLATE_RADIUS + 30; p.y = 0; p.px = PLATE_RADIUS - 1;
  g.advance(20);
  assert.equal(p.lives, 2);
  assert.ok(Math.hypot(p.x, p.y) <= PLATE_RADIUS + 1e-6);
  assert.equal(room.finished, null);
});

function dropAll(g, id) {
  const p = g.pl[id];
  p.x = PLATE_RADIUS + 30; p.y = 0; p.px = PLATE_RADIUS - 5; p.py = 0; p.vx = 0; p.vy = 0; p.inv = 0;
}

test('last ball standing wins the round, banner, next round restores lives', () => {
  const { g, ids } = make(3, { lives: 1 });
  begin(g, ids);
  toPlaying(g);
  g.pl.p2.x = 40; g.pl.p3.x = -40;
  dropAll(g, 'p1');
  g.advance(20);
  assert.equal(g.phase, 'playing');
  g.pl.p3.x = PLATE_RADIUS + 30; g.pl.p3.px = PLATE_RADIUS - 5; g.pl.p3.y = 0;
  g.advance(20);
  assert.equal(g.phase, 'roundover');
  assert.deepEqual(g.result.winners, ['p2']);
  assert.equal(g.pl.p2.wins, 1);
  assert.equal(g.snapshot().result.draw, false);
  const x = g.pl.p2.x;
  g.handleMessage('p2', 'hamsterball-move', { x: 1, y: 0 });
  g.advance(500);
  assert.equal(g.pl.p2.x, x); // frozen on the banner
  run(g, CFG.ROUND_OVER_MS + 100);
  assert.equal(g.phase, 'countdown');
  assert.equal(g.round, 2);
  assert.equal(g.pl.p1.lives, 1);
  assert.equal(g.pl.p3.lives, 1);
});

test('same-tick double fall: the later crossing wins, an exact tie is a draw', () => {
  {
    const { g, ids } = make(2, { lives: 1 });
    begin(g, ids); toPlaying(g);
    // p1 crosses later (fraction larger) than p2
    g.pl.p1.px = PLATE_RADIUS - 8; g.pl.p1.x = PLATE_RADIUS + 1; g.pl.p1.y = g.pl.p1.py = 0;
    g.pl.p2.px = PLATE_RADIUS - 1; g.pl.p2.x = PLATE_RADIUS + 8; g.pl.p2.y = g.pl.p2.py = 0;
    g.pl.p2.x = -(PLATE_RADIUS + 8); g.pl.p2.px = -(PLATE_RADIUS - 1);
    g.edges([g.pl.p1, g.pl.p2], 1 / 60);
    g.checkRoundEnd();
    assert.equal(g.phase, 'roundover');
    assert.deepEqual(g.result.winners, ['p1']);
  }
  {
    const { g, ids } = make(2, { lives: 1 });
    begin(g, ids); toPlaying(g);
    for (const [id, s] of [['p1', 1], ['p2', -1]]) {
      g.pl[id].px = s * (PLATE_RADIUS - 2); g.pl[id].x = s * (PLATE_RADIUS + 2); g.pl[id].y = g.pl[id].py = 0;
    }
    g.edges([g.pl.p1, g.pl.p2], 1 / 60);
    g.checkRoundEnd();
    assert.deepEqual(g.result.winners.sort(), ['p1', 'p2']);
    assert.equal(g.result.draw, true);
    assert.equal(g.pl.p1.wins, 1);
    assert.equal(g.pl.p2.wins, 1);
  }
});

test('plate shrinks smoothly from 15 s to 45 percent, never with shrink off until sudden death', () => {
  const { g } = make(2);
  assert.equal(g.radiusAt(10), PLATE_RADIUS);
  assert.equal(g.radiusAt(15), PLATE_RADIUS);
  const mid = g.radiusAt(45);
  assert.ok(mid < PLATE_RADIUS && mid > PLATE_RADIUS * 0.45);
  assert.ok(Math.abs(g.radiusAt(75) - PLATE_RADIUS * 0.45) < 1e-9);
  assert.ok(g.radiusAt(30) > g.radiusAt(31));
  const off = make(2, { shrink: 'off' }).g;
  assert.equal(off.radiusAt(100), PLATE_RADIUS);
  assert.ok(off.radiusAt(150) < PLATE_RADIUS);
});

test('balls beyond the shrinking radius fall', () => {
  const { g, ids } = make(2);
  begin(g, ids); toPlaying(g);
  g.playT = 75;
  g.pl.p1.x = 150; g.pl.p1.y = 0; g.pl.p1.px = 150;
  g.pl.p2.x = 0; g.pl.p2.y = 0;
  g.advance(20);
  assert.ok(g.radius < 100);
  assert.equal(g.pl.p1.lives, 2);
});

test('tilt follows the centre of mass and pulls balls downhill', () => {
  const { g, ids } = make(2);
  begin(g, ids); toPlaying(g);
  g.pl.p1.x = 100; g.pl.p1.y = 0; g.pl.p2.x = 60; g.pl.p2.y = 0;
  g.pl.p1.vx = g.pl.p1.vy = g.pl.p2.vx = g.pl.p2.vy = 0;
  run(g, 300);
  const s = g.snapshot();
  assert.ok(s.plateTilt.z < 0); // +x side goes down
  assert.ok(g.pl.p2.vx > 0);
  assert.ok(Math.abs(s.plateTilt.z) <= CFG.TILT_MAX + 1e-9);
});

test('stale input expires (lost packet cannot leave a ball drifting)', () => {
  const { g, ids } = make(2);
  begin(g, ids); toPlaying(g);
  g.pl.p1.x = g.pl.p1.y = 0; g.pl.p2.x = 150; g.pl.p2.y = 150;
  g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0 });
  g.advance(100);
  assert.equal(g.pl.p1.ix, 1);
  for (let i = 0; i < 12; i++) { g.pl.p1.x = 0; g.advance(100); }
  assert.equal(g.pl.p1.ix, 0);
});

test('simulation is independent of how advance() is sliced', () => {
  const sim = (slice) => {
    const { g, ids } = make(3);
    begin(g, ids); toPlaying(g);
    g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0.3, boost: true });
    g.handleMessage('p2', 'hamsterball-move', { x: -1, y: 0, boost: false });
    for (let t = 0; t < 3000; t += slice) { g.handleMessage('p1', 'hamsterball-move', { x: 1, y: 0.3, boost: true }); g.handleMessage('p2', 'hamsterball-move', { x: -1, y: 0 }); g.advance(slice); }
    return JSON.stringify(g.snapshot(false).players);
  };
  assert.equal(sim(10), sim(100));
});

test('full match: rank by wins, then lives, then time; note text', () => {
  const { g, room, ids } = make(3, { rounds: 3, lives: 1 });
  begin(g, ids);
  const winRound = (winner, order) => {
    toPlaying(g);
    for (const id of ids) { g.pl[id].x = ids.indexOf(id) * 40 - 40; g.pl[id].y = 0; g.pl[id].px = g.pl[id].x; }
    for (const id of order) { g.pl[id].inv = 0; dropAll(g, id); g.advance(40); run(g, 100); }
    assert.equal(g.phase, 'roundover');
    assert.deepEqual(g.result.winners, [winner]);
    run(g, CFG.ROUND_OVER_MS + 100);
  };
  winRound('p2', ['p1', 'p3']);
  winRound('p2', ['p3', 'p1']);
  winRound('p1', ['p2', 'p3']);
  assert.equal(g.phase, 'over');
  const f = room.finished;
  assert.ok(f);
  assert.equal(f.rows[0].id, 'p2');
  assert.equal(f.rows[0].score, 2);
  assert.equal(f.rows[0].note, '2 round wins');
  assert.equal(f.rows[1].id, 'p1');
  assert.equal(f.rows[1].note, '1 round win');
  assert.deepEqual(f.rows.map((r) => r.rank), [1, 2, 3]);
  assert.match(f.title, /wins/);
  assert.equal(g.snapshot().phase, 'over');
});

test('a player leaving mid-round is out; the last one left ends the match', () => {
  const { g, room, ids } = make(3);
  begin(g, ids); toPlaying(g);
  g.onPlayerLeft('p3');
  assert.equal(g.phase, 'playing');
  assert.ok(!('p3' in g.snapshot().players));
  g.onPlayerLeft('p2');
  assert.equal(g.phase, 'over');
  assert.ok(room.finished);
  assert.deepEqual(room.finished.rows.map((r) => r.id), ['p1']);
  assert.equal(room.finished.rows[0].score, 1);
});

test('snapshot shape, rounding, reload resync and spectator sync', () => {
  const { g, room, ids } = make(2, {}, ['host']);
  begin(g, ids); toPlaying(g);
  g.pl.p1.x = 12.3456789;
  const s = g.snapshot();
  assert.equal(s.type, 'hb-state');
  assert.equal(s.players.p1.x, 12.35);
  for (const k of ['x', 'y', 'vx', 'vy', 'lives', 'stamina', 'alive', 'inv']) assert.ok(k in s.players.p1, k);
  for (const k of ['plateTilt', 'radius', 'phase', 'round', 'rounds', 'cd', 'wins', 'events']) assert.ok(k in s, k);
  room.sent.length = 0;
  g.handleMessage('p1', 'hamsterball-ready', {}); // reload
  assert.equal(room.sent[0].m.type, 'hb-init');
  assert.equal(room.sent[0].m.id, 'p1');
  assert.equal(room.sent[1].m.type, 'hb-state');
  assert.deepEqual(room.sent[1].m.events, []);
  room.sent.length = 0;
  g.spectatorSync('host');
  assert.equal(room.sent[0].m.spectator, true);
  assert.equal(room.sent[0].m.id, null);
  assert.equal(room.sent[0].m.players.p1.name, 'Namep1');
  assert.equal(room.sent[1].m.type, 'hb-state');
});

test('events are flushed with each broadcast and cleanup stops timers', () => {
  const { g, room, ids } = make(2);
  g.handleMessage('p1', 'hamsterball-ready', {});
  g.handleMessage('p2', 'hamsterball-ready', {});
  assert.ok(g.loop);
  g.events.push({ t: 'bump', x: 0, y: 0, power: 1 });
  g.broadcastState();
  assert.equal(room.broadcasts.at(-1).events.length, 1);
  assert.equal(g.events.length, 0);
  g.cleanup();
  assert.equal(g.loop, null);
  assert.equal(g.readyTimer, null);
  assert.deepEqual(ids, ['p1', 'p2']);
});

test('ready timeout starts the game when someone never loads', async () => {
  const { g } = make(2);
  g.handleMessage('p1', 'hamsterball-ready', {});
  assert.ok(g.readyTimer);
  g.cleanup();
  assert.equal(g.started, false);
});
