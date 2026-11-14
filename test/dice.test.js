import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Dice, scoreSelection, bestScoring, hasScoring, TURN_MS, FARKLE_PAUSE_MS, BANK_PAUSE_MS } from '../src/games/dice.js';

const sc = (...v) => scoreSelection(v);

test('single dice and triples', () => {
  assert.deepEqual(sc(1), { valid: true, score: 100 });
  assert.deepEqual(sc(5), { valid: true, score: 50 });
  assert.equal(sc(1, 5).score, 150);
  assert.equal(sc(1, 1).score, 200);
  assert.equal(sc(5, 5).score, 100);
  assert.equal(sc(2, 2, 2).score, 200);
  assert.equal(sc(3, 3, 3).score, 300);
  assert.equal(sc(6, 6, 6).score, 600);
  assert.equal(sc(1, 1, 1).score, 1000);
  assert.equal(sc(5, 5, 5).score, 500);
  assert.equal(sc(2, 2, 2, 1).score, 300);
  assert.equal(sc(5, 5, 5, 1, 1).score, 700);
});

test('four, five and six of a kind double each time', () => {
  assert.equal(sc(2, 2, 2, 2).score, 400);
  assert.equal(sc(2, 2, 2, 2, 2).score, 800);
  assert.equal(sc(2, 2, 2, 2, 2, 2).score, 1600);
  assert.equal(sc(1, 1, 1, 1).score, 2000);
  assert.equal(sc(1, 1, 1, 1, 1).score, 4000);
  assert.equal(sc(1, 1, 1, 1, 1, 1).score, 8000);
  assert.equal(sc(6, 6, 6, 6).score, 1200);
  assert.equal(sc(5, 5, 5, 5, 1).score, 1100);
});

test('six dice combinations', () => {
  assert.equal(sc(1, 2, 3, 4, 5, 6).score, 1500);
  assert.equal(sc(6, 5, 4, 3, 2, 1).score, 1500);
  assert.equal(sc(2, 2, 3, 3, 4, 4).score, 1500);
  assert.equal(sc(1, 1, 3, 3, 6, 6).score, 1500);
  assert.equal(sc(2, 2, 2, 2, 3, 3).score, 1500);
  assert.equal(sc(1, 1, 1, 1, 2, 2).score, 2000 > 1500 ? 1500 : 0, 'four plus a pair is the 1500 bonus when the pair does not score');
  assert.equal(sc(2, 2, 2, 3, 3, 3).score, 2500);
  assert.equal(sc(1, 1, 1, 5, 5, 5).score, 2500);
  assert.equal(sc(1, 1, 1, 1, 1, 5).score, 4050);
  // the best valid reading wins: four 1s plus two 5s is 2100, more than the 1500 bonus
  assert.equal(sc(1, 1, 1, 1, 5, 5).score, 2100);
});

test('every selected die has to contribute', () => {
  assert.equal(sc(2).valid, false);
  assert.equal(sc(1, 2).valid, false);
  assert.equal(sc(2, 2).valid, false);
  assert.equal(sc(2, 2, 3).valid, false);
  assert.equal(sc(1, 1, 1, 2).valid, false);
  assert.equal(sc(1, 2, 3, 4, 5).valid, false);
  assert.equal(sc(2, 2, 3, 3, 4, 5).valid, false);
  assert.equal(sc().valid, false);
  assert.equal(scoreSelection([7]).valid, false);
  assert.equal(scoreSelection([1.5]).valid, false);
  assert.equal(scoreSelection([1, 1, 1, 1, 1, 1, 1]).valid, false);
});

test('bestScoring and hasScoring', () => {
  assert.equal(hasScoring([2, 3, 4, 6, 6, 2]), false);
  assert.equal(hasScoring([2, 3, 4, 6, 6, 5]), true);
  assert.deepEqual(bestScoring([2, 3, 4, 6, 6, 2]), { indices: [], score: 0 });
  assert.deepEqual(bestScoring([1, 2, 5, 3, 4, 6]), { indices: [0, 1, 2, 3, 4, 5], score: 1500 });
  assert.deepEqual(bestScoring([2, 2, 2, 3, 3, 5]), { indices: [0, 1, 2, 5], score: 250 });
  assert.deepEqual(bestScoring([1, 5, 2]), { indices: [0, 1], score: 150 });
  assert.equal(bestScoring([3, 3, 3, 3, 1, 1]).score, 1500);
  assert.equal(bestScoring([3, 3, 3, 3, 1, 5]).score, 750);
});

