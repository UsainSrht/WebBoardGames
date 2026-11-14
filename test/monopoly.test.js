import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Monopoly } from '../src/games/monopoly.js';
import { SPACES, GROUPS, CHANCE, CHEST, DECKS, STATIONS, UTILITIES } from '../src/games/monopoly-data.js';

export function fakeRoom(spectators = []) {
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

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** A running game with a fixed seat order, a is on turn, no timers. */
export function mk(n = 3, options = {}, extra = {}) {
  const players = Object.fromEntries(IDS.slice(0, n).map((id) => [id, { odId: id, name: id.toUpperCase() }]));
  const room = fakeRoom(extra.spectators);
  const g = new Monopoly(room, players, { turnTime: 0, timeLimit: 0, ...options }, { rng: () => 0.5, autoMs: 1e9, ...extra });
  g.order = IDS.slice(0, n);
  g.order.forEach((id, i) => { g.P[id].seat = i; });
  g.turn = 'a';
  g.running = true;
  g.rollDie = () => { throw new Error('dice not scripted'); };
  clearTimeout(g.timers.start);
  return { g, room };
}

export function dice(g, ...rolls) {
  const flat = rolls.flat();
  g.rollDie = () => { if (!flat.length) throw new Error('out of dice'); return flat.shift(); };
}
const send = (g, id, type, payload) => g.handleMessage(id, type, payload);
const own = (g, id, ...idxs) => idxs.forEach((i) => { g.owner[i] = id; });
const errs = (room) => room.sent.filter((m) => m.type === 'error');
const lastErr = (room) => errs(room).at(-1)?.message?.k;
const fresh = (g, id) => { g.turn = id; g.t = { doubles: 0, extra: false, jailed: false, rolled: false }; g.setPhase('roll'); };
const done = (g) => g.cleanup();

test('board layout and totals', () => {
  assert.equal(SPACES.length, 40);
  const count = (t) => SPACES.filter((s) => s.type === t).length;
  assert.deepEqual([count('street'), count('station'), count('utility'), count('chance'), count('chest'), count('tax')], [22, 4, 2, 3, 3, 2]);
  assert.deepEqual(Object.values(GROUPS).map((g) => g.spaces.length), [2, 3, 3, 3, 3, 3, 3, 2]);
  assert.deepEqual([0, 10, 20, 30].map((i) => SPACES[i].type), ['go', 'jail', 'parking', 'gotojail']);
  for (const s of SPACES.filter((x) => x.type === 'street')) {
    assert.ok(s.rent.every((r, i) => i === 0 || r > s.rent[i - 1]));
    assert.equal(s.mortgage, s.price / 2);
  }
  assert.equal(CHANCE.length, 16);
  assert.equal(CHEST.length, 16);
});

test('setup and option validation', () => {
  const { g } = mk(4, { startCash: 2500, freeParking: 'pot', auction: 'off' });
  assert.equal(g.P.a.cash, 2500);
  assert.equal(g.opts.freeParking, 'pot');
  assert.equal(g.opts.auction, 'off');
  assert.equal(new Set(Object.values(g.P).map((p) => p.token)).size, 4);
  done(g);
  const { g: h } = mk(2, { startCash: 7, freeParking: 'x', timeLimit: 'zzz', turnTime: -1 });
  assert.equal(h.opts.startCash, 1500);
  assert.equal(h.opts.freeParking, 'none');
  assert.equal(h.opts.turnTime, 60);
  done(h);
});

test('movement, passing and landing on GO, turn ownership', () => {
  const { g, room } = mk();
  dice(g, [1, 2]);
  send(g, 'b', 'monopoly-roll');
  assert.equal(g.diceSeq, 0);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.pos, 3);
  send(g, 'a', 'monopoly-roll');
  assert.equal(lastErr(room), 'monopoly.err.notNow');
  done(g);
  for (const [from, d, pos] of [[37, [1, 3], 1], [36, [1, 3], 0]]) {
    const { g: h } = mk();
    h.P.a.pos = from;
    dice(h, d);
    send(h, 'a', 'monopoly-roll');
    assert.equal(h.P.a.pos, pos);
    assert.equal(h.P.a.cash, 1700);
    done(h);
  }
});

test('buy, decline without auction, cannot afford', () => {
  const { g } = mk(3, { auction: 'off' });
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.phase, 'buy');
  send(g, 'b', 'monopoly-buy');
  assert.equal(g.owner[3], null);
  send(g, 'a', 'monopoly-buy');
  assert.equal(g.owner[3], 'a');
  assert.equal(g.P.a.cash, 1440);
  send(g, 'a', 'monopoly-end-turn');
  assert.equal(g.turn, 'b');
  done(g);
  const { g: h } = mk(2, { auction: 'off' });
  dice(h, [3, 3]);
  send(h, 'a', 'monopoly-roll');
  send(h, 'a', 'monopoly-decline');
  assert.equal(h.owner[6], null);
  assert.equal(h.phase, 'roll');
  h.P.a.cash = 10;
  dice(h, [1, 2]);
  send(h, 'a', 'monopoly-roll');
  assert.equal(h.phase, 'end');
  done(h);
});

