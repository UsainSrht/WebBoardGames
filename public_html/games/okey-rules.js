/**
 * Okey rules (pure functions, shared by the Worker and the browser).
 *
 * Tiles: { id, c, v } with colour c = 0..3 (yellow, blue, black, red) and value v = 1..13, or the fake okey { id, f: 1 }.
 * 106 tiles: ids 0..103 are two sets of 4 colours x 13 values (id = set * 52 + c * 13 + v - 1), ids 104 and 105 are
 * the two fake okeys.
 *
 * The indicator (gosterge) is a real tile; the okey is the tile of the same colour whose value is one higher (13 wraps
 * to 1). Real tiles equal to the okey are jokers; a fake okey is a plain tile that stands for the okey tile itself.
 */

export const FAKE_A = 104;
export const FAKE_B = 105;
export const TILE_COUNT = 106;
export const JOKER_PENALTY = 101;

export function buildTiles() {
  const tiles = [];
  for (let set = 0; set < 2; set++) {
    for (let c = 0; c < 4; c++) {
      for (let v = 1; v <= 13; v++) tiles.push({ id: set * 52 + c * 13 + v - 1, c, v });
    }
  }
  tiles.push({ id: FAKE_A, f: 1 }, { id: FAKE_B, f: 1 });
  return tiles;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** The okey that goes with an indicator tile. */
export function okeyOf(indicator) {
  return { c: indicator.c, v: indicator.v === 13 ? 1 : indicator.v + 1 };
}

export const isFake = (t) => !!t.f;
export const isJoker = (t, okey) => !t.f && t.c === okey.c && t.v === okey.v;

/** What a tile is as a plain tile: null for a joker, the okey identity for a fake okey. */
export function effOf(t, okey) {
  if (t.f) return { c: okey.c, v: okey.v };
  if (t.c === okey.c && t.v === okey.v) return null;
  return { c: t.c, v: t.v };
}

/** Face value of a tile left in hand (101 penalty): the okey counts 101, a fake okey counts as the okey. */
export function penaltyValue(t, okey) {
  if (isJoker(t, okey)) return JOKER_PENALTY;
  return t.f ? okey.v : t.v;
}

const posValue = (pos) => (pos > 13 ? 1 : pos);

/**
 * Arrange tiles as ONE group: a run (same colour, consecutive, 1 may follow 13) or a set (same value, different
 * colours, 3 or 4 tiles). Returns { kind, points, slots: [{ id, c, v, pos? }] } with jokers placed where they count the
 * most, or null when the tiles do not form a valid group. In a run the 1 after the 13 counts 14 points.
 */
export function arrangeGroup(tiles, okey) {
  const n = tiles.length;
  if (n < 3 || n > 14) return null;
  const nat = [];
  const jok = [];
  for (const t of tiles) {
    const e = effOf(t, okey);
    if (e) nat.push({ id: t.id, c: e.c, v: e.v }); else jok.push(t.id);
  }
  if (nat.length === 0) return null;
  if (new Set(tiles.map((t) => t.id)).size !== n) return null;
  const run = tryRun(nat, jok, n);
  const set = trySet(nat, jok, n);
  if (run && set) return run.points >= set.points ? run : set;
  return run || set;
}

function trySet(nat, jok, n) {
  if (n > 4) return null;
  const v = nat[0].v;
  const used = new Set();
  for (const t of nat) {
    if (t.v !== v || used.has(t.c)) return null;
    used.add(t.c);
  }
  const slots = nat.map((t) => ({ id: t.id, c: t.c, v }));
  const free = [0, 1, 2, 3].filter((c) => !used.has(c));
  jok.forEach((id, i) => slots.push({ id, c: free[i], v }));
  slots.sort((a, b) => a.c - b.c);
  return { kind: 'set', points: v * n, slots };
}

function tryRun(nat, jok, n) {
  const c = nat[0].c;
  if (nat.some((t) => t.c !== c)) return null;
  const ones = nat.filter((t) => t.v === 1);
  if (ones.length > 2) return null;
  const others = nat.filter((t) => t.v !== 1);
  // every way to put the ones at the low end (1) or the high end (14)
  const variants = ones.length === 0 ? [[]] : ones.length === 1 ? [[1], [14]] : [[1, 14]];
  let best = null;
  for (const v1 of variants) {
    const placed = others.map((t) => ({ id: t.id, pos: t.v }));
    ones.forEach((t, i) => placed.push({ id: t.id, pos: v1[i] }));
    const seen = new Set(placed.map((p) => p.pos));
    if (seen.size !== placed.length) continue;
    const lo = Math.min(...seen);
    const hi = Math.max(...seen);
    if (hi - lo + 1 > n) continue;
    // the window [s, s + n - 1] must contain [lo, hi] and stay inside 1..14; jokers count most when it sits high
    const sMax = Math.min(lo, 15 - n);
    const sMin = Math.max(1, hi - n + 1);
    if (sMin > sMax) continue;
    const s = sMax;
    let points = 0;
    for (let q = s; q < s + n; q++) points += q;
    if (best && best.points >= points) continue;
    const byPos = new Map(placed.map((p) => [p.pos, p.id]));
    const spare = [...jok];
    const slots = [];
    for (let q = s; q < s + n; q++) {
      const id = byPos.has(q) ? byPos.get(q) : spare.shift();
      slots.push({ id, c, v: posValue(q), pos: q });
    }
    best = { kind: 'run', points, slots };
  }
  return best;
}

export const isValidGroup = (tiles, okey) => arrangeGroup(tiles, okey) !== null;

/** Two tiles that make a pair: identical (colour and value) or completed by a joker. */
export function isPair(a, b, okey) {
  if (a.id === b.id) return false;
  const x = effOf(a, okey);
  const y = effOf(b, okey);
  if (!x || !y) return true;
  return x.c === y.c && x.v === y.v;
}

// ------------------------------------------------------------------ search

/**
 * Find the best way to lay tiles out in disjoint groups. With `partition` every tile must end up in a group (a winning
 * rack). Otherwise tiles may stay out and the layout covers as many tiles as possible (then as many points).
 * Returns { groups: [[id...]], rest: [id...] } or null (partition impossible / too complex).
 */
export function solveGroups(tiles, okey, { partition = false, budget = 300000 } = {}) {
  const cnt = new Array(52).fill(0);
  const idsAt = Array.from({ length: 52 }, () => []);
  const jokerIds = [];
  for (const t of tiles) {
    const e = effOf(t, okey);
    if (!e) { jokerIds.push(t.id); continue; }
    const k = e.c * 13 + e.v - 1;
    cnt[k]++;
    idsAt[k].push(t.id);
  }
  const memo = new Map();
  let nodes = 0;

  function search(J) {
    let k = 0;
    while (k < 52 && cnt[k] === 0) k++;
    if (k === 52) {
      if (J > 0 && partition) return null;
      return { score: 0, groups: [] };
    }
    const key = `${cnt.join('')}|${J}`;
    if (memo.has(key)) return memo.get(key);
    if (++nodes > budget) return null;
    let best = null;

    const consider = (natIdx, m, points) => {
      for (const i of natIdx) cnt[i]--;
      const sub = search(J - m);
      for (const i of natIdx) cnt[i]++;
      if (!sub) return;
      const score = (natIdx.length + m) * 1000 + points + sub.score;
      if (!best || score > best.score) best = { score, groups: [{ nat: natIdx.slice(), m }, ...sub.groups] };
    };

    const c = Math.floor(k / 13);
    const v = (k % 13) + 1;
    const base = c * 13;

    // sets
    const mates = [];
    for (let c2 = c + 1; c2 < 4; c2++) if (cnt[c2 * 13 + v - 1] > 0) mates.push(c2 * 13 + v - 1);
    for (let mask = 0; mask < 1 << mates.length; mask++) {
      const natIdx = [k];
      mates.forEach((x, i) => { if (mask & (1 << i)) natIdx.push(x); });
      for (let m = 0; m <= J; m++) {
        const total = natIdx.length + m;
        if (total < 3) continue;
        if (total > 4) break;
        consider(natIdx, m, v * total);
      }
    }

    // runs: the tile k sits at position p (a 1 can also be the 14 after the 13)
    for (const p of v === 1 ? [1, 14] : [v]) {
      const taken = new Array(14).fill(0); // plain tiles used by this run, by value
      taken[v]++;

      const up = (q, natIdx, ju, points, length, low) => {
        if (length >= 3) consider([k, ...natIdx], low + ju, points);
        if (q > 14) return;
        const val = q > 13 ? 1 : q;
        if (cnt[base + val - 1] - taken[val] > 0) {
          taken[val]++;
          natIdx.push(base + val - 1);
          up(q + 1, natIdx, ju, points + q, length + 1, low);
          natIdx.pop();
          taken[val]--;
        }
        if (low + ju < J) up(q + 1, natIdx, ju + 1, points + q, length + 1, low);
      };

      const down = (q, natIdx, ju, points, length) => {
        if (length >= 3) consider([k, ...natIdx], ju, points);
        if (q < 1) return;
        if (cnt[base + q - 1] - taken[q] > 0) {
          taken[q]++;
          natIdx.push(base + q - 1);
          down(q - 1, natIdx, ju, points + q, length + 1);
          natIdx.pop();
          taken[q]--;
        }
        if (ju < J) down(q - 1, natIdx, ju + 1, points + q, length + 1);
      };

      if (p === 14) {
        down(13, [], 0, 14, 1);
      } else {
        const lowMax = Math.min(J, p - 1);
        for (let low = 0; low <= lowMax; low++) {
          let lowPoints = 0;
          for (let q = p - low; q < p; q++) lowPoints += q;
          up(p + 1, [], 0, p + lowPoints, 1 + low, low);
        }
      }
    }

    if (!partition) {
      cnt[k]--;
      const sub = search(J);
      cnt[k]++;
      if (sub && (!best || sub.score > best.score)) best = { score: sub.score, groups: [{ nat: [], m: 0, skip: k }, ...sub.groups] };
    }
    memo.set(key, best);
    return best;
  }

  const res = search(jokerIds.length);
  if (!res || nodes > budget) return null;

  // turn the abstract groups into tile ids
  const pools = idsAt.map((a) => [...a]);
  const jokers = [...jokerIds];
  const groups = [];
  const rest = [];
  for (const g of res.groups) {
    if (g.skip !== undefined) { rest.push(pools[g.skip].pop()); continue; }
    const ids = g.nat.map((i) => pools[i].pop());
    for (let i = 0; i < g.m; i++) ids.push(jokers.pop());
    groups.push(ids);
  }
  rest.push(...jokers);
  for (const p of pools) rest.push(...p);
  if (partition && rest.length) return null;
  return { groups, rest };
}

/** Can these tiles all be laid out in valid groups (a classic winning rack of 14 tiles)? */
export function isWinningGroups(tiles, okey) {
  return solveGroups(tiles, okey, { partition: true }) !== null;
}

/** Seven pairs (jokers complete a pair, two jokers pair with each other). */
export function isSevenPairs(tiles, okey) {
  if (tiles.length !== 14) return false;
  const count = new Map();
  let jokers = 0;
  for (const t of tiles) {
    const e = effOf(t, okey);
    if (!e) { jokers++; continue; }
    const k = e.c * 13 + e.v;
    count.set(k, (count.get(k) || 0) + 1);
  }
  let singles = 0;
  for (const n of count.values()) singles += n % 2;
  return singles <= jokers;
}

/**
 * Classic finish: tiles are the 14 left after the final discard. Returns 'normal', 'pairs' or null.
 * Pairs win if both apply (they score more).
 */
export function winKind(tiles, okey) {
  if (tiles.length !== 14) return null;
  if (isSevenPairs(tiles, okey)) return 'pairs';
  if (isWinningGroups(tiles, okey)) return 'normal';
  return null;
}

/** Points for finishing: 1 normal, 2 pairs, doubled when the finishing tile is the okey. */
export function classicPoints(kind, finishTile, okey) {
  const joker = !!finishTile && isJoker(finishTile, okey);
  const base = kind === 'pairs' ? 2 : 1;
  return joker ? base * 2 : base;
}

/** Every discard that would finish a 15 tile rack: [{ id, kind, points }], best first. */
export function finishingDiscards(rack, okey) {
  const out = [];
  for (let i = 0; i < rack.length; i++) {
    const rest = rack.filter((_, j) => j !== i);
    const kind = winKind(rest, okey);
    if (kind) out.push({ id: rack[i].id, kind, points: classicPoints(kind, rack[i], okey) });
  }
  return out.sort((a, b) => b.points - a.points);
}

/** Validate explicit groups for laying down. Returns { melds, total } or null if any is invalid. */
export function arrangeGroups(groups, okey) {
  const melds = [];
  let total = 0;
  for (const g of groups) {
    const a = arrangeGroup(g, okey);
    if (!a) return null;
    melds.push(a);
    total += a.points;
  }
  return { melds, total };
}
