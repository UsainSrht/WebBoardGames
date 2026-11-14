import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool, judgeShot, groupOf } from '../src/games/pool.js';
import * as P from '../public_html/shared/pool-physics.js';
import { GAME_CONFIGS } from '../src/games/config.js';

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

const PL = { a: { odId: 'a', name: 'Ann' }, b: { odId: 'b', name: 'Bob' } };
const hit = (a, b, t = 5) => ({ type: 'hit', a, b, v: 1000, t });
const rail = (ball, t = 10) => ({ type: 'rail', ball, v: 500, t });
const pocket = (ball, k = 0, t = 20) => ({ type: 'pocket', ball, pocket: k, t });
const SOLIDS = [1, 2, 3, 4, 5, 6, 7];

function make(options = {}, extra = {}) {
  const room = fakeRoom();
  let t = 1000;
  const clock = { advance(ms) { t += ms; } };
  const g = new Pool(room, PL, options, { now: () => t, rng: () => 0.1, ...extra });
  return { g, room, clock };
}

const sparse = (map) => { const p = new Array(16).fill(null); for (const [k, v] of Object.entries(map)) p[k] = v; return p; };

/** A running game on a custom table, 'a' to shoot, table past the break. */
function table(map, options = {}) {
  const ctx = make(options);
  const { g } = ctx;
  g.begin();
  g.positions = sparse(map);
  g.breakShot = false;
  g.inHand = false;
  g.turn = 'a';
  g.phase = 'aim';
  return ctx;
}

const open = (over) => ({ breakShot: false, group: null, down: [], events: [], call: null, callPocket: false, ...over });

test('config entry is finished and options are documented', () => {
  const c = GAME_CONFIGS.pool;
  assert.equal(c.available, true);
  assert.deepEqual(c.options.map((o) => o.key), ['shotClock', 'callPocket']);
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/pool.json', import.meta.url), 'utf8'));
  for (const o of c.options) {
    assert.ok(dict.en[`pool.opt.${o.key}`], `label ${o.key}`);
    for (const ch of o.choices) assert.ok(dict.en[`pool.opt.${o.key}.${ch.value}`], `${o.key}.${ch.value}`);
  }
});

test('every message key the server can send exists in both languages', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/pool.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/pool.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/'(pool\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]));
  for (const f of ['noContact', 'wrongFirst', 'scratch', 'offTable', 'noRail']) keys.add(`pool.note.${f}`);
  for (const r of ['eightWin', 'eightEarly', 'eightFoul', 'eightScratch', 'eightPocket', 'forfeit', 'timeouts']) keys.add(`pool.result.${r}`);
  for (const g of ['solid', 'stripe']) keys.add(`pool.group.${g}`);
  for (const k of keys) {
    assert.ok(dict.en[k], `en ${k}`);
    assert.ok(dict.tr[k], `tr ${k}`);
  }
});

/* ------------------------------------------------------------- judgeShot */

test('groups', () => {
  assert.equal(groupOf(3), 'solid');
  assert.equal(groupOf(8), null);
  assert.equal(groupOf(12), 'stripe');
  assert.equal(groupOf(0), null);
});

test('break: scratch is a foul, the 8 is re-spotted, never a win', () => {
  let v = judgeShot(open({ breakShot: true, events: [hit(0, 1), pocket(3), pocket(0, 2)] }));
  assert.equal(v.outcome, 'pass');
  assert.ok(v.foul && v.cueDown);
  v = judgeShot(open({ breakShot: true, events: [hit(0, 1), pocket(8), pocket(4)] }));
  assert.equal(v.outcome, 'continue');
  assert.ok(v.respot8);
  v = judgeShot(open({ breakShot: true, events: [hit(0, 1), pocket(8)] }));
  assert.equal(v.outcome, 'pass');
  assert.ok(v.respot8 && !v.foul);
  v = judgeShot(open({ breakShot: true, events: [hit(0, 1), pocket(8), pocket(0)] }));
  assert.equal(v.outcome, 'pass');
  assert.ok(v.respot8 && v.foul);
  assert.equal(v.assign, null, 'the table stays open after the break');
});

