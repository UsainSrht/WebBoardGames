import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Poker, blindLevels } from '../src/games/poker.js';
import { parseCards } from '../src/games/poker-eval.js';
import { GAME_CONFIGS } from '../src/games/config.js';

/* ------------------------------------------------------------------ harness */

function makeEnv(ids = ['a', 'b', 'c'], options = {}, chips = {}, spectators = []) {
  const clock = { t: 1_000_000, timers: [], seq: 0 };
  const room = {
    sent: [],
    finished: null,
    broadcast(m) { this.sent.push({ to: '*', ...m }); },
    send(ws, m) { this.sent.push({ to: ws.id, ...m }); },
    getWsByUserId(id) { return { id }; },
    spectatorIds() { return spectators; },
    finishGame(p) { this.finished = p; }
  };
  const extra = {
    now: () => clock.t,
    rng: () => 0,
    setTimeout(fn, ms) { const h = { id: ++clock.seq, at: clock.t + ms, fn }; clock.timers.push(h); return h; },
    clearTimeout(h) { clock.timers = clock.timers.filter((x) => x !== h); }
  };
  const players = Object.fromEntries(ids.map((id) => [id, { name: id.toUpperCase() }]));
  const g = new Poker(room, players, options, extra);
  for (const [id, n] of Object.entries(chips)) g.seat(id).chips = n;
  const advance = (ms) => {
    const target = clock.t + ms;
    for (;;) {
      const due = clock.timers.filter((h) => h.at <= target).sort((x, y) => x.at - y.at || x.id - y.id)[0];
      if (!due) break;
      clock.timers = clock.timers.filter((x) => x !== due);
      clock.t = due.at;
      due.fn();
    }
    clock.t = target;
  };
  return { g, room, clock, advance, players };
}

/** Table with the first hand dealt and the first decision open. Button = a (rng 0). */
function table(ids, options, chips, spectators) {
  const env = makeEnv(ids, options, chips, spectators);
  env.g.begin();
  env.advance(2000);
  return env;
}

const act = (g, id, type, amount) => g.handleMessage(id, 'poker-action', { action: type, amount });
const total = (g) => g.seats.reduce((n, s) => n + s.chips + s.total, 0);

function rig(g, holes, board = '') {
  for (const [id, text] of Object.entries(holes)) g.seat(id).hole = parseCards(text);
  const b = parseCards(board);
  if (b.length) {
    const burn = parseCards('2c')[0];
    g.deck = [burn, b[0], b[1], b[2], burn, b[3], burn, b[4]].reverse();
  }
}

const lastError = (room) => [...room.sent].reverse().find((m) => m.type === 'error');
const stateOf = (room, id) => [...room.sent].reverse().find((m) => m.type === 'poker-state' && m.to === id);

/* -------------------------------------------------------------------- setup */

test('config entry exposes the documented options', () => {
  const cfg = GAME_CONFIGS.poker;
  assert.equal(cfg.available, true);
  assert.deepEqual(cfg.options.map((o) => o.key), ['chips', 'blinds', 'blindUp', 'turnTime']);
  assert.equal(cfg.min, 2);
  assert.equal(cfg.max, 8);
});

test('three players: blinds, hole cards and first to act', () => {
  const { g } = table();
  // button a, small blind b, big blind c, under the gun a
  assert.equal(g.button, 0);
  assert.equal(g.seat('b').bet, 25);
  assert.equal(g.seat('c').bet, 50);
  assert.equal(g.seat('b').chips, 1975);
  assert.equal(g.turn, 'a');
  assert.equal(g.stage, 'bet');
  for (const s of g.seats) assert.equal(s.hole.length, 2);
  assert.equal(g.deck.length, 52 - 6);
  const all = g.seats.flatMap((s) => s.hole).map((c) => c.r + c.s);
  assert.equal(new Set(all).size, 6);
  g.cleanup();
});

test('heads-up: the button is the small blind, acts first before the flop and last after it', () => {
  const { g, advance } = table(['a', 'b']);
  assert.equal(g.button, 0);
  assert.equal(g.seat('a').bet, 25, 'button posts the small blind');
  assert.equal(g.seat('b').bet, 50);
  assert.equal(g.turn, 'a');
  rig(g, { a: 'As Ad', b: 'Kh Kd' }, '2s 7d 9c Jh 3c');
  act(g, 'a', 'call');
  assert.equal(g.turn, 'b', 'the big blind still has the option');
  assert.equal(g.stateFor('b').legal.canCheck, true);
  act(g, 'b', 'check');
  advance(1000);
  assert.equal(g.street, 'flop');
  assert.equal(g.turn, 'b', 'big blind acts first after the flop');
  act(g, 'b', 'check');
  assert.equal(g.turn, 'a');
  g.cleanup();
});

