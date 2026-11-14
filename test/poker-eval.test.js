import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareHands, parseCards, handMessage, buildPots, makeDeck, shuffle } from '../src/games/poker-eval.js';

const ev = (text) => evaluate(parseCards(text));
const cmp = (a, b) => Math.sign(compareHands(ev(a), ev(b)));

test('deck has 52 unique cards and shuffles with an injected rng', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => c.r + c.s)).size, 52);
  const a = shuffle(makeDeck(), () => 0.3).map((c) => c.r + c.s).join();
  const b = shuffle(makeDeck(), () => 0.3).map((c) => c.r + c.s).join();
  assert.equal(a, b);
});

test('every category is recognised', () => {
  const cases = [
    ['As Kd 9h 7c 4s 3d 2c', 'highCard', 0],
    ['As Ad 9h 7c 4s 3d 2c', 'pair', 1],
    ['As Ad 9h 9c 4s 3d 2c', 'twoPair', 2],
    ['As Ad Ah 9c 4s 3d 2c', 'trips', 3],
    ['9s 8d 7h 6c 5s Kd 2c', 'straight', 4],
    ['As 9s 7s 4s 2s Kd Kc', 'flush', 5],
    ['As Ad Ah 9c 9s 3d 2c', 'fullHouse', 6],
    ['As Ad Ah Ac 9s 3d 2c', 'quads', 7],
    ['9s 8s 7s 6s 5s Kd 2c', 'straightFlush', 8],
    ['As Ks Qs Js Ts 2d 2c', 'royalFlush', 9]
  ];
  for (const [text, key, category] of cases) {
    const r = ev(text);
    assert.equal(r.key, key, text);
    assert.equal(r.category, category, text);
  }
});

test('categories rank in order', () => {
  const order = ['As Kd 9h 7c 4s 3d 2c', 'As Ad 9h 7c 4s 3d 2c', 'As Ad 9h 9c 4s 3d 2c', 'As Ad Ah 9c 4s 3d 2c', '9s 8d 7h 6c 5s Kd 2c',
    'As 9s 7s 4s 2s Kd Kc', 'As Ad Ah 9c 9s 3d 2c', 'As Ad Ah Ac 9s 3d 2c', '9s 8s 7s 6s 5s Kd 2c', 'As Ks Qs Js Ts 2d 2c'];
  for (let i = 1; i < order.length; i++) assert.equal(cmp(order[i], order[i - 1]), 1, `${i}`);
});

test('kickers decide pairs, trips, quads and high cards', () => {
  assert.equal(cmp('As Ad Kh 7c 4s 3d 2c', 'Ac Ah Qh 7d 4d 3c 2h'), 1);
  assert.equal(cmp('As Ad Kh Qc 4s 3d 2c', 'Ac Ah Kd Jc 4d 3c 2h'), 1);
  assert.equal(cmp('As Ad Kh Qc Js 3d 2c', 'Ac Ah Kd Qh Ts 3c 2h'), 1);
  assert.equal(cmp('Ks Kd Ah 7c 4s 3d 2c', 'Kc Kh Qd 7d 4d 3c 2h'), 1);
  assert.equal(cmp('As Ad Ah Kc 4s 3d 2c', 'Ac Ad Ah Qc 4s 3d 2d'), 1);
  assert.equal(cmp('Ks Kd Kh Kc As 3d 2c', 'Ks Kd Kh Kc Qs 3d 2c'), 1);
  assert.equal(cmp('As Kd Qh Jc 9s 3d 2c', 'Ac Kh Qd Jh 8s 3c 2h'), 1);
  assert.equal(cmp('As Kd Qh Jc 9s 3d 2c', 'Ac Kh Qd Jh 9d 3c 2h'), 0);
});

test('two pair uses the best two of three pairs and the best kicker', () => {
  const r = ev('Ks Kd 9h 9c 4s 4d Qc');
  assert.equal(r.key, 'twoPair');
  assert.deepEqual(r.ranks, [13, 9]);
  assert.equal(r.best.length, 5);
  assert.equal(r.best[4].r, 12, 'the queen is the kicker, not the third pair');
  assert.equal(ev('Ks Kd 9h 9c 4s 4d 2c').best[4].r, 4, 'a third pair supplies the kicker when it is higher');
});

test('full house: two trips and trips plus pair', () => {
  const r = ev('Ks Kd Kh 9c 9s 9d 2c');
  assert.equal(r.key, 'fullHouse');
  assert.deepEqual(r.ranks, [13, 9]);
  assert.equal(cmp('Ks Kd Kh 2c 2s 3d 4c', 'Qs Qd Qh Ac As 3d 4c'), 1);
  assert.equal(cmp('Ks Kd Kh 2c 2s 3d 4c', 'Ks Kd Kh 3c 3s 3d 4c'), -1);
});

test('wheel straight is the lowest straight, ace-high is the highest', () => {
  const wheel = ev('As 2d 3h 4c 5s 9d Kc');
  assert.equal(wheel.key, 'straight');
  assert.deepEqual(wheel.ranks, [5]);
  assert.deepEqual(wheel.best.map((c) => c.r), [5, 4, 3, 2, 14]);
  assert.equal(cmp('2s 3d 4h 5c 6s 9d Kc', 'As 2d 3h 4c 5s 9d Kc'), 1);
  assert.equal(cmp('As Kd Qh Jc Ts 9d 2c', 'Ks Qd Jh Tc 9s 8d 2c'), 1);
  assert.deepEqual(ev('2s 3d 4h 5c 6s 7d Kc').ranks, [7], 'six in a row: the highest five count');
  assert.equal(ev('Qs Kd Ah 2c 3s 9d 7c').key, 'highCard', 'no wrap-around straights');
});

