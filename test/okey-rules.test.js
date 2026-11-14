import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTiles, okeyOf, isJoker, effOf, penaltyValue, arrangeGroup, isPair, solveGroups, isSevenPairs, winKind,
  classicPoints, finishingDiscards, shuffle
} from '../src/games/okey-rules.js';

const T = buildTiles();
// colours: 0 yellow, 1 blue, 2 black, 3 red; the okey in these tests is red 9 (indicator red 8)
const OKEY = { c: 3, v: 9 };
const t = (c, v, set = 0) => T[set * 52 + c * 13 + v - 1];
const J1 = t(3, 9, 0);
const J2 = t(3, 9, 1);
const FAKE = T[104];
const FAKE2 = T[105];

test('tile set: 106 tiles, two of each, two fake okeys', () => {
  assert.equal(T.length, 106);
  assert.equal(new Set(T.map((x) => x.id)).size, 106);
  assert.equal(T.filter((x) => x.f).length, 2);
  for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) assert.equal(T.filter((x) => x.c === c && x.v === v).length, 2);
  assert.deepEqual(T.map((x) => x.id), [...T.keys()]);
});

test('shuffle keeps every tile', () => {
  const ids = shuffle(T.map((x) => x.id), () => 0.3);
  assert.equal(ids.length, 106);
  assert.equal(new Set(ids).size, 106);
});

test('okey is the indicator successor, 13 wraps to 1', () => {
  assert.deepEqual(okeyOf({ c: 2, v: 5 }), { c: 2, v: 6 });
  assert.deepEqual(okeyOf({ c: 0, v: 13 }), { c: 0, v: 1 });
});

test('real tiles equal to the okey are jokers, fakes are plain tiles standing for the okey', () => {
  assert.equal(isJoker(J1, OKEY), true);
  assert.equal(isJoker(J2, OKEY), true);
  assert.equal(isJoker(t(3, 8), OKEY), false);
  assert.equal(isJoker(t(2, 9), OKEY), false);
  assert.equal(isJoker(FAKE, OKEY), false);
  assert.equal(effOf(J1, OKEY), null);
  assert.deepEqual(effOf(FAKE, OKEY), { c: 3, v: 9 });
  assert.deepEqual(effOf(t(1, 4), OKEY), { c: 1, v: 4 });
});

test('runs: three consecutive of one colour', () => {
  assert.equal(arrangeGroup([t(0, 4), t(0, 5), t(0, 6)], OKEY).kind, 'run');
  assert.equal(arrangeGroup([t(0, 6), t(0, 4), t(0, 5)], OKEY).points, 15);
  assert.equal(arrangeGroup([t(0, 4), t(1, 5), t(0, 6)], OKEY), null, 'mixed colours');
  assert.equal(arrangeGroup([t(0, 4), t(0, 5)], OKEY), null, 'too short');
  assert.equal(arrangeGroup([t(0, 4), t(0, 6), t(0, 7)], OKEY), null, 'gap');
  assert.equal(arrangeGroup([t(0, 4, 0), t(0, 4, 1), t(0, 5)], OKEY), null, 'duplicate value');
});

test('1 may follow 13 but runs never wrap further', () => {
  assert.equal(arrangeGroup([t(1, 12), t(1, 13), t(1, 1)], OKEY).kind, 'run');
  assert.equal(arrangeGroup([t(1, 11), t(1, 12), t(1, 13), t(1, 1)], OKEY).kind, 'run');
  assert.equal(arrangeGroup([t(1, 13), t(1, 1), t(1, 2)], OKEY), null);
  assert.equal(arrangeGroup([t(1, 1), t(1, 2), t(1, 3)], OKEY).kind, 'run');
  assert.equal(arrangeGroup([t(1, 12), t(1, 13), t(1, 1)], OKEY).points, 12 + 13 + 14);
  assert.equal(arrangeGroup([t(1, 1), t(1, 2), t(1, 3)], OKEY).points, 6);
  // the longest legal run is 14 long: 1 .. 13 and 1 again
  const long = [];
  for (let v = 1; v <= 13; v++) long.push(t(1, v, 0));
  long.push(t(1, 1, 1));
  assert.equal(arrangeGroup(long, OKEY).kind, 'run');
});

test('sets: 3 or 4 equal values in different colours', () => {
  assert.equal(arrangeGroup([t(0, 7), t(1, 7), t(2, 7)], OKEY).kind, 'set');
  assert.equal(arrangeGroup([t(0, 7), t(1, 7), t(2, 7), t(3, 7)], OKEY).points, 28);
  assert.equal(arrangeGroup([t(0, 7), t(0, 7, 1), t(2, 7)], OKEY), null, 'same colour twice');
  assert.equal(arrangeGroup([t(0, 7), t(1, 7), t(2, 7), t(3, 7), t(0, 7, 1)], OKEY), null, 'five tiles');
  assert.equal(arrangeGroup([t(0, 7), t(1, 8), t(2, 7)], OKEY), null);
});