test('button moves clockwise and skips players who are out', () => {
  const { g, advance } = table(['a', 'b', 'c', 'd']);
  assert.equal(g.button, 0);
  act(g, 'd', 'fold'); act(g, 'a', 'fold'); act(g, 'b', 'fold'); // c wins
  advance(4000);
  assert.equal(g.handNo, 2);
  assert.equal(g.button, 1);
  g.cleanup();
  const env = table(['a', 'b', 'c', 'd']);
  env.g.button = 0;
  env.g.seat('b').out = true; env.g.seat('b').chips = 0;
  env.g.startHand();
  assert.equal(env.g.button, 2, 'b is out, so c gets the button');
  assert.equal(env.g.sbIdx, 3);
  assert.equal(env.g.bbIdx, 0);
  env.g.cleanup();
});

test('starts when everyone loaded, otherwise after the fallback', () => {
  const env = makeEnv();
  env.g.handleMessage('a', 'poker-page-loaded');
  env.g.handleMessage('b', 'poker-page-loaded');
  assert.equal(env.g.started, false);
  env.g.handleMessage('c', 'poker-page-loaded');
  assert.equal(env.g.started, true);
  env.g.cleanup();
  const late = makeEnv();
  late.advance(8000);
  assert.equal(late.g.started, true);
  assert.equal(late.g.handNo, 1);
  late.g.cleanup();
});

/* ------------------------------------------------------------ betting rounds */

test('a full hand checked down: action order on every street, best hand wins the pot', () => {
  const { g, advance, room } = table();
  rig(g, { a: 'As Ad', b: 'Kh Kd', c: '7c 2d' }, '9s 8h 4c 3d Jh');
  act(g, 'a', 'call'); act(g, 'b', 'call'); act(g, 'c', 'check');
  for (const street of ['flop', 'turn', 'river']) {
    advance(1000);
    assert.equal(g.street, street);
    assert.equal(g.turn, 'b', `first to act on the ${street}`);
    act(g, 'b', 'check'); assert.equal(g.turn, 'c');
    act(g, 'c', 'check'); assert.equal(g.turn, 'a');
    act(g, 'a', 'check');
  }
  assert.equal(g.stage, 'pause');
  assert.equal(g.board.length, 5);
  assert.equal(g.seat('a').chips, 2100);
  assert.equal(g.seat('b').chips, 1950);
  assert.equal(g.seat('c').chips, 1950);
  const st = stateOf(room, 'b');
  assert.equal(st.result.pots[0].amount, 150);
  assert.deepEqual(st.result.pots[0].hand, { k: 'poker.hand.pair', p: { a: { k: 'poker.rankp.14' } } });
  assert.ok(room.sent.some((m) => m.log?.some((l) => l.k === 'poker.log.win')));
  advance(10000);
  assert.equal(g.handNo, 2, 'next hand starts by itself');
  g.cleanup();
});

test('chips are conserved across many random hands with random legal play', () => {
  let seed = 11;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const env = makeEnv(['a', 'b', 'c', 'd', 'e']);
  env.g.rng = rng;
  const { g, advance, room } = env;
  g.begin();
  advance(2000);
  for (let guard = 0; guard < 4000 && !room.finished; guard++) {
    if (g.stage === 'bet') {
      const s = g.seat(g.turn);
      const legal = g.stateFor(s.id).legal;
      const roll = rng();
      if (roll < 0.1) act(g, s.id, 'fold');
      else if (legal.canCheck) act(g, s.id, roll < 0.7 ? 'check' : legal.canRaise ? 'raise' : 'check', legal.minTo + Math.floor(rng() * 3) * 50 > legal.maxTo ? legal.maxTo : legal.minTo + Math.floor(rng() * 3) * 50);
      else if (roll < 0.8 && legal.canRaise) act(g, s.id, 'allin');
      else act(g, s.id, 'call');
    } else advance(3000);
    assert.equal(total(g), 5 * 2000, 'no chip is created or lost');
  }
  assert.ok(room.finished, 'the tournament finishes');
  assert.equal(room.finished.rows.filter((r) => r.rank === 1).length, 1);
  g.cleanup();
});