test('break: legal with a pocketed ball or four rails, otherwise a re-rack offer', () => {
  assert.equal(judgeShot(open({ breakShot: true, events: [hit(0, 1), rail(2), rail(3), rail(4), rail(5)] })).outcome, 'pass');
  assert.equal(judgeShot(open({ breakShot: true, events: [hit(0, 1), rail(2), rail(2), rail(3), rail(4)] })).outcome, 'rerack');
  assert.equal(judgeShot(open({ breakShot: true, events: [hit(0, 1), rail(0), rail(2)] })).outcome, 'rerack');
  assert.equal(judgeShot(open({ breakShot: true, events: [hit(0, 1), pocket(9)] })).outcome, 'continue');
  assert.equal(judgeShot(open({ breakShot: true, events: [rail(0)] })).outcome, 'pass', 'no contact on the break is a foul');
  assert.ok(judgeShot(open({ breakShot: true, events: [rail(0)] })).foul);
});

test('open table: assignment by the first legally pocketed ball, shooter continues', () => {
  const v = judgeShot(open({ events: [hit(0, 10), pocket(10), pocket(3)] }));
  assert.equal(v.outcome, 'continue');
  assert.equal(v.assign, 'stripe');
  const w = judgeShot(open({ events: [hit(0, 2), rail(0), pocket(11)] }));
  assert.equal(w.assign, 'stripe', 'group of the pocketed ball, not of the first contact');
  const none = judgeShot(open({ events: [hit(0, 2), rail(0)] }));
  assert.equal(none.outcome, 'pass');
  assert.equal(none.assign, null);
});

test('foul on an open table never assigns groups', () => {
  const v = judgeShot(open({ events: [hit(0, 2), pocket(2), pocket(0)] }));
  assert.equal(v.outcome, 'pass');
  assert.equal(v.assign, null);
  assert.ok(v.foul);
});

test('assigned groups: pocketing own continues, only the opponent\'s ball passes the turn', () => {
  assert.equal(judgeShot(open({ group: 'solid', events: [hit(0, 2), pocket(2)] })).outcome, 'continue');
  assert.equal(judgeShot(open({ group: 'solid', events: [hit(0, 2), pocket(9)] })).outcome, 'pass');
  assert.equal(judgeShot(open({ group: 'solid', events: [hit(0, 2), pocket(9), pocket(3)] })).outcome, 'continue');
  const miss = judgeShot(open({ group: 'solid', events: [hit(0, 2), rail(2)] }));
  assert.equal(miss.outcome, 'pass');
  assert.ok(!miss.foul);
});

test('foul: wrong group first, 8 first, nothing hit, no rail', () => {
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [hit(0, 9), rail(0)] })).fouls, ['wrongFirst']);
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [hit(0, 8), rail(0)] })).fouls, ['wrongFirst']);
  assert.deepEqual(judgeShot(open({ events: [hit(0, 8), rail(0)] })).fouls, ['wrongFirst'], 'open table: not the 8');
  assert.deepEqual(judgeShot(open({ events: [rail(0)] })).fouls, ['noContact']);
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [hit(0, 1)] })).fouls, ['noRail']);
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [rail(0), hit(0, 1)] })).fouls, ['noRail'], 'a rail before the contact does not count');
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [hit(0, 1), rail(5)] })).fouls, [], 'any ball reaching a rail is enough');
  assert.deepEqual(judgeShot(open({ group: 'solid', events: [hit(0, 1), pocket(1)] })).fouls, [], 'a pocketed ball waives the rail');
  const v = judgeShot(open({ group: 'solid', events: [hit(0, 9), pocket(1)] }));
  assert.ok(v.foul);
  assert.equal(v.outcome, 'pass');
});

test('once the group is cleared the 8 must be hit first', () => {
  const down = SOLIDS;
  assert.deepEqual(judgeShot(open({ group: 'solid', down, events: [hit(0, 9), rail(0)] })).fouls, ['wrongFirst']);
  assert.deepEqual(judgeShot(open({ group: 'solid', down, events: [hit(0, 8), rail(8)] })).fouls, []);
});

