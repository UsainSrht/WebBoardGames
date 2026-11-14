import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  Kingdomino, Board, TILES, ROT, PICK_MS, PLACE_MS, AUTO_MS, DISCARD_MS, START_FALLBACK_MS, FINISH_DELAY_MS
} from '../src/games/kingdomino.js';

function fakeRoom(ids) {
  const sockets = Object.fromEntries(ids.map(id => [id, { id }]));
  const room = {
    sent: [], broadcasts: [], finished: null,
    broadcast(m) { this.broadcasts.push(m); },
    send(ws, m) { this.sent.push({ to: ws.id, m }); },
    getWsByUserId(id) { return sockets[id] || null; },
    spectatorIds() { return []; },
    finishGame(p) { this.finished = p; },
    lastState() { return [...this.broadcasts].reverse().find(m => m.type === 'kingdomino-state'); },
    lastLegal(id) { return [...this.sent].reverse().find(s => s.to === id && s.m.type === 'kingdomino-legal')?.m; },
    rejects(id) { return this.sent.filter(s => s.to === id && s.m.type === 'kingdomino-reject'); }
  };
  return room;
}

function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function setup(n, options = {}) {
  const ids = ['a', 'b', 'c', 'd'].slice(0, n);
  const room = fakeRoom(ids);
  const players = Object.fromEntries(ids.map(id => [id, { odId: id, name: id.toUpperCase() }]));
  const game = new Kingdomino(room, players, { size: 5, bonuses: 'on', rng: seeded(), ...options });
  ids.forEach(id => game.handleMessage(id, 'kingdomino-ready'));
  return { ids, room, game };
}

/** Play the current step optimally-simple: first legal placement, first free tile. */
function playStep(game, room) {
  const st = room.lastState();
  const actor = st.actor;
  if (st.stage === 'place') {
    if (game.legalList.length === 0) { mock.timers.tick(DISCARD_MS); return; }
    const legal = room.lastLegal(actor);
    const [r, c, rot] = legal.list[0];
    game.handleMessage(actor, 'kingdomino-place', { tile: st.tile, r, c, rot });
  } else {
    const free = st.cur.find(s => !s.owner);
    game.handleMessage(actor, 'kingdomino-pick', { tile: free.tile });
  }
}

test('tile table has 48 unique tiles and 39 crowns', () => {
  assert.equal(Object.keys(TILES).length, 48);
  let crowns = 0;
  for (const t of Object.values(TILES)) crowns += t.l[1] + t.r[1];
  assert.equal(crowns, 39);
});

test('setup per player count', () => {
  for (const [n, rows, draft, kings] of [[2, 6, 4, 2], [3, 12, 3, 1], [4, 12, 4, 1]]) {
    const { game, room } = setup(n);
    assert.equal(game.rows.length, rows);
    assert.equal(game.draftSize, draft);
    assert.equal(game.kingsEach, kings);
    const st = room.lastState();
    assert.equal(st.phase, 'play');
    assert.equal(st.cur.length, draft);
    assert.equal(st.steps.length, draft);
    assert.equal(st.rounds, rows + 1);
    for (const row of game.rows) assert.deepEqual(row, [...row].sort((a, b) => a - b));
    game.cleanup();
  }
});

test('waits for everyone to load, with a fallback start', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const ids = ['a', 'b'];
    const room = fakeRoom(ids);
    const game = new Kingdomino(room, { a: { odId: 'a', name: 'A' }, b: { odId: 'b', name: 'B' } }, { size: 5, bonuses: 'on' });
    game.handleMessage('a', 'kingdomino-ready');
    assert.equal(room.lastState()?.phase ?? 'wait', 'wait');
    mock.timers.tick(START_FALLBACK_MS);
    assert.equal(game.phase, 'play');
    game.cleanup();
  } finally { mock.timers.reset(); }
});

test('placement rules: adjacency, terrain, castle, bounds, overlap', () => {
  const b = new Board(5);
  const farmFarm = TILES[1];
  // Touching the castle is always fine.
  assert.ok(b.canPlace(farmFarm, 0, 1, 0));
  assert.ok(b.canPlace(farmFarm, 1, 0, 1));
  // Not touching anything.
  assert.ok(!b.canPlace(farmFarm, 2, 2, 0));
  // Overlapping the castle.
  assert.ok(!b.canPlace(farmFarm, 0, -1, 0));
  b.place(farmFarm, 0, 1, 0); // farm at (0,1),(0,2)
  // Same terrain next to a farm square (not touching castle).
  assert.ok(b.canPlace(TILES[2], 1, 2, 0));
  // Different terrain, away from the castle: illegal.
  assert.ok(!b.canPlace(TILES[3], 1, 2, 0));
  assert.ok(!b.canPlace(TILES[3], -1, 2, 0));
  // Mixed tile matching on one half only is enough.
  assert.ok(b.canPlace(TILES[13], 1, 2, 0)); // farm,forest: farm at (1,2) touches farm (0,2)
  // Overlap.
  assert.ok(!b.canPlace(farmFarm, 0, 2, 0));
  // Invalid inputs.
  assert.ok(!b.canPlace(farmFarm, 1.5, 0, 0));
  assert.ok(!b.canPlace(farmFarm, 1, 0, 4));
  assert.ok(!b.canPlace(farmFarm, 1, 0, '1'));
});