test('jokers substitute any tile, in runs and in sets', () => {
  const run = arrangeGroup([t(0, 4), J1, t(0, 6)], OKEY);
  assert.equal(run.kind, 'run');
  assert.equal(run.points, 15, 'the joker counts as the 5 it replaces');
  assert.deepEqual(run.slots.map((s) => s.v), [4, 5, 6]);
  const set = arrangeGroup([t(0, 7), t(1, 7), J1], OKEY);
  assert.equal(set.kind, 'set');
  assert.equal(set.points, 21);
  assert.equal(new Set(set.slots.map((s) => s.c)).size, 3);
  assert.ok(arrangeGroup([t(2, 7), J1, J2], OKEY));
  assert.ok(arrangeGroup([t(2, 7), J1, J2, t(0, 7)], OKEY));
  const ext = arrangeGroup([t(0, 4), t(0, 5), J1], OKEY);
  assert.deepEqual(ext.slots.map((s) => s.v), [4, 5, 6]);
  const high = arrangeGroup([t(0, 12), t(0, 13), J1], OKEY);
  assert.deepEqual(high.slots.map((s) => s.v), [12, 13, 1], 'the joker becomes the 1 after the 13');
  const low = arrangeGroup([t(0, 1), t(0, 2), J1], OKEY);
  assert.deepEqual(low.slots.map((s) => s.v), [1, 2, 3]);
  assert.equal(arrangeGroup([t(0, 2), t(0, 6), J1], OKEY), null, 'gap too wide for one joker');
  assert.equal(arrangeGroup([J1, J2, J1], OKEY), null, 'jokers alone are not a group');
  assert.equal(arrangeGroup([t(0, 4), t(1, 6), J1], OKEY), null, 'a joker never fixes a colour clash');
});

test('a fake okey is the okey tile: it works as red 9 and not as a joker', () => {
  assert.ok(arrangeGroup([t(3, 8), FAKE, t(3, 10)], OKEY), 'red 8, fake (red 9), red 10');
  assert.equal(arrangeGroup([t(0, 8), FAKE, t(0, 10)], OKEY), null, 'not a yellow 9');
  assert.ok(arrangeGroup([t(0, 9), t(1, 9), FAKE], OKEY), 'set of 9s with the fake as the red 9');
  assert.equal(penaltyValue(FAKE, OKEY), 9);
  assert.equal(penaltyValue(J1, OKEY), 101);
  assert.equal(penaltyValue(t(0, 13), OKEY), 13);
});

test('pairs', () => {
  assert.ok(isPair(t(0, 5, 0), t(0, 5, 1), OKEY));
  assert.ok(!isPair(t(0, 5), t(1, 5), OKEY));
  assert.ok(isPair(t(0, 5), J1, OKEY));
  assert.ok(isPair(J1, J2, OKEY));
  assert.ok(isPair(FAKE, FAKE2, OKEY));
  assert.ok(!isPair(FAKE, t(3, 8), OKEY));
  assert.ok(!isPair(t(0, 5), t(0, 5), OKEY), 'a tile is not its own pair');
});

const hand14 = (...tiles) => { assert.equal(tiles.length, 14); return tiles; };

test('seven pairs, with jokers', () => {
  const pairs = [];
  for (let v = 1; v <= 7; v++) pairs.push(t(0, v, 0), t(0, v, 1));
  assert.ok(isSevenPairs(pairs, OKEY));
  assert.equal(winKind(pairs, OKEY), 'pairs');
  assert.ok(isSevenPairs([...pairs.slice(0, 12), t(1, 1), J1], OKEY));
  assert.ok(!isSevenPairs([...pairs.slice(0, 12), t(1, 1), t(2, 2)], OKEY));
  assert.ok(isSevenPairs([...pairs.slice(0, 12), J1, J2], OKEY));
  assert.ok(!isSevenPairs(pairs.slice(0, 12), OKEY), 'needs 14 tiles');
  assert.ok(isSevenPairs([...pairs.slice(0, 12), FAKE, FAKE2], OKEY));
});

