import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public_html/shared/pool-physics.js';

const { L, W, R } = P;

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const empty = () => new Array(16).fill(null);
const shotOf = (angle, power, x = 0, y = 0) => P.sanitizeShot({ angle, power, spin: { x, y } });

test('sincos matches Math.sin / Math.cos', () => {
  for (let a = -20; a < 20; a += 0.137) {
    const { s, c } = P.sincos(a);
    assert.ok(Math.abs(s - Math.sin(a)) < 1e-12, `sin ${a}`);
    assert.ok(Math.abs(c - Math.cos(a)) < 1e-12, `cos ${a}`);
  }
});

test('rack: eight in the centre, mixed back corners, no overlaps, for many seeds', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = P.rack(seeded(seed));
    assert.equal(r.filter(Boolean).length, 16);
    // slot order (row major): the 8 is in the middle of the third row, the back corners are solid and stripe
    const apex = r.findIndex((p, i) => i > 0 && p && Math.abs(p[0] - P.FOOT_X) < 1e-9);
    assert.ok(apex > 0);
    const eight = r[8];
    assert.ok(Math.abs(eight[0] - (P.FOOT_X + 2 * (Math.sqrt(3) * R + 0.004))) < 1e-6);
    assert.ok(Math.abs(eight[1] - W / 2) < 1e-6);
    const back = [];
    for (let i = 1; i < 16; i++) if (Math.abs(r[i][0] - (P.FOOT_X + 4 * (Math.sqrt(3) * R + 0.004))) < 1e-6) back.push(i);
    assert.equal(back.length, 5);
    const ends = back.filter((i) => Math.abs(r[i][1] - W / 2) > 3.9 * R);
    assert.equal(ends.length, 2);
    assert.notEqual(ends[0] < 8, ends[1] < 8, 'one solid and one stripe in the corners');
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      assert.ok(Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]) >= 2 * R, `overlap ${i} ${j}`);
    }
  }
});

test('sanitizeShot: hostile and out of range input', () => {
  assert.equal(P.sanitizeShot(null), null);
  assert.equal(P.sanitizeShot('x'), null);
  assert.equal(P.sanitizeShot({ angle: NaN, power: 0.5 }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: NaN }), null);
  assert.equal(P.sanitizeShot({ angle: Infinity, power: 0.5 }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: -3 }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: 0 }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: '0.5' }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: 0.5, spin: { x: 'a', y: 0 } }), null);
  assert.equal(P.sanitizeShot({ angle: 1, power: 0.5, spin: { x: NaN, y: 0 } }), null);
  const big = P.sanitizeShot({ angle: 1e9, power: 1e12, spin: { x: 50, y: 50 } });
  assert.equal(big.power, 1);
  assert.ok(Math.hypot(big.spin.x, big.spin.y) <= 1.01);
  assert.ok(big.angle >= 0 && big.angle < 2 * Math.PI);
  const neg = P.sanitizeShot({ angle: -1, power: 0.3 });
  assert.ok(neg.angle > 0 && neg.angle < 2 * Math.PI);
  assert.deepEqual(P.sanitizeShot({ angle: 1, power: 0.3 }).spin, { x: 0, y: 0 });
  assert.throws(() => P.simulateShot(empty(), { angle: NaN, power: 1 }));
});

test('repeatability: the same input gives an identical result', () => {
  const r = P.rack(seeded(3));
  const shot = shotOf(0.01, 1, 0.3, -0.2);
  const a = P.simulateShot(r, shot);
  const b = P.simulateShot(r, shot);
  assert.deepEqual(a, b);
  const c = P.simulateShot(r, { ...shot });
  assert.deepEqual(a.positions, c.positions);
});

test('a shot always comes to rest and leaves legal positions', () => {
  const rng = seeded(11);
  for (let i = 0; i < 25; i++) {
    const r = P.rack(rng);
    const out = P.simulateShot(r, shotOf(rng() * 6.28, 0.2 + rng() * 0.8, rng() * 2 - 1, rng() * 2 - 1));
    assert.ok(out.ticks < P.MAX_TICKS, 'comes to rest by itself');
    const on = out.positions.map((p, k) => [k, p]).filter(([, p]) => p);
    for (const [, p] of on) {
      assert.ok(p[0] >= R - 0.01 && p[0] <= L - R + 0.01 && p[1] >= R - 0.01 && p[1] <= W - R + 0.01, 'inside the cushions');
    }
    for (let a = 0; a < on.length; a++) for (let b = a + 1; b < on.length; b++) {
      const d = Math.hypot(on[a][1][0] - on[b][1][0], on[a][1][1] - on[b][1][1]);
      assert.ok(d >= 2 * R - 0.05, `balls ${on[a][0]} and ${on[b][0]} overlap at rest (${d})`);
    }
    // pocketed balls stay pocketed
    for (const { ball } of out.pocketed) assert.equal(out.positions[ball], null);
  }
});