test('minimum raise equals the previous raise, with errors for illegal amounts', () => {
  const { g, room } = table();
  act(g, 'a', 'raise', 99);
  assert.deepEqual(lastError(room).message, { k: 'poker.err.minRaise', p: { n: 100 } });
  assert.equal(g.turn, 'a');
  act(g, 'a', 'raise', 100);
  assert.equal(g.currentBet, 100);
  assert.equal(g.minRaise, 50);
  act(g, 'b', 'raise', 140);
  assert.equal(lastError(room).message.k, 'poker.err.minRaise');
  act(g, 'b', 'raise', 150);
  assert.equal(g.minRaise, 50);
  act(g, 'c', 'raise', 400);
  assert.equal(g.minRaise, 250, 'raise of 250 on top of 150');
  assert.equal(g.stateFor('b').legal, null, 'only the player on turn gets legal actions');
  assert.equal(g.turn, 'a');
  assert.equal(g.stateFor('a').legal.minTo, 650);
  g.cleanup();
});

test('illegal actions are rejected without changing the game', () => {
  const { g, room } = table();
  const before = JSON.stringify(g.stateFor('a'));
  act(g, 'b', 'call'); assert.equal(lastError(room).message.k, 'poker.err.notTurn');
  act(g, 'a', 'check'); assert.equal(lastError(room).message.k, 'poker.err.cantCheck');
  act(g, 'a', 'raise', 'abc'); assert.equal(lastError(room).message.k, 'poker.err.badAmount');
  act(g, 'a', 'raise', -5);
  act(g, 'a', 'raise', 100.5);
  act(g, 'a', 'raise', 1e9);
  act(g, 'a', 'raise', null);
  act(g, 'a', 'raise', { x: 1 });
  act(g, 'a', 'dance'); assert.equal(lastError(room).message.k, 'poker.err.badAction');
  act(g, 'a', undefined);
  g.handleMessage('a', 'poker-action', null);
  g.handleMessage('a', 'poker-action', 'x');
  g.handleMessage('zzz', 'poker-action', { action: 'fold' });
  g.handleMessage('a', 'unknown-type', {});
  assert.equal(JSON.stringify(g.stateFor('a')), before);
  assert.equal(g.turn, 'a');
  g.cleanup();
});

test('a call that is larger than the stack becomes an all-in call', () => {
  const { g } = table(['a', 'b', 'c'], {}, { a: 30 });
  act(g, 'a', 'call');
  assert.equal(g.seat('a').allIn, true);
  assert.equal(g.seat('a').bet, 30);
  assert.equal(g.seat('a').chips, 0);
  g.cleanup();
});

test('a short all-in raise does not reopen the betting for players who already acted', () => {
  // a raises to 100, b (small blind, 130 chips in total) shoves for 30 more: not a full raise
  const { g, advance } = table(['a', 'b', 'c'], {}, { b: 130 });
  act(g, 'a', 'raise', 100);
  act(g, 'b', 'allin');
  assert.equal(g.currentBet, 130);
  assert.equal(g.minRaise, 50, 'the minimum raise is unchanged');
  act(g, 'c', 'fold');
  assert.equal(g.turn, 'a');
  const legal = g.stateFor('a').legal;
  assert.equal(legal.canRaise, false);
  assert.equal(legal.toCall, 30);
  act(g, 'a', 'raise', 300);
  assert.equal(g.turn, 'a', 'rejected');
  act(g, 'a', 'allin');
  assert.equal(g.turn, 'a', 'rejected as well');
  act(g, 'a', 'call');
  advance(0);
  assert.equal(g.stage, 'pause');
  assert.equal(g.street, 'flop', 'betting is over');
  g.cleanup();
});

test('a full all-in raise does reopen the betting', () => {
  const { g } = table(['a', 'b', 'c'], {}, { b: 305 });
  act(g, 'a', 'raise', 100);
  act(g, 'b', 'allin'); // 305 total, a raise of 205
  assert.equal(g.currentBet, 305);
  assert.equal(g.minRaise, 205);
  act(g, 'c', 'call');
  assert.equal(g.stateFor('a').legal.canRaise, true);
  assert.equal(g.stateFor('a').legal.minTo, 510);
  g.cleanup();
});

test('short all-ins that add up to a full raise reopen the betting', () => {
  const { g } = table(['a', 'b', 'c', 'd'], {}, { a: 130, b: 160 });
  // button a, small blind b, big blind c, first to act d
  act(g, 'd', 'raise', 100);
  act(g, 'a', 'allin');
  assert.equal(g.currentBet, 130);
  act(g, 'b', 'allin'); // 160 total: 60 above the last full raise, enough to reopen
  assert.equal(g.currentBet, 160);
  act(g, 'c', 'call');
  assert.equal(g.turn, 'd');
  assert.equal(g.stateFor('d').legal.canRaise, true);
  g.cleanup();
});

