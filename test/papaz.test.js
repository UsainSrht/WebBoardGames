import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Papaz, buildPapazDeck, splitPairs, isPapaz } from '../src/games/papaz.js';

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
let nid = 100;
const c = (r, s = 's') => ({ id: nid++, r, s });
const PAPAZ = () => ({ id: 25, r: 'K', s: 's' });

function make(n, options = {}, seed = 1) {
  const room = fakeRoom();
  const g = new Papaz(room, names(n), options, { rng: seeded(seed) });
  return { g, room };
}

/** Running game with a hand-built table; p0 to move. */
function table(hands, options = {}) {
  const ids = Object.keys(hands);
  const { g, room } = make(ids.length, options, 9);
  g.cleanup();
  g.isGameActive = true;
  ids.forEach((id, i) => { g.hands[`p${i}`] = hands[id]; g.discards[`p${i}`] = []; });
  g.running = true;
  g.turn = 'p0';
  return { g, room };
}

const inPlay = (g) => g.order.reduce((s, id) => s + g.hands[id].length + g.discards[id].length * 2, 0);

test('deck: 49 cards, only the king of spades remains', () => {
  const d = buildPapazDeck();
  assert.equal(d.length, 49);
  const kings = d.filter(x => x.r === 'K');
  assert.equal(kings.length, 1);
  assert.equal(kings[0].s, 's');
  assert.equal(new Set(d.map(x => x.id)).size, 49);
});

test('splitPairs: pairs regardless of suit, triples leave one card, fours make two pairs', () => {
  const r = splitPairs([c('7', 's'), c('7', 'h'), c('7', 'd'), c('9'), c('Q', 'c'), c('Q', 'h'), c('2'), c('2', 'h'), c('2', 'd'), c('2', 'c')]);
  assert.equal(r.pairs.length, 4);
  assert.deepEqual(r.rest.map(x => x.r).sort(), ['7', '9']);
});

test('dealing: all cards dealt evenly for every player count, pairs gone, Papaz present once', () => {
  for (let n = 2; n <= 8; n++) {
    const { g } = make(n, {}, n);
    assert.equal(inPlay(g), 49, `n=${n}`);
    const sizes = g.order.map(id => g.hands[id].length + g.discards[id].length * 2);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `even deal n=${n}`);
    for (const id of g.order) {
      const ranks = g.hands[id].map(x => x.r);
      assert.equal(new Set(ranks).size, ranks.length, 'no pair left in hand');
    }
    assert.equal(g.order.flatMap(id => g.hands[id]).filter(isPapaz).length, 1);
    g.cleanup();
  }
});

test('options: rounds and turn time are validated', () => {
  assert.equal(make(3, { rounds: 5 }).g.rounds, 5);
  assert.equal(make(3, { rounds: 7 }).g.rounds, 3);
  assert.equal(make(3, { turnTime: 45 }).g.turnMs, 45000);
});

test('drawing: picked slot is moved, a match is paired, otherwise inserted; turn passes to the target', () => {
  const { g } = table({
    a: [c('3'), c('5')],
    b: [c('9'), c('5', 'h'), c('J')],
    c: [c('2'), PAPAZ()]
  });
  assert.equal(g.target(), 'p1');
  g.draw('p0', 1); // takes the 5 of hearts
  assert.equal(g.discards.p0.length, 1);
  assert.deepEqual(g.hands.p0.map(x => x.r), ['3']);
  assert.equal(g.hands.p1.length, 2);
  assert.equal(g.turn, 'p1');
  assert.equal(g.target(), 'p2');
  g.draw('p1', 0); // takes the 2
  assert.equal(g.hands.p1.length, 3);
  assert.equal(g.turn, 'p2');
  g.cleanup();
});

test('drawing validation: turn, index range and types', () => {
  const { g, room } = table({ a: [c('3')], b: [c('9'), c('3', 'h')], c: [PAPAZ()] });
  g.draw('p1', 0);
  g.draw('p0', -1);
  g.draw('p0', 5);
  g.draw('p0', 0.5);
  g.draw('p0', '0');
  g.handleMessage('p0', 'papaz-draw', null);
  g.handleMessage('p0', 'papaz-draw', { index: {} });
  g.handleMessage('nobody', 'papaz-draw', { index: 0 });
  g.handleMessage('p0', 7, {});
  assert.equal(g.hands.p1.length, 2);
  assert.equal(g.turn, 'p0');
  assert.ok(room.sent.some(m => m.type === 'error'));
  g.cleanup();
});

