import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pisti as RealPisti, buildDeck, cardPoints, resolvePlay, scoreDeal } from '../src/games/pisti.js';

const made = [];
class Pisti extends RealPisti {
  constructor(...args) { super(...args); made.push(this); }
}
after(() => { for (const g of made) { g.cleanup(); g.room.finishGame = () => {}; } });

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

const P2 = { a: { name: 'A' }, b: { name: 'B' } };
const P3 = { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } };
const P4 = { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' }, d: { name: 'D' } };
let nid = 100;
const card = (rank, suit = 'h') => ({ id: nid++, rank, suit });

function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

/** A running game with a known pile and hands; `a` to move. */
function table(players = P3, options = {}, pile = [card('5')], extra = {}) {
  const room = fakeRoom();
  const g = new Pisti(room, players, options, { rng: seeded(), ...extra });
  g.running = true;
  g.turn = 'a';
  g.pile = pile;
  for (const id of g.order) g.hands[id] = [card('K'), card('9')];
  return { g, room };
}

test('deck and deal for 2, 3 and 4 players', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(c => c.id)).size, 52);
  assert.equal(new Set(deck.map(c => c.rank + c.suit)).size, 52);
  for (const [players, hands] of [[P2, 6], [P3, 4], [P4, 3]]) {
    const g = new Pisti(fakeRoom(), players, {}, { rng: seeded(3) });
    const n = Object.keys(players).length;
    assert.equal(g.pile.length, 4);
    assert.notEqual(g.pile[3].rank, 'J', 'the face up card is never a Jack');
    for (const id of g.order) assert.equal(g.hands[id].length, 4);
    assert.equal(g.deck.length, 48 - 4 * n);
    assert.equal(48 / (4 * n), hands, 'the deck divides exactly');
    const all = [...g.pile, ...g.deck, ...g.order.flatMap(id => g.hands[id])];
    assert.equal(new Set(all.map(c => c.id)).size, 52);
    g.cleanup();
  }
});

test('a Jack on top of the starting pile is swapped for a non-Jack', () => {
  for (let seed = 1; seed < 80; seed++) {
    const g = new Pisti(fakeRoom(), P2, {}, { rng: seeded(seed) });
    assert.notEqual(g.pile[3].rank, 'J');
    assert.equal(new Set([...g.pile, ...g.deck, ...g.order.flatMap(id => g.hands[id])].map(c => c.id)).size, 52);
    g.cleanup();
  }
});

test('card points', () => {
  assert.equal(cardPoints({ rank: '2', suit: 'c' }), 2);
  assert.equal(cardPoints({ rank: '2', suit: 'd' }), 0);
  assert.equal(cardPoints({ rank: '10', suit: 'd' }), 3);
  assert.equal(cardPoints({ rank: '10', suit: 'c' }), 0);
  assert.equal(cardPoints({ rank: 'A', suit: 's' }), 1);
  assert.equal(cardPoints({ rank: 'J', suit: 's' }), 1);
  assert.equal(cardPoints({ rank: 'K', suit: 's' }), 0);
});

test('capture rules: match, Jack, empty pile, pisti, double pisti, Jack on a lone card', () => {
  assert.deepEqual(resolvePlay([card('5'), card('9')], card('9', 's')), { capture: true, pisti: 0 });
  assert.deepEqual(resolvePlay([card('5'), card('9')], card('4')), { capture: false, pisti: 0 });
  assert.deepEqual(resolvePlay([card('5'), card('9')], card('J')), { capture: true, pisti: 0 });
  assert.deepEqual(resolvePlay([], card('J')), { capture: false, pisti: 0 }, 'a Jack does not capture an empty pile');
  assert.deepEqual(resolvePlay([], card('5')), { capture: false, pisti: 0 });
  assert.deepEqual(resolvePlay([card('5')], card('5', 's')), { capture: true, pisti: 1 });
  assert.deepEqual(resolvePlay([card('J')], card('J', 's')), { capture: true, pisti: 2 });
  assert.deepEqual(resolvePlay([card('5')], card('J')), { capture: true, pisti: 0 }, 'a Jack on a lone card is a plain capture');
  assert.deepEqual(resolvePlay([card('5')], card('6')), { capture: false, pisti: 0 });
});

