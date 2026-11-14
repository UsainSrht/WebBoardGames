/**
 * Wordle race (1-12 players). Everybody guesses the SAME secret word at the same time.
 *
 * Options (see config.js):
 *   language  'en' | 'tr'  word lists and alphabet (Turkish casing rules apply)
 *   rounds    number of words (1, 3 or 5)
 *   hard      'on': revealed hints must be reused (greens in place, yellows included)
 *   time      seconds per word, 0 = no limit
 *
 * Rules: 6 guesses of 5 letters, every guess must be in the language's valid word list. Colour feedback uses
 * the exact duplicate-letter rules. A solved word scores 7 - guessesUsed (6 guesses = 1 ... 1 guess = 6) plus,
 * with two or more players, a speed bonus for the first three solvers (+3, +2, +1). A word ends when everybody has
 * solved or failed, or the timer runs out. Only after the word ends is it sent to the clients.
 *
 * Privacy: the secret is never in any snapshot while the round is running. Other players (and the host view)
 * only ever see colour strings ('g', 'y', 'x'), never letters.
 */
import {
  MAX_GUESSES, WORD_LEN, cleanWord, feedback, hardViolation, normLang, solvePoints, speedBonus
} from '../../public_html/games/wordle-core.js';
import * as EN from './data/wordle-en.js';
import * as TR from './data/wordle-tr.js';

const DATA = { en: EN, tr: TR };
const cache = {};

/** { answers: string[], valid: Set<string> } for a language (built lazily from the bundled lists). */
export function wordLists(lang) {
  const l = normLang(lang);
  if (!cache[l]) {
    cache[l] = { answers: DATA[l].ANSWERS.split('\n'), valid: new Set(DATA[l].VALID.split('\n')) };
  }
  return cache[l];
}

const START_FALLBACK_MS = 8000;
const REVEAL_MS = 9000;
const FINAL_REVEAL_MS = 6000;
const RETURN_TO_LOBBY_MS = 25000;
const TYPING_MIN_GAP_MS = 80;

export class Wordle {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.now = extra.now || (() => Date.now());
    this.rng = extra.rng || Math.random;

    this.lang = normLang(options.language);
    this.rounds = [1, 3, 5].includes(Number(options.rounds)) ? Number(options.rounds) : 3;
    this.hard = options.hard === 'on';
    const t = Number(options.time);
    this.timeMs = Number.isFinite(t) && t > 0 ? Math.min(t, 600) * 1000 : 0;

    const lists = wordLists(this.lang);
    this.valid = extra.valid || lists.valid;
    this.pool = extra.words ? [...extra.words] : null; // tests: a fixed sequence of secrets
    this.answers = lists.answers;
    this.used = new Set();

    this.names = {};
    this.stats = {};
    this.order = Object.keys(players);
    for (const [id, p] of Object.entries(players)) {
      this.names[id] = p.name;
      this.stats[id] = { score: 0, solved: 0, guessSum: 0 };
    }
    this.initialPlayers = this.order.length;

    this.round = 0;
    this.phase = 'wait'; // wait | play | reveal | over
    this.word = null;
    this.boards = {};
    this.solveOrder = 0;
    this.deadline = 0;
    this.nextAt = 0;
    this.result = null;
    this.final = false;
    this.loaded = new Set();
    this.typingAt = {};
    this.roundTimer = null;
    this.nextTimer = null;