test('doubles roll again; three doubles go to jail', () => {
  const { g } = mk();
  dice(g, [1, 1], [2, 2], [3, 3]);
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-buy');
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 'a');
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-buy');
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.jail, true);
  assert.equal(g.P.a.pos, 10);
  assert.equal(g.phase, 'end');
  send(g, 'a', 'monopoly-end-turn');
  assert.equal(g.turn, 'b');
  done(g);
});

test('Go To Jail ends the turn even on doubles and pays no GO money', () => {
  const { g } = mk();
  g.P.a.pos = 24;
  dice(g, [3, 3]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.jail, true);
  assert.equal(g.phase, 'end');
  assert.equal(g.P.a.cash, 1500);
  done(g);
});

test('jail: pay, doubles, forced bail on the third failure, card', () => {
  const { g, room } = mk();
  const a = g.P.a;
  a.jail = true; a.pos = 10;
  send(g, 'a', 'monopoly-jail', { how: 'pay' });
  assert.equal(a.jail, false);
  assert.equal(a.cash, 1450);
  dice(g, [2, 3]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(a.pos, 15);
  done(g);

  const { g: h } = mk();
  const b = h.P.a;
  b.jail = true; b.pos = 10;
  dice(h, [1, 2], [2, 1], [4, 1]);
  send(h, 'a', 'monopoly-roll');
  assert.equal(b.jail, true);
  assert.equal(h.phase, 'end');
  fresh(h, 'a');
  send(h, 'a', 'monopoly-roll');
  assert.equal(b.jailTurns, 2);
  fresh(h, 'a');
  send(h, 'a', 'monopoly-roll');
  assert.equal(b.jail, false);
  assert.equal(b.cash, 1450);
  assert.equal(b.pos, 15);
  done(h);

  const { g: k } = mk();
  k.P.a.jail = true; k.P.a.pos = 10;
  dice(k, [4, 4]);
  send(k, 'a', 'monopoly-roll');
  assert.equal(k.P.a.jail, false);
  assert.equal(k.P.a.pos, 18);
  assert.notEqual(k.phase, 'roll');
  done(k);

  const { g: m, room: r } = mk();
  m.P.a.jail = true; m.P.a.pos = 10;
  send(m, 'a', 'monopoly-jail', { how: 'card' });
  assert.equal(lastErr(r), 'monopoly.err.noCard');
  send(m, 'a', 'monopoly-jail', { how: 'x' });
  m.P.a.cards = ['chance'];
  m.decks.chance.q = m.decks.chance.q.filter((n) => CHANCE[n].t !== 'free');
  send(m, 'a', 'monopoly-jail', { how: 'card' });
  assert.equal(m.P.a.jail, false);
  assert.equal(m.decks.chance.q.length, 16);
  m.P.a.jail = true; m.P.a.cash = 20;
  send(m, 'a', 'monopoly-jail', { how: 'pay' });
  assert.equal(lastErr(r), 'monopoly.err.cash');
  done(m);
  assert.ok(room);
});

test('street rent in every case', () => {
  for (const [setup, expected] of [
    [() => {}, 2],
    [(h) => own(h, 'b', 3), 4],
    [(h) => { own(h, 'b', 3); h.houses[1] = 1; }, 10],
    [(h) => { own(h, 'b', 3); h.houses[1] = 3; h.houses[3] = 3; }, 90],
    [(h) => { own(h, 'b', 3); h.houses[1] = 5; h.houses[3] = 5; }, 250],
    [(h) => { h.mortgaged[1] = true; }, 0]
  ]) {
    const { g: h } = mk();
    own(h, 'b', 1);
    setup(h);
    h.P.a.pos = 39;
    dice(h, [1, 1]);
    send(h, 'a', 'monopoly-roll');
    assert.equal(h.P.a.pos, 1);
    assert.equal(h.P.a.cash, 1700 - expected);
    assert.equal(h.P.b.cash, 1500 + expected);
    done(h);
  }
});

test('station and utility rent', () => {
  for (const [n, rent] of [[1, 25], [2, 50], [3, 100], [4, 200]]) {
    const { g } = mk();
    own(g, 'b', ...STATIONS.slice(0, n));
    g.P.a.pos = 3;
    dice(g, [1, 1]);
    send(g, 'a', 'monopoly-roll');
    assert.equal(g.P.a.cash, 1500 - rent);
    done(g);
  }
  for (const [list, mult] of [[[12], 4], [[12, 28], 10]]) {
    const { g } = mk();
    own(g, 'b', ...list);
    g.P.a.pos = 7;
    dice(g, [2, 3]);
    send(g, 'a', 'monopoly-roll');
    assert.equal(g.P.a.cash, 1500 - mult * 5);
    done(g);
  }
  const { g } = mk();
  own(g, 'a', 3);
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.cash, 1500);
  done(g);
});

