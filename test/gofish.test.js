import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GoFish } from '../src/games/gofish.js';
import { RANKS, buildDeck } from '../src/games/card-utils.js';

// Timers must not keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { const h = realSetTimeout(...a); h?.unref?.(); return h; };

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

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const names = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { odId: `p${i}`, name: `P${i}` }]));
const c = (id, r, s = 's') => ({ id, r, s });

function make(n, options = {}, seed = 1) {
  const room = fakeRoom();
  const g = new GoFish(room, names(n), options, { rng: seeded(seed) });
  return { g, room };
}

/** A running game with a hand-built table. */
function table(hands, stock = [], options = {}) {
  const ids = Object.keys(hands);
  const room = fakeRoom();
  const g = new GoFish(room, names(ids.length), options, { rng: seeded(7) });
  g.cleanup();
  g.isGameActive = true;
  ids.forEach((id, i) => { void i; });
  g.order = ids.map((_, i) => `p${i}`);
  ids.forEach((id, i) => { g.hands[`p${i}`] = hands[id]; g.books[`p${i}`] = []; });
  g.stock = stock;
  g.running = true;
  g.turn = 'p0';
  return { g, room };
}

const total = (g) => g.order.reduce((s, id) => s + g.hands[id].length + g.books[id].length * 4, 0) + g.stock.length + g.goneBooks * 4;

test('dealing: hand size by player count, forced sizes, cards conserved', () => {
  for (let n = 2; n <= 6; n++) {
    const { g } = make(n);
    const size = n <= 3 ? 7 : 5;
    assert.equal(g.handSize, size, `players ${n}`);
    assert.equal(total(g), 52);
    for (const id of g.order) assert.ok(g.hands[id].length <= size);
    assert.equal(new Set(g.order.flatMap(id => g.hands[id].map(x => x.id)).concat(g.stock.map(x => x.id))).size + g.order.reduce((s, id) => s + g.books[id].length * 4, 0), 52);
    g.cleanup();
  }
  assert.equal(make(2, { hand: 5 }).g.handSize, 5);
  assert.equal(make(6, { hand: 7 }).g.handSize, 7);
  assert.equal(make(4, { hand: 'auto' }).g.handSize, 5);
  assert.equal(make(3, { hand: 'bogus' }).g.handSize, 7);
});

test('a four of a kind in the deal becomes a book immediately', () => {
  const { g } = table({ a: [c(1, '7', 's'), c(2, '7', 'h'), c(3, '7', 'd'), c(4, '7', 'c'), c(5, '2')], b: [c(6, '3')] });
  g.layBooks('p0');
  assert.deepEqual(g.books.p0, ['7']);
  assert.equal(g.hands.p0.length, 1);
});

test('asking: all cards of the rank are handed over and you ask again', () => {
  const { g } = table({
    a: [c(1, '5', 's'), c(2, '9')],
    b: [c(3, '5', 'h'), c(4, '5', 'd'), c(5, 'K')],
    c: [c(6, '2')]
  }, [c(40, '3')]);
  g.ask('p0', 'p1', '5');
  assert.equal(g.hands.p0.filter(x => x.r === '5').length, 3);
  assert.equal(g.hands.p1.length, 1);
  assert.equal(g.turn, 'p0', 'same player asks again');
  assert.equal(g.stock.length, 1);
  const ev = g.events.filter(e => e.t === 'give')[0];
  assert.equal(ev.n, 2);
  assert.equal(g.log.at(-1).k, 'gofish.msg.give');
  g.cleanup();
});

test('asking: you must hold the rank, the target must exist and hold cards, only on your turn', () => {
  const { g, room } = table({ a: [c(1, '5')], b: [c(3, '5', 'h')], c: [] }, [c(40, '3')]);
  g.ask('p1', 'p0', '5'); // not your turn
  g.ask('p0', 'p0', '5'); // self
  g.ask('p0', 'nobody', '5');
  g.ask('p0', 'p2', '5'); // empty hand
  g.ask('p0', 'p1', 'K'); // not held
  g.ask('p0', 'p1', 5);
  g.ask('p0', 'p1', null);
  g.handleMessage('p0', 'gofish-ask', null);
  g.handleMessage('p0', 'gofish-ask', 'x');
  g.handleMessage('p0', 'gofish-ask', { target: { a: 1 }, rank: ['5'] });
  g.handleMessage('stranger', 'gofish-ask', { target: 'p1', rank: '5' });
  g.handleMessage('p0', 42, {});
  assert.equal(g.hands.p0.length, 1);
  assert.equal(g.hands.p1.length, 1);
  assert.equal(g.turn, 'p0');
  assert.ok(room.sent.filter(m => m.type === 'error').length >= 5);
  g.cleanup();
});