test('only one player left with chips cannot raise against all-in players', () => {
  const { g } = table(['a', 'b', 'c'], {}, { a: 200, b: 200 });
  act(g, 'a', 'allin');
  act(g, 'b', 'call');
  assert.equal(g.turn, 'c');
  assert.equal(g.stateFor('c').legal.canRaise, false, 'nobody left to respond to a raise');
  act(g, 'c', 'raise', 1000);
  assert.equal(g.turn, 'c', 'rejected');
  act(g, 'c', 'call');
  assert.equal(g.stage, 'pause');
  g.cleanup();
});

test('everyone all-in: remaining streets run out without betting and hands are turned up', () => {
  const { g, advance, room } = table(['a', 'b'], {}, { a: 500, b: 500 });
  rig(g, { a: 'As Ad', b: 'Kh Kd' }, '2s 7d 9c Jh 3c');
  act(g, 'a', 'allin');
  act(g, 'b', 'call');
  assert.equal(g.board.length, 3, 'flop is out at once');
  assert.ok(stateOf(room, 'a').players.find((p) => p.id === 'b').hole, 'the opponent hand is shown');
  advance(1900);
  assert.equal(g.board.length, 4);
  advance(1900);
  assert.equal(g.board.length, 5);
  advance(1900);
  assert.equal(g.seat('a').chips, 1000);
  assert.equal(g.seat('b').chips, 0);
  assert.equal(g.seat('b').out, true);
  g.cleanup();
});

/* ---------------------------------------------------------------- side pots */

test('several all-ins: side pots, eligibility and the uncalled bet is returned', () => {
  const { g, advance, room } = table(['a', 'b', 'c', 'd'], {}, { a: 100, b: 300, c: 500, d: 1000 });
  rig(g, { a: 'As Ad', b: 'Kh Kd', c: 'Qh Qd', d: '7c 2d' }, '3s 5d 9c Jh 4c');
  act(g, 'd', 'allin');
  act(g, 'a', 'call');
  act(g, 'b', 'call');
  act(g, 'c', 'call');
  assert.equal(g.seat('d').chips, 500, 'the 500 nobody could call comes back');
  advance(1900 * 3 + 10);
  const result = stateOf(room, 'a').result;
  assert.deepEqual(result.pots.map((p) => p.amount), [400, 600, 400]);
  assert.deepEqual(result.pots.map((p) => p.winners.map((w) => w.id)), [['a'], ['b'], ['c']]);
  assert.deepEqual(result.pots[1].eligible, ['b', 'c', 'd']);
  assert.equal(g.seat('a').chips, 400);
  assert.equal(g.seat('b').chips, 600);
  assert.equal(g.seat('c').chips, 400);
  assert.equal(g.seat('d').chips, 500);
  g.cleanup();
});

test('a lower hand cannot win a side pot it is not eligible for, and folded money stays in', () => {
  const { g, advance, room } = table(['a', 'b', 'c', 'd'], {}, { a: 100 });
  rig(g, { a: 'As Ad', b: 'Kh Kd', c: 'Qh Qd', d: '7c 2d' }, '3s 5d 9c Jh 4c');
  act(g, 'd', 'raise', 300);
  act(g, 'a', 'allin');
  act(g, 'b', 'call');
  act(g, 'c', 'fold');
  assert.equal(g.street, 'flop');
  advance(1000);
  act(g, 'b', 'check');
  act(g, 'd', 'check');
  advance(1000);
  act(g, 'b', 'check'); act(g, 'd', 'check');
  advance(1000);
  act(g, 'b', 'check'); act(g, 'd', 'check');
  const r = stateOf(room, 'b').result;
  assert.equal(r.pots.length, 2);
  assert.equal(r.pots[0].amount, 350, 'a 100 from a, b and d, plus the 50 blind folded by c');
  assert.equal(r.pots[1].amount, 400);
  assert.deepEqual(r.pots[0].winners.map((w) => w.id), ['a']);
  assert.deepEqual(r.pots[1].winners.map((w) => w.id), ['b']);
  assert.equal(total(g), 3 * 2000 + 100, 'conserved');
  g.cleanup();
});

