/**
 * Wordle rules shared by the Durable Object (src/games/wordle.js) and the browser (wordle.js).
 * Pure functions only: no DOM, no Worker APIs.
 */

export const WORD_LEN = 5;
export const MAX_GUESSES = 6;

export const ALPHABET = {
  en: 'abcdefghijklmnopqrstuvwxyz',
  tr: 'abcçdefgğhıijklmnoöprsştuüvyz'
};

/** On-screen keyboard rows (Q layouts). */
export const LAYOUT = {
  en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  tr: ['ertyuıopğü', 'asdfghjklşi', 'zcvbnmöç']
};

export const normLang = (lang) => (lang === 'tr' ? 'tr' : 'en');

/** Lower case with the language's own rules (Turkish: I -> dotless i, dotted I -> i). */
export function lower(text, lang) {
  let s = String(text).normalize('NFC');
  if (lang === 'tr') s = s.replace(/I/g, 'ı').replace(/İ/g, 'i');
  return s.toLowerCase().normalize('NFC');
}

/** Upper case with the language's own rules (Turkish: i -> dotted I, dotless i -> I). */
export function upper(text, lang) {
  let s = String(text).normalize('NFC');
  if (lang === 'tr') s = s.replace(/i/g, 'İ').replace(/ı/g, 'I');
  return s.toUpperCase().normalize('NFC');
}

/** Normalised guess (lower case letters) or null when it is not 5 letters of the language's alphabet. */
export function cleanWord(text, lang) {
  if (typeof text !== 'string' || text.length > 40) return null;
  const w = lower(text.trim(), lang);
  const chars = [...w];
  if (chars.length !== WORD_LEN) return null;
  const alpha = ALPHABET[normLang(lang)];
  return chars.every((c) => alpha.includes(c)) ? w : null;
}

/**
 * Wordle colour feedback with the exact duplicate-letter rules: greens are claimed first, then each
 * remaining guess letter is yellow only while the secret still has an unclaimed copy of it.
 * Returns a string of 'g' (right place), 'y' (elsewhere) and 'x' (absent).
 */
export function feedback(guess, secret) {
  const g = [...guess];
  const s = [...secret];
  const out = Array(g.length).fill('x');
  const left = new Map();
  for (let i = 0; i < g.length; i++) {
    if (g[i] === s[i]) out[i] = 'g';
    else left.set(s[i], (left.get(s[i]) || 0) + 1);
  }
  for (let i = 0; i < g.length; i++) {
    if (out[i] === 'g') continue;
    const n = left.get(g[i]) || 0;
    if (n > 0) { out[i] = 'y'; left.set(g[i], n - 1); }
  }
  return out.join('');
}

/**
 * Hard mode: every revealed hint must be used. `history` = [{ word, fb }].
 * Returns null when the guess is fine, otherwise { k, p } describing the first broken hint.
 */
export function hardViolation(guess, history, lang) {
  const g = [...guess];
  for (const { word, fb } of history) {
    const w = [...word];
    const need = new Map();
    for (let i = 0; i < w.length; i++) {
      if (fb[i] === 'g') {
        if (g[i] !== w[i]) return { k: 'wordle.err.hardGreen', p: { pos: i + 1, letter: upper(w[i], lang) } };
      }
      if (fb[i] === 'g' || fb[i] === 'y') need.set(w[i], (need.get(w[i]) || 0) + 1);
    }
    for (const [letter, n] of need) {
      if (g.filter((c) => c === letter).length < n) return { k: 'wordle.err.hardYellow', p: { letter: upper(letter, lang) } };
    }
  }
  return null;
}

/** Points for a solved word: 6 guesses = 1 ... 1 guess = 6. */
export const solvePoints = (guessesUsed) => Math.max(1, MAX_GUESSES + 1 - guessesUsed);

/** Speed bonus by solve order (first solver 3, second 2, third 1); none when playing alone. */
export const speedBonus = (order, playerCount) => (playerCount < 2 ? 0 : Math.max(0, 4 - order));

/** Rank of keyboard letter states: g beats y beats x. */
export const STATE_RANK = { x: 1, y: 2, g: 3 };

/** Best known state of every letter over a list of { word, fb }. */
export function letterStates(history) {
  const best = {};
  for (const { word, fb } of history) {
    [...word].forEach((c, i) => {
      if ((STATE_RANK[fb[i]] || 0) > (STATE_RANK[best[c]] || 0)) best[c] = fb[i];
    });
  }
  return best;
}