test('tax and the free parking jackpot', () => {
  const { g } = mk(3, { freeParking: 'pot' });
  g.P.a.pos = 1;
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.cash, 1300);
  assert.equal(g.pot, 200);
  fresh(g, 'b');
  g.P.b.pos = 36;
  dice(g, [1, 1]);
  send(g, 'b', 'monopoly-roll');
  assert.equal(g.pot, 300);
  g.P.b.pos = 18;
  dice(g, [1, 1]);
  send(g, 'b', 'monopoly-roll');
  assert.equal(g.P.b.cash, 1700);
  assert.equal(g.pot, 0);
  done(g);
  const { g: h } = mk(3);
  h.P.a.pos = 1;
  dice(h, [1, 2]);
  send(h, 'a', 'monopoly-roll');
  assert.equal(h.pot, 0);
  assert.equal(h.P.a.cash, 1300);
  done(h);
});

test('all 32 cards', () => {
  const play = (deck, n, setup) => {
    const { g } = mk(3);
    g.decks[deck].q = [n, ...g.decks[deck].q.filter((x) => x !== n)];
    g.P.a.pos = deck === 'chance' ? 7 : 2;
    setup?.(g);
    g.rollDie = () => 2;
    g.t = { doubles: 0, extra: false, jailed: false, rolled: false };
    g.drawCard(g.P.a, deck);
    return g;
  };
  CHANCE.forEach((c, n) => {
    const g = play('chance', n, (h) => own(h, 'b', 11, 12, 24, 39));
    const a = g.P.a;
    switch (c.t) {
      case 'move': assert.equal(a.pos, c.to); if (c.to === 0) assert.equal(a.cash, 1700); break;
      case 'nearest': assert.ok((c.kind === 'station' ? STATIONS : UTILITIES).includes(a.pos)); break;
      case 'cash': assert.equal(a.cash, 1500 + c.a); break;
      case 'pay': assert.equal(a.cash, 1500 - c.a); break;
      case 'jail': assert.equal(a.jail, true); break;
      case 'free': assert.deepEqual(a.cards, ['chance']); break;
      case 'back': assert.equal(a.pos, 4); assert.equal(a.cash, 1300); break;
      case 'repairs': assert.equal(a.cash, 1500); break;
      case 'payEach': assert.equal(a.cash, 1400); assert.equal(g.P.b.cash, 1550); break;
      default: assert.fail('unknown');
    }
    done(g);
  });
  CHEST.forEach((c, n) => {
    const g = play('chest', n);
    const a = g.P.a;
    switch (c.t) {
      case 'move': assert.equal(a.pos, 0); assert.equal(a.cash, 1700); break;
      case 'cash': assert.equal(a.cash, 1500 + c.a); break;
      case 'pay': assert.equal(a.cash, 1500 - c.a); break;
      case 'jail': assert.equal(a.jail, true); break;
      case 'free': assert.deepEqual(a.cards, ['chest']); break;
      case 'collectEach': assert.equal(a.cash, 1520); assert.equal(g.P.b.cash, 1490); break;
      case 'repairs': assert.equal(a.cash, 1500); break;
      default: assert.fail('unknown');
    }
    done(g);
  });
});

test('card details: double station rent, utility 10x, repairs, deck cycling', () => {
  const top = (g, n) => { g.decks.chance.q = [n, ...g.decks.chance.q.filter((x) => x !== n)]; };
  const { g } = mk();
  own(g, 'b', 15);
  g.P.a.pos = 7;
  top(g, 5);
  g.drawCard(g.P.a, 'chance');
  assert.equal(g.P.a.cash, 1450);
  done(g);
  const { g: h } = mk();
  own(h, 'b', 28);
  h.P.a.pos = 22;
  top(h, 3);
  dice(h, [3, 4]);
  h.drawCard(h.P.a, 'chance');
  assert.equal(h.P.a.cash, 1430);
  done(h);
  const { g: k } = mk();
  own(k, 'a', 1, 3, 6);
  k.houses[1] = 2; k.houses[3] = 5;
  top(k, 10);
  k.drawCard(k.P.a, 'chance');
  assert.equal(k.P.a.cash, 1500 - 150);
  assert.equal(k.decks.chance.q.at(-1), 10);
  top(k, 7);
  k.drawCard(k.P.a, 'chance');
  assert.equal(k.decks.chance.q.length, 15);
  done(k);
});