test('odd chip split: the winner closest to the left of the button gets it', () => {
  const env = table(['a', 'b', 'c']);
  const { g, advance } = env;
  rig(g, { a: '2s 3d', b: '2h 3h', c: '4s 5d' }, 'As Ks Qs Js Ts');
  act(g, 'a', 'call');
  act(g, 'b', 'fold');
  act(g, 'c', 'check');
  for (let i = 0; i < 3; i++) {
    advance(1000);
    act(g, 'c', 'check');
    act(g, 'a', 'check');
  }
  // 125 pot, button a: c is next to the button's left among the winners
  assert.equal(g.seat('c').chips, 1950 + 63);
  assert.equal(g.seat('a').chips, 1950 + 62);
  assert.equal(g.seat('b').chips, 1975);
  g.cleanup();
});

test('split pot between equal hands (board plays)', () => {
  const { g, advance, room } = table(['a', 'b']);
  rig(g, { a: '2s 3d', b: '2h 4h' }, 'As Ks Qs Js Ts');
  act(g, 'a', 'call'); act(g, 'b', 'check');
  for (let i = 0; i < 3; i++) { advance(1000); act(g, 'b', 'check'); act(g, 'a', 'check'); }
  assert.equal(g.seat('a').chips, 2000);
  assert.equal(g.seat('b').chips, 2000);
  const r = stateOf(room, 'a').result;
  assert.equal(r.pots[0].winners.length, 2);
  assert.equal(r.pots[0].hand.k, 'poker.hand.royalFlush');
  g.cleanup();
});

/* ------------------------------------------------------ folding and privacy */

test('everybody folds: the last player wins, nothing is revealed', () => {
  const { g, room, advance } = table();
  act(g, 'a', 'raise', 150);
  act(g, 'b', 'fold');
  act(g, 'c', 'fold');
  assert.equal(g.seat('a').chips, 2000 + 75);
  const st = stateOf(room, 'b');
  assert.equal(st.result.uncontested, true);
  assert.deepEqual(st.result.shown, {});
  for (const id of ['a', 'b', 'c']) {
    for (const p of stateOf(room, 'b').players) if (p.id !== 'b') assert.equal(p.hole, null);
  }
  advance(4000);
  assert.equal(g.handNo, 2);
  g.cleanup();
});

test('hole cards never reach anyone but their owner until shown; folded hands never', () => {
  const spectators = ['s'];
  const { g, room, advance } = table(['a', 'b', 'c'], {}, {}, spectators);
  rig(g, { a: 'As Ad', b: 'Kh Kd', c: 'Qh Qd' }, '2s 7d 9c Jh 3c');
  // re-broadcast with the rigged cards
  g.broadcast();
  const key = (c) => `"r":${c.r},"s":"${c.s}"`;
  const cardsOf = (id) => g.seat(id).hole.map(key);
  const leaks = (viewer, owner) => room.sent.filter((m) => m.to === viewer && cardsOf(owner).some((k) => JSON.stringify(m).includes(k))).length;
  act(g, 'a', 'fold');
  act(g, 'b', 'call');
  act(g, 'c', 'check');
  for (let i = 0; i < 3; i++) { advance(1000); act(g, 'b', 'check'); act(g, 'c', 'check'); }
  // c and b showed down; a folded
  for (const viewer of ['b', 'c', 's']) assert.equal(leaks(viewer, 'a'), 0, `${viewer} never sees the folded hand`);
  assert.ok(leaks('a', 'a') > 0, 'owner sees own cards');
  // before the showdown nobody else saw b or c
  const preShowdown = room.sent.filter((m) => m.type === 'poker-state' && !m.result);
  for (const m of preShowdown) {
    for (const p of m.players) {
      if (m.to === 's') assert.equal(p.hole, null);
      else if (p.id !== m.to) assert.equal(p.hole, null, `${m.to} sees ${p.id}`);
    }
  }
  assert.equal(leaks('s', 'b') > 0, true, 'shown hands are public after the showdown');
  g.cleanup();
});

test('spectator sync sends the public table and no private data', () => {
  const { g, room } = table(['a', 'b', 'c'], {}, {}, ['s']);
  room.sent.length = 0;
  g.spectatorSync('s');
  const m = room.sent[0];
  assert.equal(m.type, 'poker-state');
  assert.equal(m.spectator, true);
  assert.equal(m.to, 's');
  assert.equal(m.legal, null);
  assert.equal(m.myHand, null);
  assert.ok(m.players.every((p) => p.hole === null));
  assert.equal(m.players.length, 3);
  assert.equal(m.players.filter((p) => p.hasCards).length, 3);
  g.cleanup();
});