test('players who run out of cards are safe; the hand ends when one player is left (the Papaz holder loses)', () => {
  const { g, room } = table({ a: [c('3')], b: [c('3', 'h')], c: [PAPAZ()] }, { rounds: 1 });
  g.draw('p0', 0); // p0 pairs the 3 and is safe; p1 safe too
  assert.equal(g.phase, 'roundOver');
  assert.equal(g.result.loser, 'p2');
  assert.equal(g.losses.p2, 1);
  assert.equal(g.result.card.r, 'K');
  g.cleanup();
});

test('turn skips safe players', () => {
  const { g } = table({ a: [c('3'), PAPAZ()], b: [c('3', 'h')], c: [c('8'), c('9')], d: [c('8', 'h'), c('9', 'h')] });
  g.draw('p0', 0); // p0 pairs, p1 safe
  assert.equal(g.hands.p1.length, 0);
  assert.equal(g.turn, 'p2', 'p1 is skipped');
  assert.equal(g.target(), 'p3');
  g.draw('p2', 0);
  g.draw('p3', 0); // p3 draws from p0 (next after p3 is p0)
  g.cleanup();
});

test('round scoring: losses accumulate, multi-round, ties share the rank', () => {
  const { g, room } = table({ a: [c('3')], b: [c('3', 'h')], c: [PAPAZ()] }, { rounds: 3 });
  g.draw('p0', 0);
  assert.equal(g.phase, 'roundOver');
  assert.equal(g.losses.p2, 1);
  assert.equal(room.finished, null, 'more hands to play');
  g.cleanup();

  const t = table({ a: [c('3')], b: [c('3', 'h')], c: [PAPAZ()] }, { rounds: 1 });
  t.g.losses.p0 = 0;
  t.g.draw('p0', 0);
  t.g.finish();
  const rows = t.room.finished.rows;
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 1, 'zero losses share first place');
  assert.equal(rows[2].rank, 3);
  assert.equal(rows[2].id, 'p2');
  assert.equal(t.room.finished.title.k, 'papaz.msg.loserTitle');
  t.g.cleanup();

  const u = table({ a: [], b: [], c: [] }, { rounds: 3 });
  u.g.losses = { p0: 2, p1: 2, p2: 0 };
  u.g.finish();
  assert.equal(u.room.finished.title.k, 'papaz.msg.tieTitle');
  assert.deepEqual(u.room.finished.rows.map(r => r.rank), [1, 2, 2]);
  u.g.cleanup();
});

test('next hand is dealt after the reveal (fake timers) and the last hand finishes the game', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = fakeRoom();
  const g = new Papaz(room, names(3), { rounds: 3 }, { rng: seeded(2) });
  g.begin();
  g.endHand('p1');
  assert.equal(g.phase, 'roundOver');
  t.mock.timers.tick(7000);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'play');
  assert.equal(inPlay(g), 49);
  g.endHand('p2');
  t.mock.timers.tick(7000);
  assert.equal(g.round, 3);
  g.endHand('p2');
  assert.equal(room.finished, null);
  t.mock.timers.tick(7000);
  assert.ok(room.finished);
  assert.equal(room.finished.rows.at(-1).id, 'p2');
  assert.equal(g.losses.p2, 2);
  g.cleanup();
});

test('timeout draws a random card; stale timers are ignored', () => {
  const { g } = table({ a: [c('3')], b: [c('9'), c('3', 'h'), c('J')], c: [PAPAZ(), c('2')] });
  g.onTimeout('p1', g.round);
  assert.equal(g.hands.p1.length, 3);
  g.onTimeout('p0', 99);
  assert.equal(g.hands.p1.length, 3);
  g.onTimeout('p0', g.round);
  assert.equal(g.hands.p1.length, 2);
  assert.ok(g.log.some(l => l.k === 'papaz.msg.timeout'));
  g.cleanup();
});