test('pay-each card into debt, resign shares the cash', () => {
  const { g } = mk(3);
  g.P.a.cash = 60;
  g.decks.chance.q = [14, ...g.decks.chance.q.filter((x) => x !== 14)];
  g.drawCard(g.P.a, 'chance');
  assert.equal(g.phase, 'debt');
  send(g, 'a', 'monopoly-pay-debt');
  assert.equal(g.phase, 'debt');
  send(g, 'a', 'monopoly-resign');
  assert.equal(g.P.b.cash, 1530);
  assert.equal(g.P.c.cash, 1530);
  assert.equal(g.turn, 'b');
  done(g);
});

test('debt: mortgage to raise money, then pay', () => {
  const { g } = mk(2);
  own(g, 'b', 39);
  own(g, 'a', 1, 5);
  g.P.a.cash = 10;
  g.P.a.pos = 36;
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.phase, 'debt');
  send(g, 'a', 'monopoly-pay-debt');
  assert.equal(g.phase, 'debt');
  send(g, 'a', 'monopoly-mortgage', { idx: 5 });
  send(g, 'a', 'monopoly-pay-debt');
  assert.equal(g.phase, 'end');
  assert.equal(g.P.a.cash, 60);
  assert.equal(g.P.b.cash, 1550);
  done(g);
});

test('bankruptcy to a player', () => {
  const { g } = mk(3);
  own(g, 'b', 39, 37);
  g.houses[39] = 5;
  own(g, 'a', 1, 3, 5, 6);
  g.houses[1] = 1; g.houses[3] = 1;
  g.mortgaged[5] = true;
  g.P.a.cards = ['chest'];
  g.P.a.cash = 0;
  g.P.a.pos = 36;
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.debt.amount, 2000);
  send(g, 'a', 'monopoly-resign');
  assert.deepEqual([1, 3, 5, 6].map((i) => g.owner[i]), ['b', 'b', 'b', 'b']);
  assert.equal(g.mortgaged[5], true);
  assert.equal(g.houses[1], 0);
  assert.equal(g.P.b.cash, 1500 + 50 - 10);
  assert.deepEqual(g.P.b.cards, ['chest']);
  assert.equal(g.turn, 'b');
  done(g);
});

test('bankruptcy to the bank auctions the properties', () => {
  const { g } = mk(3);
  own(g, 'a', 1, 6);
  g.P.a.cash = 0;
  g.P.a.pos = 2;
  g.P.a.cards = ['chance'];
  g.decks.chance.q = g.decks.chance.q.filter((n) => CHANCE[n].t !== 'free');
  dice(g, [1, 1]);
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.phase, 'debt');
  send(g, 'a', 'monopoly-resign');
  assert.equal(g.phase, 'auction');
  assert.equal(g.auction.idx, 1);
  send(g, 'b', 'monopoly-bid', { amount: 30 });
  send(g, 'c', 'monopoly-auction-pass');
  assert.equal(g.owner[1], 'b');
  assert.equal(g.auction.idx, 6);
  send(g, 'b', 'monopoly-auction-pass');
  send(g, 'c', 'monopoly-auction-pass');
  assert.equal(g.owner[6], null);
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 'b');
  assert.equal(g.decks.chance.q.length, 16);
  done(g);
});

test('last player standing wins with ranked standings', () => {
  const { g, room } = mk(3);
  send(g, 'a', 'monopoly-resign');
  send(g, 'b', 'monopoly-resign');
  assert.equal(room.finished.title.k, 'monopoly.over.win');
  assert.equal(room.finished.title.p.name, 'C');
  assert.deepEqual(room.finished.rows.map((r) => [r.id, r.rank]), [['c', 1], ['b', 2], ['a', 3]]);
  send(g, 'c', 'monopoly-roll');
  done(g);
});