test('the 8 ball: win, early loss, loss on a foul, scratch while pocketing it', () => {
  const win = judgeShot(open({ group: 'solid', down: SOLIDS, events: [hit(0, 8), pocket(8, 3)] }));
  assert.equal(win.outcome, 'win');
  const early = judgeShot(open({ group: 'solid', down: [1, 2], events: [hit(0, 3), pocket(8)] }));
  assert.equal(early.outcome, 'lose');
  assert.equal(early.reason, 'eightEarly');
  const openLoss = judgeShot(open({ events: [hit(0, 3), pocket(8)] }));
  assert.equal(openLoss.reason, 'eightEarly');
  const sameShot = judgeShot(open({ group: 'solid', down: [1, 2, 3, 4, 5, 6], events: [hit(0, 7), pocket(7), pocket(8)] }));
  assert.equal(sameShot.outcome, 'lose', 'last ball and the 8 in one shot');
  const foul = judgeShot(open({ group: 'solid', down: SOLIDS, events: [hit(0, 9), rail(0), pocket(8)] }));
  assert.equal(foul.reason, 'eightFoul');
  const scratch = judgeShot(open({ group: 'solid', down: SOLIDS, events: [hit(0, 8), pocket(8), pocket(0)] }));
  assert.equal(scratch.outcome, 'lose');
  assert.equal(scratch.reason, 'eightScratch');
});

test('callPocket: the 8 must go in the called pocket', () => {
  const ev = [hit(0, 8), pocket(8, 4)];
  assert.equal(judgeShot(open({ group: 'stripe', down: [9, 10, 11, 12, 13, 14, 15], events: ev, callPocket: true, call: 4 })).outcome, 'win');
  const wrong = judgeShot(open({ group: 'stripe', down: [9, 10, 11, 12, 13, 14, 15], events: ev, callPocket: true, call: 5 }));
  assert.equal(wrong.outcome, 'lose');
  assert.equal(wrong.reason, 'eightPocket');
  assert.equal(judgeShot(open({ group: 'stripe', down: [9, 10, 11, 12, 13, 14, 15], events: ev, callPocket: false, call: 5 })).outcome, 'win');
});

test('ball off the table is a foul and is not a pocketed ball', () => {
  const v = judgeShot(open({ group: 'solid', events: [hit(0, 1), { type: 'off', ball: 1, t: 9 }, rail(5)] }));
  assert.ok(v.fouls.includes('offTable'));
  assert.deepEqual(v.potted, []);
  const c = judgeShot(open({ group: 'solid', events: [hit(0, 1), { type: 'off', ball: 0, t: 9 }] }));
  assert.ok(c.cueDown && c.foul);
});

/* ---------------------------------------------------------------- game */

test('start: racked table, break with ball in hand behind the head string, state is public', () => {
  const { g, room } = make();
  g.begin();
  assert.equal(g.turn, 'a');
  assert.ok(g.inHand && g.breakShot);
  assert.equal(g.positions.filter(Boolean).length, 16);
  assert.ok(g.positions[0][0] <= P.HEAD_X);
  const s = room.sent.at(-1);
  assert.equal(s.type, 'pool-state');
  assert.equal(s.phase, 'aim');
  assert.equal(s.players.length, 2);
  assert.equal(s.timeLeft, 45000);
  g.cleanup();
});

test('page loaded sends the state; both loaded starts the game early', () => {
  const { g, room } = make();
  g.handleMessage('a', 'pool-page-loaded', {});
  assert.ok(room.sent.some((m) => m.to === 'a' && m.type === 'pool-state'));
  assert.equal(g.started, false);
  g.handleMessage('b', 'pool-page-loaded', {});
  assert.equal(g.started, true);
  g.cleanup();
});