test('energy never increases, with every kind of spin', () => {
  const rng = seeded(5);
  for (let i = 0; i < 12; i++) {
    const r = P.rack(rng);
    const sim = P.createSim(r, shotOf(rng() * 6.28, 0.3 + rng() * 0.7, rng() * 2 - 1, rng() * 2 - 1));
    let prev = P.energy(sim);
    while (!sim.done) {
      P.stepSim(sim);
      const e = P.energy(sim);
      assert.ok(e <= prev * (1 + 1e-9) + 1e-6, `energy rose from ${prev} to ${e} at tick ${sim.tick}`);
      prev = e;
    }
  }
});

test('no tunnelling at full power: balls stay inside the cushions and never overlap while moving', () => {
  const rng = seeded(21);
  for (let i = 0; i < 10; i++) {
    const r = P.rack(rng);
    r[0] = [100 + rng() * 400, 200 + rng() * 800];
    const aim = Math.atan2(W / 2 - r[0][1], P.FOOT_X - r[0][0]) + (rng() - 0.5) * 0.1;
    const sim = P.createSim(r, shotOf(aim, 1, rng() - 0.5, rng() - 0.5));
    while (!sim.done) {
      P.stepSim(sim);
      const on = sim.balls.filter((b) => b.on);
      for (const b of on) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
        assert.ok(b.x >= R - 1e-6 && b.x <= L - R + 1e-6 && b.y >= R - 1e-6 && b.y <= W - R + 1e-6);
      }
      for (let a = 0; a < on.length; a++) for (let b = a + 1; b < on.length; b++) {
        const d = Math.hypot(on[a].x - on[b].x, on[a].y - on[b].y);
        assert.ok(d > 2 * R - 1.5, `deep overlap ${d} at tick ${sim.tick}`);
      }
    }
  }
});

test('a fast ball does not pass through a resting ball', () => {
  const pos = empty();
  pos[0] = [300, 600];
  pos[5] = [1500, 600];
  const out = P.simulateShot(pos, shotOf(0, 1));
  const hit = out.events.find((e) => e.type === 'hit');
  assert.ok(hit && ((hit.a === 0 && hit.b === 5) || (hit.a === 5 && hit.b === 0)));
  assert.ok(hit.v > 6000);
});

test('head-on collision passes the momentum on (stun shot leaves the cue ball almost still)', () => {
  const pos = empty();
  pos[0] = [600, 635];
  pos[1] = [1200, 635];
  const sim = P.createSim(pos, shotOf(0, 0.5, 0, 0));
  while (sim.tick < 400 && !sim.events.some((e) => e.type === 'hit')) P.stepSim(sim);
  const v0 = sim.events.find((e) => e.type === 'hit').v;
  const [c, o] = [sim.balls[0], sim.balls[1]];
  assert.ok(o.vx > v0 * 0.9, 'object ball takes the speed');
  assert.ok(Math.abs(o.vy) < 1e-6);
  assert.ok(c.vx < v0 * 0.2, 'cue ball nearly stops');
});

test('top spin follows through, back spin draws back', () => {
  const pos = empty();
  pos[0] = [800, 635];
  pos[1] = [1200, 635];
  const stun = P.simulateShot(pos, shotOf(0, 0.55, 0, 0)).positions[0][0];
  const follow = P.simulateShot(pos, shotOf(0, 0.55, 0, 1)).positions[0][0];
  const draw = P.simulateShot(pos, shotOf(0, 0.55, 0, -1)).positions[0][0];
  assert.ok(follow > stun + 150, `follow ${follow} vs stun ${stun}`);
  assert.ok(draw < stun - 150, `draw ${draw} vs stun ${stun}`);
  assert.ok(draw < 1100, 'the draw shot comes back');
});

test('rails: restitution slows the ball and side spin changes the rebound', () => {
  const pos = empty();
  pos[0] = [800, 900];
  const sim = P.createSim(pos, shotOf(Math.PI / 2, 0.5));
  const v0 = sim.balls[0].vy;
  while (!sim.events.some((e) => e.type === 'rail') && !sim.done) P.stepSim(sim);
  const ev = sim.events.find((e) => e.type === 'rail');
  assert.ok(ev && ev.ball === 0);
  assert.ok(sim.balls[0].vy < 0, 'bounced back');
  assert.ok(Math.abs(sim.balls[0].vy) < v0 * 0.76);
  assert.ok(Math.abs(sim.balls[0].vx) < 1, 'no sideways drift without english');

  const spinR = P.createSim(pos, shotOf(Math.PI / 2, 0.5, 1, 0));
  while (!spinR.events.some((e) => e.type === 'rail') && !spinR.done) P.stepSim(spinR);
  const spinL = P.createSim(pos, shotOf(Math.PI / 2, 0.5, -1, 0));
  while (!spinL.events.some((e) => e.type === 'rail') && !spinL.done) P.stepSim(spinL);
  assert.ok(Math.abs(spinR.balls[0].vx) > 20, 'english kicks the ball sideways');
  assert.ok(spinR.balls[0].vx * spinL.balls[0].vx < 0, 'opposite english, opposite kick');
});