test('building rules', () => {
  const { g, room } = mk();
  own(g, 'a', 1);
  send(g, 'a', 'monopoly-build', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.needSet');
  own(g, 'a', 3);
  send(g, 'a', 'monopoly-build', { idx: 1 });
  assert.equal(g.P.a.cash, 1450);
  send(g, 'a', 'monopoly-build', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.even');
  for (let i = 0; i < 6; i++) { send(g, 'a', 'monopoly-build', { idx: 3 }); send(g, 'a', 'monopoly-build', { idx: 1 }); }
  assert.deepEqual([g.houses[1], g.houses[3]], [5, 5]);
  send(g, 'a', 'monopoly-build', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.maxBuilt');
  assert.equal(g.hotelsLeft(), 10);
  assert.equal(g.housesLeft(), 32);
  send(g, 'a', 'monopoly-build', { idx: 5 });
  assert.equal(lastErr(room), 'monopoly.why.notStreet');
  for (const idx of [99, '3', 1.5, undefined, null, {}]) send(g, 'a', 'monopoly-build', { idx });
  done(g);
});

test('building limits: cash, mortgaged set, house and hotel shortage', () => {
  const { g, room } = mk();
  own(g, 'a', 37, 39);
  g.P.a.cash = 100;
  send(g, 'a', 'monopoly-build', { idx: 37 });
  assert.equal(lastErr(room), 'monopoly.why.cash');
  g.P.a.cash = 5000;
  g.mortgaged[39] = true;
  send(g, 'a', 'monopoly-build', { idx: 37 });
  assert.equal(lastErr(room), 'monopoly.why.mortgagedInSet');
  g.mortgaged[39] = false;
  for (const i of [1, 3, 6, 8, 9, 11, 13, 14]) g.houses[i] = 4;
  assert.equal(g.housesLeft(), 0);
  send(g, 'a', 'monopoly-build', { idx: 37 });
  assert.equal(lastErr(room), 'monopoly.why.noHouses');
  g.houses.fill(0);
  [1, 3, 6, 8, 9, 11, 13, 14, 16, 18, 19, 21].forEach((i) => { g.houses[i] = 5; });
  assert.equal(g.hotelsLeft(), 0);
  g.houses[37] = 4; g.houses[39] = 4;
  send(g, 'a', 'monopoly-build', { idx: 37 });
  assert.equal(lastErr(room), 'monopoly.why.noHotels');
  done(g);
});

test('selling buildings: half price, even rule, hotel shortage', () => {
  const { g, room } = mk();
  own(g, 'a', 1, 3);
  g.houses[1] = 2; g.houses[3] = 1;
  send(g, 'a', 'monopoly-sell', { idx: 3 });
  assert.equal(lastErr(room), 'monopoly.why.evenSell');
  send(g, 'a', 'monopoly-sell', { idx: 1 });
  assert.equal(g.P.a.cash, 1525);
  g.houses[1] = 5; g.houses[3] = 5;
  send(g, 'a', 'monopoly-sell', { idx: 1 });
  assert.equal(g.houses[1], 4);
  g.houses.fill(0);
  g.houses[1] = 5; g.houses[3] = 5;
  for (const i of [6, 8, 9, 11, 13, 14, 16, 18, 19, 21]) g.houses[i] = 3;
  assert.equal(g.housesLeft(), 2);
  g.P.a.cash = 0;
  send(g, 'a', 'monopoly-sell', { idx: 1 });
  assert.equal(g.houses[1], 2);
  assert.equal(g.P.a.cash, 75);
  done(g);
});

test('mortgages', () => {
  const { g, room } = mk();
  own(g, 'a', 1, 3, 5, 12);
  g.houses[3] = 1;
  send(g, 'a', 'monopoly-mortgage', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.hasBuildings');
  send(g, 'a', 'monopoly-mortgage', { idx: 5 });
  assert.equal(g.P.a.cash, 1600);
  send(g, 'a', 'monopoly-mortgage', { idx: 5 });
  assert.equal(lastErr(room), 'monopoly.why.alreadyMortgaged');
  send(g, 'a', 'monopoly-unmortgage', { idx: 5 });
  assert.equal(g.P.a.cash, 1490);
  send(g, 'a', 'monopoly-unmortgage', { idx: 5 });
  assert.equal(lastErr(room), 'monopoly.why.notMortgaged');
  send(g, 'b', 'monopoly-mortgage', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.notOwner');
  send(g, 'a', 'monopoly-mortgage', { idx: 0 });
  assert.equal(lastErr(room), 'monopoly.why.notProperty');
  g.P.a.cash = 0;
  send(g, 'a', 'monopoly-mortgage', { idx: 12 });
  assert.equal(g.P.a.cash, 75);
  send(g, 'a', 'monopoly-unmortgage', { idx: 12 });
  assert.equal(lastErr(room), 'monopoly.why.cash');
  g.P.a.cash = 100;
  send(g, 'a', 'monopoly-unmortgage', { idx: 12 });
  assert.equal(g.P.a.cash, 17);
  done(g);
});

test('auctions', () => {
  const { g, room } = mk(3);
  dice(g, [3, 3]);
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-decline');
  assert.equal(g.phase, 'auction');
  send(g, 'b', 'monopoly-bid', { amount: 50 });
  send(g, 'c', 'monopoly-bid', { amount: 50 });
  assert.equal(lastErr(room), 'monopoly.err.bidLow');
  send(g, 'b', 'monopoly-bid', { amount: 60 });
  assert.equal(lastErr(room), 'monopoly.err.topBidder');
  send(g, 'c', 'monopoly-bid', { amount: 5000 });
  assert.equal(lastErr(room), 'monopoly.err.cash');
  for (const amount of [-5, 'x', 1.5, null]) send(g, 'c', 'monopoly-bid', { amount });
  send(g, 'c', 'monopoly-bid', { amount: 70 });
  send(g, 'b', 'monopoly-auction-pass');
  send(g, 'a', 'monopoly-auction-pass');
  assert.equal(g.owner[6], 'c');
  assert.equal(g.P.c.cash, 1430);
  assert.equal(g.turn, 'a');
  assert.equal(g.phase, 'roll');
  dice(g, [1, 1]);
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-decline');
  send(g, 'b', 'monopoly-bid', { amount: 10 });
  g.endAuction();
  assert.equal(g.owner[8], 'b');
  assert.equal(g.phase, 'roll');
  assert.ok(room);
  done(g);
});

test('auction: leaver loses their bid; timeout does not touch it; building is blocked', () => {
  const { g, room } = mk(3);
  dice(g, [3, 3]);
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-decline');
  send(g, 'c', 'monopoly-bid', { amount: 90 });
  send(g, 'b', 'monopoly-bid', { amount: 100 });
  g.onTurnTimeout();
  assert.equal(g.phase, 'auction');
  own(g, 'c', 1, 3);
  send(g, 'c', 'monopoly-build', { idx: 1 });
  assert.equal(lastErr(room), 'monopoly.why.auction');
  g.onPlayerLeft('b');
  assert.equal(g.auctionTop().id, 'c');
  send(g, 'a', 'monopoly-auction-pass');
  assert.equal(g.owner[6], 'c');
  done(g);
});

test('trades: execution, mortgage interest, rights', () => {
  const { g, room } = mk(3);
  own(g, 'a', 1, 5);
  own(g, 'b', 6);
  g.mortgaged[5] = true;
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { props: [1, 5], cash: 100 }, take: { props: [6] } });
  send(g, 'c', 'monopoly-trade', { to: 'a', give: { cash: 1 }, take: {} });
  assert.equal(lastErr(room), 'monopoly.err.tradeBusy');
  send(g, 'a', 'monopoly-trade-accept');
  assert.ok(g.trade);
  send(g, 'b', 'monopoly-trade-accept');
  assert.equal(g.trade, null);
  assert.deepEqual([1, 5, 6].map((i) => g.owner[i]), ['b', 'b', 'a']);
  assert.equal(g.P.a.cash, 1400);
  assert.equal(g.P.b.cash, 1590);
  assert.equal(g.mortgaged[5], true);
  done(g);
});

test('trades: hostile offers rejected', () => {
  const { g } = mk(3);
  own(g, 'a', 1, 3);
  g.houses[1] = 1;
  const bad = [
    { to: 'a', give: { cash: 1 }, take: {} }, { to: 'zzz', give: { cash: 1 }, take: {} },
    { to: 'b', give: { cash: -5 }, take: {} }, { to: 'b', give: { cash: 1.5 }, take: {} },
    { to: 'b', give: { cash: 99999 }, take: {} }, { to: 'b', give: { cash: 'abc' }, take: {} },
    { to: 'b', give: { props: [6] }, take: {} }, { to: 'b', give: { props: [1] }, take: {} },
    { to: 'b', give: { props: [3] }, take: {} }, { to: 'b', give: { props: [0] }, take: {} },
    { to: 'b', give: { props: [3, 3] }, take: {} }, { to: 'b', give: { props: 'x' }, take: {} },
    { to: 'b', give: { props: [-1] }, take: {} }, { to: 'b', give: { jail: 1 }, take: {} },
    { to: 'b', give: {}, take: {} }, { to: 'b', give: null, take: {} }, { to: 'b', give: { cash: 1 } },
    { to: { x: 1 }, give: { cash: 1 }, take: {} }, null, 5, 'str'
  ];
  for (const d of bad) {
    send(g, 'a', 'monopoly-trade', d);
    assert.equal(g.trade, null, JSON.stringify(d));
  }
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { cash: 10 }, take: {} });
  assert.ok(g.trade);
  done(g);
});

test('trades: decline, cancel, counter, revalidation, jail cards, expiry', () => {
  const { g } = mk(3);
  own(g, 'a', 1);
  g.P.b.cards = ['chest'];
  const offer = () => send(g, 'a', 'monopoly-trade', { to: 'b', give: { props: [1] }, take: { jail: 1 } });
  offer();
  send(g, 'b', 'monopoly-trade-decline');
  assert.equal(g.trade, null);
  offer();
  send(g, 'a', 'monopoly-trade-cancel');
  assert.equal(g.trade, null);
  offer();
  send(g, 'b', 'monopoly-trade-counter', { give: { jail: 1 }, take: { props: [1], cash: 50 } });
  assert.equal(g.trade.from, 'b');
  send(g, 'a', 'monopoly-trade-accept');
  assert.equal(g.owner[1], 'b');
  assert.deepEqual(g.P.a.cards, ['chest']);
  assert.equal(g.P.a.cash, 1450);
  own(g, 'a', 3);
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { props: [3] }, take: {} });
  g.owner[3] = 'c';
  send(g, 'b', 'monopoly-trade-accept');
  assert.equal(g.trade, null);
  assert.equal(g.owner[3], 'c');
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { cash: 5 }, take: {} });
  g.cancelTrade('monopoly.log.tradeExpired');
  assert.equal(g.trade, null);
  done(g);
});