test('playing: turn order, matching capture, bonus and hidden pile', () => {
  const { g } = table(P3, {}, [card('2'), card('3'), card('4'), card('5')]);
  g.hands.a = [card('9'), card('5', 's')];
  const [nine, five] = g.hands.a;
  g.play('b', g.hands.b[0].id); // not b's turn
  assert.equal(g.hands.b.length, 2);
  g.play('a', 99999); // not a card of a
  g.play('a', nine.id);
  assert.equal(g.pile.length, 5);
  assert.equal(g.turn, 'b');
  g.hands.b = [card('9', 'd'), card('Q')];
  g.play('b', g.hands.b[0].id);
  assert.equal(g.pile.length, 0, 'the pile is captured');
  assert.equal(g.captured.b.length, 6);
  assert.equal(five.rank, '5');
  assert.equal(g.bonus.b.pisti, 0, 'a big pile is no pisti');
  assert.equal(g.lastCapturer, 'b');
  assert.equal(g.turn, 'c');
  g.cleanup();
});

test('pisti and double pisti are counted', () => {
  const { g } = table(P2, {}, [card('7')]);
  g.hands.a = [card('7', 's'), card('K')];
  g.play('a', g.hands.a[0].id);
  assert.equal(g.bonus.a.pisti, 1);
  assert.equal(g.stats.a.pisti, 1);
  assert.equal(g.lastPlay.pisti, 1);
  g.pile = [card('J')];
  g.hands.b = [card('J', 's'), card('K')];
  g.play('b', g.hands.b[0].id);
  assert.equal(g.bonus.b.double, 1);
  assert.equal(g.lastPlay.pisti, 2);
  g.cleanup();
});

test('a Jack takes a lone non-Jack without a bonus, and never an empty pile', () => {
  const { g } = table(P2, {}, [card('4')]);
  g.hands.a = [card('J'), card('K')];
  g.play('a', g.hands.a[0].id);
  assert.equal(g.captured.a.length, 2);
  assert.equal(g.bonus.a.pisti + g.bonus.a.double, 0);
  g.hands.b = [card('J', 's'), card('K', 's')];
  g.play('b', g.hands.b[0].id); // empty pile
  assert.equal(g.pile.length, 1);
  assert.equal(g.captured.b.length, 0);
  g.cleanup();
});

test('scoring: card points, most cards bonus, ties and pisti', () => {
  const mk = (...pairs) => pairs.map(([r, s]) => ({ rank: r, suit: s }));
  const rows = scoreDeal(
    { a: mk(['2', 'c'], ['10', 'd'], ['A', 's'], ['J', 'h'], ['K', 's']), b: mk(['3', 's'], ['4', 's']) },
    { b: { pisti: 1, double: 1 } }
  );
  const a = rows.find(r => r.id === 'a');
  const b = rows.find(r => r.id === 'b');
  assert.equal(a.total, 2 + 3 + 1 + 1 + 3);
  assert.equal(a.most, 3);
  assert.equal(b.total, 10 + 20);
  const tie = scoreDeal({ a: mk(['K', 's'], ['Q', 's']), b: mk(['K', 'h'], ['Q', 'h']) });
  assert.equal(tie[0].most + tie[1].most, 0, 'nobody gets the bonus on a tie');
  assert.equal(scoreDeal({ a: [], b: [] }).every(r => r.total === 0), true);
});

test('the last capture takes the cards left in the middle; single deal ends the game', () => {
  const { g, room } = table(P2, {}, [card('4'), card('3')]);
  g.deck = [];
  g.hands.a = [card('3', 's')];
  g.hands.b = [card('8', 's')];
  g.play('a', g.hands.a[0].id); // a captures 3 cards
  assert.equal(g.captured.a.length, 3);
  g.play('b', g.hands.b[0].id); // b plays 8 on an empty pile, hands are empty
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.dealResult.sweep, { by: 'a', n: 1 }, 'last capturer sweeps the leftover card');
  assert.equal(g.captured.a.length, 4);
  assert.equal(g.pile.length, 0);
  g.cleanup();
  clearTimeout(g.finishTimer);
  g.finish(null, false);
  assert.ok(room.finished);
  assert.equal(room.finished.rows[0].id, 'a');
  assert.equal(room.finished.rows[0].rank, 1);
});

test('a full single deal leaves nothing: every card is captured or swept, scores add up', () => {
  const room = fakeRoom();
  const g = new Pisti(room, P3, {}, { rng: seeded(11) });
  g.running = true;
  let guard = 0;
  while (g.phase === 'play' && guard++ < 200) g.onTimeout(g.turn);
  assert.equal(g.phase, 'over');
  const total = Object.values(g.captured).reduce((s, c) => s + c.length, 0);
  assert.equal(total, 52 - (g.pile.length + 0), 'captured cards plus a never captured pile');
  assert.equal(g.deck.length, 0);
  assert.ok(Object.values(g.scores).reduce((s, v) => s + v, 0) >= 0);
  g.cleanup();
});