test('state for a player carries their own legal actions and current hand name', () => {
  const { g } = table();
  rig(g, { a: 'As Ad' });
  const st = g.stateFor('a');
  assert.deepEqual(st.legal, { toCall: 50, canCheck: false, canRaise: true, minTo: 100, maxTo: 2000, currentBet: 50 });
  assert.equal(st.myHand.k, 'poker.hand.pair');
  assert.equal(g.stateFor('b').legal, null);
  assert.equal(g.stateFor('b').players.find((p) => p.id === 'a').hole, null);
  g.cleanup();
});

/* ------------------------------------------------------------------ timers */

test('timeout: auto-fold when facing a bet, auto-check when it is free', () => {
  const { g, advance } = table();
  advance(30000);
  assert.equal(g.seat('a').folded, true);
  assert.equal(g.seat('a').timeouts, 1);
  assert.equal(g.turn, 'b');
  act(g, 'b', 'call');
  assert.equal(g.turn, 'c');
  advance(30000); // big blind may check
  assert.equal(g.seat('c').folded, false);
  assert.equal(g.street, 'flop');
  g.cleanup();
});

test('turn timer option is used for the deadline', () => {
  const { g } = table(['a', 'b', 'c'], { turnTime: 20 });
  assert.equal(g.stateFor('a').timeLeft, 20000 - 400);
  assert.equal(g.stateFor('a').turnMs, 20000);
  g.cleanup();
});

test('two timeouts in a row sit a player out; they auto-act quickly until they return', () => {
  const { g, advance, clock, room } = table();
  g.seat('b').timeouts = 1;
  act(g, 'a', 'fold');
  advance(30000); // b times out for the second time (owes 25)
  assert.equal(g.seat('b').sittingOut, true);
  assert.ok(room.sent.some((m) => m.log?.some((l) => l.k === 'poker.log.sitout')));
  advance(5000);
  assert.equal(g.handNo, 2);
  assert.equal(g.seat('b').chips, 1975, 'blind lost');
  // b sits out in hand 2: auto fold when it is b's turn
  const t0 = clock.t;
  for (let guard = 0; guard < 20 && g.turn !== 'b'; guard++) {
    if (g.stage === 'bet') act(g, g.turn, 'call'); else advance(500);
  }
  if (g.turn === 'b') {
    advance(800);
    assert.equal(g.seat('b').folded || g.seat('b').bet >= g.currentBet, true);
    assert.ok(clock.t - t0 < 30000);
  }
  g.handleMessage('b', 'poker-sitin');
  assert.equal(g.seat('b').sittingOut, false);
  assert.equal(g.seat('b').timeouts, 0);
  g.cleanup();
});

test('acting resets the timeout counter', () => {
  const { g } = table();
  g.seat('a').timeouts = 1;
  act(g, 'a', 'call');
  assert.equal(g.seat('a').timeouts, 0);
  g.cleanup();
});

test('cleanup clears every timer', () => {
  const env = table();
  env.g.cleanup();
  assert.equal(env.clock.timers.length, 0);
  env.advance(100000);
  assert.equal(env.g.handNo, 1);
  act(env.g, 'a', 'fold');
  assert.equal(env.g.seat('a').folded, false, 'ignored after cleanup');
});

/* ------------------------------------------------------------------- levels */

test('blind levels climb by roughly one and a half to two times', () => {
  for (const sb of [10, 25, 50]) {
    const lv = blindLevels(sb);
    assert.equal(lv[0].sb, sb);
    assert.equal(lv[0].bb, sb * 2);
    for (let i = 1; i < lv.length; i++) {
      const f = lv[i].sb / lv[i - 1].sb;
      assert.ok(f >= 1.25 && f <= 2, `${sb}: ${lv[i - 1].sb} -> ${lv[i].sb}`);
    }
  }
});

test('blinds go up on the timer, announced one hand ahead', () => {
  const { g, advance, clock, room } = table(['a', 'b', 'c'], { blindUp: 5 });
  assert.equal(g.stateFor('a').blinds.inMs, 5 * 60000 - 2000);
  assert.deepEqual(g.stateFor('a').blinds.next, { sb: 50, bb: 100 });
  clock.t += 5 * 60000;
  act(g, 'a', 'fold'); act(g, 'b', 'fold');
  advance(4000); // hand 2: the rise is announced, blinds unchanged
  assert.equal(g.handNo, 2);
  assert.equal(g.blinds.bb, 50);
  assert.equal(g.stateFor('a').blinds.soon, true);
  assert.ok(room.sent.some((m) => m.log?.some((l) => l.k === 'poker.log.levelSoon')));
  advance(2000);
  while (g.turn) { act(g, g.turn, 'fold'); if (g.handNo > 2 || g.stage !== 'bet') break; }
  advance(4000);
  assert.equal(g.handNo, 3);
  assert.equal(g.blinds.bb, 100, 'new level in force');
  assert.equal(g.stateFor('a').blinds.level, 2);
  assert.equal(g.stateFor('a').blinds.soon, false);
  assert.equal(g.seats.reduce((n, s) => n + s.bet, 0), 150);
  g.cleanup();
});