test('shuffle: only the target, once per turn', () => {
  const { g } = table({ a: [c('3')], b: [c('9'), c('4', 'h'), c('J'), c('Q')], c: [PAPAZ(), c('2')] });
  const ids = g.hands.p1.map(x => x.id);
  g.handleMessage('p0', 'papaz-shuffle'); // not the target
  assert.deepEqual(g.hands.p1.map(x => x.id), ids);
  assert.equal(g.stateFor('p1').canShuffle, true);
  assert.equal(g.stateFor('p0').canShuffle, false);
  g.handleMessage('p1', 'papaz-shuffle');
  assert.equal(g.shuffled, true);
  assert.deepEqual([...g.hands.p1.map(x => x.id)].sort(), [...ids].sort());
  const after = g.hands.p1.map(x => x.id);
  g.handleMessage('p1', 'papaz-shuffle');
  assert.deepEqual(g.hands.p1.map(x => x.id), after, 'second shuffle ignored');
  assert.equal(g.stateFor('p1').canShuffle, false);
  g.cleanup();
});

test('privacy: others never see your cards; draw events show the card only to drawer and source', () => {
  const { g } = table({ a: [c('3'), c('6')], b: [c('9'), c('4', 'h')], c: [PAPAZ(), c('2')] });
  for (const viewer of g.order) {
    const json = JSON.stringify(g.stateFor(viewer));
    for (const other of g.order) {
      if (other === viewer) continue;
      for (const card of g.hands[other]) assert.ok(!json.includes(`"id":${card.id},"r":`), `${viewer} sees ${other}`);
    }
  }
  g.draw('p0', 0); // takes the 9, no pair
  const ev = (v) => g.stateFor(v).events.find(e => e.t === 'draw');
  assert.ok(ev('p0').card && ev('p1').card, 'drawer and source see it');
  assert.equal(ev('p2').card, undefined);
  assert.equal(ev(null).card, undefined);
  assert.ok(!JSON.stringify(g.stateFor('p2')).includes('"r":"9"'));
  // spectator
  const room2 = fakeRoom(['host']);
  const g2 = new Papaz(room2, names(3), {}, { rng: seeded(4) });
  g2.spectatorSync('host');
  const m = room2.sent.find(x => x.to === 'host');
  assert.equal(m.spectator, true);
  assert.deepEqual(m.hand, []);
  assert.equal(m.type, 'papaz-state');
  g2.broadcastState();
  assert.ok(room2.sent.filter(x => x.to === 'host').length >= 2);
  g.cleanup(); g2.cleanup();
});

test('page load sends the snapshot, game starts once everyone loaded', () => {
  const { g, room } = make(2, {}, 3);
  g.handleMessage('p0', 'papaz-page-loaded');
  assert.ok(room.sent.some(m => m.to === 'p0' && m.type === 'papaz-state'));
  assert.equal(g.running, false);
  g.handleMessage('p1', 'papaz-page-loaded');
  assert.equal(g.running, true);
  g.cleanup();
});

test('leaving: Papaz stays with a real player, parity is kept, the turn moves on', () => {
  const { g } = table({
    a: [c('3'), c('4')],
    b: [PAPAZ(), c('9')],
    c: [c('3', 'h'), c('9', 'h'), c('4', 'h')],
    d: [c('J')]
  });
  g.draw('p0', 0); // p0 takes the 9 of b? (slot 0 is the Papaz)
  g.cleanup();

  const t = table({ a: [c('3'), c('4')], b: [PAPAZ(), c('9')], c: [c('3', 'h'), c('9', 'h'), c('4', 'h')] });
  t.g.onPlayerLeft('p1'); // holds the Papaz and the 9
  const all = t.g.order.flatMap(id => t.g.hands[id]);
  assert.equal(all.filter(isPapaz).length, 1, 'Papaz still in play');
  const counts = {};
  for (const x of all) if (!isPapaz(x)) counts[x.r] = (counts[x.r] || 0) + 1;
  for (const [r, n] of Object.entries(counts)) assert.equal(n % 2, 0, `rank ${r} even`);
  t.g.cleanup();

  const u = table({ a: [c('3'), c('4')], b: [c('9')], c: [c('3', 'h'), c('9', 'h'), PAPAZ(), c('4', 'h')] });
  u.g.onPlayerLeft('p0'); // turn player leaves
  assert.notEqual(u.g.turn, 'p0');
  assert.ok(u.g.order.includes(u.g.turn));
  u.g.cleanup();

  const v = table({ a: [c('3')], b: [c('3', 'h')], c: [PAPAZ()] });
  v.g.onPlayerLeft('p1');
  v.g.onPlayerLeft('p2');
  assert.equal(v.room.finished.rows.length, 1);
  assert.equal(v.room.finished.rows[0].id, 'p0');
  v.g.cleanup();
});