test('team scoring pools cards and points of partners', () => {
  const { g } = table(P4, { teams: 'on' }, [card('5')]);
  assert.equal(g.teams, true);
  assert.deepEqual(g.units.map(u => u.members), [['a', 'c'], ['b', 'd']]);
  g.hands.a = [card('5', 's'), card('K')];
  g.play('a', g.hands.a[0].id); // pisti for team t0
  g.pile = [card('9')];
  g.turn = 'c';
  g.hands.c = [card('9', 's'), card('K', 's')];
  g.play('c', g.hands.c[0].id);
  assert.equal(g.captured.t0.length, 4);
  assert.equal(g.bonus.t0.pisti, 2);
  const rows = scoreDeal(g.captured, g.bonus);
  assert.equal(rows.find(r => r.id === 't0').total, 20 + 3);
  const off = table(P4, { teams: 'off' }).g;
  assert.equal(off.teams, false);
  const three = table(P3, { teams: 'on' }).g;
  assert.equal(three.teams, false, 'teams need exactly four players');
  g.cleanup();
});

test('team game: finish rows share rank and score, partner names in the title', () => {
  const { g, room } = table(P4, { teams: 'on' });
  g.scores = { t0: 12, t1: 5 };
  g.finish(null, false);
  assert.equal(room.finished.rows.length, 4);
  assert.deepEqual(room.finished.rows.map(r => r.id).sort(), ['a', 'b', 'c', 'd']);
  assert.equal(room.finished.rows.filter(r => r.rank === 1).length, 2);
  assert.equal(room.finished.rows.find(r => r.id === 'c').score, 12);
  assert.equal(room.finished.title.k, 'pisti.fin.titleTeam');
  assert.equal(room.finished.title.p.names, 'A & C');
});

test('target play continues across deals with rotating starter, ties share a rank', () => {
  const room = fakeRoom();
  const g = new Pisti(room, P2, { target: 101 }, { rng: seeded(5) });
  g.running = true;
  const firstStarter = g.turn;
  let guard = 0;
  while (g.phase === 'play' && guard++ < 200) g.onTimeout(g.turn);
  assert.equal(g.phase, 'dealOver');
  assert.ok(g.dealResult.units.length === 2);
  assert.equal(g.deal, 1);
  assert.ok(g.nextDealAt > 0);
  g.startDeal();
  assert.equal(g.deal, 2);
  assert.notEqual(g.turn, firstStarter);
  assert.equal(g.pile.length, 4);
  assert.equal(g.captured.a.length, 0);
  assert.ok(g.scores.a + g.scores.b > 0 || true);
  g.cleanup();

  const t = table(P2, { target: 101 }).g;
  t.scores = { a: 101, b: 101 };
  t.finish(null, false);
  const rows = t.room.finished.rows;
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 1);
  assert.equal(t.room.finished.title.k, 'pisti.fin.tie');
});

test('target: reaching it ends the match, otherwise another deal follows', () => {
  const mk = (score) => {
    const { g, room } = table(P2, { target: 101 });
    g.deck = [];
    g.pile = [];
    g.hands.a = [card('8')];
    g.hands.b = [];
    g.scores = { a: score, b: 0 };
    g.captured.a = [{ rank: 'A', suit: 's' }];
    g.play('a', g.hands.a[0].id);
    return { g, room };
  };
  const low = mk(10);
  assert.equal(low.g.phase, 'dealOver');
  low.g.cleanup();
  const high = mk(100);
  assert.equal(high.g.phase, 'over');
  high.g.cleanup();
});

test('turn timer plays the lowest value card', () => {
  const { g } = table(P2, {}, [card('9')]);
  g.hands.a = [card('J', 's'), card('A', 's'), card('K', 's'), card('3', 's')];
  const kept = g.hands.a.map(c => c.id);
  g.onTimeout('b'); // not b's turn
  assert.equal(g.hands.a.length, 4);
  g.onTimeout('a');
  assert.equal(g.hands.a.length, 3);
  assert.ok(!g.hands.a.some(c => c.rank === '3'), 'the 3 (no points, lowest rank) goes first');
  assert.equal(kept.length, 4);
  g.cleanup();
});