test('hostile input: out of turn, NaN, bad types, bad cue placement, shots while rolling', () => {
  const { g, room } = table({ 0: [500, 635], 1: [1000, 635], 9: [2000, 300], 8: [2200, 900] });
  const errs = () => room.sent.filter((m) => m.type === 'error').length;
  g.handleMessage('b', 'pool-shot', { angle: 0, power: 0.5 });
  assert.equal(errs(), 1);
  for (const bad of [{ angle: NaN, power: 0.5 }, { angle: 0, power: NaN }, { angle: 'x', power: 1 }, { angle: 0, power: -1 }, { angle: 0, power: 0.5, spin: { x: NaN, y: 0 } }, null, 'str', 5]) {
    g.handleMessage('a', 'pool-shot', bad);
  }
  assert.equal(errs(), 1 + 8);
  assert.equal(g.phase, 'aim');
  g.handleMessage('zzz', 'pool-shot', { angle: 0, power: 0.5 });
  g.handleMessage('a', 'unknown-type', {});
  g.handleMessage('a', 'pool-rerack', { accept: false });
  assert.equal(g.phase, 'aim');
  // ball in hand: placements out of bounds, on a ball, NaN, behind the head string on the break
  g.inHand = true;
  const before = errs();
  for (const cue of [{ x: -50, y: 100 }, { x: 5000, y: 5000 }, { x: NaN, y: 1 }, { x: 1000, y: 635 }, { x: 'a', y: 'b' }, { x: 5, y: 5 }]) {
    g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.5, cue });
  }
  assert.equal(errs(), before + 6);
  assert.equal(g.phase, 'aim');
  g.breakShot = true;
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.5, cue: { x: P.HEAD_X + 100, y: 635 } });
  assert.equal(errs(), before + 7, 'the break must be from behind the head string');
  g.cleanup();
});

test('a legal shot: the shot is broadcast, the outcome is published only after the replay', () => {
  const { g, room } = table({ 0: [400, 400], 1: [200, 200], 9: [2000, 300], 8: [2200, 900] });
  g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45 });
  assert.equal(g.phase, 'rolling');
  const shot = room.sent.find((m) => m.type === 'pool-shot');
  assert.ok(shot && shot.ticks > 0 && shot.from.length === 16 && shot.final.length === 16);
  assert.equal(JSON.stringify(shot).length < 900, true, 'small payload');
  assert.equal(g.turn, 'a');
  // a second shot while the balls roll is rejected
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.4 });
  assert.equal(room.sent.filter((m) => m.type === 'pool-shot').length, 1);
  // a reload during the replay restores it
  g.sendState('a');
  const mid = room.sent.at(-1);
  assert.equal(mid.phase, 'rolling');
  assert.equal(mid.shot.seq, shot.seq);
  assert.equal(mid.last, null, 'the result is not leaked before the replay ends');
  g.settle();
  assert.equal(g.phase, 'aim');
  assert.deepEqual(g.down, [1]);
  assert.equal(g.groups.a, 'solid');
  assert.equal(g.groups.b, 'stripe');
  assert.equal(g.turn, 'a', 'pocketing a ball continues the turn');
  assert.equal(g.inHand, false);
  assert.ok(g.last.notes.some((n) => n.k === 'pool.note.assigned'));
  g.cleanup();
});

test('the replay a client runs matches the server result', () => {
  const { g, room } = table({ 0: [400, 400], 1: [200, 200], 9: [2000, 300], 8: [2200, 900] });
  g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1) + 0.01, power: 0.8, spin: { x: 0.2, y: 0.4 } });
  const shot = room.sent.find((m) => m.type === 'pool-shot');
  const sim = P.createSim(shot.from, shot.shot);
  while (!sim.done) P.stepSim(sim);
  assert.equal(sim.tick, shot.ticks);
  assert.deepEqual(P.snapshot(sim), shot.final);
  g.cleanup();
});

test('a missed shot with no foul passes the turn without ball in hand', () => {
  const { g } = table({ 0: [400, 400], 1: [1000, 600], 9: [2000, 300], 8: [2200, 900] });
  g.groups = { a: 'solid', b: 'stripe' };
  g.handleMessage('a', 'pool-shot', { angle: Math.atan2(200, 600), power: 0.5 });
  g.settle();
  assert.equal(g.turn, 'b');
  assert.equal(g.inHand, false);
  g.cleanup();
});