test('no blind rise when the option is off', () => {
  const { g, advance, clock } = table(['a', 'b', 'c'], { blindUp: 0 });
  clock.t += 3600000;
  act(g, 'a', 'fold'); act(g, 'b', 'fold');
  advance(4000);
  assert.equal(g.blinds.bb, 50);
  assert.equal(g.stateFor('a').blinds.inMs, null);
  assert.equal(g.stateFor('a').blinds.soon, false);
  g.cleanup();
});

test('starting blinds and stacks come from the options', () => {
  const { g } = table(['a', 'b', 'c'], { chips: 5000, blinds: '50/100' });
  assert.equal(g.seat('a').chips, 5000);
  assert.equal(g.seat('c').bet, 100);
  assert.equal(g.seat('b').bet, 50);
  g.cleanup();
  const bad = makeEnv(['a', 'b'], { chips: 'x', blinds: 'nonsense', turnTime: -4, blindUp: 99 });
  assert.equal(bad.g.seat('a').chips, 2000);
  assert.equal(bad.g.turnMs, 30000);
  bad.g.cleanup();
});

/* -------------------------------------------------- leaving and elimination */

test('a player who leaves on their turn folds and the action moves on', () => {
  const { g } = table();
  g.onPlayerLeft('a');
  assert.equal(g.seat('a').left, true);
  assert.equal(g.turn, 'b');
  assert.ok(!g.stateFor('b').players.find((p) => p.id === 'a').hasCards);
  g.cleanup();
});

test('a leaver mid-hand is removed; the hand goes on and chips already bet stay in the pot', () => {
  const { g, advance } = table(['a', 'b', 'c', 'd']);
  act(g, 'd', 'raise', 200);
  g.onPlayerLeft('d');
  assert.equal(g.seat('d').folded, true);
  assert.equal(g.turn, 'a');
  assert.equal(g.seat('d').chips, 0);
  act(g, 'a', 'call'); act(g, 'b', 'fold');
  act(g, 'c', 'call');
  advance(1000);
  assert.equal(g.street, 'flop');
  assert.equal(g.seat('c').chips + g.seat('c').total, 2000);
  assert.equal(g.seat('c').total, 200);
  g.cleanup();
});

test('everyone but one leaves: the last player wins and the game finishes', () => {
  const { g, room, advance } = table();
  g.onPlayerLeft('a');
  g.onPlayerLeft('b');
  advance(5000);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'c');
  assert.equal(room.finished.rows[0].rank, 1);
  assert.deepEqual(room.finished.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(room.finished.rows[1].id, 'b', 'who left last ranks higher');
  assert.equal(room.finished.rows[1].note.k, 'poker.note.left');
  g.cleanup();
});

test('leaving between hands and leaving before the start never stalls', () => {
  const { g, room, advance } = table(['a', 'b']);
  act(g, 'a', 'fold');
  g.onPlayerLeft('a');
  advance(5000);
  assert.ok(room.finished);
  assert.equal(room.finished.title.k, 'poker.finish.title');
  const early = makeEnv(['a', 'b']);
  early.g.onPlayerLeft('a');
  assert.ok(early.room.finished);
  early.g.cleanup();
});

test('elimination ranking: later bust-outs rank higher, same-hand busts by chips at the start of the hand', () => {
  const { g, room, advance } = table(['a', 'b', 'c', 'd'], {}, { a: 300, b: 700, c: 1000, d: 2000 });
  rig(g, { a: '7c 2d', b: '8c 3d', c: '9c 4d', d: 'As Ad' }, 'Ks 5d Jc 6h 10d');
  act(g, 'd', 'allin');
  act(g, 'a', 'call'); act(g, 'b', 'call'); act(g, 'c', 'call');
  advance(1900 * 3 + 10);
  advance(10000);
  assert.ok(room.finished);
  const rows = Object.fromEntries(room.finished.rows.map((r) => [r.id, r]));
  assert.equal(rows.d.rank, 1);
  assert.equal(rows.c.rank, 2);
  assert.equal(rows.b.rank, 3);
  assert.equal(rows.a.rank, 4);
  assert.equal(rows.d.score, 4000);
  assert.deepEqual(rows.d.note, { k: 'poker.note.winner', p: { n: 4000 } });
  assert.equal(rows.a.note.k, 'poker.note.out');
  g.cleanup();
});

