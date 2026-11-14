/**
 * Typing test race (1-12 players). Everybody types the identical text, seeded by the server, against the
 * server clock: 3-2-1, then `duration` seconds.
 *
 * Options (see config.js):
 *   language  'en' | 'tr'
 *   duration  15 | 30 | 60 | 120 seconds
 *   source    'words' (random common words) | 'quotes' (quotations / proverbs)
 *
 * The client sends its typed text with throttled 'typing-progress' messages and a final 'typing-finish'. The
 * server recomputes everything from the typed text and the server clock: net WPM = correct characters / 5 / minutes,
 * raw WPM, accuracy, consistency. A race ends for a player when the text is complete (time = arrival minus a small
 * latency allowance) or the time is up (time = the full duration). Speeds no human can reach are marked disqualified.
 */
import { MAX_CPS, consistency, round1, scoreTyped, seededRng, wpmOf } from '../../public_html/games/typing-core.js';
import { WORDS_EN } from './data/typing-words-en.js';
import { WORDS_TR } from './data/typing-words-tr.js';
import { QUOTES_EN, QUOTES_TR } from './data/typing-quotes.js';

const WORDS = { en: WORDS_EN.split(' '), tr: WORDS_TR.split(' ') };
const QUOTES = { en: QUOTES_EN, tr: QUOTES_TR };

export const COUNTDOWN_MS = 3000;
export const GRACE_MS = 2500;
export const LATENCY_MS = 250;
export const MAX_WPM = MAX_CPS * 12;
const START_FALLBACK_MS = 8000;
const PROGRESS_MIN_GAP_MS = 100;
const BROADCAST_MS = 200;
const RESULT_SHOW_MS = 10000;
const RETURN_TO_LOBBY_MS = 25000;
const CHARS_PER_SECOND_TEXT = 14;

/** The text everybody types: deterministic for a given rng. */
export function generateText(language, source, duration, rng) {
  const lang = language === 'tr' ? 'tr' : 'en';
  const target = Math.max(150, duration * CHARS_PER_SECOND_TEXT);
  const out = [];
  let len = 0;
  if (source === 'quotes') {
    const list = QUOTES[lang];
    while (len < target) {
      const order = list.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const i of order) {
        out.push(list[i]);
        len += list[i].length + 1;
        if (len >= target) break;
      }
    }
  } else {
    const list = WORDS[lang];
    let prev = -1;
    while (len < target) {
      let i = Math.floor(rng() * list.length);
      if (i === prev) i = (i + 1) % list.length;
      prev = i;
      out.push(list[i]);
      len += list[i].length + 1;
    }
  }
  return out.join(' ');
}

export class Typing {
  constructor(room, players, options = {}, extra = {}) {
    this.room = room;
    this.players = players;
    this.isGameActive = true;
    this.now = extra.now || (() => Date.now());

    this.lang = options.language === 'tr' ? 'tr' : 'en';
    this.duration = [15, 30, 60, 120].includes(Number(options.duration)) ? Number(options.duration) : 30;
    this.source = options.source === 'quotes' ? 'quotes' : 'words';
    this.seed = extra.seed ?? Math.floor((extra.rng || Math.random)() * 2 ** 32);
    this.text = extra.text || generateText(this.lang, this.source, this.duration, seededRng(this.seed));

    this.names = {};
    this.rec = {};
    this.order = Object.keys(players);
    for (const [id, p] of Object.entries(players)) {
      this.names[id] = p.name;
      this.rec[id] = { typed: '', ks: 0, mistakes: 0, lastAt: 0, samples: [], done: false, dq: false, result: null };
    }
    this.initialPlayers = this.order.length;

    this.phase = 'wait'; // wait | countdown | play | over
    this.startAt = 0;
    this.loaded = new Set();
    this.dirty = false;
    this.results = null;
    this.timers = { wait: null, start: null, end: null, show: null };
    this.tick = null;

    this.timers.wait = setTimeout(() => { this.timers.wait = null; this.beginCountdown(); }, START_FALLBACK_MS);
  }

  // ------------------------------------------------------------------ flow

  beginCountdown() {
    if (!this.isGameActive || this.phase !== 'wait') return;
    clearTimeout(this.timers.wait);
    this.timers.wait = null;
    this.phase = 'countdown';
    this.startAt = this.now() + COUNTDOWN_MS;
    this.timers.start = setTimeout(() => this.beginPlay(), COUNTDOWN_MS);
    this.broadcastState();
  }