test('foul: wrong ball first gives the opponent ball in hand', () => {
  const { g } = table({ 0: [400, 635], 1: [2000, 300], 9: [900, 635], 8: [2200, 900] });
  g.groups = { a: 'solid', b: 'stripe' };
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.5 });
  g.settle();
  assert.equal(g.turn, 'b');
  assert.equal(g.inHand, true);
  assert.ok(g.last.foul);
  assert.equal(g.last.notes[0].k, 'pool.note.wrongFirst');
  assert.ok(P.validCue(g.positions, g.positions[0][0], g.positions[0][1], false));
  // Bob places the cue ball anywhere
  g.handleMessage('b', 'pool-shot', { angle: Math.PI, power: 0.3, cue: { x: 1500, y: 300 } });
  assert.equal(g.phase, 'rolling');
  g.cleanup();
});

test('scratch: the cue ball comes back as ball in hand for the opponent', () => {
  const { g } = table({ 0: [1270, 400], 1: [2000, 300], 9: [2200, 900] });
  g.groups = { a: 'solid', b: 'stripe' };
  g.handleMessage('a', 'pool-shot', { angle: Math.PI / 2, power: 0.5 });
  g.settle();
  assert.equal(g.turn, 'b');
  assert.ok(g.inHand);
  assert.ok(g.positions[0], 'cue ball is back on the table');
  assert.equal(g.last.notes[0].k, 'pool.note.noContact');
  g.cleanup();
});

test('pocketing the 8 early loses, legally wins, both end the game once', () => {
  let t = table({ 0: [400, 400], 8: [200, 200], 1: [2000, 300] });
  t.g.groups = { a: 'solid', b: 'stripe' };
  t.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45 });
  t.g.settle();
  assert.equal(t.g.phase, 'over');
  assert.equal(t.g.winner, 'b');
  assert.equal(t.room.finished.title.p.name, 'Bob');
  assert.equal(t.room.finished.subtitle.k, 'pool.result.eightFoul', 'hitting the 8 first with balls left is also a foul');
  assert.deepEqual(t.room.finished.rows.map((r) => r.rank), [1, 2]);

  t = table({ 0: [400, 400], 8: [200, 200], 9: [2000, 300] });
  t.g.groups = { a: 'solid', b: 'stripe' };
  t.g.down = [...SOLIDS];
  t.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45 });
  t.g.settle();
  assert.equal(t.g.winner, 'a');
  assert.equal(t.room.finished.subtitle.k, 'pool.result.eightWin');
  assert.equal(t.room.finished.rows[0].score, 7);
  t.g.cleanup();
});

test('callPocket: a shot at the 8 needs a call and the right pocket', () => {
  const t = table({ 0: [400, 400], 8: [200, 200], 9: [2000, 300] }, { callPocket: 'on' });
  t.g.groups = { a: 'solid', b: 'stripe' };
  t.g.down = [...SOLIDS];
  const errs = () => t.room.sent.filter((m) => m.type === 'error').length;
  t.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45 });
  assert.equal(errs(), 1);
  assert.equal(t.g.phase, 'aim');
  t.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45, call: 99 });
  assert.equal(errs(), 2);
  t.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45, call: 5 });
  t.g.settle();
  assert.equal(t.g.winner, 'b');
  assert.equal(t.room.finished.subtitle.k, 'pool.result.eightPocket');

  const ok = table({ 0: [400, 400], 8: [200, 200], 9: [2000, 300] }, { callPocket: 'on' });
  ok.g.groups = { a: 'solid', b: 'stripe' };
  ok.g.down = [...SOLIDS];
  ok.g.handleMessage('a', 'pool-shot', { angle: Math.atan2(-1, -1), power: 0.45, call: 0 });
  ok.g.settle();
  assert.equal(ok.g.winner, 'a');
  // no call is needed while balls of the group remain
  const early = table({ 0: [400, 635], 1: [900, 635], 9: [2000, 300] }, { callPocket: 'on' });
  early.g.groups = { a: 'solid', b: 'stripe' };
  early.g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.4 });
  assert.equal(early.g.phase, 'rolling');
  for (const x of [t, ok, early]) x.g.cleanup();
});

