import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Okey, SLOTS } from '../src/games/okey.js';
import { buildTiles } from '../src/games/okey-rules.js';

const T = buildTiles();
const tile = (c, v, set = 0) => T[set * 52 + c * 13 + v - 1];
const J1 = tile(3, 9, 0); // the okey is red 9 in the staged games
const J2 = tile(3, 9, 1);
const FAKE = T[104];

function fakeRoom(spectators = []) {
  return {
    sent: [],
    finished: null,
    broadcast(m) { this.sent.push(m); },
    send(ws, m) { this.sent.push({ to: ws.id, ...m }); },
    getWsByUserId(id) { return { id }; },
    spectatorIds() { return spectators; },
    finishGame(p) { this.finished = p; }
  };
}
const lastTo = (room, id, type) => [...room.sent].reverse().find((m) => m.to === id && m.type === type);
const errors = (room, id) => room.sent.filter((m) => m.to === id && m.type === 'error');

const P = { a: { name: 'Ann' }, b: { name: 'Bob' }, c: { name: 'Cem' }, d: { name: 'Deniz' } };
const pick = (n) => Object.fromEntries(Object.entries(P).slice(0, n));

const games = [];
after(() => games.forEach((g) => g.cleanup()));

function lcg(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

/** A started game with a staged table: the okey is red 9, 'a' is on turn in the given stage. */
function staged(opts = {}, n = 3, { stage = 'discard', seed = 1 } = {}) {
  const room = fakeRoom(opts.spectators || []);
  const g = new Okey(room, pick(n), { mode: 'classic', rounds: 1, turnTime: 45, ...opts }, { rng: lcg(seed), startDelay: 1e7, handDelay: 1e7, finishDelay: 0 });
  games.push(g);
  g.running = true;
  g.indicator = tile(3, 8);
  g.okey = { c: 3, v: 9 };
  g.turn = 'a';
  g.stage = stage;
  g.startTurnTimer();
  return { g, room };
}

/** Replace a player's rack (tile objects) and refresh their arrangement. */
function give(g, id, tiles) {
  g.racks[id] = tiles.map((x) => x.id);
  g.arr[id] = new Array(SLOTS).fill(null);
  g.syncArrange(id);
}

const WIN13 = [ // 14 tiles minus nothing: complete hand
  tile(0, 1), tile(0, 2), tile(0, 3), tile(0, 4),
  tile(1, 5), tile(2, 5), tile(0, 5),
  tile(0, 9), tile(1, 9), tile(2, 9),
  tile(0, 10), tile(0, 11), tile(0, 12), tile(0, 13)
];

test('deal: dealer 15, others 14, stock, indicator is a real tile, okey follows it', () => {
  for (let n = 2; n <= 4; n++) {
    const room = fakeRoom();
    const g = new Okey(room, pick(n), {}, { rng: lcg(n), startDelay: 1e7 });
    games.push(g);
    const ids = Object.keys(pick(n));
    assert.equal(g.racks[g.dealer].length, 15);
    for (const id of ids) if (id !== g.dealer) assert.equal(g.racks[id].length, 14);
    assert.equal(g.stock.length, 106 - 1 - 15 - 14 * (n - 1));
    assert.equal(g.turn, g.dealer);
    assert.equal(g.stage, 'discard', 'the dealer starts by discarding');
    // every tile is somewhere exactly once
    const all = [...g.stock, g.indicator.id, ...ids.flatMap((id) => g.racks[id])];
    assert.equal(new Set(all).size, 106);
    assert.ok(!g.indicator.f);
    assert.equal(g.okey.c, g.indicator.c);
    assert.equal(g.okey.v, g.indicator.v === 13 ? 1 : g.indicator.v + 1);
  }
});

test('the indicator is never a fake okey, whatever the shuffle', () => {
  for (let seed = 1; seed < 80; seed++) {
    const g = new Okey(fakeRoom(), pick(2), {}, { rng: lcg(seed), startDelay: 1e7 });
    games.push(g);
    assert.ok(!g.indicator.f);
  }
  // a shuffle that puts a fake on the very top of the stock
  const g = new Okey(fakeRoom(), pick(2), {}, { rng: () => 0.999999, startDelay: 1e7 });
  games.push(g);
  assert.ok(!g.indicator.f);
});

test('options are sanitised', () => {
  const g = new Okey(fakeRoom(), pick(2), { mode: 'weird', rounds: 9, turnTime: 5 }, { startDelay: 1e7 });
  games.push(g);
  assert.equal(g.mode, 'classic');
  assert.equal(g.rounds, 1);
  assert.equal(g.turnMs, 45000);
  const h = new Okey(fakeRoom(), pick(2), { mode: '101', rounds: 5, turnTime: 90 }, { startDelay: 1e7 });
  games.push(h);
  assert.equal(h.mode, '101');
  assert.equal(h.turnMs, 90000);
});

test('snapshots are private: own rack only, spectators see no rack, no stock contents', () => {
  const { g, room } = staged({ spectators: ['host'] }, 3);
  g.broadcastState();
  const sa = lastTo(room, 'a', 'okey-state');
  const sb = lastTo(room, 'b', 'okey-state');
  const sh = lastTo(room, 'host', 'okey-state');
  assert.equal(sa.rack.length, g.racks.a.length);
  assert.deepEqual(sa.rack.map((x) => x.id).sort(), [...g.racks.a].sort());
  assert.equal(sb.rack.length, g.racks.b.length);
  assert.ok(!sb.rack.some((x) => g.racks.a.includes(x.id)));
  assert.equal(sh.rack.length, 0);
  assert.equal(sh.spectator, true);
  for (const s of [sa, sb, sh]) {
    assert.equal(typeof s.stock, 'number');
    assert.ok(!('stockIds' in s));
    assert.equal(s.players.find((p) => p.id === 'b').count, g.racks.b.length);
  }
  // the JSON for b contains none of a's tile ids as a rack
  assert.ok(!JSON.stringify(sh).includes('"rack":[{'));
});

test('turn flow: draw from stock, then discard onto your own pile', () => {
  const { g, room } = staged({}, 3, { stage: 'draw' });
  const before = g.racks.a.length;
  const stock = g.stock.length;
  g.handleMessage('b', 'okey-draw', { from: 'stock' });
  assert.equal(g.racks.b.length, 14, 'not b turn');
  g.handleMessage('a', 'okey-discard', { tile: g.racks.a[0] });
  assert.equal(g.racks.a.length, before, 'cannot discard before drawing');
  g.handleMessage('a', 'okey-draw', { from: 'stock' });
  assert.equal(g.racks.a.length, before + 1);
  assert.equal(g.stock.length, stock - 1);
  assert.equal(g.stage, 'discard');
  g.handleMessage('a', 'okey-draw', { from: 'stock' });
  assert.equal(g.racks.a.length, before + 1, 'only one draw per turn');
  const out = g.racks.a[0];
  g.handleMessage('a', 'okey-discard', { tile: out });
  assert.deepEqual(g.piles.a, [out]);
  assert.equal(g.turn, 'b');
  assert.equal(g.stage, 'draw');
  assert.ok(!g.racks.a.includes(out));
  const s = lastTo(room, 'b', 'okey-state');
  assert.equal(s.takeFrom, 'a');
  assert.equal(s.players.find((p) => p.id === 'a').pile.at(-1).id, out);
});

test('drawing the previous player discard', () => {
  const { g, room } = staged({}, 3, { stage: 'draw' });
  g.turn = 'b';
  g.piles.a = [tile(0, 2).id, tile(1, 3).id];
  g.handleMessage('b', 'okey-draw', { from: 'discard' });
  assert.ok(g.racks.b.includes(tile(1, 3).id));
  assert.deepEqual(g.piles.a, [tile(0, 2).id]);
  // c may not take from a (only from the previous player b)
  g.stage = 'draw';
  g.turn = 'c';
  g.handleMessage('c', 'okey-draw', { from: 'discard' });
  assert.equal(errors(room, 'c').at(-1).message.k, 'okey.err.noDiscard');
  assert.equal(g.stage, 'draw');
  // the player after the dealer cannot take a tile that is not there
  g.turn = 'a';
  g.piles.c = [];
  g.handleMessage('a', 'okey-draw', { from: 'discard' });
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.noDiscard');
});

test('hostile input is ignored', () => {
  const { g, room } = staged({ mode: '101' }, 3, { stage: 'draw' });
  const rack = [...g.racks.a];
  const bad = [null, undefined, 'x', 5, {}, [], NaN, -1, 1e9, '12', [1], { a: 1 }];
  for (const b of bad) {
    g.handleMessage('a', 'okey-draw', b);
    g.handleMessage('a', 'okey-draw', { from: b });
    g.handleMessage('a', 'okey-discard', b);
    g.handleMessage('a', 'okey-discard', { tile: b });
    g.handleMessage('a', 'okey-open', b);
    g.handleMessage('a', 'okey-open', { groups: b });
    g.handleMessage('a', 'okey-open', { pairs: b });
    g.handleMessage('a', 'okey-add', b);
    g.handleMessage('a', 'okey-arrange', { slots: b });
    g.handleMessage('a', 'okey-finish', { tile: b });
  }
  g.handleMessage('zzz', 'okey-draw', { from: 'stock' });
  g.handleMessage('a', 'nonsense', {});
  g.handleMessage('a', undefined, undefined);
  g.handleMessage('a', 'okey-draw', null);
  assert.deepEqual(g.racks.a, rack);
  assert.equal(g.stage, 'draw');
  g.stage = 'discard';
  give(g, 'a', WIN13.concat(tile(0, 6)));
  for (const b of [[[1, 2, 3]], [[1, 2, 3], [4, 5]], [[tile(0, 1).id, tile(0, 1).id, tile(0, 2).id]], [[999, 998, 997]], Array(100).fill([1, 2, 3]), [[tile(0, 1).id, tile(0, 2).id, tile(0, 3).id, 'x']]]) {
    g.handleMessage('a', 'okey-open', { groups: b });
  }
  g.handleMessage('a', 'okey-open', { groups: [[tile(0, 1).id, tile(0, 2).id, tile(0, 3).id]], pairs: [] });
  assert.equal(g.racks.a.length, 15, 'nothing was laid down');
  assert.equal(g.table.length, 0);
  assert.ok(errors(room, 'a').every((e) => typeof e.message.k === 'string' && e.message.k.startsWith('okey.err.')));
});

test('cannot discard a tile you do not hold', () => {
  const { g, room } = staged({}, 3);
  const foreign = g.racks.b[0];
  g.handleMessage('a', 'okey-discard', { tile: foreign });
  assert.equal(g.turn, 'a');
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.notYours');
  g.handleMessage('a', 'okey-discard', { tile: 4.5 });
  assert.equal(g.turn, 'a');
});

test('classic: discarding a tile that leaves a complete hand wins (1 point)', () => {
  const { g, room } = staged({}, 3);
  give(g, 'a', WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-discard', { tile: tile(3, 1).id });
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winner, 'a');
  assert.equal(g.result.kind, 'normal');
  assert.equal(g.scores.a, 1);
  assert.equal(g.scores.b, 0);
  assert.deepEqual(g.result.hands.a.length, 14);
  assert.ok(Array.isArray(g.result.hands.b), 'every rack is revealed after the hand');
});

test('classic: okey-finish must be a winning discard', () => {
  const { g, room } = staged({ rounds: 3 }, 3);
  give(g, 'a', WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-finish', { tile: WIN13[0].id });
  assert.equal(g.phase, 'play');
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.notWinning');
  g.handleMessage('a', 'okey-finish', { tile: tile(3, 1).id });
  assert.equal(g.phase, 'handOver');
  assert.equal(g.scores.a, 1);
});

test('classic scoring: okey finish 2, pairs 2, pairs plus okey 4', () => {
  let r = staged({ rounds: 5 }, 3);
  give(r.g, 'a', WIN13.concat(J1));
  r.g.handleMessage('a', 'okey-discard', { tile: J1.id });
  assert.equal(r.g.result.kind, 'okey');
  assert.equal(r.g.scores.a, 2);

  const pairs = [];
  for (let v = 1; v <= 7; v++) pairs.push(tile(0, v, 0), tile(0, v, 1));
  r = staged({ rounds: 5 }, 3);
  give(r.g, 'a', pairs.concat(tile(2, 13)));
  r.g.handleMessage('a', 'okey-discard', { tile: tile(2, 13).id });
  assert.equal(r.g.result.kind, 'pairs');
  assert.equal(r.g.scores.a, 2);

  r = staged({ rounds: 5 }, 3);
  give(r.g, 'a', pairs.concat(J1));
  r.g.handleMessage('a', 'okey-discard', { tile: J1.id });
  assert.equal(r.g.result.kind, 'pairs-okey');
  assert.equal(r.g.scores.a, 4);

  // finishing on a fake okey does not double
  r = staged({ rounds: 5 }, 3);
  give(r.g, 'a', WIN13.concat(FAKE));
  r.g.handleMessage('a', 'okey-discard', { tile: FAKE.id });
  assert.equal(r.g.scores.a, 1);
});

test('classic: several hands add up, the next hand is dealt with a rotated dealer', () => {
  const { g, room } = staged({ rounds: 3 }, 3);
  const dealer1 = g.dealer;
  give(g, 'a', WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-discard', { tile: tile(3, 1).id });
  assert.equal(g.phase, 'handOver');
  assert.equal(room.finished, null);
  const s = lastTo(room, 'b', 'okey-state');
  assert.equal(s.result.winner, 'a');
  assert.ok(s.nextHandIn > 0);
  g.handTimer && clearTimeout(g.handTimer);
  g.dealHand();
  assert.equal(g.round, 2);
  assert.notEqual(g.dealer, dealer1);
  assert.equal(g.racks[g.dealer].length, 15);
  assert.equal(g.scores.a, 1, 'points carry over');
  assert.equal(g.result, null);
});

test('classic: final standings rank by points, ties share', async () => {
  const { g, room } = staged({ rounds: 1 }, 3);
  g.scores = { a: 0, b: 0, c: 0 };
  give(g, 'a', WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-discard', { tile: tile(3, 1).id });
  await new Promise((r) => setTimeout(r, 30));
  const f = room.finished;
  assert.ok(f, 'finishGame called');
  assert.equal(f.rows[0].id, 'a');
  assert.equal(f.rows[0].rank, 1);
  assert.equal(f.rows[1].rank, 2);
  assert.equal(f.rows[2].rank, 2, 'ties share a rank');
  assert.equal(f.title.k, 'okey.finish.wins');
  assert.equal(f.title.p.name, 'Ann');
  assert.equal(f.rows[0].score, 1);
});

test('classic: when the stock runs out the hand is a draw', async () => {
  const { g, room } = staged({ rounds: 1 }, 2);
  g.stock = [];
  g.handleMessage('a', 'okey-discard', { tile: g.racks.a[0] });
  assert.equal(g.phase, 'over');
  assert.equal(g.result.kind, 'draw');
  assert.equal(g.result.winner, null);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(room.finished.rows[0].rank, 1);
  assert.equal(room.finished.rows[1].rank, 1);
  assert.equal(room.finished.title.k, 'okey.finish.tie');
});

test('arrangement: stored per player, restored in the snapshot, hostile layouts ignored', () => {
  const { g, room } = staged({}, 3);
  const rack = [...g.racks.a];
  const slots = new Array(SLOTS).fill(null);
  rack.forEach((id, i) => { slots[SLOTS - 1 - i] = id; });
  g.handleMessage('a', 'okey-arrange', { slots });
  assert.deepEqual(g.arr.a, slots);
  g.sendState('a');
  assert.deepEqual(lastTo(room, 'a', 'okey-state').slots, slots);

  // foreign tile, duplicates, wrong length, junk: all rejected or cleaned
  const foreign = g.racks.b[0];
  const evil = new Array(SLOTS).fill(null);
  evil[0] = foreign; evil[1] = rack[0]; evil[2] = rack[0]; evil[3] = 'x'; evil[4] = -5;
  g.handleMessage('a', 'okey-arrange', { slots: evil });
  const ids = g.arr.a.filter((x) => x !== null);
  assert.equal(ids.length, rack.length);
  assert.equal(new Set(ids).size, rack.length);
  assert.ok(!ids.includes(foreign));
  const keep = [...g.arr.a];
  g.handleMessage('a', 'okey-arrange', { slots: [1, 2, 3] });
  g.handleMessage('a', 'okey-arrange', {});
  assert.deepEqual(g.arr.a, keep);
  // a drawn tile joins the layout without disturbing it
  g.stage = 'draw';
  g.handleMessage('a', 'okey-draw', { from: 'stock' });
  assert.equal(g.arr.a.filter((x) => x !== null).length, rack.length + 1);
  for (let i = 0; i < SLOTS; i++) if (keep[i] !== null) assert.equal(g.arr.a[i], keep[i]);
});

// ---------------------------------------------------------------- timeouts

test('timeout in the draw stage: draws from the stock and discards the rightmost non-joker', () => {
  const { g } = staged({}, 3, { stage: 'draw' });
  const rack = [tile(0, 1), tile(0, 5), tile(1, 7), tile(2, 2), J1];
  give(g, 'a', [...rack, ...WIN13.slice(0, 9)].slice(0, 14));
  // a layout where the joker is at the very right
  const slots = new Array(SLOTS).fill(null);
  g.racks.a.forEach((id, i) => { slots[i] = id; });
  const jokerAt = g.racks.a.indexOf(J1.id);
  slots[SLOTS - 1] = J1.id;
  slots[jokerAt] = null;
  g.arr.a = slots;
  const stockTop = g.stock.at(-1);
  const stockBefore = g.stock.length;
  g.onTimeout('a');
  assert.equal(g.stock.length, stockBefore - 1);
  assert.ok(g.racks.a.includes(J1.id), 'the joker is never auto discarded');
  assert.equal(g.piles.a.length, 1);
  assert.notEqual(g.piles.a[0], J1.id);
  assert.equal(g.racks.a.length, 14);
  assert.equal(g.turn, 'b');
  assert.equal(g.stage, 'draw');
  assert.ok(g.racks.a.includes(stockTop) || g.piles.a[0] === stockTop);
});

test('timeout picks the rightmost tile of the layout', () => {
  const { g } = staged({}, 3, { stage: 'discard' });
  give(g, 'a', [tile(0, 1), tile(0, 5), tile(1, 7), tile(2, 2), tile(0, 13), tile(1, 1), tile(2, 3), tile(1, 4), tile(2, 6), tile(0, 8), tile(1, 10), tile(2, 11), tile(0, 12), tile(1, 12), tile(2, 13)]);
  const slots = new Array(SLOTS).fill(null);
  g.racks.a.forEach((id, i) => { slots[i] = id; });
  slots[SLOTS - 3] = slots[14]; slots[14] = null;
  g.arr.a = slots;
  const expected = slots[SLOTS - 3];
  g.onTimeout('a');
  assert.deepEqual(g.piles.a, [expected]);
  assert.equal(g.turn, 'b');
});

test('timeout is ignored for a player who is not on turn, and a real timer fires', async () => {
  const { g } = staged({ turnTime: 30 }, 3, { stage: 'draw' });
  const rack = [...g.racks.b];
  g.onTimeout('b');
  assert.deepEqual(g.racks.b, rack);
  assert.equal(g.turn, 'a');
  g.turnMs = 40;
  g.startTurnTimer();
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(g.turn, 'b', 'the timer auto-played');
});

// ------------------------------------------------------------------- 101

/** a 101 table; a is to discard with the given rack. */
function room101(rack, n = 3) {
  const s = staged({ mode: '101' }, n, { stage: 'discard' });
  give(s.g, 'a', rack);
  return s;
}

const RUN_HIGH = [tile(0, 11), tile(0, 12), tile(0, 13)]; // 36
const SET_13 = [tile(0, 13, 1), tile(1, 13), tile(2, 13)]; // 39
const SET_12 = [tile(1, 12), tile(2, 12), tile(3, 12)]; // 36
const ids = (a) => a.map((x) => x.id);

test('101: opening needs 101 points', () => {
  const { g, room } = room101([...RUN_HIGH, ...SET_12, tile(0, 1), tile(1, 2), tile(2, 3)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_12)] });
  assert.equal(g.table.length, 0);
  const e = errors(room, 'a').at(-1).message;
  assert.equal(e.k, 'okey.err.openTotal');
  assert.equal(e.p.n, 72);
  assert.equal(e.p.need, 101);
});

test('101: opening with 101+ lays the groups on the table', () => {
  const { g, room } = room101([...RUN_HIGH, ...SET_13, ...SET_12, tile(0, 1), tile(1, 2), tile(2, 3)]);
  // 36 + 39 + 36 = 111
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  assert.equal(g.opened.a, 'groups');
  assert.equal(g.table.length, 3);
  assert.equal(g.racks.a.length, 3);
  assert.equal(g.table[0].kind, 'run');
  assert.equal(g.table[1].kind, 'set');
  assert.ok(g.table.every((m) => m.owner === 'a'));
  assert.equal(g.stage, 'discard', 'you still discard after opening');
  const s = lastTo(room, 'b', 'okey-state');
  assert.equal(s.table.length, 3);
  assert.equal(s.players.find((p) => p.id === 'a').opened, 'groups');
});

test('101: jokers count as the tile they replace; a fake okey counts as the okey', () => {
  // 11 12 [joker=13] = 36, 13 13 [joker] = 39 -> 75, plus 12 12 [fake=red 9 not equal] ... build 101 with a fake
  const rack = [
    tile(0, 11), tile(0, 12), J1, // 36
    tile(0, 13, 1), tile(1, 13), J2, // 39
    tile(1, 12), tile(2, 12), tile(3, 12), // 36 -> 111
    tile(0, 2), tile(1, 4), tile(2, 6), tile(2, 8)
  ];
  const { g } = room101(rack);
  g.handleMessage('a', 'okey-open', { groups: [[rack[0].id, rack[1].id, rack[2].id], [rack[3].id, rack[4].id, rack[5].id], [rack[6].id, rack[7].id, rack[8].id]] });
  assert.equal(g.table.length, 3);
  const run = g.table[0];
  assert.deepEqual(run.tiles.map((x) => x.v), [11, 12, 13]);
  assert.equal(run.tiles.find((x) => x.j).id, J1.id);
});

test('101: the same opening is exactly at the threshold', () => {
  // 9 9 9 = 27, 13 13 13 = 39, 11 12 13 = 36 -> 102
  const { g } = room101([tile(0, 9), tile(1, 9), FAKE, tile(0, 13), tile(1, 13), tile(2, 13), tile(1, 11), tile(1, 12), tile(1, 13, 1), tile(2, 1), tile(0, 4), tile(1, 6), tile(2, 8), tile(1, 10)]);
  g.handleMessage('a', 'okey-open', { groups: [[tile(0, 9).id, tile(1, 9).id, FAKE.id], [tile(0, 13).id, tile(1, 13).id, tile(2, 13).id], [tile(1, 11).id, tile(1, 12).id, tile(1, 13, 1).id]] });
  assert.equal(g.table.length, 3);
  assert.equal(g.opened.a, 'groups');
});

test('101: 100 points is not enough', () => {
  // 13 13 13 = 39, 12 12 12 = 36, 8 8 8 = 24 -> 99
  const rack = [tile(0, 13), tile(1, 13), tile(2, 13), tile(0, 12), tile(1, 12), tile(2, 12), tile(0, 8), tile(1, 8), tile(2, 8), tile(0, 1), tile(1, 2), tile(2, 3), tile(3, 5), tile(3, 7)];
  const { g, room } = room101(rack);
  g.handleMessage('a', 'okey-open', { groups: [ids(rack.slice(0, 3)), ids(rack.slice(3, 6)), ids(rack.slice(6, 9))] });
  assert.equal(g.table.length, 0);
  assert.equal(errors(room, 'a').at(-1).message.p.n, 99);
  // one more tile makes it 123 (add a run 1 2 3 won't: use a 4 set of 8: 8 8 8 8 = 32 -> 107)
  give(g, 'a', [...rack, tile(3, 8)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(rack.slice(0, 3)), ids(rack.slice(3, 6)), ids([...rack.slice(6, 9), tile(3, 8)])] });
  assert.equal(g.table.length, 3);
});

test('101: opening with an invalid group or with tiles you do not hold fails', () => {
  const { g, room } = room101([...RUN_HIGH, ...SET_13, ...SET_12, tile(0, 1), tile(1, 2), tile(2, 3)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), [SET_12[0].id, SET_12[1].id, tile(0, 1).id]] });
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.badGroup');
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(g.racks.b.slice(0, 3).map((i) => T[i]))] });
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.badMove');
  assert.equal(g.table.length, 0);
  g.stage = 'draw';
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH)] });
  assert.equal(g.table.length, 0, 'only in the discard stage');
  g.stage = 'discard';
  g.turn = 'b';
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  assert.equal(g.table.length, 0, 'only on your turn');
});

