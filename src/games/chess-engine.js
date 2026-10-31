/**
 * Minimal, dependency-free chess rules engine.
 *
 * Board: array of 64 chars, index 0 = a8 ... 63 = h1 (row 0 is rank 8).
 * White pieces are upper case (PNBRQK), black lower case, '' = empty.
 */

export const START_FEN_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

const KNIGHT = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

const isWhite = (p) => p !== '' && p === p.toUpperCase();
const colorOf = (p) => (p === '' ? null : isWhite(p) ? 'w' : 'b');
const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

export const squareName = (i) => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
export const squareIndex = (name) => {
  if (typeof name !== 'string' || !/^[a-h][1-8]$/.test(name)) return -1;
  return (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);
};

export function initialState() {
  return parseFen(`${START_FEN_BOARD} w KQkq - 0 1`);
}

export function parseFen(fen) {
  const [placement, turn, castling, ep, half, full] = fen.split(' ');
  const b = [];
  for (const ch of placement) {
    if (ch === '/') continue;
    if (/\d/.test(ch)) for (let i = 0; i < Number(ch); i++) b.push('');
    else b.push(ch);
  }
  return {
    b,
    turn,
    castle: { K: castling.includes('K'), Q: castling.includes('Q'), k: castling.includes('k'), q: castling.includes('q') },
    ep: ep === '-' ? -1 : squareIndex(ep),
    half: Number(half) || 0,
    full: Number(full) || 1
  };
}

/** Is square `sq` attacked by any piece of colour `by`? */
export function isAttacked(b, sq, by) {
  const r = Math.floor(sq / 8), c = sq % 8;
  const at = (rr, cc) => (inside(rr, cc) ? b[rr * 8 + cc] : '');
  const own = (p) => (by === 'w' ? p : p.toLowerCase());

  // pawns attack "forward"; so look backwards from the target square
  const pr = by === 'w' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) if (at(pr, c + dc) === own('P')) return true;

  for (const [dr, dc] of KNIGHT) if (at(r + dr, c + dc) === own('N')) return true;
  for (const [dr, dc] of KING) if (at(r + dr, c + dc) === own('K')) return true;

  const slide = (dirs, kinds) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inside(rr, cc)) {
        const p = b[rr * 8 + cc];
        if (p) {
          if (colorOf(p) === by && kinds.includes(p.toUpperCase())) return true;
          break;
        }
        rr += dr; cc += dc;
      }
    }
    return false;
  };
  return slide(ROOK_DIRS, 'RQ') || slide(BISHOP_DIRS, 'BQ');
}

export function kingSquare(b, color) {
  return b.indexOf(color === 'w' ? 'K' : 'k');
}

export function inCheck(state, color = state.turn) {
  const k = kingSquare(state.b, color);
  return k !== -1 && isAttacked(state.b, k, color === 'w' ? 'b' : 'w');
}

