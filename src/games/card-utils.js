/** Small helpers shared by the French-deck card games (Go Fish, Papaz Kacti). */

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['s', 'h', 'd', 'c'];

/** A standard 52-card deck. Card = { id, r: rank, s: suit }; ids are unique and stable (0..51). */
export function buildDeck() {
  const cards = [];
  for (let si = 0; si < SUITS.length; si++) {
    for (let ri = 0; ri < RANKS.length; ri++) cards.push({ id: si * 13 + ri, r: RANKS[ri], s: SUITS[si] });
  }
  return cards;
}

/** In-place Fisher-Yates shuffle. */
export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const rankIndex = (r) => RANKS.indexOf(r);

/** Sort a hand by rank, then suit (for display). Returns a new array. */
export function sortHand(cards) {
  return [...cards].sort((a, b) => rankIndex(a.r) - rankIndex(b.r) || SUITS.indexOf(a.s) - SUITS.indexOf(b.s));
}

/** The shape of a card that is safe to put on the wire. */
export const pub = (c) => ({ id: c.id, r: c.r, s: c.s });

/** Send an error message object to one player. */
export function failTo(room, odId, message) {
  const ws = room.getWsByUserId(odId);
  if (ws) room.send(ws, { type: 'error', message });
}