test('101: opening with five pairs', () => {
  const pairs = [];
  for (let v = 1; v <= 5; v++) pairs.push([tile(0, v, 0), tile(0, v, 1)]);
  const { g, room } = room101([...pairs.flat(), tile(1, 13), tile(2, 13), tile(3, 13), tile(1, 1)]);
  g.handleMessage('a', 'okey-open', { pairs: pairs.slice(0, 4).map(ids) });
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.openPairs');
  assert.equal(g.opened.a, null);
  g.handleMessage('a', 'okey-open', { pairs: [...pairs.slice(0, 4).map(ids), [pairs[4][0].id, tile(1, 13).id]] });
  assert.equal(errors(room, 'a').at(-1).message.k, 'okey.err.badPair');
  g.handleMessage('a', 'okey-open', { pairs: pairs.map(ids) });
  assert.equal(g.opened.a, 'pairs');
  assert.equal(g.table.length, 5);
  assert.ok(g.table.every((m) => m.kind === 'pair' && m.tiles.length === 2));
  assert.equal(g.racks.a.length, 4);
  // pairs cannot take more tiles
  g.handleMessage('a', 'okey-add', { meld: g.table[0].id, tiles: [tile(1, 1).id] });
  assert.equal(g.racks.a.length, 4);
  // a joker completes a pair
  const { g: h } = room101([...pairs.slice(0, 4).flat(), pairs[4][0], J1, tile(1, 13), tile(1, 1)]);
  h.handleMessage('a', 'okey-open', { pairs: [...pairs.slice(0, 4).map(ids), [pairs[4][0].id, J1.id]] });
  assert.equal(h.opened.a, 'pairs');
});