test('go fish: a non-matching draw passes the turn and is private', () => {
  const { g, room } = table({ a: [c(1, '5'), c(2, '9')], b: [c(3, '4')], c: [c(6, '2')] }, [c(40, 'Q', 'h'), c(41, '8')]);
  g.ask('p0', 'p1', '5');
  assert.equal(g.hands.p0.length, 3);
  assert.equal(g.stock.length, 1);
  assert.equal(g.turn, 'p1');
  const ev = g.events.find(e => e.t === 'fish');
  assert.equal(ev.lucky, false);
  assert.equal(ev.rank, undefined, 'drawn card is not revealed');
  assert.ok(!JSON.stringify(g.stateFor('p1')).includes('"Q"'));
  assert.ok(JSON.stringify(g.stateFor('p0')).includes('"Q"'));
  assert.ok(room.sent.length > 0);
  g.cleanup();
});

test('go fish: drawing the asked rank shows it and gives another turn', () => {
  const { g } = table({ a: [c(1, '5'), c(2, '9')], b: [c(3, '4')], c: [c(6, '2')] }, [c(40, '5', 'h')]);
  g.ask('p0', 'p1', '5');
  assert.equal(g.turn, 'p0');
  const ev = g.events.find(e => e.t === 'fish');
  assert.equal(ev.lucky, true);
  assert.equal(ev.rank, '5');
  assert.equal(g.log.some(l => l.k === 'gofish.msg.lucky'), true);
  g.cleanup();
});

test('go fish with an empty stock just passes the turn', () => {
  const { g } = table({ a: [c(1, '5')], b: [c(3, '4')] }, []);
  g.ask('p0', 'p1', '5');
  assert.equal(g.turn, 'p1');
  assert.equal(g.log.some(l => l.k === 'gofish.msg.stockEmpty'), true);
  g.cleanup();
});

test('a completed book is laid down at once, even from a draw', () => {
  const { g } = table({
    a: [c(1, '5', 's'), c(2, '5', 'h'), c(10, '9')],
    b: [c(3, '5', 'd'), c(4, '5', 'c'), c(5, 'K')],
    c: [c(6, '2')]
  }, [c(40, '3')]);
  g.ask('p0', 'p1', '5');
  assert.deepEqual(g.books.p0, ['5']);
  assert.equal(g.hands.p0.length, 1);
  assert.equal(g.turn, 'p0');
  // drawing the fourth card
  const t2 = table({ a: [c(1, '5', 's'), c(2, '5', 'h'), c(3, '5', 'd'), c(9, '9')], b: [c(5, 'K')], c: [c(6, '2')] }, [c(40, '5', 'c')]);
  t2.g.ask('p0', 'p1', '9'); // go fish, draws 5c: completes the book, turn passes
  assert.deepEqual(t2.g.books.p0, ['5']);
  assert.equal(t2.g.turn, 'p1');
  g.cleanup(); t2.g.cleanup();
});

test('empty hand: refills from the stock on your turn, skipped when the stock is empty', () => {
  const stock = Array.from({ length: 9 }, (_, i) => c(40 + i, RANKS[i]));
  const { g } = table({ a: [c(1, '5')], b: [], c: [c(6, '2')] }, stock, { hand: 5 });
  g.ask('p0', 'p2', '5'); // go fish: draws (stock 9 -> 8) and passes
  assert.equal(g.turn, 'p1', 'p1 refilled and plays');
  assert.equal(g.hands.p1.length, 5);
  assert.equal(g.stock.length, 3);

  const t2 = table({ a: [c(1, '5')], b: [], c: [c(6, '5', 'h'), c(7, '9')] }, []);
  t2.g.ask('p0', 'p2', '5');
  assert.equal(t2.g.turn, 'p0', 'p0 asks again');
  t2.g.ask('p0', 'p2', '5'); // p2 has none now: go fish on an empty stock passes the turn
  assert.equal(t2.g.turn, 'p2', 'p1 has no cards and the stock is empty, so p1 is skipped');
  g.cleanup(); t2.g.cleanup();
});

test('a player who gives away their last card refills at their own turn, not before', () => {
  const stock = Array.from({ length: 12 }, (_, i) => c(40 + i, RANKS[i + 1]));
  const { g } = table({ a: [c(1, '5'), c(2, 'A')], b: [c(3, '5', 'h')], c: [c(6, '2')] }, stock, { hand: 5 });
  g.ask('p0', 'p1', '5');
  assert.equal(g.hands.p1.length, 0);
  assert.equal(g.stock.length, 12);
  // p0 asks p2 for a rank and fishes (stock -> 11), turn goes to p1 who refills 5
  g.ask('p0', 'p2', 'A');
  assert.equal(g.turn, 'p1');
  assert.equal(g.hands.p1.length, 5);
  g.cleanup();
});

