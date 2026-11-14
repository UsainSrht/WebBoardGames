import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monopoly } from '../src/games/monopoly.js';
import { SPACES, DECKS } from '../src/games/monopoly-data.js';

function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function room() {
  return { finished: null, errors: 0, broadcast() {}, send(ws, m) { if (m.type === 'error') this.errors++; }, getWsByUserId(id) { return { id }; }, spectatorIds() { return []; }, finishGame(p) { this.finished = p; } };
}

function invariants(g) {
  const hs = g.houses.reduce((n, h) => n + (h > 0 && h < 5 ? h : 0), 0);
  assert.ok(hs <= 32 && g.houses.filter((h) => h === 5).length <= 12, 'bank limits');
  for (const id of g.order) {
    const p = g.P[id];
    assert.ok(p.cash >= 0, `cash of ${id}: ${p.cash}`);
    if (p.bankrupt) assert.equal(g.ownedBy(id).length, 0);
  }
  for (let i = 0; i < 40; i++) {
    if (g.owner[i] !== null) assert.ok(SPACES[i].price && !g.P[g.owner[i]].bankrupt);
    else assert.ok(!g.mortgaged[i] && g.houses[i] === 0);
    if (g.houses[i] > 0) assert.equal(SPACES[i].type, 'street');
  }
  for (const [name, cards] of Object.entries(DECKS)) {
    const held = Object.values(g.P).reduce((n, p) => n + p.cards.filter((d) => d === name).length, 0);
    assert.equal(g.decks[name].q.length + held, cards.length, 'deck conservation');
  }
}

/** One random but legal action by a random participant. */
function step(g, rnd, canTrade) {
  const R = (n) => Math.floor(rnd() * n);
  const send = (id, type, d) => g.handleMessage(id, type, d);
  const live = g.active();
  const cur = g.turn;
  const p = g.P[cur];
  if (g.trade && rnd() < 0.7) {
    const id = g.trade.to;
    return rnd() < 0.5 ? send(id, 'monopoly-trade-accept') : rnd() < 0.5 ? send(id, 'monopoly-trade-decline') : send(id, 'monopoly-trade-counter', { give: { cash: R(100) }, take: { cash: R(100) } });
  }
  // everybody may build, mortgage, trade
  if (rnd() < 0.35 && g.phase !== 'auction') {
    const id = live[R(live.length)];
    const owned = g.ownedBy(id);
    const kind = R(5);
    if (kind === 0 && owned.length) send(id, 'monopoly-build', { idx: owned[R(owned.length)] });
    else if (kind === 1 && owned.length) send(id, 'monopoly-sell', { idx: owned[R(owned.length)] });
    else if (kind === 2 && owned.length) send(id, 'monopoly-mortgage', { idx: owned[R(owned.length)] });
    else if (kind === 3 && owned.length) send(id, 'monopoly-unmortgage', { idx: owned[R(owned.length)] });
    else if (canTrade && live.length > 1) {
      const to = live.filter((x) => x !== id)[R(live.length - 1)];
      const give = { cash: R(200), props: owned.filter(() => rnd() < 0.3) };
      const take = { cash: R(200), props: g.ownedBy(to).filter(() => rnd() < 0.3), jail: R(2) };
      send(id, 'monopoly-trade', { to, give, take });
    }
    return;
  }
  switch (g.phase) {
    case 'roll':
      if (p.jail && rnd() < 0.3) return send(cur, 'monopoly-jail', { how: rnd() < 0.5 ? 'pay' : 'card' });
      return send(cur, 'monopoly-roll');
    case 'buy':
      return send(cur, rnd() < 0.6 ? 'monopoly-buy' : 'monopoly-decline');
    case 'auction': {
      const id = g.auction.participants[R(g.auction.participants.length)];
      const top = g.auctionTop();
      if (rnd() < 0.5) return send(id, 'monopoly-bid', { amount: (top ? top.amount : 0) + 1 + R(150) });
      return send(id, 'monopoly-auction-pass');
    }
    case 'debt':
      if (p.cash >= g.debt.amount) return send(cur, 'monopoly-pay-debt');
      if (rnd() < 0.15) return send(cur, 'monopoly-resign');
      g.autoRaise(p, g.debt.amount);
      return p.cash >= g.debt.amount ? send(cur, 'monopoly-pay-debt') : send(cur, 'monopoly-resign');
    case 'end':
      return send(cur, 'monopoly-end-turn');
    default:
  }
}

for (const [seed, n, opts] of [
  [1, 2, { auction: 'on', freeParking: 'none' }], [2, 3, { auction: 'on', freeParking: 'pot' }], [3, 4, { auction: 'off' }],
  [4, 6, { startCash: 1000, freeParking: 'pot' }], [5, 5, { startCash: 2500 }], [6, 2, { startCash: 1000 }], [7, 3, {}], [8, 4, { auction: 'off', freeParking: 'pot' }]
]) {
  test(`simulated game ${seed} with ${n} bots finishes without stalls`, () => {
    const rnd = rngFrom(seed);
    const players = Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { name: `P${i}` }]));
    const r = room();
    const g = new Monopoly(r, players, { turnTime: 0, timeLimit: 0, ...opts }, { rng: rngFrom(seed * 99), autoMs: 1e9 });
    g.running = true;
    clearTimeout(g.timers.start);
    let steps = 0;
    try {
      while (!r.finished && steps < 60000) {
        step(g, rnd, true);
        // trades and lone players never block: expire any open trade now and then
        if (g.trade && rnd() < 0.2) g.cancelTrade();
        // after a while all remaining players resign gradually so that every game finishes
        if (steps > 9000 && steps % 40 === 0 && g.phase !== 'auction') g.handleMessage(g.turn, 'monopoly-resign');
        if (steps % 25 === 0) invariants(g);
        steps++;
      }
      invariants(g);
      assert.ok(r.finished, `game finished after ${steps} actions`);
      assert.equal(r.finished.rows.length, n);
      assert.equal(r.finished.rows[0].rank, 1);
      assert.equal(g.active().length <= 1, true);
    } finally {
      g.cleanup();
    }
  });
}

test('simulation with auto players only runs to the end through autoStep', () => {
  const players = { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } };
  const r = room();
  const g = new Monopoly(r, players, { turnTime: 0, timeLimit: 0 }, { rng: rngFrom(11), autoMs: 1e9 });
  g.running = true;
  clearTimeout(g.timers.start);
  for (const id of g.order) g.P[id].auto = true;
  let steps = 0;
  while (!r.finished && steps < 40000) {
    const job = g.autoWork();
    assert.ok(job, `something to do in phase ${g.phase}`);
    job();
    if (steps % 50 === 0) invariants(g);
    if (steps > 15000 && steps % 60 === 0) g.onTimeUp();
    steps++;
  }
  assert.ok(r.finished, 'auto game finished');
  g.cleanup();
});