test('101: groups and pairs cannot be mixed in one message, opened players cannot open with pairs again', () => {
  const pairs = [];
  for (let v = 1; v <= 5; v++) pairs.push([tile(0, v, 0), tile(0, v, 1)]);
  const { g } = room101([...pairs.flat(), tile(1, 13), tile(2, 13), tile(3, 13), tile(1, 1)]);
  g.handleMessage('a', 'okey-open', { pairs: pairs.map(ids), groups: [[tile(1, 13).id, tile(2, 13).id, tile(3, 13).id]] });
  assert.equal(g.table.length, 0);
});

test('101: after opening, more groups can be laid down without a threshold and tiles added to melds', () => {
  const rack = [...RUN_HIGH, ...SET_13, ...SET_12, tile(0, 3), tile(0, 4), tile(0, 5), tile(2, 10), tile(3, 13)];
  const { g } = room101(rack);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  assert.equal(g.opened.a, 'groups');
  // lay another small group straight away
  g.handleMessage('a', 'okey-open', { groups: [[tile(0, 3).id, tile(0, 4).id, tile(0, 5).id]] });
  assert.equal(g.table.length, 4);
  // add the red 13 to the set of 13s (13 yellow(set 2), 13 blue, 13 black + 13 red)
  const set13 = g.table.find((m) => m.kind === 'set' && m.tiles[0].v === 13);
  g.handleMessage('a', 'okey-add', { meld: set13.id, tiles: [tile(3, 13).id] });
  assert.equal(set13.tiles.length, 4);
  assert.equal(g.racks.a.length, 1);
});