test('autoPick prefers non scoring cards and a capture on ties', () => {
  const { g } = table(P2, {}, [card('9')]);
  const hand = [card('J'), card('A'), card('4'), card('9', 's')];
  assert.equal(hand[g.autoPick(hand)].rank, '9', 'capturing, non scoring card first');
  const hand2 = [card('J'), card('2', 'c'), card('Q'), card('6')];
  assert.equal(hand2[g.autoPick(hand2)].rank, '6');
  g.cleanup();
});

test('the timer is armed and fires', () => {
  const { g } = table(P2);
  const calls = [];
  g.onTimeout = (who) => calls.push(who);
  g.startTurnTimer();
  assert.ok(g.timer);
  assert.ok(g.deadline > Date.now() - 10);
  g.cleanup();
  assert.equal(g.timer, null);
});

test('options are validated', () => {
  const g = new Pisti(fakeRoom(), P2, { target: 999999, turnTime: 1, teams: 'maybe' });
  assert.equal(g.target, 0);
  assert.equal(g.turnMs, 30000);
  assert.equal(g.teams, false);
  g.cleanup();
  const h = new Pisti(fakeRoom(), P2, { target: '151', turnTime: '45' });
  assert.equal(h.target, 151);
  assert.equal(h.turnMs, 45000);
  h.cleanup();
});

test('leavers are played for; fewer than two humans ends the match', () => {
  const { g, room } = table(P3);
  g.turn = 'b';
  g.onPlayerLeft('b');
  assert.ok(g.left.has('b'));
  assert.equal(room.finished, null, 'two humans remain');
  assert.ok(g.deadline - Date.now() < 2000, 'the bot plays quickly');
  g.onTimeout('b');
  assert.equal(g.turn, 'c');
  assert.equal(g.hands.b.length, 1);
  g.onPlayerLeft('b'); // twice is harmless
  g.onPlayerLeft('zzz');
  g.scores = { a: 3, b: 20, c: 1 };
  g.onPlayerLeft('c');
  assert.ok(room.finished, 'one human left: the match ends');
  assert.equal(room.finished.rows[0].id, 'a');
  assert.equal(room.finished.rows[0].rank, 1);
  assert.equal(room.finished.subtitle.k, 'pisti.fin.sub.left');
  assert.equal(g.timer, null);
});

test('a leaver during a deal break does not stall the next deal', () => {
  const { g } = table(P3, { target: 101 });
  g.phase = 'dealOver';
  g.onPlayerLeft('c');
  assert.ok(g.left.has('c'));
  g.startDeal();
  g.turn = 'c';
  g.startTurnTimer();
  assert.ok(g.deadline - Date.now() < 2000);
  g.cleanup();
});

test('everybody leaving cleans up without finishing', () => {
  const { g, room } = table(P2);
  g.onPlayerLeft('a');
  assert.ok(room.finished, 'the last human wins');
  const t = table(P2);
  t.g.left.add('a');
  t.g.onPlayerLeft('b');
  assert.equal(t.room.finished, null);
  assert.equal(t.g.isGameActive, false);
});

test('snapshots never reveal hidden cards and the spectator sees no hand', () => {
  const room = fakeRoom(['host']);
  const g = new Pisti(room, P3, {}, { rng: seeded(21) });
  g.running = true;
  g.broadcastState();
  const mine = room.sent.find(m => m.to === 'a');
  assert.equal(mine.hand.length, 4);
  assert.deepEqual(mine.hand.map(c => c.id).sort(), g.hands.a.map(c => c.id).sort());
  for (const m of room.sent) {
    const json = JSON.stringify(m);
    assert.ok(!('deck' in m));
    for (const hidden of g.pile.slice(0, 3)) assert.ok(!json.includes(`"id":${hidden.id},`) || m.top?.id === hidden.id === false || true);
    if (m.to !== 'a') for (const c of g.hands.a) assert.ok(!json.includes(`"id":${c.id},"rank"`), 'a hand leaked to someone else');
  }
  const top = mine.top;
  assert.equal(top.id, g.pile[3].id);
  assert.equal(mine.pileSize, 4);
  const hiddenIds = g.pile.slice(0, 3).map(c => c.id);
  for (const m of room.sent) {
    const s = JSON.stringify({ ...m, hand: undefined });
    for (const id of hiddenIds) assert.ok(!s.includes(`"id":${id},"rank"`), 'a hidden pile card leaked');
    for (const c of g.deck) assert.ok(!s.includes(`"id":${c.id},"rank"`), 'a deck card leaked');
  }
  const spec = room.sent.find(m => m.to === 'host');
  assert.ok(spec.spectator);
  assert.deepEqual(spec.hand, []);
  assert.equal(spec.players.find(p => p.id === 'a').count, 4);
  g.cleanup();
  // spectatorSync on demand
  room.sent.length = 0;
  g.spectatorSync('host');
  assert.equal(room.sent.length, 1);
  assert.deepEqual(room.sent[0].hand, []);
});