    this.nextTimer = setTimeout(() => { this.nextTimer = null; this.startRound(); }, START_FALLBACK_MS);
  }

  // ----------------------------------------------------------------- rounds

  pickWord() {
    if (this.pool) return this.pool[(this.round - 1) % this.pool.length];
    for (let tries = 0; tries < 50; tries++) {
      const w = this.answers[Math.floor(this.rng() * this.answers.length)];
      if (!this.used.has(w)) { this.used.add(w); return w; }
    }
    return this.answers[Math.floor(this.rng() * this.answers.length)];
  }

  startRound() {
    if (!this.isGameActive || this.phase === 'play' || this.phase === 'over') return;
    clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this.round++;
    this.word = this.pickWord();
    this.boards = {};
    for (const id of this.order) this.boards[id] = { guesses: [], status: 'playing', order: 0 };
    this.solveOrder = 0;
    this.result = null;
    this.phase = 'play';
    this.startedAt = this.now();
    this.deadline = this.timeMs ? this.startedAt + this.timeMs : 0;
    if (this.timeMs) this.roundTimer = setTimeout(() => this.endRound('time'), this.timeMs);
    this.broadcastState();
  }

  allDone() {
    return this.order.every((id) => this.boards[id].status !== 'playing');
  }

  endRound() {
    if (this.phase !== 'play') return;
    clearTimeout(this.roundTimer);
    this.roundTimer = null;
    const result = [];
    for (const id of this.order) {
      const b = this.boards[id];
      if (b.status === 'playing') b.status = 'failed';
      let points = 0;
      let bonus = 0;
      if (b.status === 'solved') {
        points = solvePoints(b.guesses.length);
        bonus = speedBonus(b.order, this.initialPlayers);
        const st = this.stats[id];
        st.score += points + bonus;
        st.solved++;
        st.guessSum += b.guesses.length;
      }
      result.push({ id, status: b.status, guesses: b.guesses.length, points, bonus });
    }
    this.result = result;
    this.phase = 'reveal';
    this.final = this.round >= this.rounds;
    const wait = this.final ? FINAL_REVEAL_MS : REVEAL_MS;
    this.nextAt = this.now() + wait;
    this.broadcastState();
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      if (!this.isGameActive) return;
      if (this.final) this.finish();
      else this.startRound();
    }, wait);
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.names[odId] || !this.order.includes(odId)) return;
    const p = payload && typeof payload === 'object' ? payload : {};
    switch (type) {
      case 'wordle-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (this.phase === 'wait' && this.loaded.size >= this.order.length) this.startRound();
        return;
      case 'wordle-guess': return this.guess(odId, p.word);
      case 'wordle-typing': return this.typing(odId, p.n);
    }
  }

  reject(odId, message) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { type: 'wordle-reject', message });
  }

  guess(odId, raw) {
    if (this.phase !== 'play') return;
    const board = this.boards[odId];
    if (!board || board.status !== 'playing') return;
    const word = cleanWord(raw, this.lang);
    if (!word) return this.reject(odId, { k: 'wordle.err.short' });
    if (!this.valid.has(word)) return this.reject(odId, { k: 'wordle.err.notWord' });
    if (this.hard) {
      const v = hardViolation(word, board.guesses, this.lang);
      if (v) return this.reject(odId, v);
    }
    const fb = feedback(word, this.word);
    board.guesses.push({ word, fb });
    this.typingAt[odId] = 0;
    if (word === this.word) {
      board.status = 'solved';
      board.order = ++this.solveOrder;
      board.solvedAt = this.now() - this.startedAt;
    } else if (board.guesses.length >= MAX_GUESSES) {
      board.status = 'failed';
    }
    if (this.allDone()) return this.endRound();
    this.broadcastState();
  }

  /** How many letters a player has typed in the current row (never the letters). */
  typing(odId, n) {
    if (this.phase !== 'play' || this.boards[odId]?.status !== 'playing') return;
    const count = Math.max(0, Math.min(WORD_LEN, Math.floor(Number(n)) || 0));
    const t = this.now();
    if (t - (this.typingAt[odId] || 0) < TYPING_MIN_GAP_MS && count !== 0) return;
    this.typingAt[odId] = t;
    this.room.broadcast({ type: 'wordle-typing', id: odId, n: count });
  }

  // --------------------------------------------------------------- snapshots

  /** Public view of a player's board: colours only. */
  publicPlayer(id) {
    const b = this.boards[id] || { guesses: [], status: 'playing' };
    const st = this.stats[id];
    return {
      id,
      name: this.names[id],
      score: st.score,
      solved: st.solved,
      status: b.status,
      board: b.guesses.map((g) => g.fb)
    };
  }

  stateFor(odId) {
    const showWord = this.phase === 'reveal' || this.phase === 'over';
    const now = this.now();
    const mine = odId && this.boards[odId];
    return {
      type: 'wordle-state',
      you: odId,
      language: this.lang,
      rounds: this.rounds,
      hard: this.hard,
      time: this.timeMs / 1000,
      round: this.round,
      phase: this.phase,
      players: this.order.map((id) => this.publicPlayer(id)),
      mine: mine ? { guesses: mine.guesses, status: mine.status } : null,
      word: showWord ? this.word : null,
      result: this.phase === 'reveal' ? this.result : null,
      timeLeft: this.phase === 'play' && this.deadline ? Math.max(0, this.deadline - now) : 0,
      nextIn: this.phase === 'reveal' ? Math.max(0, this.nextAt - now) : 0,
      final: this.final
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  /** Host view: the same public data as players get, never anyone's letters. */
  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, spectator: true });
  }

  broadcastState() {
    for (const id of this.order) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  // ------------------------------------------------------------------ ending

  finish() {
    this.phase = 'over';
    const ids = [...this.order];
    const key = (id) => {
      const s = this.stats[id];
      return [s.score, s.solved, s.solved ? -s.guessSum / s.solved : -99];
    };
    ids.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    });
    let rank = 0;
    let prev = null;
    const rows = ids.map((id, i) => {
      const k = key(id).join('|');
      if (k !== prev) rank = i + 1;
      prev = k;
      const s = this.stats[id];
      return {
        id,
        name: this.names[id],
        score: s.score,
        rank,
        note: s.solved
          ? { k: 'wordle.note.summary', p: { solved: s.solved, rounds: this.rounds, avg: (s.guessSum / s.solved).toFixed(1) } }
          : { k: 'wordle.note.none', p: { rounds: this.rounds } }
      };
    });
    const winners = rows.filter((r) => r.rank === 1);
    let title;
    let subtitle = { k: 'wordle.final.sub', p: { n: this.rounds } };
    if (!rows.length) title = { k: 'wordle.final.over' };
    else if (this.initialPlayers === 1) {
      title = rows[0].score > 0 ? { k: 'wordle.final.solo', p: { score: rows[0].score } } : { k: 'wordle.final.soloNone' };
    } else if (winners.length > 1) title = { k: 'wordle.final.tie' };
    else title = { k: 'wordle.final.wins', p: { name: winners[0].name } };
    if (this.broadcastDone) return;
    this.broadcastDone = true;
    this.broadcastState();
    this.room.finishGame({ title, subtitle, rows, delayMs: RETURN_TO_LOBBY_MS });
  }

  // ------------------------------------------------------------------ leaving

  onPlayerLeft(odId) {
    const i = this.order.indexOf(odId);
    if (i < 0) return;
    this.order.splice(i, 1);
    this.loaded.delete(odId);
    if (!this.order.length) { this.cleanup(); return; }
    if (this.phase === 'wait' && this.loaded.size >= this.order.length) return this.startRound();
    if (this.phase === 'play' && this.allDone()) return this.endRound();
    this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    clearTimeout(this.roundTimer);
    clearTimeout(this.nextTimer);
    this.roundTimer = this.nextTimer = null;
  }
}
