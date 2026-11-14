import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseClock, REASON_KEYS } from '../src/games/chess.js';
import { parseFen, legalMoves, toSan, squareIndex } from '../src/games/chess-engine.js';

function fakeRoom() {
  return {
    sent: [],
    finished: null,
    broadcast(m) { this.sent.push(m); },
    send(ws, m) { this.sent.push(m); },
    getWsByUserId() { return {}; },
    spectatorIds() { return []; },
    finishGame(p) { this.finished = p; }
  };
}

const PLAYERS = { a: { name: 'Ann' }, b: { name: 'Ben' } };
const sanOf = (fen, from, to, promo) => {
  const s = parseFen(fen);
  const legal = legalMoves(s);
  const m = legal.find(x => x.from === squareIndex(from) && x.to === squareIndex(to) && (!promo || x.promo === promo));
  assert.ok(m, `${from}${to} legal in ${fen}`);
  return toSan(s, m, legal);
};

test('san: disambiguation, castling, captures, promotion, check and mate', () => {
  assert.equal(sanOf('4k3/8/8/8/8/8/4K3/R6R w - - 0 1', 'a1', 'd1'), 'Rad1');
  assert.equal(sanOf('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'a1', 'd1'), 'Rd1');
  assert.equal(sanOf('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1', 'g1'), 'O-O');
  assert.equal(sanOf('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1', 'c1'), 'O-O-O');
  assert.equal(sanOf('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'e4', 'd5'), 'exd5');
  assert.equal(sanOf('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'e5', 'f6'), 'exf6');
  assert.equal(sanOf('7k/P7/8/8/8/8/8/K7 w - - 0 1', 'a7', 'a8', 'q'), 'a8=Q+');
  assert.equal(sanOf('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'a1', 'a8'), 'Ra8#');
  // two knights that can reach the same square on the same file need the rank
  assert.equal(sanOf('4k3/8/8/1N6/8/8/8/1N2K3 w - - 0 1', 'b1', 'c3'), 'N1c3');
});

test('clock option parsing', () => {
  assert.deepEqual(parseClock('10+0'), { base: 600000, inc: 0 });
  assert.deepEqual(parseClock('15+10'), { base: 900000, inc: 10000 });
  assert.equal(parseClock('none'), null);
});

test('moves, notation list and turn order', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: 'none' });
  const [w, b] = [c.white, c.black];
  c.handleMessage(b, 'chess-move', { from: 'e7', to: 'e5' }); // black cannot start
  assert.equal(c.history.length, 0);
  c.handleMessage(w, 'chess-move', { from: 'e2', to: 'e5' }); // illegal
  assert.equal(c.history.length, 0);
  c.handleMessage(w, 'chess-move', { from: 'e2', to: 'e4' });
  c.handleMessage(b, 'chess-move', { from: 'e7', to: 'e5' });
  c.handleMessage(w, 'chess-move', { from: 'g1', to: 'f3' });
  assert.deepEqual(c.snapshot().moves, ['e4', 'e5', 'Nf3']);
  assert.equal(c.snapshot().clock, null);
  c.cleanup();
});

test('clock runs after both players load, charges the mover and adds the increment', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: '3+2' });
  let t = 1_000_000;
  c.now = () => t;
  c.handleMessage('a', 'chess-page-loaded', {});
  assert.equal(c.running, null, 'waits for the second player');
  c.handleMessage('b', 'chess-page-loaded', {});
  assert.equal(c.running, 'w');

  t += 5000;
  c.handleMessage(c.white, 'chess-move', { from: 'd2', to: 'd4' });
  assert.equal(c.running, 'b');
  assert.equal(Math.round(c.remaining.w), 180000 - 5000 + 2000);

  t += 7000;
  c.handleMessage(c.black, 'chess-move', { from: 'd7', to: 'd5' });
  assert.equal(Math.round(c.remaining.b), 180000 - 7000 + 2000);
  assert.equal(c.snapshot().clock.running, 'w');
  c.cleanup();
});

test('flag fall loses on time, but is a draw against a bare king', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: '3+2' });
  let t = 0;
  c.now = () => t;
  c.handleMessage('a', 'chess-page-loaded', {});
  c.handleMessage('b', 'chess-page-loaded', {});
  t += 181_000;
  c.checkFlag();
  assert.equal(c.result.reason, 'timeout');
  assert.equal(c.result.winner, c.black);
  assert.equal(room.finished.rows[0].id, c.black);
  c.cleanup();

  const room2 = fakeRoom();
  const d = new Chess(room2, PLAYERS, { clock: '3+2' });
  d.now = () => t;
  d.state = parseFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  d.moves = legalMoves(d.state);
  d.handleMessage('a', 'chess-page-loaded', {});
  d.handleMessage('b', 'chess-page-loaded', {});
  // white (to move) flags, but black only has a bare king
  d.white = 'a'; d.black = 'b';
  t += 181_000;
  d.checkFlag();
  assert.equal(d.result.winner, null, 'no mating material means a draw');
  d.cleanup();
});