test('players busted in the same hand with equal chips share a rank', () => {
  const { g, room, advance } = table(['a', 'b', 'c'], {}, { a: 500, b: 500, c: 2000 });
  rig(g, { a: '7c 2d', b: '8c 3d', c: 'As Ad' }, 'Ks 5d Jc 6h 10d');
  act(g, 'a', 'allin'); act(g, 'b', 'call'); act(g, 'c', 'call');
  advance(1900 * 3 + 10);
  advance(10000);
  const rows = Object.fromEntries(room.finished.rows.map((r) => [r.id, r]));
  assert.equal(rows.c.rank, 1);
  assert.equal(rows.a.rank, 2);
  assert.equal(rows.b.rank, 2);
  g.cleanup();
});

test('a busted player becomes a table viewer: still gets the public state, never hole cards', () => {
  const { g, room, advance } = table(['a', 'b', 'c'], {}, { a: 100, b: 2000, c: 2000 });
  rig(g, { a: '7c 2d', b: 'As Ad', c: 'Kh Kd' }, 'Qs 5d Jc 6h 10d');
  act(g, 'a', 'allin'); act(g, 'b', 'call'); act(g, 'c', 'fold');
  advance(1900 * 3 + 10);
  advance(1000);
  assert.equal(g.seat('a').out, true);
  advance(10000);
  assert.equal(g.handNo, 2);
  const st = g.stateFor('a');
  assert.equal(st.players.find((p) => p.id === 'a').out, true);
  assert.equal(st.players.find((p) => p.id === 'a').hasCards, false);
  assert.equal(st.legal, null);
  assert.equal(st.spectator, undefined);
  assert.equal(g.seats.filter((s) => s.hole.length).length, 2, 'only two players are dealt in');
  g.cleanup();
  assert.ok(room);
});

test('winner takes all, heads-up continues after a bust and finish reports hands played', () => {
  const { g, room, advance } = table(['a', 'b'], {}, { a: 50, b: 1950 });
  rig(g, { a: '7c 2d', b: 'As Ad' }, 'Ks 5d Jc 6h 10d');
  act(g, 'a', 'allin'); act(g, 'b', 'call');
  advance(1900 * 3 + 10);
  advance(10000);
  assert.ok(room.finished);
  assert.deepEqual(room.finished.subtitle, { k: 'poker.finish.sub', p: { n: 1 } });
  assert.equal(room.finished.rows.length, 2);
  g.cleanup();
});

/* -------------------------------------------------------------- translation */

test('every translation key used by the server and client exists in both languages', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/poker.json', import.meta.url), 'utf8'));
  const sources = ['../src/games/poker.js', '../src/games/poker-eval.js', '../public_html/games/poker.js', '../public_html/games/poker.html']
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const keys = new Set([...sources.matchAll(/['"`](poker\.[a-zA-Z0-9_.]*[a-zA-Z0-9_])['"`]/g)].map((m) => m[1]));
  for (const k of ['poker.log.flop', 'poker.log.turn', 'poker.log.river']) keys.add(k);
  for (let r = 2; r <= 14; r++) { keys.add(`poker.rank.${r}`); keys.add(`poker.rankp.${r}`); }
  for (const c of ['royalFlush', 'straightFlush', 'quads', 'fullHouse', 'flush', 'straight', 'trips', 'twoPair', 'pair', 'highCard']) keys.add(`poker.hand.${c}`);
  for (const o of GAME_CONFIGS.poker.options) {
    keys.add(`poker.opt.${o.key}`);
    for (const c of o.choices) keys.add(`poker.opt.${o.key}.${c.value}`);
  }
  for (const k of keys) {
    if (/\.$/.test(k)) continue;
    assert.ok(k in dict.en, `${k} missing in en`);
    assert.ok(k in dict.tr, `${k} missing in tr`);
  }
  // Turkish hand names as poker players say them
  assert.match(dict.tr['poker.hand.straightFlush'], /Aynı renk sıra/);
  assert.match(dict.tr['poker.hand.quads'], /Kare/);
});