test('illegal break: the opponent may accept the table or force a re-rack', () => {
  const { g, room } = make();
  g.begin();
  // a feeble break that reaches nothing
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.4, cue: { x: 300, y: 635 } });
  g.settle();
  assert.equal(g.phase, 'rerack');
  assert.equal(g.chooser, 'b');
  assert.equal(g.turn, 'b');
  assert.ok(g.last.notes.some((n) => n.k === 'pool.note.illegalBreak'));
  g.handleMessage('a', 'pool-rerack', { accept: true });
  assert.equal(g.phase, 'rerack', 'only the chooser may decide');
  g.handleMessage('b', 'pool-rerack', { accept: false });
  assert.equal(g.phase, 'aim');
  assert.ok(g.breakShot && g.inHand);
  assert.equal(g.turn, 'b');
  assert.equal(g.positions.filter(Boolean).length, 16);
  assert.ok(room.sent.at(-1).phase === 'aim');
  g.cleanup();

  const acc = make();
  acc.g.begin();
  acc.g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.4, cue: { x: 300, y: 635 } });
  acc.g.settle();
  acc.g.handleMessage('b', 'pool-rerack', { accept: true });
  assert.equal(acc.g.phase, 'aim');
  assert.equal(acc.g.breakShot, false);
  assert.equal(acc.g.inHand, false);
  assert.equal(acc.g.turn, 'b');
  acc.g.cleanup();
});

test('a real break keeps the game legal: an 8 on the break is never a result', () => {
  for (let seed = 1; seed <= 6; seed++) {
    let s = seed;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const { g } = make({}, { rng });
    g.begin();
    g.handleMessage(g.turn, 'pool-shot', { angle: 0, power: 1 });
    g.settle();
    assert.notEqual(g.phase, 'over');
    assert.ok(g.positions[8], 'the 8 is still on the table');
    assert.equal(g.groups.a, null);
    assert.equal(g.groups.b, null);
    g.cleanup();
  }
});

test('shot clock: timeout is a foul with ball in hand; three in a row lose', () => {
  const { g, room } = make({ shotClock: 30 });
  g.begin();
  g.positions = sparse({ 0: [500, 635], 1: [1000, 635], 9: [2000, 300], 8: [2200, 900] });
  g.breakShot = false;
  g.inHand = false;
  g.turn = 'a';
  g.timeoutTurn();
  assert.equal(g.turn, 'b');
  assert.ok(g.inHand);
  assert.equal(g.last.notes[0].k, 'pool.note.timeout');
  assert.equal(room.sent.at(-1).timeLeft, 30000);
  g.timeoutTurn();
  assert.equal(g.turn, 'a');
  g.timeoutTurn();
  g.timeoutTurn();
  g.timeoutTurn();
  assert.equal(g.phase, 'over');
  assert.equal(room.finished.subtitle.k, 'pool.result.timeouts');
  assert.equal(g.winner, 'b');
  g.cleanup();
});

test('shot clock: a real shot resets the timeout counter, "off" has no clock, the timer fires', async () => {
  const { g } = make({ shotClock: 0 });
  g.begin();
  assert.equal(g.deadline, 0);
  assert.equal(g.view().timeLeft, null);
  g.cleanup();

  const t = make({ shotClock: 30 });
  t.g.begin();
  assert.ok(t.g.clockTimer);
  t.g.timeouts.a = 2;
  t.g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.6 });
  assert.equal(t.g.timeouts.a, 0);
  assert.equal(t.g.clockTimer, null, 'no clock while the balls roll');
  t.g.cleanup();
  assert.equal(t.g.settleTimer, null);

  const bad = make({ shotClock: 999 });
  assert.equal(bad.g.shotClock, 45);
  bad.g.cleanup();
});