test('draw offers: offer, decline, accept, and a move cancels an offer', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: 'none' });
  const [w, b] = [c.white, c.black];
  c.handleMessage(w, 'chess-offer-draw', {});
  assert.equal(c.snapshot().drawOffer, 'w');
  c.handleMessage(w, 'chess-accept-draw', {}); // cannot accept own offer
  assert.equal(c.result, null);
  c.handleMessage(b, 'chess-decline-draw', {});
  assert.equal(c.snapshot().drawOffer, null);

  c.handleMessage(w, 'chess-offer-draw', {});
  c.handleMessage(w, 'chess-move', { from: 'e2', to: 'e4' });
  assert.equal(c.snapshot().drawOffer, null, 'moving ignores the offer');

  c.handleMessage(b, 'chess-offer-draw', {});
  c.handleMessage(w, 'chess-accept-draw', {});
  assert.equal(c.result.winner, null);
  assert.equal(c.result.reason, 'agreement');
  assert.equal(room.finished.rows.length, 2);
  c.cleanup();
});

test('resign, leaving and spectator sync', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: 'none' });
  c.spectatorSync('host');
  assert.equal(room.sent.at(-1).type, 'chess-state');
  c.onPlayerLeft(c.white);
  assert.equal(c.result.winner, c.black);
  assert.equal(c.result.reason, 'left');
  c.cleanup();

  const r2 = fakeRoom();
  const d = new Chess(r2, PLAYERS, { clock: 'none' });
  d.handleMessage(d.black, 'chess-resign', {});
  assert.equal(d.result.winner, d.white);
  assert.equal(r2.finished.title.k, 'chess.title.wins');
  d.cleanup();
});

test('checkmate finishes the game with standings', () => {
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: 'none' });
  const play = (id, from, to) => c.handleMessage(id, 'chess-move', { from, to });
  play(c.white, 'f2', 'f3'); play(c.black, 'e7', 'e5'); play(c.white, 'g2', 'g4'); play(c.black, 'd8', 'h4');
  assert.equal(c.result.reason, 'checkmate');
  assert.equal(c.result.winner, c.black);
  assert.equal(c.snapshot().moves.at(-1), 'Qh4#');
  assert.equal(room.finished.rows[0].id, c.black);
  assert.deepEqual(room.finished.rows.map(r => r.rank), [1, 2]);
  c.cleanup();
});

test('server messages are keys and every referenced key is translated', async () => {
  const { assertKeysExist, assertOptionKeys, assertMsg } = await import('./helpers/i18n-keys.mjs');
  assertKeysExist('chess', ['src/games/chess.js', 'public_html/games/chess.js', 'public_html/games/chess.html']);
  assertOptionKeys('chess');
  const room = fakeRoom();
  const c = new Chess(room, PLAYERS, { clock: 'none' });
  c.handleMessage(c.white, 'chess-move', { from: 'e2', to: 'e5' });
  assertMsg('chess', room.sent.find(m => m.type === 'error').message, 'chess.err.illegal');
  c.handleMessage(c.black, 'chess-resign', {});
  assertMsg('chess', room.finished.title, 'chess.title.wins');
  assert.equal(room.finished.title.p.name, PLAYERS[c.white].name);
  assertMsg('chess', room.finished.subtitle, 'chess.reason.resignation');
  c.cleanup();

  for (const [reason, key] of Object.entries(REASON_KEYS)) {
    const r = fakeRoom();
    const g = new Chess(r, PLAYERS, { clock: 'none' });
    g.finish(null, reason);
    assertMsg('chess', r.finished.subtitle, key);
    assertMsg('chess', r.finished.title, 'chess.title.draw');
    g.cleanup();
  }
});