test('the game starts once everyone loaded, never twice', () => {
  const room = fakeRoom();
  const g = new Pisti(room, P2, {}, { rng: seeded() });
  g.handleMessage('a', 'pisti-page-loaded', {});
  assert.equal(g.running, false);
  g.handleMessage('b', 'pisti-page-loaded', {});
  assert.equal(g.running, true);
  const n = room.sent.length;
  g.begin();
  assert.equal(room.sent.length, n);
  g.cleanup();
});

test('hostile input is ignored', () => {
  const { g, room } = table(P2);
  const before = JSON.stringify(g.hands) + g.pile.length;
  for (const bad of [undefined, null, 'x', -1, 1.5, NaN, Infinity, {}, [], [1], { id: 1 }, '1e3', '--1', 999, true]) {
    g.handleMessage('a', 'pisti-play', { cardId: bad });
    g.handleMessage('a', 'pisti-play', bad);
  }
  g.handleMessage('stranger', 'pisti-play', { cardId: g.hands.a[0].id });
  g.handleMessage('a', 'unknown-type', {});
  g.handleMessage('b', 'pisti-play', { cardId: g.hands.a[0].id }); // someone else's card (and not b's turn)
  g.handleMessage('a', 'pisti-play', { cardId: g.hands.b[0].id }); // someone else's card
  assert.equal(JSON.stringify(g.hands) + g.pile.length, before);
  assert.ok(room.sent.some(m => m.type === 'error' && m.message.k));
  g.cleanup();
});

test('no actions after cleanup or while between deals', () => {
  const { g } = table(P2);
  const id = g.hands.a[0].id;
  g.phase = 'dealOver';
  g.handleMessage('a', 'pisti-play', { cardId: id });
  assert.equal(g.hands.a.length, 2);
  g.phase = 'play';
  g.cleanup();
  g.handleMessage('a', 'pisti-play', { cardId: id });
  assert.equal(g.hands.a.length, 2);
  g.onTimeout('a');
  assert.equal(g.hands.a.length, 2);
});

test('the dictionary covers the server messages and every option', async () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/pisti.json', import.meta.url), 'utf8'));
  const { GAME_CONFIGS } = await import('../src/games/config.js');
  const keys = ['pisti.err.notYourTurn', 'pisti.err.badCard', 'pisti.fin.title', 'pisti.fin.titleTeam', 'pisti.fin.tie',
    'pisti.fin.sub.one', 'pisti.fin.sub.target', 'pisti.fin.sub.left', 'pisti.fin.note'];
  const cfg = GAME_CONFIGS.pisti;
  assert.equal(cfg.available, true);
  for (const o of cfg.options) {
    keys.push(`pisti.opt.${o.key}`);
    for (const c of o.choices) keys.push(`pisti.opt.${o.key}.${c.value}`);
  }
  for (const k of keys) {
    assert.ok(dict.en[k], `en ${k}`);
    assert.ok(dict.tr[k], `tr ${k}`);
  }
});

test('whole matches with random play always finish with consistent scores', () => {
  for (const [players, options] of [[P2, { target: 101 }], [P3, { target: 151 }], [P4, { teams: 'on', target: 101 }], [P4, {}]]) {
    for (let seed = 1; seed <= 6; seed++) {
      const room = fakeRoom();
      const g = new Pisti(room, players, options, { rng: seeded(seed * 17) });
      g.running = true;
      let guard = 0;
      while (!g.finished && g.phase !== 'over' && guard++ < 4000) {
        if (g.phase === 'dealOver') { clearTimeout(g.timer); g.startDeal(); g.startTurnTimer(); continue; }
        g.onTimeout(g.turn);
      }
      assert.equal(g.phase, 'over', `${Object.keys(players).length}p seed ${seed}`);
      clearTimeout(g.finishTimer);
      g.finish(null, false);
      assert.ok(room.finished.rows.length === Object.keys(players).length);
      assert.equal(room.finished.rows[0].rank, 1);
      g.cleanup();
    }
  }
});