test('101: adding extends runs at either end, also other players melds; invalid adds fail', () => {
  const { g, room } = room101([...RUN_HIGH, ...SET_13, ...SET_12, tile(0, 10), tile(1, 7), tile(2, 9)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  g.handleMessage('a', 'okey-discard', { tile: tile(2, 9).id });
  assert.equal(g.turn, 'b');
  g.stage = 'discard';
  give(g, 'b', [tile(0, 10, 1), tile(0, 1, 1), tile(1, 1), tile(0, 5), tile(3, 3)]);
  // b has not opened: cannot add
  g.handleMessage('b', 'okey-add', { meld: g.table[0].id, tiles: [tile(0, 10, 1).id] });
  assert.equal(errors(room, 'b').at(-1).message.k, 'okey.err.notOpened');
  g.opened.b = 'groups';
  const run = g.table[0];
  g.handleMessage('b', 'okey-add', { meld: run.id, tiles: [tile(0, 10, 1).id] });
  assert.deepEqual(run.tiles.map((x) => x.v), [10, 11, 12, 13], 'added at the low end');
  g.handleMessage('b', 'okey-add', { meld: run.id, tiles: [tile(0, 1, 1)] .map((x) => x.id) });
  assert.deepEqual(run.tiles.map((x) => x.v), [10, 11, 12, 13, 1], 'the 1 follows the 13');
  g.handleMessage('b', 'okey-add', { meld: run.id, tiles: [tile(1, 1).id] });
  assert.equal(run.tiles.length, 5, 'wrong colour refused');
  assert.equal(errors(room, 'b').at(-1).message.k, 'okey.err.cantAdd');
  g.handleMessage('b', 'okey-add', { meld: 999, tiles: [tile(0, 5).id] });
  g.handleMessage('b', 'okey-add', { meld: run.id, tiles: [tile(0, 5).id, tile(0, 5).id] });
  g.handleMessage('b', 'okey-add', { meld: run.id, tiles: [] });
  assert.equal(g.racks.b.length, 3);
  // a set can not take a 5th tile
  const set13 = g.table[1];
  g.handleMessage('b', 'okey-add', { meld: set13.id, tiles: [tile(3, 13, 1).id] });
});

test('101: adding a joker to a run and re-solving', () => {
  const { g } = room101([...RUN_HIGH, ...SET_13, ...SET_12, J1, tile(1, 7), tile(2, 9)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  const run = g.table[0];
  g.handleMessage('a', 'okey-add', { meld: run.id, tiles: [J1.id] });
  assert.equal(run.tiles.length, 4);
  assert.ok(run.tiles.some((x) => x.j));
});

test('101: emptying the rack ends the hand; penalties: unopened 202, tiles in hand, okey 101', () => {
  const { g, room } = room101([...RUN_HIGH, ...SET_13, ...SET_12]);
  give(g, 'b', [tile(0, 2), tile(1, 3), J1]);
  g.opened.b = 'groups';
  give(g, 'c', [tile(0, 7)]);
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  assert.equal(g.phase, 'over');
  assert.equal(g.result.winner, 'a');
  assert.equal(g.result.kind, 'out');
  assert.equal(g.result.gains.a, 0);
  assert.equal(g.result.gains.b, 2 + 3 + 101);
  assert.equal(g.result.gains.c, 202, 'never opened');
  assert.equal(g.scores.b, 106);
  assert.equal(g.scores.c, 202);
  // the match is over: 101 or more reached
  assert.equal(g.round, 1);
});

test('101: a fake okey in hand counts the value of the okey', () => {
  const { g } = room101([...RUN_HIGH, ...SET_13, ...SET_12]);
  give(g, 'b', [FAKE, tile(0, 2)]);
  g.opened.b = 'groups';
  give(g, 'c', []);
  g.opened.c = 'groups';
  g.handleMessage('a', 'okey-open', { groups: [ids(RUN_HIGH), ids(SET_13), ids(SET_12)] });
  assert.equal(g.result.gains.b, 9 + 2);
  assert.equal(g.result.gains.c, 0);
});

test('101: finishing with a discard ends the hand; the match continues until 101 and ranks ascending', async () => {
  const { g, room } = room101([tile(0, 3)]);
  give(g, 'b', [tile(0, 2), tile(1, 3)]);
  g.opened.b = 'groups';
  give(g, 'c', [tile(0, 4)]);
  g.opened.c = 'groups';
  g.scores = { a: 0, b: 10, c: 20 };
  g.handleMessage('a', 'okey-discard', { tile: tile(0, 3).id });
  assert.equal(g.phase, 'handOver', 'nobody is at 101 yet');
  assert.equal(g.scores.b, 15);
  assert.equal(g.scores.c, 24);
  assert.equal(room.finished, null);
  g.handTimer && clearTimeout(g.handTimer);
  g.dealHand();
  assert.equal(g.round, 2);
  assert.equal(g.scores.c, 24);
  // second hand: c is unopened and gets 202
  g.running = true;
  g.turn = 'b';
  g.stage = 'discard';
  give(g, 'b', [tile(0, 3)]);
  g.handleMessage('b', 'okey-discard', { tile: tile(0, 3).id });
  assert.equal(g.phase, 'over');
  await new Promise((r) => setTimeout(r, 30));
  const f = room.finished;
  assert.deepEqual(f.rows.map((r) => r.id), ['b', 'a', 'c'].sort((x, y) => g.scores[x] - g.scores[y]));
  assert.equal(f.rows[0].rank, 1);
  assert.equal(f.rows[0].note.k, 'okey.note.penalty');
  assert.equal(f.subtitle.k, 'okey.finish.m101');
});

test('101 ties share a rank (lowest wins)', async () => {
  const { g, room } = room101([tile(0, 3)]);
  g.opened.a = g.opened.b = g.opened.c = 'groups';
  give(g, 'a', []);
  give(g, 'b', []);
  give(g, 'c', []);
  g.scores = { a: 105, b: 105, c: 3 };
  g.endHand('c', {});
  await new Promise((r) => setTimeout(r, 30));
  const rows = room.finished.rows;
  assert.equal(rows[0].id, 'c');
  assert.equal(rows[1].rank, 2);
  assert.equal(rows[2].rank, 2);
});

test('101: stock exhaustion ends the hand with penalties for everybody', () => {
  const { g } = room101([tile(0, 3), tile(0, 9)]);
  g.stock = [];
  g.opened.b = 'groups';
  give(g, 'b', [tile(0, 5)]);
  g.handleMessage('a', 'okey-discard', { tile: tile(0, 3).id });
  assert.equal(g.result.kind, 'draw');
  assert.equal(g.result.gains.a, 202);
  assert.equal(g.result.gains.b, 5);
});

test('101 mode never wins by completing the rack', () => {
  const { g } = room101(WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-discard', { tile: tile(3, 1).id });
  assert.equal(g.phase, 'play');
  assert.equal(g.turn, 'b');
  g.stage = 'discard';
  g.turn = 'a';
  g.handleMessage('a', 'okey-finish', { tile: WIN13[0].id });
  assert.equal(g.turn, 'a');
});

// --------------------------------------------------------------- leaving

test('a leaver tiles go back to the stock and the game goes on', () => {
  const { g, room } = staged({}, 3, { stage: 'draw' });
  const stock = g.stock.length;
  const theirs = g.racks.c.length;
  g.onPlayerLeft('c');
  assert.equal(g.stock.length, stock + theirs);
  assert.deepEqual(g.order, ['a', 'b']);
  assert.equal(g.turn, 'a');
  assert.ok(!g.racks.c);
  assert.equal(lastTo(room, 'b', 'okey-state').players.length, 2);
  assert.equal(g.stock.length + g.racks.a.length + g.racks.b.length, stock + theirs + g.racks.a.length + g.racks.b.length);
});

test('the player on turn leaves: the next one is up and the timer restarts', () => {
  const { g } = staged({}, 4, { stage: 'discard' });
  g.turn = 'b';
  g.onPlayerLeft('b');
  assert.equal(g.turn, 'c');
  assert.equal(g.stage, 'draw');
  assert.deepEqual(g.order, ['a', 'c', 'd']);
  g.handleMessage('c', 'okey-draw', { from: 'discard' });
});

test('the last turn player leaves at the end of the order', () => {
  const { g } = staged({}, 3, { stage: 'discard' });
  g.turn = 'c';
  g.onPlayerLeft('c');
  assert.equal(g.turn, 'a');
});

test('with fewer than two players left the game ends', () => {
  const { g, room } = staged({}, 2);
  g.onPlayerLeft('b');
  assert.equal(g.phase, 'over');
  assert.ok(room.finished);
  assert.equal(room.finished.rows.length, 1);
  assert.equal(room.finished.rows[0].id, 'a');
  assert.equal(room.finished.title.k, 'okey.finish.wins');
  g.onPlayerLeft('b');
});

test('leaving during the pause between hands and after the end is harmless', () => {
  const { g } = staged({ rounds: 3 }, 3);
  give(g, 'a', WIN13.concat(tile(3, 1)));
  g.handleMessage('a', 'okey-discard', { tile: tile(3, 1).id });
  assert.equal(g.phase, 'handOver');
  g.onPlayerLeft('c');
  assert.equal(g.phase, 'handOver');
  assert.deepEqual(g.order, ['a', 'b']);
  g.handTimer && clearTimeout(g.handTimer);
  g.dealHand();
  assert.equal(g.racks.a.length + g.racks.b.length, 29);
});

test('spectator sync and cleanup', () => {
  const { g, room } = staged({ spectators: ['host'] }, 3);
  g.spectatorSync('host');
  const s = lastTo(room, 'host', 'okey-state');
  assert.equal(s.spectator, true);
  assert.equal(s.rack.length, 0);
  assert.equal(s.players.length, 3);
  assert.ok(s.indicator && s.okey);
  g.cleanup();
  assert.equal(g.timer, null);
  assert.equal(g.handTimer, null);
  const n = room.sent.length;
  g.handleMessage('a', 'okey-draw', { from: 'stock' });
  assert.equal(room.sent.length, n, 'a cleaned up game ignores messages');
});

test('page load: the game starts when everybody has loaded', () => {
  const room = fakeRoom();
  const g = new Okey(room, pick(2), {}, { rng: lcg(3), startDelay: 1e7 });
  games.push(g);
  assert.equal(g.running, false);
  g.handleMessage('a', 'okey-page-loaded', {});
  assert.equal(g.running, false);
  assert.ok(lastTo(room, 'a', 'okey-state'));
  g.handleMessage('b', 'okey-page-loaded', {});
  assert.equal(g.running, true);
  const s = lastTo(room, 'a', 'okey-state');
  assert.ok(s.timeLeft > 0);
});

// ----------------------------------------------------------------- i18n

test('every message key the server and client use exists in both languages', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/okey.json', import.meta.url), 'utf8'));
  const files = ['../src/games/okey.js', '../public_html/games/okey.js', '../public_html/games/okey.html'];
  const used = new Set();
  for (const f of files) {
    let src;
    try { src = readFileSync(new URL(f, import.meta.url), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/['"`](okey\.[A-Za-z0-9_.]+)['"`]/g)) used.add(m[1]);
  }
  assert.ok(used.size > 20);
  for (const k of used) {
    if (k.endsWith('.')) continue;
    assert.ok(k in dict.en || `${k}_other` in dict.en, `${k} missing (en)`);
    assert.ok(k in dict.tr || `${k}_other` in dict.tr, `${k} missing (tr)`);
  }
});

test('config: options match the game and it is available', async () => {
  const { GAME_CONFIGS, sanitizeOptions } = await import('../src/games/config.js');
  const c = GAME_CONFIGS.okey;
  assert.equal(c.available, true);
  assert.deepEqual(sanitizeOptions('okey', { mode: '101', rounds: 3, turnTime: 60 }), { mode: '101', rounds: 3, turnTime: 60 });
  assert.deepEqual(sanitizeOptions('okey', { mode: 'x' }), { mode: 'classic', rounds: 1, turnTime: 45 });
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/okey.json', import.meta.url), 'utf8'));
  for (const o of c.options) {
    assert.ok(`okey.opt.${o.key}` in dict.en, `label ${o.key}`);
    if (o.hint) assert.ok(`okey.opt.${o.key}.hint` in dict.en, `hint ${o.key}`);
    for (const ch of o.choices) assert.ok(`okey.opt.${o.key}.${ch.value}` in dict.en, `choice ${o.key}.${ch.value}`);
  }
});