test('13 books end the game, most books wins and ties share the rank', () => {
  const { g, room } = table({ a: [c(1, '5', 's'), c(2, '5', 'h'), c(3, '5', 'd')], b: [c(4, '5', 'c')], c: [c(5, 'K')] }, []);
  const ranks12 = RANKS.filter(r => r !== '5');
  g.books.p0 = ranks12.slice(0, 6);
  g.books.p1 = ranks12.slice(6, 11);
  g.books.p2 = ranks12.slice(11);
  g.hands.p2 = [];
  g.ask('p0', 'p1', '5');
  assert.equal(g.phase, 'over');
  assert.equal(g.books.p0.length, 7);
  assert.equal(room.finished.rows[0].id, 'p0');
  assert.equal(room.finished.rows[0].rank, 1);
  assert.equal(room.finished.rows[0].score, 7);
  assert.equal(room.finished.rows[1].rank, 2);
  assert.equal(room.finished.rows[2].rank, 3);
  assert.equal(room.finished.title.k, 'gofish.msg.wins');
  assert.equal(g.turn, null);
  g.cleanup();

  const t = table({ a: [c(1, '5', 's'), c(2, '5', 'h'), c(3, '5', 'd')], b: [c(4, '5', 'c')], c: [] }, []);
  t.g.books.p0 = ranks12.slice(0, 4);
  t.g.books.p1 = ranks12.slice(4, 9);
  t.g.books.p2 = ranks12.slice(9);
  t.g.ask('p0', 'p1', '5');
  assert.equal(t.room.finished.rows[0].rank, 1);
  assert.equal(t.room.finished.rows[1].rank, 1, 'tie shares the rank');
  assert.equal(t.room.finished.rows[2].rank, 3);
  assert.equal(t.room.finished.title.k, 'gofish.msg.tie');
  t.g.cleanup();
});

test('timeout makes a legal random ask; with no legal ask the turn passes', () => {
  const { g } = table({ a: [c(1, '5'), c(2, '9')], b: [c(3, '9', 'h')], c: [c(6, '2')] }, [c(40, '3'), c(41, '4'), c(42, '6')]);
  g.onTimeout('p1'); // not their turn: ignored
  assert.equal(g.turn, 'p0');
  const before = g.log.length;
  g.onTimeout('p0');
  assert.ok(g.log.length > before);
  assert.ok(g.log.some(l => l.k === 'gofish.msg.timeout'));
  assert.ok(g.log.some(l => l.k === 'gofish.msg.ask'));
  g.cleanup();
});

test('timers fire from the turn clock (fake timers)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = fakeRoom();
  let now = 0;
  const g = new GoFish(room, names(3), { turnTime: 20 }, { rng: seeded(3), now: () => now });
  g.begin();
  const first = g.turn;
  assert.ok(first);
  assert.equal(g.stateFor('p0').timeLeft, 20000);
  now = 20000;
  t.mock.timers.tick(20000);
  assert.ok(g.log.some(l => l.k === 'gofish.msg.timeout'), 'auto ask happened');
  g.cleanup();
});

test('leaving: cards return to the stock; the turn moves on; last player wins', () => {
  const { g, room } = table({ a: [c(1, '5')], b: [c(3, '4'), c(4, '4', 'h')], c: [c(6, '2')] }, [c(40, '3')]);
  g.books.p1 = ['A'];
  g.onPlayerLeft('p1'); // not their turn
  assert.equal(g.stock.length, 3);
  assert.equal(g.goneBooks, 1);
  assert.deepEqual(g.order, ['p0', 'p2']);
  assert.equal(g.turn, 'p0');
  g.onPlayerLeft('p0'); // their turn, one player left
  assert.equal(g.phase, 'over');
  assert.equal(room.finished.rows.length, 1);
  assert.equal(room.finished.rows[0].id, 'p2');
  g.onPlayerLeft('p0'); // idempotent
  g.cleanup();

  const t = table({ a: [c(1, '5')], b: [c(3, '4')], c: [c(6, '2')] }, [c(40, '3')]);
  t.g.onPlayerLeft('p0'); // the turn player leaves
  assert.equal(t.g.turn, 'p1');
  t.g.cleanup();
});

