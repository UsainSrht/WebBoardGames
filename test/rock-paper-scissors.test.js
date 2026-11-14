import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RockPaperScissors, resolveThrows, compare, CHOOSE_MS, SHOOT_MS, REVEAL_MS } from '../src/games/rock-paper-scissors.js';

function fakeRoom(spectators = []) {
  const room = {
    sent: [], finished: null,
    broadcast() {},
    send(ws, m) { room.sent.push({ ws, m }); },
    getWsByUserId(id) { return `ws-${id}`; },
    spectatorIds: () => spectators,
    finishGame(p) { room.finished = p; }
  };
  /** Latest state message delivered to this user. */
  room.stateFor = (id) => [...room.sent].reverse().find(x => x.ws === `ws-${id}` && x.m.type === 'rps-state')?.m;
  return room;
}

function setup(n, options = {}, { spectators = [], rng = () => 0 } = {}) {
  const room = fakeRoom(spectators);
  const players = {};
  for (let i = 0; i < n; i++) players['p' + i] = { odId: 'p' + i, name: 'Player' + i };
  const game = new RockPaperScissors(room, players, options, rng);
  for (let i = 0; i < n; i++) game.handleMessage('p' + i, 'rps-page-loaded');
  mock.timers.tick(1000);
  return { room, game, ids: Object.keys(players) };
}

function withTimers(fn) {
  return (t) => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    t.after(() => mock.timers.reset());
    return fn(t);
  };
}

/** Everybody picks (moves: { id: move }), then run shoot + reveal. Returns the reveal state. */
function play(room, game, moves) {
  for (const [id, move] of Object.entries(moves)) game.handleMessage(id, 'rps-move', { move });
  mock.timers.tick(600);              // all locked in -> shoot
  mock.timers.tick(SHOOT_MS);         // -> reveal
  const s = room.stateFor('p0');
  assert.equal(s.phase, 'reveal');
  return s;
}

function next(room, game) {
  mock.timers.tick(REVEAL_MS);
  return room.stateFor('p0');
}

test('compare and resolveThrows', () => {
  assert.equal(compare('rock', 'scissors'), 1);
  assert.equal(compare('scissors', 'rock'), -1);
  assert.equal(compare('paper', 'rock'), 1);
  assert.equal(compare('paper', 'paper'), 0);
  const r = resolveThrows({ a: 'rock', b: 'scissors', c: 'scissors' });
  assert.equal(r.results.a.beat, 2);
  assert.equal(r.results.a.result, 'win');
  assert.equal(r.results.b.result, 'lose');
  assert.deepEqual(r.kinds.sort(), ['rock', 'scissors']);
  const all = resolveThrows({ a: 'rock', b: 'paper', c: 'scissors' });
  assert.deepEqual(Object.values(all.results).map(x => x.result), ['draw', 'draw', 'draw']);
  const same = resolveThrows({ a: 'rock', b: 'rock' });
  assert.equal(same.results.a.result, 'draw');
});

test('points mode: pairwise scoring, no negatives, winner after the rounds', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 });
  assert.equal(room.stateFor('p0').phase, 'choosing');
  assert.equal(room.stateFor('p0').round, 1);
  // round 1: rock beats two scissors -> p0 +2
  let s = play(room, game, { p0: 'rock', p1: 'scissors', p2: 'scissors' });
  assert.equal(s.players.find(p => p.id === 'p0').score, 2);
  assert.equal(s.players.find(p => p.id === 'p1').score, 0);
  assert.equal(s.reveal.throws.p0.result, 'win');
  assert.equal(s.reveal.throws.p1.result, 'lose');
  assert.equal(s.reveal.outcome, 'decisive');
  next(room, game);
  // round 2: all different -> everyone draws but scores their pairwise win
  s = play(room, game, { p0: 'rock', p1: 'paper', p2: 'scissors' });
  assert.equal(s.players.find(p => p.id === 'p0').score, 3);
  assert.equal(s.players.find(p => p.id === 'p1').score, 1);
  assert.equal(s.players.find(p => p.id === 'p2').score, 1);
  next(room, game);
  // round 3: all draw
  s = play(room, game, { p0: 'rock', p1: 'rock', p2: 'rock' });
  assert.equal(s.reveal.outcome, 'draw');
  next(room, game);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'p0');
  assert.deepEqual(room.finished.rows.map(r => r.rank), [1, 2, 2]);
  assert.equal(room.stateFor('p0').phase, 'over');
}));