/* ------------------------------------------------------------- game tests */

function fakeRoom(spectators = []) {
  const room = {
    sent: [], broadcasts: [], finished: null,
    broadcast(m) { room.broadcasts.push(m); },
    send(ws, m) { room.sent.push({ ws, m }); },
    getWsByUserId(id) { return `ws-${id}`; },
    spectatorIds: () => spectators,
    finishGame(p) { room.finished = p; }
  };
  room.last = () => room.broadcasts[room.broadcasts.length - 1];
  return room;
}

/** Game with scripted dice: `faces` are the dice values rolled in order (zeros after that). */
function setup(faces, { n = 2, options = {}, spectators = [] } = {}) {
  const room = fakeRoom(spectators);
  const players = {};
  for (let i = 0; i < n; i++) players['p' + i] = { odId: 'p' + i, name: 'Player' + i };
  let seating = n - 1; // the seating shuffle consumes n-1 values; 0.999 keeps the order
  const queue = [...faces];
  const rng = () => {
    if (seating > 0) { seating--; return 0.999; }
    const f = queue.shift();
    return f === undefined ? 0 : (f - 1) / 6 + 0.01;
  };
  const game = new Dice(room, players, { target: 2000, opening: 0, ...options }, rng);
  game.start();
  return { room, game };
}

const state = (room) => room.last();
const BAD = [2, 3, 4, 6, 6, 2];

function withTimers(fn) {
  return (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => mock.timers.reset());
    return fn(t);
  };
}

test('first roll, keep and bank', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 3, 4, 6]);
  assert.equal(state(room).phase, 'roll');
  assert.equal(state(room).turn, 'p0');
  game.handleMessage('p1', 'dice-roll');                  // not your turn
  assert.equal(state(room).phase, 'roll');
  game.handleMessage('p0', 'dice-roll');
  let s = state(room);
  assert.equal(s.phase, 'pick');
  assert.deepEqual(s.dice.map(d => d.v), [1, 2, 3, 3, 4, 6]);
  game.handleMessage('p0', 'dice-bank', { keep: [1] });    // a 2 does not score
  assert.equal(state(room).phase, 'pick');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 0] }); // duplicate indices
  assert.equal(state(room).phase, 'pick');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });
  s = state(room);
  assert.equal(s.phase, 'busy');
  assert.equal(s.players[0].banked, 100);
  assert.equal(s.event.kind, 'bank');
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).turn, 'p1');
  assert.equal(state(room).phase, 'roll');
}));

test('keep and roll the rest, turn score accumulates', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6, 5, 5, 2, 3, 4]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0] });
  let s = state(room);
  assert.equal(s.turnScore, 100);
  assert.deepEqual(s.rolled, [1, 2, 3, 4, 5]);
  assert.equal(s.dice[0].held, true);
  assert.equal(s.dice.filter(d => d.held).length, 1);
  game.handleMessage('p0', 'dice-roll', { keep: [0] });    // a held die cannot be chosen again
  assert.equal(state(room).turnScore, 100);
  game.handleMessage('p0', 'dice-bank', { keep: [1, 2] });
  s = state(room);
  assert.equal(s.players[0].banked, 200);
}));

test('cannot roll again without setting a die aside', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [] });
  assert.equal(state(room).turnScore, 0);
  assert.equal(state(room).rollSeq, 1);
}));

test('a farkle loses the turn score and passes the turn', withTimers(() => {
  const { room, game } = setup([1, 1, 1, 2, 3, 4, ...BAD, 1, 5, 2, 3, 4, 6]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0, 1, 2] });   // 1000, rerolls 3 dice: 2 3 4 -> no score
  let s = state(room);
  assert.equal(s.event.kind, 'farkle');
  assert.equal(s.event.points, 1000, 'reports what was lost');
  assert.equal(s.turnScore, 0);
  assert.equal(s.players[0].banked, 0);
  assert.equal(s.players[0].strikes, 1);
  assert.equal(s.phase, 'busy');
  mock.timers.tick(FARKLE_PAUSE_MS);
  assert.equal(state(room).turn, 'p1');
}));