test('every pocket captures a ball rolled into it', () => {
  const targets = [
    [[1270, 635], [0, 0], 0], [[1270, 400], [L / 2, 0], 1], [[1270, 635], [L, 0], 2],
    [[1270, 635], [0, W], 3], [[1270, 900], [L / 2, W], 4], [[1270, 635], [L, W], 5]
  ];
  for (const [from, to, pocket] of targets) {
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const cuePos = empty();
    cuePos[0] = [from[0], from[1]];
    const res = P.simulateShot(cuePos, shotOf(angle, 0.5));
    assert.deepEqual(res.pocketed.map((p) => [p.ball, p.pocket]), [[0, pocket]], `pocket ${pocket}`);
    assert.equal(res.positions[0], null);
  }
});

test('a ball that misses the pocket mouth is not captured', () => {
  const pos = empty();
  pos[0] = [1270, 200];
  // runs along the rail well away from the side pocket and stops
  const res = P.simulateShot(pos, shotOf(0, 0.3));
  assert.equal(res.pocketed.length, 0);
});

test('symmetric break: a centre break mirrors across the table axis', () => {
  const r = P.rack(seeded(9));
  r[0] = [P.HEAD_X, W / 2];
  const sim = P.createSim(r, shotOf(0, 0.6));
  while (sim.tick < 40) P.stepSim(sim);
  const on = sim.balls.filter((b) => b.on);
  for (const b of on) {
    const mirror = on.reduce((best, c) => Math.min(best, Math.hypot(c.x - b.x, c.y - (W - b.y))), Infinity);
    assert.ok(mirror < 0.5, `ball ${b.id} has no mirror partner (${mirror})`);
  }
});

test('break: balls spread and stay legal, cue ball keeps moving or stops without errors', () => {
  const r = P.rack(seeded(4));
  const out = P.simulateShot(r, shotOf(0, 1));
  assert.ok(out.events.filter((e) => e.type === 'hit').length >= 10);
  assert.ok(out.events.filter((e) => e.type === 'rail').length >= 4);
});

test('validCue, nearestCue and freeSpot', () => {
  const r = P.rack(seeded(2));
  assert.ok(P.validCue(r, P.HEAD_X, W / 2, true));
  assert.ok(!P.validCue(r, P.HEAD_X + 10, W / 2, true), 'must be behind the head string');
  assert.ok(P.validCue(r, P.HEAD_X + 10, W / 2, false));
  assert.ok(!P.validCue(r, 5, 5), 'outside the cushions');
  assert.ok(!P.validCue(r, NaN, 100));
  assert.ok(!P.validCue(r, 'a', 100));
  assert.ok(!P.validCue(r, r[8][0] + 10, r[8][1]), 'overlapping a ball');
  assert.ok(!P.validCue(r, 45, 45), 'inside a pocket mouth');
  const n = P.nearestCue(r, r[1][0] + 5, r[1][1], false);
  assert.ok(n && P.validCue(r, n.x, n.y, false));
  const m = P.nearestCue(r, 5000, -500, true);
  assert.ok(m && m.x <= P.HEAD_X && P.validCue(r, m.x, m.y, true));
  assert.equal(P.nearestCue(r, NaN, 3), null);
  const spot = P.freeSpot(r, 8);
  assert.ok(spot[0] >= P.FOOT_X);
  const free = P.freeSpot(empty());
  assert.deepEqual(free, [P.FOOT_X, W / 2]);
});

test('aimPreview finds the first ball and the deflections', () => {
  const pos = empty();
  pos[0] = [500, 635];
  pos[4] = [1000, 635];
  const straight = P.aimPreview(pos, { x: 500, y: 635 }, 0);
  assert.equal(straight.hit, 4);
  assert.ok(Math.abs(straight.point.x - (1000 - 2 * R)) < 1e-6);
  assert.ok(Math.abs(straight.objDir.x - 1) < 1e-9);
  assert.ok(straight.cueSpeed < 1e-6);
  const cut = P.aimPreview(pos, { x: 500, y: 635 }, 0.05);
  assert.equal(cut.hit, 4);
  assert.ok(cut.cueDir.y !== 0);
  const miss = P.aimPreview(pos, { x: 500, y: 635 }, Math.PI);
  assert.equal(miss.hit, null);
  assert.ok(Math.abs(miss.point.x - R) < 1e-6);
});

test('a ball that leaves the table is reported (defensive off event)', () => {
  const sim = P.createSim(P.rack(seeded(1)), null);
  sim.balls[3].x = NaN;
  sim.balls[3].vx = 1;
  sim.done = false;
  P.stepSim(sim);
  assert.ok(sim.events.some((e) => e.type === 'off' && e.ball === 3));
  assert.equal(P.snapshot(sim)[3], null);
});
