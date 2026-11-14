import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Uno, buildDeck, cardPoints } from '../src/games/uno.js';

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

const P3 = { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } };
const card = (id, color, value) => ({ id, color, value });

/** A running game with a known table: red 5 on top, A to move. */
function table(options = {}, players = P3) {
  const room = fakeRoom();
  const u = new Uno(room, players, options);
  u.running = true;
  u.turn = 'a';
  u.dir = 1;
  u.color = 'red';
  u.discard.push(card(900, 'red', '5'));
  u.pending = null;
  u.pendingDraw = 0;
  return { u, room };
}

test('deck and deal', () => {
  assert.equal(buildDeck().length, 108);
  const u = new Uno(fakeRoom(), P3, {});
  assert.equal(u.hands.a.length, 7);
  assert.equal(u.deck.length, 108 - 21 - 1);
  assert.match(u.top.value, /^\d$/);
  u.cleanup();
});

test('card points', () => {
  assert.equal(cardPoints(card(1, 'red', '7')), 7);
  assert.equal(cardPoints(card(1, 'red', 'skip')), 20);
  assert.equal(cardPoints(card(1, 'wild', 'wild4')), 50);
});

test('playing, turn order, skip and reverse', () => {
  const { u } = table();
  u.hands.a = [card(1, 'red', 'skip'), card(2, 'blue', '1'), card(3, 'red', 'reverse'), card(4, 'blue', '2')];
  u.play('b', 2, null); // not b's turn
  assert.equal(u.hands.a.length, 4);
  u.play('a', 2, null); // blue 1 on red 5: not playable
  assert.equal(u.hands.a.length, 4);
  u.play('a', 1, null); // skip
  assert.equal(u.turn, 'c', 'b is skipped');
  u.hands.c = [card(5, 'red', 'reverse'), card(6, 'blue', '9'), card(7, 'blue', '8')];
  u.play('c', 5, null);
  assert.equal(u.dir, -1);
  assert.equal(u.turn, 'b', 'direction reversed: c -> b');
  u.cleanup();
});

test('reverse acts like skip with two players', () => {
  const { u } = table({}, { a: { name: 'A' }, b: { name: 'B' } });
  u.hands.a = [card(1, 'red', 'reverse'), card(2, 'blue', '1')];
  u.play('a', 1, null);
  assert.equal(u.turn, 'a');
  u.cleanup();
});

test('+4 without stacking makes the next player draw and lose their turn', () => {
  const { u } = table();
  u.hands.a = [card(1, 'wild', 'wild4'), card(2, 'red', '1')];
  const before = u.hands.b.length;
  u.play('a', 1, 'green');
  assert.equal(u.hands.b.length, before + 4);
  assert.equal(u.color, 'green');
  assert.equal(u.turn, 'c');
  u.play('c', 1, 'red'); // not c's card
  u.cleanup();
});

test('wild needs a colour', () => {
  const { u } = table();
  u.hands.a = [card(1, 'wild', 'wild'), card(2, 'red', '1')];
  u.play('a', 1, null);
  assert.equal(u.hands.a.length, 2);
  u.play('a', 1, 'blue');
  assert.equal(u.color, 'blue');
  u.cleanup();
});

test('stacking: +2 can be answered with +2, otherwise the stack is drawn', () => {
  const { u } = table({ stacking: 'on' });
  u.hands.a = [card(1, 'red', 'draw2'), card(9, 'red', '2')];
  u.hands.b = [card(2, 'blue', 'draw2'), card(3, 'blue', '3')];
  u.hands.c = [card(4, 'green', '4'), card(5, 'green', '5')];
  u.play('a', 1, null);
  assert.equal(u.pendingDraw, 2);
  assert.equal(u.turn, 'b');
  assert.deepEqual(u.playableIds('b'), [2], 'only a +2 can answer');
  u.play('b', 3, null); // blue 3 is not allowed on a pending +2
  assert.equal(u.hands.b.length, 2);
  u.play('b', 2, null);
  assert.equal(u.pendingDraw, 4);
  assert.equal(u.turn, 'c');
  const before = u.hands.c.length;
  u.draw('c');
  assert.equal(u.hands.c.length, before + 4);
  assert.equal(u.pendingDraw, 0);
  assert.equal(u.turn, 'a');
  u.cleanup();
});