test('complete simulated games with random bots finish without stalls (2 to 8 players)', () => {
  for (let n = 2; n <= 8; n++) {
    for (let seed = 1; seed <= 6; seed++) {
      const rng = seeded(seed * 17 + n);
      const room = fakeRoom(['host']);
      const g = new Papaz(room, names(n), { rounds: 3 }, { rng: seeded(seed * 5 + n) });
      g.cleanup();
      g.isGameActive = true;
      g.running = true;
      g.startTurn();
      let steps = 0;
      let hands = 0;
      while (!room.finished && steps++ < 6000) {
        if (g.phase === 'roundOver') {
          assert.ok(g.result.loser, 'a loser exists');
          assert.equal(g.hands[g.result.loser].length, 1);
          assert.equal(g.hands[g.result.loser][0].r, 'K');
          hands++;
          // skip the reveal delay
          clearTimeout(g.timer);
          if (g.round >= g.rounds) g.finish(); else { g.dealRound(); g.startTurn(); }
          continue;
        }
        const who = g.turn;
        assert.ok(who && g.hands[who].length > 0, 'turn player has cards');
        const tg = g.target();
        assert.ok(tg && tg !== who);
        if (steps % 41 === 0) { g.onTimeout(who, g.round); continue; }
        g.handleMessage(who, 'papaz-draw', { index: Math.floor(rng() * g.hands[tg].length) });
      }
      assert.ok(room.finished, `finished n=${n} seed=${seed}`);
      assert.equal(hands, 3);
      assert.equal(room.finished.rows.length, n);
      assert.equal(room.finished.rows.reduce((s, r) => s + (r.note.p.n), 0), 3);
      g.cleanup();
    }
  }
});

test('simulated games with leavers always end with the Papaz held by a real player', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const rng = seeded(seed * 3);
    const n = 3 + (seed % 5);
    const room = fakeRoom();
    const g = new Papaz(room, names(n), { rounds: 1 }, { rng: seeded(seed) });
    g.cleanup();
    g.isGameActive = true;
    g.running = true;
    g.startTurn();
    let steps = 0;
    while (g.phase === 'play' && steps++ < 3000) {
      if (steps % 5 === 0 && g.order.length > 1) g.onPlayerLeft(g.order[Math.floor(rng() * g.order.length)]);
      if (g.phase !== 'play') break;
      const who = g.turn;
      assert.ok(who, `turn set (seed ${seed})`);
      const tg = g.target();
      g.handleMessage(who, 'papaz-draw', { index: Math.floor(rng() * g.hands[tg].length) });
    }
    assert.notEqual(g.phase, 'play', `seed ${seed} ended`);
    if (g.result?.loser) {
      assert.equal(g.hands[g.result.loser].length, 1);
      assert.ok(isPapaz(g.hands[g.result.loser][0]));
    } else {
      assert.ok(room.finished, 'ended by everyone leaving');
    }
    g.cleanup();
  }
});

test('every message key used by the server exists in both languages', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/papaz.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/papaz.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/'(papaz\.(?:msg|err)\.\w+)'/g)].map(m => m[1]));
  assert.ok(keys.size > 10);
  for (const k of keys) {
    const has = (d) => k in d || `${k}_other` in d;
    assert.ok(has(dict.en), `${k} (en)`);
    assert.ok(has(dict.tr), `${k} (tr)`);
  }
});