test('trades: blocked in an auction, cancelled when a party leaves, interest needs cash', () => {
  const { g } = mk(3);
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { cash: 5 }, take: {} });
  g.onPlayerLeft('b');
  assert.equal(g.trade, null);
  send(g, 'a', 'monopoly-trade', { to: 'b', give: { cash: 5 }, take: {} });
  assert.equal(g.trade, null);
  done(g);
  const { g: h } = mk(2);
  own(h, 'a', 5);
  h.mortgaged[5] = true;
  h.P.b.cash = 5;
  send(h, 'a', 'monopoly-trade', { to: 'b', give: { props: [5] }, take: {} });
  assert.equal(h.trade, null);
  h.P.b.cash = 10;
  send(h, 'a', 'monopoly-trade', { to: 'b', give: { props: [5] }, take: {} });
  assert.ok(h.trade);
  done(h);
});

test('timeouts and auto play', () => {
  const { g } = mk(3);
  dice(g, [1, 2]);
  g.onTurnTimeout();
  g.onTurnTimeout();
  assert.equal(g.owner[3], 'a');
  g.P.a.timeouts = 2;
  g.onTurnTimeout();
  assert.equal(g.turn, 'b');
  assert.equal(g.P.a.auto, true);
  done(g);

  const { g: h } = mk(2);
  own(h, 'b', 39, 37);
  h.houses[39] = 2; h.houses[37] = 2;
  own(h, 'a', 1, 3, 5);
  h.P.a.cash = 0;
  h.P.a.pos = 36;
  dice(h, [1, 2]);
  send(h, 'a', 'monopoly-roll');
  h.onTurnTimeout();
  assert.equal(h.P.a.bankrupt, true);
  assert.equal(h.owner[1], 'b');
  done(h);

  const { g: k } = mk(2);
  own(k, 'b', 39);
  own(k, 'a', 1, 3, 5);
  k.P.a.cash = 0;
  k.P.a.pos = 36;
  dice(k, [1, 2]);
  send(k, 'a', 'monopoly-roll');
  k.onTurnTimeout();
  assert.equal(k.P.a.bankrupt, false);
  assert.equal(k.phase, 'end');
  done(k);

  const { g: m } = mk(3);
  m.P.a.timeouts = 2; m.P.a.auto = true;
  dice(m, [1, 2]);
  send(m, 'a', 'monopoly-roll');
  assert.equal(m.P.a.timeouts, 0);
  assert.equal(m.P.a.auto, false);
  done(m);
});

