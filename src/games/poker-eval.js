/**
 * Pure Texas Hold'em hand evaluation (no I/O, no randomness).
 *
 * A card is { r, s }: r = 2..14 (11 J, 12 Q, 13 K, 14 A), s = 's' | 'h' | 'd' | 'c'.
 * evaluate(cards) takes 1..7 cards and returns
 *   { score, category, key, ranks, best }
 * where score is a number (a higher score always wins, equal scores tie), category 0..9, key the
 * category name, ranks the ranks that name the hand (e.g. [13, 10] for Kings full of Tens) and
 * best the best five cards (fewer when fewer than five were given).
 */

export const SUITS = ['s', 'h', 'd', 'c'];
export const CATEGORY_KEYS = ['highCard', 'pair', 'twoPair', 'trips', 'straight', 'flush', 'fullHouse', 'quads', 'straightFlush', 'royalFlush'];

export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Parse 'As', 'Td', '9h' style shorthand (handy for tests). */
export function parseCards(text) {
  const map = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return String(text).trim().split(/\s+/).filter(Boolean).map((t) => {
    const r = map[t[0].toUpperCase()] || Number(t.slice(0, -1) || t[0]);
    return { r, s: t[t.length - 1].toLowerCase() };
  });
}

/** Highest card of a straight in the given set of ranks (the wheel counts as 5), or 0. */
function straightHigh(rankSet) {
  for (let hi = 14; hi >= 5; hi--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const need = hi - k === 1 ? 14 : hi - k;
      if (!rankSet.has(need)) { ok = false; break; }
    }
    if (ok) return hi;
  }
  return 0;
}

function straightCards(cards, hi) {
  const out = [];
  for (let k = 0; k < 5; k++) {
    const need = hi - k === 1 ? 14 : hi - k;
    out.push(cards.find((c) => c.r === need));
  }
  return out;
}

const pack = (category, kickers) => {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] || 0);
  return score;
};

export function evaluate(cards) {
  const byRank = new Map();
  const bySuit = new Map();
  for (const c of cards) {
    if (!byRank.has(c.r)) byRank.set(c.r, []);
    byRank.get(c.r).push(c);
    if (!bySuit.has(c.s)) bySuit.set(c.s, []);
    bySuit.get(c.s).push(c);
  }
  const done = (category, kickers, ranks, best) => ({
    score: pack(category, kickers), category, key: CATEGORY_KEYS[category], ranks, best
  });

  let flushCards = null;
  for (const list of bySuit.values()) if (list.length >= 5) flushCards = [...list].sort((a, b) => b.r - a.r);

  if (flushCards) {
    const sf = straightHigh(new Set(flushCards.map((c) => c.r)));
    if (sf) return done(sf === 14 ? 9 : 8, [sf], [sf], straightCards(flushCards, sf));
  }

  const groups = [...byRank.entries()]
    .map(([r, list]) => ({ r, n: list.length, list }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const take = (g, n) => g.list.slice(0, n);
  const kickersFrom = (skip, count) => groups
    .filter((g) => !skip.includes(g))
    .sort((a, b) => b.r - a.r)
    .slice(0, count);

  if (groups[0].n === 4) {
    const k = kickersFrom([groups[0]], 1);
    return done(7, [groups[0].r, k[0]?.r || 0], [groups[0].r], [...take(groups[0], 4), ...k.map((g) => g.list[0])]);
  }
  if (groups[0].n === 3 && groups[1] && groups[1].n >= 2) {
    return done(6, [groups[0].r, groups[1].r], [groups[0].r, groups[1].r], [...take(groups[0], 3), ...take(groups[1], 2)]);
  }
  if (flushCards) {
    const best = flushCards.slice(0, 5);
    return done(5, best.map((c) => c.r), [best[0].r], best);
  }
  const sh = straightHigh(new Set(byRank.keys()));
  if (sh) {
    const best = straightCards(cards, sh);
    return done(4, [sh], [sh], best);
  }
  if (groups[0].n === 3) {
    const k = kickersFrom([groups[0]], 2);
    return done(3, [groups[0].r, ...k.map((g) => g.r)], [groups[0].r], [...take(groups[0], 3), ...k.map((g) => g.list[0])]);
  }
  if (groups[0].n === 2 && groups[1] && groups[1].n === 2) {
    const k = kickersFrom([groups[0], groups[1]], 1);
    return done(2, [groups[0].r, groups[1].r, k[0]?.r || 0], [groups[0].r, groups[1].r],
      [...take(groups[0], 2), ...take(groups[1], 2), ...k.map((g) => g.list[0])]);
  }
  if (groups[0].n === 2) {
    const k = kickersFrom([groups[0]], 3);
    return done(1, [groups[0].r, ...k.map((g) => g.r)], [groups[0].r], [...take(groups[0], 2), ...k.map((g) => g.list[0])]);
  }
  const k = kickersFrom([], 5);
  return done(0, k.map((g) => g.r), [k[0]?.r || 0], k.map((g) => g.list[0]));
}

/** Positive when hand a beats hand b, negative when it loses, 0 for a tie. */
export function compareHands(a, b) {
  const sa = typeof a === 'number' ? a : (a.score ?? evaluate(a).score);
  const sb = typeof b === 'number' ? b : (b.score ?? evaluate(b).score);
  return sa - sb;
}

/** Translatable name of an evaluated hand: { k, p } with nested rank messages. */
export function handMessage(res) {
  const one = (r) => ({ k: `poker.rank.${r}` });
  const many = (r) => ({ k: `poker.rankp.${r}` });
  const [x, y] = res.ranks;
  switch (res.key) {
    case 'royalFlush': return { k: 'poker.hand.royalFlush' };
    case 'straightFlush': return { k: 'poker.hand.straightFlush', p: { a: one(x) } };
    case 'quads': return { k: 'poker.hand.quads', p: { a: many(x) } };
    case 'fullHouse': return { k: 'poker.hand.fullHouse', p: { a: many(x), b: many(y) } };
    case 'flush': return { k: 'poker.hand.flush', p: { a: one(x) } };
    case 'straight': return { k: 'poker.hand.straight', p: { a: one(x) } };
    case 'trips': return { k: 'poker.hand.trips', p: { a: many(x) } };
    case 'twoPair': return { k: 'poker.hand.twoPair', p: { a: many(x), b: many(y) } };
    case 'pair': return { k: 'poker.hand.pair', p: { a: many(x) } };
    default: return { k: 'poker.hand.highCard', p: { a: one(x) } };
  }
}

/**
 * Side pots from every player's total contribution this hand.
 * entries: [{ id, total, folded }]. Returns [{ amount, eligible: [id] }] (main pot first); layers with the
 * same eligible players are merged and money from players who folded stays in the pot it was paid into.
 */
export function buildPots(entries) {
  const levels = [...new Set(entries.filter((e) => e.total > 0).map((e) => e.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lv of levels) {
    let amount = 0;
    for (const e of entries) amount += Math.min(e.total, lv) - Math.min(e.total, prev);
    prev = lv;
    const eligible = entries.filter((e) => !e.folded && e.total >= lv).map((e) => e.id);
    const last = pots[pots.length - 1];
    if (!eligible.length) {
      if (last) last.amount += amount;
      else pots.push({ amount, eligible: [] });
    } else if (last && (!last.eligible.length || (last.eligible.length === eligible.length && last.eligible.every((id) => eligible.includes(id))))) {
      last.amount += amount;
      last.eligible = eligible;
    } else pots.push({ amount, eligible });
  }
  return pots;
}