test('three farkles in a row cost 1000 and the counter resets', withTimers(() => {
  // p0 banks 2000 in a 10000 game, then farkles three times in a row.
  const faces = [1, 1, 1, 1, 2, 3, ...BAD, ...BAD, ...BAD, ...BAD, ...BAD, ...BAD];
  const { room, game } = setup(faces, { options: { target: 10000 } });
  const farkle = (id) => { game.handleMessage(id, 'dice-roll'); mock.timers.tick(FARKLE_PAUSE_MS); };
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2, 3] });
  mock.timers.tick(BANK_PAUSE_MS);
  farkle('p1');
  farkle('p0'); assert.equal(state(room).players[0].strikes, 1);
  farkle('p1');
  farkle('p0'); assert.equal(state(room).players[0].strikes, 2);
  farkle('p1');
  game.handleMessage('p0', 'dice-roll');
  const s = state(room);
  assert.equal(s.event.kind, 'triple-farkle');
  assert.equal(s.event.penalty, 1000);
  assert.equal(s.players[0].banked, 1000);
  assert.equal(s.players[0].strikes, 0);
}));

test('the three-farkle penalty never goes below zero', withTimers(() => {
  const { room, game } = setup([...BAD, ...BAD, ...BAD, ...BAD, ...BAD, ...BAD]);
  const farkle = (id) => { game.handleMessage(id, 'dice-roll'); mock.timers.tick(FARKLE_PAUSE_MS); };
  for (let i = 0; i < 3; i++) { farkle('p0'); farkle('p1'); }
  const s = state(room);
  assert.equal(s.players[0].banked, 0);
  assert.equal(s.players[0].strikes, 0);
}));

test('banking resets the farkle counter', withTimers(() => {
  const { room, game } = setup([...BAD, ...BAD, 1, 5, 2, 3, 4, 6, ...BAD, 1, 5, 2, 3, 4, 6], { options: { target: 10000 } });
  const farkle = (id) => { game.handleMessage(id, 'dice-roll'); mock.timers.tick(FARKLE_PAUSE_MS); };
  farkle('p0'); farkle('p1'); // p0: 1 strike
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });
  assert.equal(state(room).players[0].strikes, 0);
}));

test('hot dice gives six fresh dice', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 5, 6, 3, 3, 3, 1, 5, 2]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0, 1, 2, 3, 4, 5] });
  const s = state(room);
  assert.equal(s.turnScore, 1500);
  assert.equal(s.event.kind, 'hot-dice');
  assert.equal(s.dice.every(d => !d.held), true);
  assert.deepEqual(s.rolled, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(s.dice.map(d => d.v), [3, 3, 3, 1, 5, 2]);
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2, 3, 4] });
  assert.equal(state(room).players[0].banked, 1500 + 300 + 100 + 50);
}));

test('hot dice followed by a dead roll is a farkle', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 5, 6, ...BAD]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0, 1, 2, 3, 4, 5] });
  assert.equal(state(room).event.kind, 'farkle');
  assert.equal(state(room).event.points, 1500);
}));

test('opening threshold blocks a small first bank', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 6, 6], { options: { opening: 500, target: 10000 } });
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });     // 100 < 500
  assert.equal(state(room).phase, 'pick');
  assert.ok(room.sent.some(x => x.m.type === 'dice-error'));
}));

test('opening threshold counts the whole turn and applies to the first bank only', withTimers(() => {
  // p0: 1 1 1 2 3 4 -> keep triple 1s (1000) and bank: opened. p1 farkles. p0 then banks 100.
  const { room, game } = setup([1, 1, 1, 2, 3, 4, ...BAD, 1, 2, 3, 4, 6, 6], { options: { opening: 500, target: 10000 } });
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2] });
  assert.equal(state(room).players[0].banked, 1000);
  assert.equal(state(room).players[0].opened, true);
  mock.timers.tick(BANK_PAUSE_MS);
  game.handleMessage('p1', 'dice-roll');
  mock.timers.tick(FARKLE_PAUSE_MS);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });
  assert.equal(state(room).players[0].banked, 1100);
}));