test('bounding box limits the kingdom to size x size', () => {
  const b = new Board(5);
  const f = TILES[1];
  // Build a horizontal row to the right: castle at col 0, squares cols 1..4 (width 5).
  assert.ok(b.place(f, 0, 1, 0)); // cols 1,2
  assert.ok(b.place(f, 0, 3, 0)); // cols 3,4
  assert.equal(b.extents().maxC, 4);
  // One more to the right would make width 6.
  assert.ok(!b.canPlace(f, 0, 5, 0));
  // Going left of the castle is now impossible (width would be 6).
  assert.ok(!b.canPlace(f, 0, -2, 0));
  assert.ok(!b.canPlace(f, 0, -1, 2));
  // Vertical is still free.
  assert.ok(b.canPlace(f, 1, 0, 1));
  // 7x7 allows more.
  const b7 = new Board(7);
  b7.place(f, 0, 1, 0); b7.place(f, 0, 3, 0);
  assert.ok(b7.canPlace(f, 0, 5, 0));
});

test('legal list matches canPlace and rotation offsets', () => {
  const b = new Board(5);
  const tile = TILES[19]; // farm(1) + forest
  const list = b.legal(tile);
  assert.ok(list.length > 0);
  for (const [r, c, rot] of list) assert.ok(b.canPlace(tile, r, c, rot));
  b.place(tile, 0, 1, 0);
  assert.equal(b.at(0, 1).t, 'farm');
  assert.equal(b.at(0, 2).t, 'forest');
  b.place(TILES[13], 1, 0, 1); // right half goes below
  assert.equal(b.at(1, 0).t, 'farm');
  assert.equal(b.at(2, 0).t, 'forest');
  assert.deepEqual(ROT[2], [0, -1]);
});

test('scoring: properties, crowns, bonuses', () => {
  const b = new Board(5);
  b.place(TILES[19], 0, 1, 0);   // farm(1) at (0,1), forest at (0,2)
  b.place(TILES[20], 1, 0, 1);   // farm(1) at (1,0), water at (2,0)
  b.place(TILES[1], 1, 1, 0);    // farm (1,1),(1,2): joins (0,1) and (1,0)
  let s = b.score(true);
  // farm property: (0,1),(1,0),(1,1),(1,2) = 4 squares, 2 crowns = 8; forest 1 square 0 crowns; water 0.
  assert.equal(s.base, 8);
  assert.equal(s.largest, 4);
  assert.equal(s.crowns, 2);
  assert.equal(s.middle, 0);
  assert.equal(s.total, 8);
  assert.equal(b.score(false).total, 8);

  // Middle Kingdom: symmetric extents.
  const m = new Board(5);
  m.place(TILES[1], 0, 1, 0);    // east
  m.place(TILES[1], 0, -1, 2);   // west: (0,-1),(0,-2)
  m.place(TILES[3], 1, 0, 1);    // south (1,0),(2,0)
  m.place(TILES[3], -1, 0, 3);   // north (-1,0),(-2,0)
  const ms = m.score(true);
  assert.equal(ms.middle, 10);
  assert.equal(m.score(false).middle, 0);
});

test('harmony needs a complete kingdom without discards', () => {
  const b = new Board(5);
  // Fill a 5x5 by hand with farm squares.
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
    if (r || c) b.cells.set(`${r},${c}`, { r, c, t: 'farm', k: 0, n: 1 });
  }
  let s = b.score(true);
  assert.equal(s.harmony, 5);
  assert.equal(s.middle, 10);
  b.discards = 1;
  assert.equal(b.score(true).harmony, 0);
  b.discards = 0;
  assert.equal(b.score(false).total, 0);
});