test('auto players pass auctions and decline trades', () => {
  const { g } = mk(3);
  g.P.b.auto = true; g.P.c.auto = true;
  dice(g, [3, 3]);
  send(g, 'a', 'monopoly-roll');
  send(g, 'a', 'monopoly-decline');
  assert.ok(g.auction.passed.has('b') && g.auction.passed.has('c'));
  send(g, 'a', 'monopoly-auction-pass');
  fresh(g, 'b');
  dice(g, [1, 2]);
  g.autoWork()();
  g.autoWork()();
  assert.equal(g.owner[3], 'b');
  g.autoWork()();
  assert.equal(g.turn, 'c');
  send(g, 'a', 'monopoly-trade', { to: 'c', give: { cash: 1 }, take: {} });
  g.autoWork()();
  assert.equal(g.trade, null);
  done(g);
});

test('leavers: bank bankruptcy, no stall in any phase', () => {
  const { g, room } = mk(3);
  own(g, 'a', 1, 3);
  g.onPlayerLeft('a');
  for (let i = 0; i < 20 && g.phase === 'auction'; i++) for (const id of ['b', 'c']) send(g, id, 'monopoly-auction-pass');
  assert.equal(g.turn, 'b');
  assert.equal(g.phase, 'roll');
  g.onPlayerLeft('c');
  assert.equal(room.finished.rows[0].id, 'b');
  assert.equal(room.finished.rows.find((r) => r.id === 'a').note.k, 'monopoly.note.left');
  g.onPlayerLeft('zzz');
  done(g);
  for (const setup of ['buy', 'debt', 'auction', 'roll']) {
    const { g: h } = mk(3);
    if (setup === 'buy') { dice(h, [1, 2]); send(h, 'a', 'monopoly-roll'); }
    if (setup === 'debt') { own(h, 'b', 3); h.P.a.cash = 0; h.P.a.pos = 1; dice(h, [1, 2]); send(h, 'a', 'monopoly-roll'); }
    if (setup === 'auction') { dice(h, [1, 2]); send(h, 'a', 'monopoly-roll'); send(h, 'a', 'monopoly-decline'); }
    h.onPlayerLeft('a');
    for (let i = 0; i < 20 && h.phase === 'auction'; i++) for (const id of ['b', 'c']) send(h, id, 'monopoly-auction-pass');
    assert.equal(h.turn, 'b', setup);
    assert.equal(h.phase, 'roll', setup);
    done(h);
  }
});