test('opening: turn score accumulated over several rolls can reach the threshold', withTimers(() => {
  // keep 1 (100), reroll 5: 1 1 2 3 4 -> keep two 1s (200) reroll 3: 5 5 5 -> bank 100+200+500 = 800
  const { room, game } = setup([1, 2, 3, 4, 6, 6, 1, 1, 2, 3, 4, 5, 5, 5], { options: { opening: 500, target: 10000 } });
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0] });
  game.handleMessage('p0', 'dice-roll', { keep: [1, 2] });
  game.handleMessage('p0', 'dice-bank', { keep: [3, 4, 5] });
  assert.equal(state(room).players[0].banked, 800);
}));

test('reaching the target gives everybody else exactly one more turn; ties share the rank', withTimers(() => {
  const { room, game } = setup([1, 1, 1, 1, 2, 3, 1, 1, 1, 1, 2, 3]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2, 3] });
  assert.equal(state(room).finalRound, true);
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).turn, 'p1');
  game.handleMessage('p1', 'dice-roll');
  game.handleMessage('p1', 'dice-bank', { keep: [0, 1, 2, 3] });
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).phase, 'over');
  assert.ok(room.finished);
  assert.deepEqual(room.finished.rows.map(r => r.rank), [1, 1]);
  assert.match(room.finished.title, /Tie/);
}));

test('in the last round a trailing player can overtake and everybody plays once', withTimers(() => {
  const { room, game } = setup([1, 1, 1, 1, 2, 3, 1, 1, 1, 1, 1, 3, 1, 5, 2, 3, 4, 6], { n: 3 });
  assert.equal(state(room).turn, 'p0');
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2, 3] });          // 2000 triggers
  mock.timers.tick(BANK_PAUSE_MS);
  game.handleMessage('p1', 'dice-roll');
  game.handleMessage('p1', 'dice-bank', { keep: [0, 1, 2, 3, 4] });       // 4000
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).phase, 'roll');
  assert.equal(state(room).turn, 'p2');
  game.handleMessage('p2', 'dice-roll');
  game.handleMessage('p2', 'dice-bank', { keep: [0] });
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).phase, 'over');
  assert.equal(room.finished.rows[0].id, 'p1');
  assert.deepEqual(room.finished.rows.map(r => r.rank), [1, 2, 3]);
  assert.equal(room.finished.rows[0].score, 4000);
}));

test('a farkle in the last round still uses up that player turn', withTimers(() => {
  const { room, game } = setup([1, 1, 1, 1, 2, 3, ...BAD]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0, 1, 2, 3] });
  mock.timers.tick(BANK_PAUSE_MS);
  game.handleMessage('p1', 'dice-roll');
  mock.timers.tick(FARKLE_PAUSE_MS);
  assert.equal(state(room).phase, 'over');
  assert.equal(room.finished.rows[0].id, 'p0');
}));

test('timeout auto-banks the best scoring dice', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 2, 4, 6]);
  game.handleMessage('p0', 'dice-roll');
  mock.timers.tick(TURN_MS);
  const s = state(room);
  assert.equal(s.players[0].banked, 150);
  assert.equal(s.event.kind, 'bank');
  void game;
}));

test('timeout auto-banks on top of dice already held', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 6, 6, 5, 1, 2, 3, 4], { options: { target: 10000 } });
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-roll', { keep: [0] });
  mock.timers.tick(TURN_MS);
  assert.equal(state(room).players[0].banked, 100 + 150);
}));

test('timeout auto-bank respects the opening threshold (counts as a farkle)', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 6, 6], { options: { opening: 500, target: 10000 } });
  game.handleMessage('p0', 'dice-roll');
  mock.timers.tick(TURN_MS);
  assert.equal(state(room).event.kind, 'farkle');
  assert.equal(state(room).players[0].banked, 0);
}));

