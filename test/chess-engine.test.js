import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, parseFen, perft, legalMoves, applyMove, inCheck, squareIndex } from '../src/games/chess-engine.js';

test('perft from the start position', () => {
  const s = initialState();
  assert.equal(perft(s, 1), 20);
  assert.equal(perft(s, 2), 400);
  assert.equal(perft(s, 3), 8902);
});

test('perft "kiwipete" (castling, en passant, promotions, pins)', () => {
  const s = parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(s, 1), 48);
  assert.equal(perft(s, 2), 2039);
  assert.equal(perft(s, 3), 97862);
});

test('perft endgame position with en passant pins', () => {
  const s = parseFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.equal(perft(s, 3), 2812);
  assert.equal(perft(s, 4), 43238);
});

test("fool's mate is checkmate", () => {
  let s = initialState();
  for (const [f, t] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    const m = legalMoves(s).find(x => x.from === squareIndex(f) && x.to === squareIndex(t));
    assert.ok(m, `${f}${t} legal`);
    s = applyMove(s, m);
  }
  assert.ok(inCheck(s));
  assert.equal(legalMoves(s).length, 0);
});
