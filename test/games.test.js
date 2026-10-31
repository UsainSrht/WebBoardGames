import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kingdomino } from '../src/games/kingdomino.js';
import { RockPaperScissors } from '../src/games/rock-paper-scissors.js';

const fakeRoom = () => ({
  sent: [],
  broadcast(m) { this.sent.push(m); },
  send(ws, m) { this.sent.push(m); },
  getWsByUserId() { return null; },
  endGame() {}
});

test('rock-paper-scissors scoring', () => {
  const g = new RockPaperScissors(fakeRoom(), { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } });
  g.playerGameData.a.move = 'rock';
  g.playerGameData.b.move = 'scissors';
  g.playerGameData.c.move = 'rock';
  g.processMoves();
  assert.equal(g.playerGameData.a.score, 1);
  assert.equal(g.playerGameData.b.score, -2);
  assert.equal(g.playerGameData.c.score, 1);
});

test('kingdomino placement rules', () => {
  const k = new Kingdomino(fakeRoom(), { a: { name: 'A' } });
  const grid = k.createGrid();
  assert.ok(k.placementCells(grid, 2, 3, 0), 'adjacent to castle, right');
  assert.equal(k.placementCells(grid, 2, 2, 0), null, 'castle cell occupied');
  assert.equal(k.placementCells(grid, 0, 0, 0), null, 'not touching anything');
  assert.equal(k.placementCells(grid, 2, 4, 0), null, 'second half off-grid');
  assert.deepEqual(k.placementCells(grid, 2, 1, 180), [{ r: 2, c: 1 }, { r: 2, c: 0 }]);
  assert.equal(k.placementCells(grid, 2, 3, 45), null, 'bad rotation');
});

test('kingdomino scoring = property size x crowns', () => {
  const k = new Kingdomino(fakeRoom(), { a: { name: 'A' } });
  const grid = k.createGrid();
  const cell = (type, crown) => ({ type, crown, tile: 1 });
  grid[2][3] = cell('farm', 1);
  grid[2][4] = cell('farm', 0);
  grid[1][3] = cell('farm', 2); // farm property: 3 cells, 3 crowns => 9
  grid[3][2] = cell('water', 0); // no crowns => 0
  grid[3][3] = cell('forest', 1); // single cell, 1 crown => 1
  k.grids.a = grid;
  assert.equal(k.calculateScore('a'), 10);
});

test('kingdomino full flow with timeouts discards nothing illegal', () => {
  const room = fakeRoom();
  const k = new Kingdomino(room, { a: { name: 'A' }, b: { name: 'B' } });
  k.startGame();
  assert.equal(k.drawn.length, 2);
  const [first, second] = k.drawn;
  k.handleMessage('a', 'kingdomino-select-tile', { tileNumber: second });
  k.handleMessage('b', 'kingdomino-select-tile', { tileNumber: second }); // already taken
  assert.equal(k.playerGameData.b.selectedTile, 0);
  k.handleMessage('b', 'kingdomino-select-tile', { tileNumber: first });
  assert.equal(k.isTileSelecting, false);
  assert.equal(k.playerGameData.b.turnIndex, 1, 'lower tile number plays first');
  k.cleanup();
});

import { Uno, buildDeck } from '../src/games/uno.js';
import { Dice } from '../src/games/dice.js';
import { Chess } from '../src/games/chess.js';

test('uno deck has 108 cards and a deal works', () => {
  assert.equal(buildDeck().length, 108);
  const u = new Uno(fakeRoom(), { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } });
  assert.equal(u.hands.a.length, 7);
  assert.equal(u.deck.length, 108 - 21 - 1);
  assert.match(u.top.value, /^\d$/);
  u.cleanup();
});

test('uno play, skip and draw rules', () => {
  const u = new Uno(fakeRoom(), { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } });
  u.running = true;
  u.color = 'red';
  u.discard.push({ id: 900, color: 'red', value: '5' });
  u.hands.a = [{ id: 901, color: 'red', value: 'skip' }, { id: 902, color: 'blue', value: '1' }];
  u.play('b', 902, null); // not b's turn
  assert.equal(u.hands.a.length, 2);
  u.play('a', 902, null); // unplayable
  assert.equal(u.hands.a.length, 2);
  u.play('a', 901, null);
  assert.equal(u.turn, 'c', 'b is skipped');
  u.hands.c = [{ id: 903, color: 'wild', value: 'wild4' }, { id: 904, color: 'red', value: '1' }];
  const before = u.hands.a.length;
  u.play('c', 903, 'green');
  assert.equal(u.hands.a.length, before + 4, 'next player (a) draws 4');
  assert.equal(u.color, 'green');
  assert.equal(u.turn, 'b');
  u.cleanup();
});

test('uno win when hand is empty', () => {
  const u = new Uno(fakeRoom(), { a: { name: 'A' }, b: { name: 'B' } });
  u.running = true;
  u.color = 'red';
  u.hands.a = [{ id: 950, color: 'red', value: '3' }];
  u.play('a', 950, null);
  assert.equal(u.winner, 'a');
  u.cleanup();
});

test('dice: all rolls resolve a round and award points', () => {
  const d = new Dice(fakeRoom(), { a: { name: 'A' }, b: { name: 'B' } });
  d.startRound();
  d.handleMessage('a', 'dice-roll');
  d.handleMessage('a', 'dice-roll'); // second roll ignored
  d.handleMessage('b', 'dice-roll');
  assert.equal(d.phase, 'reveal');
  assert.ok(d.roundWinners.length >= 1);
  const total = Object.values(d.data).reduce((s, p) => s + p.score, 0);
  assert.equal(total, d.roundWinners.length);
  d.cleanup();
});

test('chess: move validation, turn order and resignation', () => {
  const room = fakeRoom();
  const c = new Chess(room, { a: { name: 'A' }, b: { name: 'B' } });
  const [w, b] = [c.white, c.black];
  c.handleMessage(b, 'chess-move', { from: 'e7', to: 'e5' }); // black can't start
  assert.equal(c.history.length, 0);
  c.handleMessage(w, 'chess-move', { from: 'e2', to: 'e5' }); // illegal
  assert.equal(c.history.length, 0);
  c.handleMessage(w, 'chess-move', { from: 'e2', to: 'e4' });
  c.handleMessage(b, 'chess-move', { from: 'e7', to: 'e5' });
  assert.equal(c.history.length, 2);
  c.handleMessage(w, 'chess-resign');
  assert.equal(c.result.winner, b);
  c.cleanup();
});