test('timeout while choosing the re-rack accepts the table', () => {
  const { g } = make({ shotClock: 30 });
  g.begin();
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.4, cue: { x: 300, y: 635 } });
  g.settle();
  g.onClock();
  assert.equal(g.phase, 'aim');
  assert.equal(g.turn, 'b');
  g.cleanup();
});

test('a leaving player forfeits; the game ends once', () => {
  const { g, room } = make();
  g.begin();
  g.onPlayerLeft('a');
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'b');
  assert.equal(room.finished.subtitle.k, 'pool.result.forfeit');
  const first = room.finished;
  g.onPlayerLeft('b');
  assert.equal(room.finished, first);
  g.handleMessage('b', 'pool-shot', { angle: 0, power: 1 });
  assert.equal(g.phase, 'over');
  assert.equal(g.clockTimer, null);
  g.cleanup();
});

test('leaving during the replay forfeits immediately and stops the settle timer', () => {
  const { g, room } = table({ 0: [400, 635], 1: [900, 635], 9: [2000, 300] });
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 0.5 });
  assert.ok(g.settleTimer);
  g.onPlayerLeft('b');
  assert.equal(g.winner, 'a');
  assert.equal(g.settleTimer, null);
  g.settle();
  assert.equal(room.finished.rows[0].id, 'a');
  g.cleanup();
});

test('spectator sync and the live aim relay (throttled, shooter only)', () => {
  const room = fakeRoom(['host']);
  let t = 5000;
  const g = new Pool(room, PL, {}, { now: () => t, rng: () => 0.1 });
  g.begin();
  g.spectatorSync('host');
  const s = room.sent.at(-1);
  assert.equal(s.to, 'host');
  assert.equal(s.type, 'pool-state');
  assert.equal(JSON.stringify(s).includes('secret'), false);

  g.handleMessage('b', 'pool-aim', { angle: 1, power: 0.2 });
  assert.equal(room.sent.filter((m) => m.type === 'pool-aim').length, 0, 'only the shooter');
  g.handleMessage('a', 'pool-aim', { angle: 1, power: 0.2, spin: { x: 0.1, y: 0.2 }, cue: { x: 300, y: 600 } });
  const aims = () => room.sent.filter((m) => m.type === 'pool-aim');
  assert.deepEqual(aims().map((m) => m.to).sort(), ['b', 'host']);
  assert.equal(aims()[0].cue.x, 300);
  g.handleMessage('a', 'pool-aim', { angle: 1.1, power: 0.2 });
  assert.equal(aims().length, 2, 'throttled');
  t += 100;
  g.handleMessage('a', 'pool-aim', { angle: NaN, power: 0.2 });
  assert.equal(aims().length, 2, 'NaN ignored');
  g.handleMessage('a', 'pool-aim', { angle: 1.1, power: 99, cue: { x: 99999, y: -5 } });
  assert.equal(aims().length, 4);
  assert.equal(aims().at(-1).power, 1);
  assert.ok(P.validCue(g.positions, aims().at(-1).cue.x, aims().at(-1).cue.y, true));
  g.cleanup();
});

test('reload after the game started restores the table (full snapshot)', () => {
  const { g, room } = table({ 0: [400, 635], 1: [900, 635], 9: [2000, 300], 8: [2200, 900] });
  g.groups = { a: 'solid', b: 'stripe' };
  g.down = [2, 10];
  g.sendState('b');
  const s = room.sent.at(-1);
  assert.equal(s.balls.length, 16);
  assert.deepEqual(s.down, [2, 10]);
  assert.equal(s.players.find((p) => p.id === 'a').group, 'solid');
  assert.equal(s.turn, 'a');
  g.cleanup();
});

test('cleanup clears every timer', () => {
  const { g } = make({ shotClock: 30 });
  g.begin();
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 1 });
  g.cleanup();
  assert.equal(g.startTimer, null);
  assert.equal(g.clockTimer, null);
  assert.equal(g.settleTimer, null);
  g.handleMessage('a', 'pool-shot', { angle: 0, power: 1 });
});