  beginPlay() {
    if (!this.isGameActive || this.phase !== 'countdown') return;
    this.timers.start = null;
    this.phase = 'play';
    this.timers.end = setTimeout(() => this.timeUp(), this.duration * 1000 + GRACE_MS);
    this.tick = setInterval(() => { if (this.dirty) this.broadcastProgress(); }, BROADCAST_MS);
    this.broadcastState();
  }

  timeUp() {
    this.timers.end = null;
    if (this.phase !== 'play') return;
    for (const id of this.order) if (!this.rec[id].done) this.finalize(id, this.duration * 1000);
    this.endRace();
  }

  allDone() {
    return this.order.every((id) => this.rec[id].done);
  }

  endRace() {
    if (this.phase === 'over') return;
    this.phase = 'over';
    clearTimeout(this.timers.end);
    this.timers.end = null;
    clearInterval(this.tick);
    this.tick = null;

    const list = this.order.map((id) => ({ id, name: this.names[id], ...this.rec[id].result }));
    list.sort((a, b) => (a.dq - b.dq) || (b.wpm - a.wpm) || (b.acc - a.acc));
    let rank = 0;
    let prev = null;
    list.forEach((r, i) => {
      const k = `${r.dq}|${r.wpm}`;
      if (k !== prev) rank = i + 1;
      prev = k;
      r.rank = rank;
    });
    this.results = list;
    this.broadcastState();
    this.timers.show = setTimeout(() => { this.timers.show = null; if (this.isGameActive) this.finish(); }, RESULT_SHOW_MS);
  }

  finish() {
    const rows = this.results.map((r) => ({
      id: r.id,
      name: r.name,
      score: r.dq ? 0 : r.wpm,
      rank: r.rank,
      note: r.dq ? { k: 'typing.note.dq' } : { k: 'typing.note.result', p: { acc: r.acc, raw: r.raw } }
    }));
    let title;
    if (!rows.length) title = { k: 'typing.final.over' };
    else if (this.initialPlayers === 1) title = rows[0].score > 0 ? { k: 'typing.final.solo', p: { wpm: rows[0].score } } : { k: 'typing.final.soloNone' };
    else if (rows.filter((r) => r.rank === 1).length > 1) title = { k: 'typing.final.tie' };
    else title = { k: 'typing.final.wins', p: { name: rows[0].name, wpm: rows[0].score } };
    this.room.finishGame({ title, subtitle: { k: 'typing.final.sub', p: { sec: this.duration } }, rows, delayMs: RETURN_TO_LOBBY_MS });
  }

  // --------------------------------------------------------------- messages

  handleMessage(odId, type, payload) {
    if (!this.isGameActive || !this.rec[odId] || !this.order.includes(odId)) return;
    const p = payload && typeof payload === 'object' ? payload : {};
    switch (type) {
      case 'typing-page-loaded':
        this.loaded.add(odId);
        this.sendState(odId);
        if (this.phase === 'wait' && this.loaded.size >= this.order.length) this.beginCountdown();
        return;
      case 'typing-progress': return this.progress(odId, p, false);
      case 'typing-finish': return this.progress(odId, p, true);
    }
  }

  /** Validate a progress / finish message and apply it. */
  progress(odId, p, wantsFinish) {
    if (this.phase !== 'play') return;
    const r = this.rec[odId];
    if (r.done) return;
    const t = this.now();
    if (!wantsFinish && t - r.lastAt < PROGRESS_MIN_GAP_MS) return;
    if (typeof p.typed !== 'string' || p.typed.length > this.text.length + 1) return;
    const elapsed = t - this.startAt;
    if (elapsed < 0) return;
    r.lastAt = t;
    r.typed = p.typed;
    r.ks = clampInt(p.keystrokes, 0, 100000);
    r.mistakes = clampInt(p.mistakes, 0, 100000);
    // Nobody types faster than MAX_CPS: more characters than that means pasted or scripted text.
    if (r.typed.length > MAX_CPS * (elapsed / 1000 + 0.5) + 5) r.dq = true;
    const s = scoreTyped(this.text, r.typed);
    r.samples.push({ t: Math.min(elapsed, this.duration * 1000), c: s.correct });
    this.dirty = true;

    if (s.complete && (wantsFinish || r.typed.length >= this.text.length)) {
      this.finalize(odId, Math.min(this.duration * 1000, Math.max(1000, elapsed - LATENCY_MS)));
    } else if (wantsFinish && elapsed >= this.duration * 1000 - 300) {
      this.finalize(odId, this.duration * 1000);
    }
    if (r.done && this.allDone()) this.endRace();
    else if (r.done) this.broadcastProgress();
  }