test('points mode: ties go to sudden death among the tied leaders only', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 });
  // p0 and p1 end up tied on top, p2 behind
  play(room, game, { p0: 'rock', p1: 'scissors', p2: 'rock' });     // p0 +1 p2 +0... p0 beats p1, p2 draws p0 -> p0 1, p2 beats p1 -> p2 1
  next(room, game);
  play(room, game, { p0: 'rock', p1: 'rock', p2: 'rock' });
  next(room, game);
  const before = room.stateFor('p0');
  play(room, game, { p0: 'paper', p1: 'rock', p2: 'scissors' });    // each 1
  let s = next(room, game);
  // scores: p0 2, p1 1, p2 2 -> p0 and p2 tied
  assert.equal(s.phase, 'choosing');
  assert.equal(s.sudden, true);
  assert.deepEqual(s.contenders.sort(), ['p0', 'p2']);
  void before;
  play(room, game, { p0: 'rock', p2: 'rock' });
  s = next(room, game);
  assert.equal(s.phase, 'choosing');   // draw, replay
  assert.deepEqual(s.contenders.sort(), ['p0', 'p2']);
  play(room, game, { p0: 'rock', p2: 'scissors' });
  next(room, game);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'p0');
  assert.equal(room.finished.rows[0].score, 3);
  // p1 is not allowed to throw during sudden death
}));

test('players outside sudden death cannot move', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 });
  play(room, game, { p0: 'rock', p1: 'scissors', p2: 'rock' });
  next(room, game);
  play(room, game, { p0: 'rock', p1: 'rock', p2: 'rock' });
  next(room, game);
  play(room, game, { p0: 'paper', p1: 'rock', p2: 'scissors' });
  next(room, game);
  game.handleMessage('p1', 'rps-move', { move: 'rock' });
  assert.equal(room.stateFor('p1').locked, undefined);
  assert.equal(room.stateFor('p1').players.find(p => p.id === 'p1').locked, false);
}));

test('elimination: losing move is knocked out, draws replay, last one standing wins', withTimers(() => {
  const { room, game } = setup(4, { mode: 'elimination' });
  // draw: all three moves present
  let s = play(room, game, { p0: 'rock', p1: 'paper', p2: 'scissors', p3: 'rock' });
  assert.equal(s.reveal.outcome, 'draw');
  assert.ok(s.players.every(p => p.alive));
  s = next(room, game);
  assert.equal(s.round, 2);
  // rock vs scissors: p2 (scissors) out
  s = play(room, game, { p0: 'rock', p1: 'rock', p2: 'scissors', p3: 'rock' });
  assert.deepEqual(s.reveal.eliminated, ['p2']);
  assert.equal(s.players.find(p => p.id === 'p2').alive, false);
  s = next(room, game);
  assert.deepEqual(s.contenders.sort(), ['p0', 'p1', 'p3']);
  // everyone same -> draw
  play(room, game, { p0: 'paper', p1: 'paper', p3: 'paper' });
  next(room, game);
  // paper beats rock: p0 and p1 out -> p3 wins? p3 throws paper
  s = play(room, game, { p0: 'rock', p1: 'rock', p3: 'paper' });
  assert.deepEqual(s.reveal.eliminated.sort(), ['p0', 'p1']);
  next(room, game);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'p3');
  const ranks = Object.fromEntries(room.finished.rows.map(r => [r.id, r.rank]));
  assert.equal(ranks.p3, 1);
  assert.equal(ranks.p0, ranks.p1);
  assert.ok(ranks.p2 > ranks.p0 - 3 && ranks.p2 > 1);
  assert.equal(ranks.p0, 2);
  assert.equal(ranks.p2, 4);
}));

test('elimination with two players: one decisive round ends the match', withTimers(() => {
  const { room, game } = setup(2, { mode: 'elimination' });
  play(room, game, { p0: 'paper', p1: 'paper' });
  next(room, game);
  play(room, game, { p0: 'paper', p1: 'rock' });
  next(room, game);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'p0');
}));

test('private picks are only sent to their owner', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 }, { spectators: ['host'] });
  game.handleMessage('p0', 'rps-move', { move: 'paper' });
  assert.equal(room.stateFor('p0').mine, 'paper');
  assert.equal(room.stateFor('p1').mine, null);
  assert.equal(room.stateFor('host').mine, null);
  assert.equal(room.stateFor('p1').players.find(p => p.id === 'p0').locked, true);
  assert.equal(room.stateFor('p1').players.find(p => p.id === 'p1').locked, false);
  const json = JSON.stringify(room.sent.filter(x => x.ws !== 'ws-p0').map(x => x.m));
  assert.equal(json.includes('paper'), false, 'no move leaks to other clients before the reveal');
  assert.equal(room.stateFor('p1').reveal, null);
}));

test('a pick can be changed until time is up; invalid moves are ignored', withTimers(() => {
  const { room, game } = setup(2, { mode: 'points', rounds: 3 });
  game.handleMessage('p0', 'rps-move', { move: 'banana' });
  assert.equal(room.stateFor('p0').mine, null);
  game.handleMessage('p0', 'rps-move', { move: 'rock' });
  game.handleMessage('p0', 'rps-move', { move: 'paper' });
  assert.equal(room.stateFor('p0').mine, 'paper');
  game.handleMessage('stranger', 'rps-move', { move: 'paper' });
}));