test('drawing: a playable drawn card may be played, otherwise the turn passes', () => {
  const { u } = table();
  u.hands.a = [card(1, 'blue', '1')];
  u.deck.push(card(50, 'blue', '7'), card(51, 'red', '9'));
  u.draw('a'); // draws red 9, playable
  assert.equal(u.pending, 51);
  assert.deepEqual(u.playableIds('a'), [51]);
  u.play('a', 1, null); // only the drawn card may be played
  assert.equal(u.hands.a.length, 2);
  u.pass('a');
  assert.equal(u.turn, 'b');

  u.hands.b = [card(2, 'blue', '2')];
  u.deck.push(card(60, 'blue', '9'));
  u.draw('b'); // blue 9 does not match red 5
  assert.equal(u.turn, 'c');
  u.cleanup();
});

test('UNO: playing to one card exposes you, calling is safe, anyone else can catch you', () => {
  const { u } = table({ unoCall: 'on' });
  u.hands.a = [card(1, 'red', '1'), card(2, 'red', '2')];
  u.play('a', 1, null);
  assert.equal(u.exposed.id, 'a');
  u.catchPlayer('a'); // cannot catch yourself
  assert.equal(u.hands.a.length, 1);
  u.catchPlayer('b');
  assert.equal(u.hands.a.length, 3, 'caught: draws two');
  assert.equal(u.exposed, null);

  const t2 = table({ unoCall: 'on' });
  t2.u.hands.a = [card(1, 'red', '1'), card(2, 'red', '2')];
  t2.u.play('a', 1, null);
  t2.u.call('a');
  t2.u.catchPlayer('b');
  assert.equal(t2.u.hands.a.length, 1, 'called in time: safe');

  const t3 = table({ unoCall: 'on' });
  t3.u.hands.a = [card(1, 'red', '1'), card(2, 'red', '2')];
  t3.u.call('a'); // pressing early on your turn also counts
  t3.u.play('a', 1, null);
  assert.equal(t3.u.exposed, null);

  const t4 = table({ unoCall: 'on' });
  t4.u.hands.a = [card(1, 'red', '1'), card(2, 'red', '2')];
  t4.u.play('a', 1, null);
  t4.u.hands.b = [card(7, 'red', '3'), card(8, 'red', '4')];
  t4.u.play('b', 7, null); // next player acts: the window closes
  t4.u.catchPlayer('c');
  assert.equal(t4.u.hands.a.length, 1);
  [u, t2.u, t3.u, t4.u].forEach(g => g.cleanup());
});

test('UNO call can be turned off', () => {
  const { u } = table({ unoCall: 'off' });
  u.hands.a = [card(1, 'red', '1'), card(2, 'red', '2')];
  u.play('a', 1, null);
  assert.equal(u.exposed, null);
  u.cleanup();
});