test('time limit ranking by net worth', () => {
  const { g, room } = mk(3, { timeLimit: 45 });
  own(g, 'b', 39, 37);
  g.houses[37] = 2;
  g.mortgaged[39] = true;
  assert.equal(g.netWorth(g.P.b), 1500 + 350 + 200 + 400);
  g.P.c.cash = 3000;
  g.onTimeUp();
  assert.equal(room.finished.rows[0].id, 'c');
  assert.equal(room.finished.subtitle.k, 'monopoly.over.time');
  done(g);
  const { g: h, room: r2 } = mk(2, { timeLimit: 45 });
  dice(h, [1, 2]);
  send(h, 'a', 'monopoly-roll');
  h.P.b.cash = 1600;
  h.onTimeUp();
  assert.equal(r2.finished, null);
  send(h, 'a', 'monopoly-buy');
  assert.equal(r2.finished.rows[0].id, 'b');
  done(h);
  const { g: k, room: r3 } = mk(2, { timeLimit: 45 });
  k.onTimeUp();
  assert.equal(r3.finished.title.k, 'monopoly.over.tie');
  assert.deepEqual(r3.finished.rows.map((r) => r.rank), [1, 1]);
  done(k);
  const { g: m } = mk(2, { timeLimit: 45 });
  m.running = false;
  m.begin();
  assert.ok(m.timers.game);
  m.cleanup();
  assert.equal(m.timers.game, null);
});

test('snapshots: public, spectator sync, manage reasons for the owner only', () => {
  const { g, room } = mk(3, {}, { spectators: ['host'] });
  own(g, 'a', 1, 3);
  g.push();
  const msgs = room.sent.filter((m) => m.type === 'monopoly-state');
  const mineA = msgs.find((m) => m.to === 'a');
  const mineB = msgs.find((m) => m.to === 'b');
  const spec = msgs.find((m) => m.to === 'host');
  assert.equal(mineA.manage[1].b, 0);
  assert.deepEqual(mineB.manage, {});
  assert.equal(spec.spectator, true);
  for (const k of ['players', 'own', 'hs', 'ms', 'phase', 'turn', 'log', 'pot']) assert.deepEqual(spec[k], mineB[k], k);
  assert.deepEqual(mineA.own.slice(0, 4), [-1, 0, -1, 0]);
  room.sent.length = 0;
  g.spectatorSync('host');
  assert.equal(room.sent[0].type, 'monopoly-board');
  assert.equal(room.sent[0].board.spaces.length, 40);
  send(g, 'b', 'monopoly-page-loaded');
  assert.ok(room.sent.some((m) => m.type === 'monopoly-board' && m.to === 'b'));
  dice(g, [1, 2]);
  send(g, 'a', 'monopoly-roll');
  const s = JSON.parse(JSON.stringify(g.stateFor('a')));
  assert.equal(s.phase, 'end');
  assert.equal(s.moves.at(-1).to, 3);
  done(g);
});

test('hostile input', () => {
  const { g } = mk(3);
  for (const t of ['monopoly-nope', 'x', 5, null, 'monopoly-build', 'monopoly-bid', 'monopoly-jail', 'monopoly-trade-counter', 'monopoly-trade']) {
    for (const p of [undefined, null, 5, 'str', [], { idx: {} }, { amount: [] }, { how: {} }]) {
      send(g, 'a', t, p);
      send(g, 'nobody', t, p);
    }
  }
  assert.equal(g.phase, 'roll');
  send(g, 'a', 'monopoly-resign');
  send(g, 'a', 'monopoly-roll');
  assert.equal(g.P.a.bankrupt, true);
  done(g);
});

test('dictionary covers every key the server emits, spaces and cards', () => {
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/monopoly.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/monopoly.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/'(monopoly\.[A-Za-z.]+)'/g)) {
    const k = m[1];
    if (k.endsWith('.')) continue;
    assert.ok(dict.en[k] && dict.tr[k], `missing ${k}`);
  }
  for (const deck of Object.keys(DECKS)) DECKS[deck].forEach((c, n) => assert.ok(dict.en[`monopoly.card.${deck}.${n}`]));
  SPACES.forEach((s, i) => assert.ok(dict.en[`monopoly.space.${i}`]));
});