test('AFK players get a random move and are marked; the round waits the full time', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 }, { rng: () => 0.5 });
  game.handleMessage('p0', 'rps-move', { move: 'rock' });
  game.handleMessage('p1', 'rps-move', { move: 'rock' });
  mock.timers.tick(CHOOSE_MS - 100);
  assert.equal(room.stateFor('p0').phase, 'choosing');
  mock.timers.tick(200);
  assert.equal(room.stateFor('p0').phase, 'shoot');
  assert.equal(room.stateFor('p0').players.find(p => p.id === 'p2').afk, true);
  mock.timers.tick(SHOOT_MS);
  const s = room.stateFor('p0');
  assert.equal(s.phase, 'reveal');
  assert.equal(s.reveal.throws.p2.afk, true);
  assert.equal(s.reveal.throws.p2.move, 'paper');   // rng 0.5 -> index 1
}));

test('moves cannot change during the shoot beat', withTimers(() => {
  const { room, game } = setup(2, { mode: 'points', rounds: 3 });
  game.handleMessage('p0', 'rps-move', { move: 'rock' });
  game.handleMessage('p1', 'rps-move', { move: 'scissors' });
  mock.timers.tick(600);
  assert.equal(room.stateFor('p0').phase, 'shoot');
  game.handleMessage('p0', 'rps-move', { move: 'paper' });
  mock.timers.tick(SHOOT_MS);
  assert.equal(room.stateFor('p0').reveal.throws.p0.move, 'rock');
}));

test('leavers: elimination ranks them last, one player left wins', withTimers(() => {
  const { room, game } = setup(3, { mode: 'elimination' });
  game.onPlayerLeft('p1');
  assert.equal(room.stateFor('p0').players.find(p => p.id === 'p1').left, true);
  game.onPlayerLeft('p2');
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'p0');
  assert.equal(room.finished.rows[0].rank, 1);
  assert.deepEqual(room.finished.rows.at(-1).note, { k: 'rock-paper-scissors.note.left' });
}));

test('leaving mid-choice lets the round continue with the rest', withTimers(() => {
  const { room, game } = setup(3, { mode: 'points', rounds: 3 });
  game.handleMessage('p0', 'rps-move', { move: 'rock' });
  game.handleMessage('p1', 'rps-move', { move: 'paper' });
  game.onPlayerLeft('p2');
  mock.timers.tick(600);
  assert.equal(room.stateFor('p0').phase, 'shoot');
  mock.timers.tick(SHOOT_MS);
  assert.deepEqual(Object.keys(room.stateFor('p0').reveal.throws).sort(), ['p0', 'p1']);
}));

test('spectator sync, history and cleanup', withTimers(() => {
  const { room, game } = setup(2, { mode: 'points', rounds: 3 }, { spectators: ['host'] });
  play(room, game, { p0: 'rock', p1: 'scissors' });
  game.spectatorSync('host');
  const s = room.stateFor('host');
  assert.equal(s.phase, 'reveal');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].throws.p0.result, 'win');
  game.cleanup();
  const n = room.sent.length;
  mock.timers.tick(REVEAL_MS * 3);
  assert.equal(room.sent.length, n);
}));

test('starts after the fallback when nobody reports in', withTimers(() => {
  const room = fakeRoom();
  const g = new RockPaperScissors(room, { a: { name: 'Aaa' }, b: { name: 'Bbb' } }, {});
  mock.timers.tick(7000);
  g.handleMessage('a', 'rps-page-loaded');
  assert.equal(room.stateFor('a').phase, 'choosing');
  g.cleanup();
}));

test('results and notes are message objects and every referenced key is translated', withTimers(async () => {
  const { assertKeysExist, assertOptionKeys, assertMsg } = await import('./helpers/i18n-keys.mjs');
  assertKeysExist('rock-paper-scissors', ['src/games/rock-paper-scissors.js', 'public_html/games/rock-paper-scissors.js', 'public_html/games/rock-paper-scissors.html']);
  const { dictionary } = await import('./helpers/i18n-keys.mjs');
  const d = dictionary('rock-paper-scissors');
  for (const k of Object.keys(d.en)) assert.ok(k.startsWith('rock-paper-scissors.'), k);
  assertOptionKeys('rock-paper-scissors');

  const { room, game } = setup(3, { mode: 'elimination' });
  game.onPlayerLeft('p2');
  game.onPlayerLeft('p1');
  assertMsg('rock-paper-scissors', room.finished.subtitle, 'rock-paper-scissors.sub.last');
  assertMsg('rock-paper-scissors', room.finished.title, 'rock-paper-scissors.title.wins');
  assertMsg('rock-paper-scissors', room.finished.rows.at(-1).note, 'rock-paper-scissors.note.left');
  assertMsg('rock-paper-scissors', room.finished.rows[0].note, 'rock-paper-scissors.note.last');
  game.cleanup();
}));
