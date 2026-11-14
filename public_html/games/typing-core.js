/**
 * Typing test maths shared by the Durable Object (src/games/typing.js) and the browser (typing.js).
 *
 * The typed text is the words the player committed (joined by single spaces) plus the word being typed.
 * A character is correct when it equals the target character at the same place of the same word; a space is
 * correct when the word before it was typed exactly right.
 */

export const MAX_CPS = 25; // 300 wpm: anything faster is not a human typing

/** Small seeded generator (mulberry32). */
export function seededRng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compare typed text with the target. */
export function scoreTyped(target, typed) {
  const xw = target.split(' ');
  const tw = typed.split(' ');
  let correct = 0;
  let wrong = 0;
  for (let i = 0; i < tw.length; i++) {
    const t = tw[i];
    const x = xw[i] ?? '';
    let m = 0;
    const n = Math.min(t.length, x.length);
    for (let j = 0; j < n; j++) if (t[j] === x[j]) m++;
    correct += m;
    const committed = i < tw.length - 1;
    if (committed) {
      if (t === x) correct++; // the space after a perfect word
      else wrong += Math.max(t.length, x.length) - m;
    } else {
      wrong += t.length - m; // the word in progress: only wrong or extra letters count
    }
  }
  const complete = tw.length === xw.length && tw[tw.length - 1].length >= xw[xw.length - 1].length;
  return { correct, wrong, length: typed.length, complete, words: Math.max(0, tw.length - 1) };
}

export const wpmOf = (chars, ms) => (ms > 0 ? chars / 5 / (ms / 60000) : 0);

export const round1 = (n) => Math.round(n * 10) / 10;

/** Per-second consistency 0..100 from a list of per-second speeds (100 = perfectly steady). */
export function consistency(samples) {
  const s = samples.filter((x) => Number.isFinite(x));
  if (s.length < 3) return 100;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  if (mean <= 0) return 0;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return Math.max(0, Math.min(100, Math.round(100 - (sd / mean) * 100)));
}