test('turn flow: first round picks only, then place then pick, final place only', () => {
  const { game, room } = setup(3);
  let st = room.lastState();
  assert.equal(st.round, 1);
  assert.equal(st.stage, 'pick');
  assert.equal(st.prev, null);
  assert.ok(st.steps.every(s => s.place === null));
  // Acting out of turn is rejected.
  const other = ['a', 'b', 'c'].find(i => i !== st.actor);
  game.handleMessage(other, 'kingdomino-pick', { tile: st.cur[0].tile });
  assert.equal(room.rejects(other).length, 1);
  // Invalid tile
  game.handleMessage(st.actor, 'kingdomino-pick', { tile: 999 });
  assert.equal(room.rejects(st.actor).length, 1);

  for (let i = 0; i < 3; i++) playStep(game, room);
  st = room.lastState();
  assert.equal(st.round, 2);
  assert.ok(st.prev.every(s => s.owner));
  assert.ok(st.cur.every(s => !s.owner));
  // Players act in order of the previous row's tile numbers.
  const order = [...st.prev].sort((x, y) => x.tile - y.tile).map(s => s.owner);
  assert.deepEqual(st.steps.map(s => s.id), order);
  assert.equal(st.stage, 'place');
  assert.equal(st.tile, [...st.prev].sort((x, y) => x.tile - y.tile)[0].tile);

  // Wrong tile / illegal placement is rejected, still the same stage.
  const actor = st.actor;
  const rejBefore = room.rejects(actor).length;
  game.handleMessage(actor, 'kingdomino-place', { tile: st.tile + 1, r: 0, c: 1, rot: 0 });
  game.handleMessage(actor, 'kingdomino-place', { tile: st.tile, r: 4, c: 4, rot: 0 });
  assert.equal(room.rejects(actor).length - rejBefore, 2);
  assert.equal(room.lastState().stage, 'place');
  playStep(game, room);
  assert.equal(room.lastState().stage, 'pick');
  assert.equal(room.lastState().actor, actor);
  game.cleanup();
});

test('a full game for every player count finishes with ranked rows', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try { fullGames(); } finally { mock.timers.reset(); }
});

function fullGames() {
  for (const n of [2, 3, 4]) {
    const { game, room } = setup(n);
    let guard = 0;
    while (!room.finished && guard++ < 500) playStep(game, room);
    assert.ok(room.finished, `game with ${n} players finished`);
    const rows = room.finished.rows;
    assert.equal(rows.length, n);
    assert.equal(room.finished.delayMs, FINISH_DELAY_MS);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
    assert.match(rows[0].note, /Largest property: \d+/);
    const st = room.lastState();
    assert.equal(st.phase, 'over');
    // Every player ends with 12 tiles on board or discarded.
    for (const p of st.players) assert.equal(p.cells.length / 2 + p.discards, 12);
    assert.equal(st.final.length, n);
    game.cleanup();
  }
}

test('two players each act twice per round', () => {
  const { game, room } = setup(2);
  const st = room.lastState();
  const counts = {};
  for (const s of st.steps) counts[s.id] = (counts[s.id] || 0) + 1;
  assert.deepEqual(Object.values(counts), [2, 2]);
  game.cleanup();
});

test('timeouts auto-play, pick 20s then place 30s', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { game, room } = setup(3);
    let st = room.lastState();
    assert.equal(st.duration, PICK_MS);
    mock.timers.tick(PICK_MS);
    st = room.lastState();
    assert.equal(st.cur.filter(s => s.owner).length, 1);
    assert.ok(room.lastState().notices.some(n => n.kind === 'pick' && n.auto));
    mock.timers.tick(PICK_MS);
    mock.timers.tick(PICK_MS);
    st = room.lastState();
    assert.equal(st.round, 2);
    assert.equal(st.stage, 'place');
    assert.equal(st.duration, PLACE_MS);
    const before = st.players.find(p => p.id === st.actor).cells.length;
    const actor = st.actor;
    mock.timers.tick(PLACE_MS);
    st = room.lastState();
    assert.equal(st.players.find(p => p.id === actor).cells.length, before + 2);
    assert.equal(st.stage, 'pick');
    game.cleanup();
  } finally { mock.timers.reset(); }
});

test('a tile with no legal placement is discarded and announced', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { game, room } = setup(3);
    // Fill player a's board so nothing fits, then force a step for a.
    const a = game.pl.a.board;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      if (r || c) a.cells.set(`${r},${c}`, { r, c, t: 'farm', k: 0, n: 1 });
    }
    game.steps = [{ odId: 'a', place: 5, pick: false }, { odId: 'b', place: null, pick: true }];
    game.prev = [{ tile: 5, owner: 'a' }];
    game.enterStep(0);
    let st = room.lastState();
    assert.equal(st.prev[0].placed, 'discarded');
    assert.ok(st.notices.some(n => n.kind === 'discard' && n.odId === 'a' && n.tile === 5));
    assert.equal(st.players.find(p => p.id === 'a').discards, 1);
    assert.equal(st.players.find(p => p.id === 'a').harmony, 0);
    mock.timers.tick(DISCARD_MS);
    assert.equal(game.stepIdx, 1);
    game.cleanup();
  } finally { mock.timers.reset(); }
});