test('steel wheel and royal flush', () => {
  const sw = ev('As 2s 3s 4s 5s Kd Kc');
  assert.equal(sw.key, 'straightFlush');
  assert.deepEqual(sw.ranks, [5]);
  assert.equal(ev('As Ks Qs Js Ts').key, 'royalFlush');
  assert.equal(cmp('As Ks Qs Js Ts 2d 3d', '9h 8h 7h 6h 5h Ah Ad'), 1);
  assert.equal(cmp('6s 5s 4s 3s 2s Ad Ac', 'As 2s 3s 4s 5s Kd Kc'), 1);
});

test('a flush beats a straight even when both are present, a straight flush needs one suit', () => {
  assert.equal(ev('9s 8s 7s 6s 2s 5d Kc').key, 'flush');
  assert.equal(ev('9s 8s 7s 6s 5d 4h Kc').key, 'straight');
  assert.equal(ev('9s 8s 7s 6s 5s 5d Kc').key, 'straightFlush');
});

test('flush compares card by card and picks the five highest of six suited cards', () => {
  assert.equal(cmp('As Ks 9s 7s 4s 2s Kd', 'Ah Kh 9h 7h 3h 2c Kc'), 1);
  const r = ev('As Ks 9s 7s 4s 2s Kd');
  assert.deepEqual(r.best.map((c) => c.r), [14, 13, 9, 7, 4]);
});

test('board plays: identical best five is a tie', () => {
  const board = 'As Ks Qs Js Ts';
  assert.equal(compareHands(evaluate(parseCards(`${board} 2d 3d`)), evaluate(parseCards(`${board} 4h 5h`))), 0);
  assert.equal(cmp('2s 2d 9h 9c Ks Qd Jc', '3s 3d 9h 9c Ks Qd Jc'), -1, 'the higher pocket pair makes two pair with the board');
  assert.equal(cmp('2s 4d 9h 9c Ks Qd Jc', '3s 5d 9h 9c Ks Qd Jc'), 0, 'pair on the board plays for both');
});

test('compareHands accepts cards, results and scores', () => {
  const a = parseCards('As Ad 9h 7c 4s 3d 2c');
  const b = parseCards('Ks Kd 9h 7c 4s 3d 2c');
  assert.ok(compareHands(a, b) > 0);
  assert.ok(compareHands(evaluate(b), evaluate(a)) < 0);
  assert.equal(compareHands(evaluate(a).score, evaluate(a).score), 0);
});

test('fewer than five cards still evaluate (preflop helper)', () => {
  assert.equal(evaluate(parseCards('As Ad')).key, 'pair');
  assert.equal(evaluate(parseCards('As Kd')).key, 'highCard');
  assert.equal(evaluate(parseCards('As Kd Qh')).ranks[0], 14);
});

test('best five cards are returned and exclude the unused cards', () => {
  const r = ev('As Ad Ah Ac 9s 3d 2c');
  assert.equal(r.best.length, 5);
  assert.equal(r.best.filter((c) => c.r === 14).length, 4);
  assert.equal(r.best[4].r, 9);
  assert.deepEqual(ev('As Ad Ah 9c 8s 3d 2c').best.map((c) => c.r), [14, 14, 14, 9, 8]);
});

test('random 7 card hands: best five reproduces the score and no card removal helps', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 300; i++) {
    const cards = shuffle(makeDeck(), rng).slice(0, 7);
    const r = evaluate(cards);
    assert.equal(r.best.length, 5);
    assert.equal(evaluate(r.best).score, r.score);
    for (let k = 0; k < 7; k++) assert.ok(evaluate(cards.filter((_, j) => j !== k)).score <= r.score);
  }
});

test('hand names are built from keys with nested rank messages', () => {
  assert.deepEqual(handMessage(ev('Ks Kd Kh 9c 9s 3d 2c')), { k: 'poker.hand.fullHouse', p: { a: { k: 'poker.rankp.13' }, b: { k: 'poker.rankp.9' } } });
  assert.deepEqual(handMessage(ev('As Ks Qs Js Ts')), { k: 'poker.hand.royalFlush' });
  assert.deepEqual(handMessage(ev('As 2d 3h 4c 5s')), { k: 'poker.hand.straight', p: { a: { k: 'poker.rank.5' } } });
  assert.equal(handMessage(ev('As Kd 9h 7c 4s 3d 2c')).k, 'poker.hand.highCard');
});

test('side pots follow the all-in levels', () => {
  const pots = buildPots([
    { id: 'a', total: 100, folded: false }, { id: 'b', total: 300, folded: false },
    { id: 'c', total: 300, folded: false }, { id: 'd', total: 50, folded: true }
  ]);
  assert.deepEqual(pots, [{ amount: 350, eligible: ['a', 'b', 'c'] }, { amount: 400, eligible: ['b', 'c'] }]);
  const merged = buildPots([{ id: 'a', total: 200, folded: false }, { id: 'b', total: 200, folded: false }, { id: 'c', total: 80, folded: true }]);
  assert.deepEqual(merged, [{ amount: 480, eligible: ['a', 'b'] }]);
});