test('single round ends the game and ranks by cards left', () => {
  const { u, room } = table({ target: 0 });
  u.hands.a = [card(1, 'red', '1')];
  u.hands.b = [card(2, 'blue', '9')];
  u.hands.c = [card(3, 'wild', 'wild4'), card(4, 'blue', '2')];
  u.play('a', 1, null);
  assert.equal(u.phase, 'over');
  assert.equal(room.finished.rows[0].id, 'a');
  assert.deepEqual(room.finished.rows.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(u.scores.a, 9 + 50 + 2);
  u.cleanup();
});

test('multi-round: points accumulate and the next round is dealt', () => {
  const { u, room } = table({ target: 100 });
  u.hands.a = [card(1, 'red', '1')];
  u.hands.b = [card(2, 'blue', 'skip')];
  u.hands.c = [card(3, 'wild', 'wild')];
  u.play('a', 1, null);
  assert.equal(u.phase, 'roundOver');
  assert.equal(u.scores.a, 70);
  assert.equal(room.finished, null);
  assert.equal(u.roundResult.points, 70);
  u.dealRound();
  assert.equal(u.round, 2);
  assert.equal(u.phase, 'play');
  assert.equal(u.hands.a.length, 7);
  assert.equal(u.turn, 'b', 'dealer rotates');

  u.scores.a = 95;
  u.hands.a = [card(11, 'red', '1')];
  u.hands.b = [card(12, 'blue', '9')];
  u.hands.c = [card(13, 'blue', '1')];
  u.turn = 'a';
  u.color = 'red';
  u.play('a', 11, null);
  assert.equal(u.phase, 'over', 'reached the target');
  assert.equal(room.finished.rows[0].id, 'a');
  u.cleanup();
});

test('spectator (host view) never gets a hand, players only get their own', () => {
  const room = fakeRoom(['host']);
  const u = new Uno(room, P3, {});
  u.running = true;
  u.broadcastState();
  const forHost = room.sent.find(m => m.to === 'host');
  assert.deepEqual(forHost.hand, []);
  assert.equal(forHost.spectator, true);
  const forA = room.sent.find(m => m.to === 'a' && m.type === 'uno-state');
  assert.equal(forA.hand.length, 7);
  assert.ok(!JSON.stringify(forHost).includes('"hand":[{'));
  u.cleanup();
});

test('a player leaving passes the turn and hands their cards back', () => {
  const { u } = table();
  const deckBefore = u.deck.length;
  const handSize = u.hands.a.length;
  u.onPlayerLeft('a');
  assert.equal(u.order.length, 2);
  assert.equal(u.deck.length, deckBefore + handSize);
  assert.equal(u.turn, 'b');
  u.onPlayerLeft('b');
  assert.equal(u.phase, 'over');
  u.cleanup();
});

test('turn timer: out of time draws a card and passes', () => {
  const { u } = table({ turnTime: 20 });
  const before = u.hands.a.length;
  u.onTimeout('a');
  assert.equal(u.hands.a.length, before + 1);
  assert.equal(u.turn, 'b');
  assert.equal(u.turnMs, 20000);
  u.cleanup();
});

test('log lines, errors and results are translatable message objects', async () => {
  const { assertKeysExist, assertOptionKeys, assertMsg } = await import('./helpers/i18n-keys.mjs');
  assertKeysExist('uno', ['src/games/uno.js', 'public_html/games/uno.js', 'public_html/games/uno.html']);
  assertOptionKeys('uno');

  const { u, room } = table({ stacking: 'on' });
  u.hands.a = [card(1, 'red', 'draw2'), card(2, 'wild', 'wild4'), card(3, 'blue', '2')];
  u.play('a', 1, null);
  assert.deepEqual(u.log[0], { k: 'uno.log.played', p: { name: 'A', card: { k: 'uno.card.draw2', p: { color: { k: 'uno.color.red' } } } } });
  assert.equal(u.log[1].k, 'uno.log.mustStack');
  assert.equal(u.log[1].p.n, 2);
  for (const m of u.log) assertMsg('uno', m);

  u.hands.b = [card(10, 'blue', '9'), card(11, 'blue', '8')];
  u.play('b', 10, null);
  assertMsg('uno', room.sent.filter(m => m.type === 'error').at(-1).message, 'uno.err.stack');
  assert.equal(room.sent.filter(m => m.type === 'error').at(-1).message.p.type, '+2');

  // a wild card names the colour that was chosen
  const w = table();
  w.u.hands.a = [card(2, 'wild', 'wild4'), card(3, 'blue', '2')];
  w.u.play('a', 2, 'blue');
  assert.deepEqual(w.u.log[0].p.card, { k: 'uno.card.wild4', p: { color: { k: 'uno.color.blue' } } });
  w.u.play('b', 99, null);
  w.u.turn = 'b'; w.u.hands.b = [card(20, 'wild', 'wild')];
  w.u.play('b', 20, 'purple');
  assertMsg('uno', w.room.sent.filter(m => m.type === 'error').at(-1).message, 'uno.err.chooseColor');

  // finishing: notes carry the cards left and the points
  const f = table();
  f.u.hands.a = [card(1, 'red', '7')];
  f.u.hands.b = [card(2, 'blue', '9'), card(3, 'wild', 'wild')];
  f.u.play('a', 1, null);
  const fin = f.room.finished;
  assertMsg('uno', fin.title, 'uno.title.wins');
  assertMsg('uno', fin.subtitle, 'uno.sub.round');
  assert.equal(fin.rows[0].note.k, 'uno.note.last');
  const loser = fin.rows.find(r => r.id === 'b');
  assertMsg('uno', loser.note, 'uno.note.left');
  assert.deepEqual(loser.note.p, { n: 2, points: 59 });
  for (const x of [u, w.u, f.u]) x.cleanup();
});