  /** Compute a player's authoritative result. */
  finalize(odId, ms) {
    const r = this.rec[odId];
    if (r.done) return;
    r.done = true;
    const s = scoreTyped(this.text, r.typed);
    const wpm = wpmOf(s.correct, ms);
    const keystrokes = Math.max(r.ks, r.typed.length);
    const raw = wpmOf(keystrokes, ms);
    const errors = Math.max(r.mistakes, s.wrong);
    const acc = keystrokes > 0 ? Math.max(0, Math.min(100, round1((1 - errors / keystrokes) * 100))) : 0;
    if (wpm > MAX_WPM || raw > MAX_WPM * 1.15) r.dq = true;

    // cumulative net wpm every second and per-second speed for the consistency score
    const series = [];
    const speeds = [];
    let at = 0;
    let lastC = 0;
    let lastSecC = 0;
    const samples = [...r.samples, { t: ms, c: s.correct }].sort((a, b) => a.t - b.t);
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    for (let sec = 1; sec <= seconds; sec++) {
      const limit = Math.min(sec * 1000, ms);
      while (at < samples.length && samples[at].t <= limit) lastC = samples[at++].c;
      series.push(round1(wpmOf(lastC, limit)));
      speeds.push((lastC - lastSecC) * 12);
      lastSecC = lastC;
    }
    r.result = {
      wpm: r.dq ? 0 : round1(wpm),
      raw: r.dq ? 0 : round1(raw),
      acc,
      consistency: consistency(speeds),
      correct: s.correct,
      errors,
      chars: r.typed.length,
      complete: s.complete,
      seconds: round1(ms / 1000),
      dq: r.dq,
      series: r.dq ? [] : series
    };
  }

  // --------------------------------------------------------------- snapshots

  progressList() {
    const elapsed = Math.max(0, this.now() - this.startAt);
    return this.order.map((id) => {
      const r = this.rec[id];
      const res = r.result;
      const s = scoreTyped(this.text, r.typed);
      return {
        id,
        c: res ? res.correct : s.correct,
        pos: r.typed.length,
        wpm: res ? res.wpm : round1(wpmOf(s.correct, Math.min(elapsed, this.duration * 1000))),
        done: r.done,
        dq: r.dq && r.done
      };
    });
  }

  broadcastProgress() {
    this.dirty = false;
    this.room.broadcast({ type: 'typing-progress', players: this.progressList() });
  }

  stateFor(odId) {
    const t = this.now();
    const r = odId && this.rec[odId];
    return {
      type: 'typing-state',
      you: odId,
      language: this.lang,
      duration: this.duration,
      source: this.source,
      phase: this.phase,
      text: this.text,
      startIn: this.phase === 'countdown' ? Math.max(0, this.startAt - t) : 0,
      timeLeft: this.phase === 'play' ? Math.max(0, this.startAt + this.duration * 1000 - t) : 0,
      players: this.order.map((id) => ({ id, name: this.names[id] })),
      progress: this.phase === 'wait' ? [] : this.progressList(),
      mine: r ? { typed: r.typed, ks: r.ks, mistakes: r.mistakes, done: r.done } : null,
      results: this.phase === 'over' ? this.results : null
    };
  }

  sendState(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, this.stateFor(odId));
  }

  spectatorSync(odId) {
    const ws = this.room.getWsByUserId(odId);
    if (ws) this.room.send(ws, { ...this.stateFor(null), you: odId, spectator: true });
  }

  broadcastState() {
    for (const id of this.order) this.sendState(id);
    for (const id of this.room.spectatorIds()) this.spectatorSync(id);
  }

  // ------------------------------------------------------------------ leaving

  onPlayerLeft(odId) {
    const i = this.order.indexOf(odId);
    if (i < 0) return;
    this.order.splice(i, 1);
    this.loaded.delete(odId);
    if (!this.order.length) { this.cleanup(); return; }
    if (this.phase === 'wait' && this.loaded.size >= this.order.length) return this.beginCountdown();
    if (this.phase === 'play' && this.allDone()) return this.endRace();
    this.broadcastState();
  }

  cleanup() {
    this.isGameActive = false;
    for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); this.timers[k] = null; }
    clearInterval(this.tick);
    this.tick = null;
  }
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
}