function pseudoMoves(state) {
  const { b, turn, castle, ep } = state;
  const moves = [];
  const enemy = turn === 'w' ? 'b' : 'w';

  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || colorOf(p) !== turn) continue;
    const r = Math.floor(from / 8), c = from % 8;
    const type = p.toUpperCase();

    if (type === 'P') {
      const dir = turn === 'w' ? -1 : 1;
      const startRow = turn === 'w' ? 6 : 1;
      const lastRow = turn === 'w' ? 0 : 7;
      const push = (to, extra = {}) => {
        if (Math.floor(to / 8) === lastRow) {
          for (const promo of ['q', 'r', 'b', 'n']) moves.push({ from, to, promo, ...extra });
        } else moves.push({ from, to, ...extra });
      };
      const one = (r + dir) * 8 + c;
      if (inside(r + dir, c) && !b[one]) {
        push(one);
        const two = (r + 2 * dir) * 8 + c;
        if (r === startRow && !b[two]) moves.push({ from, to: two, double: true });
      }
      for (const dc of [-1, 1]) {
        if (!inside(r + dir, c + dc)) continue;
        const to = (r + dir) * 8 + c + dc;
        if (b[to] && colorOf(b[to]) === enemy) push(to);
        else if (to === ep) moves.push({ from, to, enPassant: true });
      }
    } else if (type === 'N' || type === 'K') {
      for (const [dr, dc] of type === 'N' ? KNIGHT : KING) {
        if (!inside(r + dr, c + dc)) continue;
        const to = (r + dr) * 8 + c + dc;
        if (colorOf(b[to]) !== turn) moves.push({ from, to });
      }
      if (type === 'K') {
        const row = turn === 'w' ? 7 : 0;
        if (from === row * 8 + 4 && !isAttacked(b, from, enemy)) {
          const ks = turn === 'w' ? castle.K : castle.k;
          const qs = turn === 'w' ? castle.Q : castle.q;
          const rook = turn === 'w' ? 'R' : 'r';
          if (ks && b[row * 8 + 7] === rook && !b[row * 8 + 5] && !b[row * 8 + 6]
            && !isAttacked(b, row * 8 + 5, enemy) && !isAttacked(b, row * 8 + 6, enemy)) {
            moves.push({ from, to: row * 8 + 6, castle: 'k' });
          }
          if (qs && b[row * 8] === rook && !b[row * 8 + 1] && !b[row * 8 + 2] && !b[row * 8 + 3]
            && !isAttacked(b, row * 8 + 3, enemy) && !isAttacked(b, row * 8 + 2, enemy)) {
            moves.push({ from, to: row * 8 + 2, castle: 'q' });
          }
        }
      }
    } else {
      const dirs = type === 'R' ? ROOK_DIRS : type === 'B' ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inside(rr, cc)) {
          const to = rr * 8 + cc;
          if (!b[to]) moves.push({ from, to });
          else {
            if (colorOf(b[to]) !== turn) moves.push({ from, to });
            break;
          }
          rr += dr; cc += dc;
        }
      }
    }
  }
  return moves;
}

/** Apply a (pseudo-legal) move and return the new state. */
export function applyMove(state, move) {
  const b = state.b.slice();
  const piece = b[move.from];
  const type = piece.toUpperCase();
  const captured = b[move.to];

  b[move.to] = piece;
  b[move.from] = '';

  if (move.enPassant) b[move.to + (state.turn === 'w' ? 8 : -8)] = '';
  if (move.castle) {
    const row = Math.floor(move.from / 8) * 8;
    if (move.castle === 'k') { b[row + 5] = b[row + 7]; b[row + 7] = ''; }
    else { b[row + 3] = b[row]; b[row] = ''; }
  }
  if (move.promo) b[move.to] = state.turn === 'w' ? move.promo.toUpperCase() : move.promo;

  const castle = { ...state.castle };
  if (type === 'K') {
    if (state.turn === 'w') { castle.K = false; castle.Q = false; } else { castle.k = false; castle.q = false; }
  }
  const touch = (sq) => {
    if (sq === 63) castle.K = false;
    if (sq === 56) castle.Q = false;
    if (sq === 7) castle.k = false;
    if (sq === 0) castle.q = false;
  };
  touch(move.from);
  touch(move.to);

  return {
    b,
    turn: state.turn === 'w' ? 'b' : 'w',
    castle,
    ep: move.double ? (move.from + move.to) / 2 : -1,
    half: type === 'P' || captured || move.enPassant ? 0 : state.half + 1,
    full: state.full + (state.turn === 'b' ? 1 : 0)
  };
}

export function legalMoves(state) {
  return pseudoMoves(state).filter(m => !inCheck(applyMove(state, m), state.turn));
}

export function insufficientMaterial(b) {
  const pieces = b.filter(p => p && p.toUpperCase() !== 'K');
  if (pieces.length === 0) return true;
  if (pieces.length === 1) return 'BN'.includes(pieces[0].toUpperCase());
  if (pieces.every(p => p.toUpperCase() === 'B')) {
    // all bishops on the same colour of square
    const shades = new Set();
    b.forEach((p, i) => { if (p && p.toUpperCase() === 'B') shades.add((Math.floor(i / 8) + (i % 8)) % 2); });
    return shades.size === 1;
  }
  return false;
}

/** Position key for repetition detection (placement, side to move, rights, ep). */
export function positionKey(state) {
  const rights = Object.entries(state.castle).filter(([, v]) => v).map(([k]) => k).join('');
  return `${state.b.map(p => p || '.').join('')}|${state.turn}|${rights}|${state.ep}`;
}

export function perft(state, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(state)) n += perft(applyMove(state, m), depth - 1);
  return n;
}