test('winning racks: partition into groups', () => {
  const misfit = hand14(
    t(0, 1), t(0, 2), t(0, 3),
    t(1, 5), t(2, 5), t(0, 5),
    t(0, 9), t(1, 9), t(2, 9),
    t(0, 10), t(0, 11), t(0, 12), t(0, 13), t(1, 13)
  );
  assert.equal(winKind(misfit, OKEY), null, 'a stray 13 fits nowhere');
  const win = hand14(
    t(0, 1), t(0, 2), t(0, 3), t(0, 4),
    t(1, 5), t(2, 5), t(0, 5),
    t(0, 9), t(1, 9), t(2, 9),
    t(0, 10), t(0, 11), t(0, 12), t(0, 13)
  );
  assert.equal(winKind(win, OKEY), 'normal');
  assert.equal(winKind(win.slice(0, 13), OKEY), null, '13 tiles are never a finished hand');
});

test('winning racks: jokers complete groups and tiles are never shared', () => {
  const win = hand14(
    t(0, 1), t(0, 2), J1,
    t(1, 8), t(2, 8), t(0, 8), t(3, 8),
    t(1, 4), t(1, 5), t(1, 6), t(1, 7),
    t(2, 11), t(2, 12), J2
  );
  assert.equal(winKind(win, OKEY), 'normal');
  const hard = hand14(
    t(0, 3), t(0, 4), t(0, 5), t(0, 6),
    t(1, 5), t(2, 5), J1,
    t(1, 10), t(2, 10), t(0, 10),
    t(2, 1), t(2, 2), t(2, 3), t(2, 4)
  );
  assert.equal(winKind(hard, OKEY), 'normal');
  const bad = hand14(
    t(0, 3), t(0, 4), t(0, 5), t(0, 6),
    t(1, 5), t(2, 5), t(0, 7),
    t(1, 10), t(2, 10), t(0, 10),
    t(2, 1), t(2, 2), t(2, 3), t(2, 4)
  );
  assert.equal(winKind(bad, OKEY), null);
});

test('a winning rack with 12-13-1 and a fake okey', () => {
  const win = hand14(
    t(1, 12), t(1, 13), t(1, 1),
    t(3, 8), FAKE, t(3, 10),
    t(0, 2), t(1, 2), t(2, 2),
    t(2, 6), t(2, 7), t(2, 8), t(2, 9), t(2, 10)
  );
  assert.equal(winKind(win, OKEY), 'normal');
});

test('solveGroups: best layout for a rack, leftovers reported', () => {
  const rack = [t(0, 1), t(0, 2), t(0, 3), t(1, 5), t(2, 5), t(0, 5), t(1, 13), t(0, 9)];
  const r = solveGroups(rack, OKEY);
  assert.equal(r.groups.length, 2);
  assert.deepEqual(r.rest.sort((a, b) => a - b), [t(0, 9).id, t(1, 13).id].sort((a, b) => a - b));
  for (const g of r.groups) assert.ok(arrangeGroup(g.map((id) => T[id]), OKEY));
  const all = r.groups.flat().concat(r.rest);
  assert.equal(new Set(all).size, rack.length);
});

test('solveGroups on random 15 tile racks is quick and consistent', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const ids = shuffle(T.map((x) => x.id), rng).slice(0, 15);
    const rack = ids.map((id) => T[id]);
    const r = solveGroups(rack, OKEY);
    assert.ok(r, 'solved');
    const used = r.groups.flat().concat(r.rest);
    assert.deepEqual([...used].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
    for (const g of r.groups) assert.ok(arrangeGroup(g.map((id) => T[id]), OKEY), 'every group valid');
    finishingDiscards(rack, OKEY);
  }
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

test('scoring: normal 1, okey finish 2, pairs 2, pairs with okey 4', () => {
  assert.equal(classicPoints('normal', t(0, 3), OKEY), 1);
  assert.equal(classicPoints('normal', J1, OKEY), 2);
  assert.equal(classicPoints('pairs', t(0, 3), OKEY), 2);
  assert.equal(classicPoints('pairs', J2, OKEY), 4);
  assert.equal(classicPoints('normal', FAKE, OKEY), 1, 'a fake okey does not double');
});

test('finishingDiscards lists the winning discards, best first', () => {
  const win = [
    t(0, 1), t(0, 2), t(0, 3), t(0, 4),
    t(1, 5), t(2, 5), t(0, 5),
    t(0, 9), t(1, 9), t(2, 9),
    t(0, 10), t(0, 11), t(0, 12), t(0, 13)
  ];
  const f = finishingDiscards([...win, J1], OKEY);
  assert.equal(f[0].id, J1.id);
  assert.equal(f[0].points, 2);
  assert.ok(finishingDiscards([...win, t(3, 1)], OKEY).some((x) => x.id === t(3, 1).id));
  assert.deepEqual(finishingDiscards([...win, t(1, 13)], OKEY).filter((x) => x.id === t(1, 13).id).length, 1);
});