test('timeout before rolling counts as a farkle', withTimers(() => {
  const { room } = setup([]);
  mock.timers.tick(TURN_MS);
  const s = state(room);
  assert.equal(s.event.kind, 'farkle');
  assert.equal(s.players[0].strikes, 1);
  mock.timers.tick(FARKLE_PAUSE_MS);
  assert.equal(state(room).turn, 'p1');
}));

test('the turn timer restarts after every roll', withTimers(() => {
  const { room, game } = setup([1, 2, 3, 4, 6, 6, 5, 1, 2, 3, 4]);
  game.handleMessage('p0', 'dice-roll');
  mock.timers.tick(TURN_MS - 1000);
  game.handleMessage('p0', 'dice-roll', { keep: [0] });
  mock.timers.tick(TURN_MS - 1000);
  assert.equal(state(room).phase, 'pick');
  assert.equal(state(room).turn, 'p0');
}));

test('leavers are skipped; the last player standing wins', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6], { n: 3 });
  game.onPlayerLeft('p1');
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });
  mock.timers.tick(BANK_PAUSE_MS);
  assert.equal(state(room).turn, 'p2');
  game.onPlayerLeft('p2');
  assert.equal(state(room).phase, 'over');
  assert.equal(room.finished.rows[0].id, 'p0');
  assert.equal(room.finished.rows[0].rank, 1);
  assert.equal(room.finished.rows.at(-1).note, 'Left the game');
}));

test('leaving on your own turn passes the turn', withTimers(() => {
  const { room, game } = setup([], { n: 3 });
  game.onPlayerLeft('p0');
  assert.equal(state(room).turn, 'p1');
  assert.equal(state(room).players[0].left, true);
}));

test('spectator sync and page-loaded send the full state; cleanup clears timers', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6], { spectators: ['host'] });
  game.handleMessage('p0', 'dice-roll');
  game.spectatorSync('host');
  const last = room.sent.at(-1);
  assert.equal(last.ws, 'ws-host');
  assert.equal(last.m.type, 'dice-state');
  assert.equal(last.m.dice.length, 6);
  game.handleMessage('p1', 'dice-page-loaded');
  assert.equal(room.sent.at(-1).ws, 'ws-p1');
  game.cleanup();
  const before = room.broadcasts.length;
  mock.timers.tick(TURN_MS * 2);
  assert.equal(room.broadcasts.length, before);
}));

test('invalid client input is rejected', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6]);
  game.handleMessage('p0', 'dice-roll');
  for (const keep of [undefined, null, 'x', [], [9], [-1], [1.5], ['0'], [2], [0, 0], [0, 1, 2, 3, 4, 5, 6]]) {
    game.handleMessage('p0', 'dice-bank', { keep });
    assert.equal(state(room).phase, 'pick');
  }
  game.handleMessage('nobody', 'dice-roll');
  game.handleMessage('p0', 'dice-bank');
  assert.equal(state(room).phase, 'pick');
}));

test('actions during the pause after a turn are ignored', withTimers(() => {
  const { room, game } = setup([1, 5, 2, 3, 4, 6]);
  game.handleMessage('p0', 'dice-roll');
  game.handleMessage('p0', 'dice-bank', { keep: [0] });
  game.handleMessage('p0', 'dice-bank', { keep: [1] });
  game.handleMessage('p0', 'dice-roll', { keep: [1] });
  assert.equal(state(room).players[0].banked, 100);
}));

test('game starts after the fallback even if nobody loaded, and sooner when all loaded', withTimers(() => {
  const room = fakeRoom();
  const g = new Dice(room, { a: { name: 'Aaa' }, b: { name: 'Bbb' } }, { target: 2000, opening: 0 });
  assert.equal(room.broadcasts.length, 0);
  mock.timers.tick(7000);
  assert.equal(room.last().phase, 'roll');
  g.cleanup();

  const room2 = fakeRoom();
  const g2 = new Dice(room2, { a: { name: 'Aaa' }, b: { name: 'Bbb' } }, { target: 2000, opening: 0 });
  g2.handleMessage('a', 'dice-page-loaded');
  g2.handleMessage('b', 'dice-page-loaded');
  mock.timers.tick(1000);
  assert.equal(room2.last().phase, 'roll');
  g2.cleanup();
}));