test('privacy: no snapshot or event leaks another hand; spectators get no hand', () => {
  const { g, room } = make(4, {}, 11);
  g.begin();
  for (const viewer of g.order) {
    const json = JSON.stringify(g.stateFor(viewer));
    for (const other of g.order) {
      if (other === viewer) continue;
      for (const card of g.hands[other]) assert.ok(!json.includes(`"id":${card.id},"r":`), `viewer ${viewer} sees ${other}'s card`);
    }
  }
  for (const card of g.stock) assert.ok(!JSON.stringify(g.stateFor('p0')).includes(`"id":${card.id},"r":`), 'stock cards are hidden');
  const spec = { ...g.stateFor(null), spectator: true };
  assert.deepEqual(spec.hand, []);
  const room2 = fakeRoom(['host']);
  const g2 = new GoFish(room2, names(3), {}, { rng: seeded(5) });
  g2.spectatorSync('host');
  const m = room2.sent.find(x => x.to === 'host');
  assert.equal(m.type, 'gofish-state');
  assert.equal(m.spectator, true);
  assert.deepEqual(m.hand, []);
  assert.equal(m.players.length, 3);
  g2.broadcastState();
  assert.ok(room2.sent.filter(x => x.to === 'host').length >= 2, 'broadcast reaches spectators');
  g.cleanup(); g2.cleanup();
  assert.ok(room.sent.length >= 0);
});

test('page load sends the snapshot and the game starts when everyone loaded', () => {
  const { g, room } = make(2, {}, 4);
  g.handleMessage('p0', 'gofish-page-loaded');
  assert.ok(room.sent.some(m => m.to === 'p0' && m.type === 'gofish-state'));
  assert.equal(g.running, false);
  g.handleMessage('p1', 'gofish-page-loaded');
  assert.equal(g.running, true);
  assert.ok(g.turn);
  g.cleanup();
});

test('complete simulated games with random bots always finish', () => {
  for (let n = 2; n <= 6; n++) {
    for (let seed = 1; seed <= 8; seed++) {
      const rng = seeded(seed * 100 + n);
      const room = fakeRoom(['host']);
      const g = new GoFish(room, names(n), { hand: seed % 3 === 0 ? 5 : 'auto' }, { rng: seeded(seed * 31 + n) });
      g.begin();
      let steps = 0;
      while (g.phase !== 'over' && steps++ < 4000) {
        assert.equal(total(g), 52, 'cards are conserved');
        const who = g.turn;
        assert.ok(who, `turn set (n=${n}, seed=${seed}, step=${steps})`);
        assert.ok(g.hands[who].length > 0);
        if (steps % 37 === 0) { g.onTimeout(who); continue; }
        const targets = g.targets(who);
        assert.ok(targets.length > 0);
        const target = targets[Math.floor(rng() * targets.length)];
        const rank = g.hands[who][Math.floor(rng() * g.hands[who].length)].r;
        g.handleMessage(who, 'gofish-ask', { target, rank });
      }
      assert.equal(g.phase, 'over', `finished (n=${n}, seed=${seed})`);
      assert.equal(g.totalBooks(), 13);
      assert.ok(room.finished);
      assert.equal(room.finished.rows.length, n);
      const sum = room.finished.rows.reduce((s, r) => s + r.score, 0);
      assert.equal(sum, 13);
      assert.equal(room.finished.rows[0].rank, 1);
      g.cleanup();
    }
  }
});

test('simulated games survive players leaving at random', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rng = seeded(seed * 7);
    const n = 3 + (seed % 4);
    const room = fakeRoom();
    const g = new GoFish(room, names(n), {}, { rng: seeded(seed) });
    g.begin();
    let steps = 0;
    while (g.phase !== 'over' && steps++ < 4000) {
      if (g.order.length < 2) break;
      if (steps % 23 === 0 && g.order.length > 1) g.onPlayerLeft(g.order[Math.floor(rng() * g.order.length)]);
      if (g.phase === 'over') break;
      const who = g.turn;
      assert.ok(who, `turn set after leaving (seed ${seed})`);
      const targets = g.targets(who);
      const target = targets[Math.floor(rng() * targets.length)];
      const rank = g.hands[who][Math.floor(rng() * g.hands[who].length)].r;
      g.handleMessage(who, 'gofish-ask', { target, rank });
    }
    assert.equal(g.phase, 'over', `seed ${seed} finished`);
    assert.ok(room.finished);
    g.cleanup();
  }
});

test('every message key used by the server exists in both languages', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/gofish.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/gofish.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/'(gofish\.(?:msg|err)\.\w+)'/g)].map(m => m[1]));
  assert.ok(keys.size > 10);
  for (const k of keys) {
    assert.ok(k in dict.en || `${k}_other` in dict.en, `${k} (en)`);
    assert.ok(k in dict.tr || `${k}_other` in dict.tr, `${k} (tr)`);
  }
  for (const r of RANKS) {
    for (const form of ['one', 'other']) assert.ok(`gofish.rank.${r}_${form}` in dict.tr, `rank ${r} ${form}`);
  }
  assert.equal(buildDeck().length, 52);
});