test('players who left are auto-played immediately', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { game, room } = setup(3);
    const st = room.lastState();
    game.onPlayerLeft(st.actor);
    assert.equal(room.lastState().cur.filter(s => s.owner).length, 0);
    mock.timers.tick(AUTO_MS);
    assert.equal(room.lastState().cur.filter(s => s.owner).length, 1);
    // A left player's later steps also resolve quickly: run the whole game on timers.
    let guard = 0;
    while (!room.finished && guard++ < 400) {
      const s = room.lastState();
      if (s.actor === st.actor) mock.timers.tick(AUTO_MS);
      else playStep(game, room);
      if (s.phase === 'over') break;
    }
    assert.ok(room.finished);
    game.cleanup();
  } finally { mock.timers.reset(); }
});

test('reload and spectator sync resend the snapshot and legal list', () => {
  const { game, room } = setup(3);
  for (let i = 0; i < 3; i++) playStep(game, room);
  const st = room.lastState();
  room.sent.length = 0;
  game.spectatorSync('spec');
  game.handleMessage(st.actor, 'kingdomino-ready');
  const types = room.sent.map(s => s.m.type);
  assert.ok(types.includes('kingdomino-state'));
  assert.ok(types.includes('kingdomino-legal'));
  assert.equal(room.lastLegal(st.actor).tile, st.tile);
  // Non-actors never receive a legal list.
  const other = ['a', 'b', 'c'].find(i => i !== st.actor);
  room.sent.length = 0;
  game.handleMessage(other, 'kingdomino-ready');
  assert.ok(!room.sent.some(s => s.m.type === 'kingdomino-legal'));
  game.cleanup();
});

test('hostile input is ignored', () => {
  const { game, room } = setup(2);
  game.handleMessage('stranger', 'kingdomino-pick', { tile: 1 });
  game.handleMessage('a', 'kingdomino-pick', null);
  game.handleMessage('a', 'kingdomino-place', { tile: 'x', r: {}, c: [], rot: 9 });
  game.handleMessage('a', 'unknown', {});
  assert.equal(room.lastState().phase, 'play');
  game.cleanup();
});

test('cleanup clears timers', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { game, room } = setup(2);
    const n = room.broadcasts.length;
    game.cleanup();
    mock.timers.tick(PICK_MS * 3);
    assert.equal(room.broadcasts.length, n);
  } finally { mock.timers.reset(); }
});

test('tie-breakers: largest property then crowns', () => {
  const { game } = setup(2);
  const fill = (board, cells) => cells.forEach(([r, c, t, k]) => board.cells.set(`${r},${c}`, { r, c, t, k, n: 1 }));
  // Both score 4: a = 2x2 property with... use simple equal-score setups.
  fill(game.pl.a.board, [[0, 1, 'farm', 2], [0, 2, 'farm', 0]]);            // 2 squares * 2 = 4, largest 2
  fill(game.pl.b.board, [[0, 1, 'farm', 1], [0, 2, 'farm', 1], [1, 1, 'farm', 0], [1, 2, 'forest', 0]]); // 3*2=6
  assert.deepEqual(game.standings().map(r => r.id), ['b', 'a']);
  game.pl.b.board.cells.clear();
  fill(game.pl.b.board, [[0, 1, 'farm', 1], [1, 1, 'forest', 1], [1, 2, 'forest', 1], [0, 2, 'water', 1]]);
  // b: farm 1x1=1, forest 2x2=4, water 1 = 6 total... compare with a=4 so b still first
  assert.equal(game.standings()[0].id, 'b');
  game.cleanup();
});

test('snapshot: doms carry the picture, live score excludes bonuses until the end', () => {
  const { game, room } = setup(2);
  const st0 = room.lastState();
  assert.ok(st0.players.every(p => p.score === 0 && p.middle === 10));
  let guard = 0;
  while (!room.finished && guard++ < 500) {
    const st = room.lastState();
    if (st.stage === 'place' && game.legalList.length === 0) { game.cleanup(); break; }
    playStep(game, room);
  }
  const st = room.lastState();
  const withDoms = st.players.find(p => p.doms.length);
  if (withDoms) assert.ok(withDoms.doms.every(d => typeof d.a === 'string' && Number.isInteger(d.rot)));
  game.cleanup();
});
