import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Typing, generateText, COUNTDOWN_MS, MAX_WPM } from '../src/games/typing.js';
import { scoreTyped, seededRng, wpmOf, consistency } from '../public_html/games/typing-core.js';
import { WORDS_TR } from '../src/games/data/typing-words-tr.js';
import { QUOTES_EN, QUOTES_TR } from '../src/games/data/typing-quotes.js';

function fakeRoom(spectators = []) {
  return {
    sent: [], finished: null, finishCount: 0,
    broadcast(m) { this.sent.push(m); },
    send(ws, m) { this.sent.push({ to: ws.id, ...m }); },
    getWsByUserId(id) { return { id }; },
    spectatorIds() { return spectators; },
    finishGame(p) { this.finished = p; this.finishCount++; }
  };
}
const P = (...ids) => Object.fromEntries(ids.map((i) => [i, { odId: i, name: i.toUpperCase() }]));
const TEXT = 'the quick brown fox jumps over the lazy dog and keeps running far away';
const last = (room, to, type) => [...room.sent].reverse().find((m) => m.to === to && m.type === type);

/** A running race: fake clock, fixed text, countdown done. */
function race(opts = {}, players = P('a', 'b'), spectators = []) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const room = fakeRoom(spectators);
  const g = new Typing(room, players, { language: 'en', duration: 30, source: 'words', ...opts }, { text: TEXT, seed: 1 });
  for (const id of Object.keys(players)) g.handleMessage(id, 'typing-page-loaded', {});
  mock.timers.tick(COUNTDOWN_MS);
  return { g, room };
}
const done = (g) => { g.cleanup(); mock.timers.reset(); };

test('text generation is seeded and language aware', () => {
  const a = generateText('en', 'words', 30, seededRng(5));
  const b = generateText('en', 'words', 30, seededRng(5));
  const c = generateText('en', 'words', 30, seededRng(6));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.length >= 30 * 14);
  assert.ok(!/\s{2}/.test(a) && !a.startsWith(' ') && !a.endsWith(' '));
  const tr = generateText('tr', 'words', 60, seededRng(2));
  const known = new Set(WORDS_TR.split(' '));
  assert.ok(tr.split(' ').every((w) => known.has(w)));
  const q = generateText('en', 'quotes', 120, seededRng(3));
  assert.ok(QUOTES_EN.some((x) => q.includes(x)));
  assert.ok(q.length >= 120 * 14);
  const qt = generateText('tr', 'quotes', 15, seededRng(3));
  assert.ok(QUOTES_TR.some((x) => qt.includes(x)));
  assert.ok(/[çğıöşü]/.test(generateText('tr', 'quotes', 120, seededRng(9))));
});

test('scoring maths', () => {
  const t = 'ab cd ef';
  assert.deepEqual(scoreTyped(t, ''), { correct: 0, wrong: 0, length: 0, complete: false, words: 0 });
  assert.equal(scoreTyped(t, 'ab c').correct, 4);
  assert.equal(scoreTyped(t, 'ab cd ef').correct, 8);
  assert.equal(scoreTyped(t, 'ab cd ef').complete, true);
  const bad = scoreTyped(t, 'ax cd e');
  assert.equal(bad.correct, 5);
  assert.ok(bad.wrong >= 1);
  assert.equal(scoreTyped(t, 'abc ').correct, 2, 'extra letter breaks the space');
  assert.equal(wpmOf(300, 60000), 60);
  assert.equal(wpmOf(10, 0), 0);
  assert.equal(consistency([60, 60, 60, 60]), 100);
  assert.ok(consistency([10, 100, 10, 100]) < 60);
});

test('countdown, live progress and perfect run', () => {
  const { g, room } = race({ duration: 30 }, P('a'));
  assert.equal(g.phase, 'play');
  assert.equal(last(room, 'a', 'typing-state').text, TEXT);
  mock.timers.tick(10000);
  g.handleMessage('a', 'typing-progress', { typed: TEXT.slice(0, 20), keystrokes: 20, mistakes: 0 });
  mock.timers.tick(300);
  const prog = last({ sent: room.sent.map((m) => ({ to: 'x', ...m })) }, 'x', 'typing-progress');
  assert.ok(prog.players[0].c > 0 && prog.players[0].pos === 20);
  mock.timers.tick(8000);
  g.handleMessage('a', 'typing-finish', { typed: TEXT, keystrokes: TEXT.length, mistakes: 0 });
  assert.equal(g.phase, 'over');
  const r = last(room, 'a', 'typing-state').results[0];
  assert.equal(r.complete, true);
  assert.equal(r.correct, TEXT.length);
  assert.equal(r.acc, 100);
  const ms = 18300 - 250;
  assert.ok(Math.abs(r.wpm - Math.round(wpmOf(TEXT.length, ms) * 10) / 10) < 0.2);
  assert.ok(r.series.length >= 17);
  mock.timers.tick(10000);
  assert.equal(room.finishCount, 1);
  assert.equal(room.finished.title.k, 'typing.final.solo');
  assert.equal(room.finished.rows[0].rank, 1);
  done(g);
});

test('accuracy uses mistakes, time-up uses the full duration', () => {
  const { g, room } = race({ duration: 15 }, P('a', 'b'));
  mock.timers.tick(5000);
  g.handleMessage('a', 'typing-progress', { typed: 'the quick brown ', keystrokes: 20, mistakes: 4 });
  g.handleMessage('b', 'typing-progress', { typed: 'the qxick', keystrokes: 9, mistakes: 1 });
  mock.timers.tick(10000);
  g.handleMessage('a', 'typing-finish', { typed: 'the quick brown fox ju', keystrokes: 30, mistakes: 4 });
  assert.equal(g.rec.a.done, true);
  assert.equal(g.rec.a.result.seconds, 15);
  assert.equal(g.rec.a.result.acc, Math.round((1 - 4 / 30) * 1000) / 10);
  assert.equal(g.phase, 'play', 'b has not finished yet');
  mock.timers.tick(2600); // grace expires: b is finalised from its last progress
  assert.equal(g.phase, 'over');
  const res = last(room, 'a', 'typing-state').results;
  assert.equal(res[0].id, 'a');
  assert.equal(res[1].id, 'b');
  assert.ok(res[1].errors >= 1);
  assert.deepEqual(res.map((r) => r.rank), [1, 2]);
  done(g);
});

test('an early finish before the time is up is only progress unless the text is complete', () => {
  const { g } = race({ duration: 30 }, P('a'));
  mock.timers.tick(3000);
  g.handleMessage('a', 'typing-finish', { typed: 'the quick', keystrokes: 9, mistakes: 0 });
  assert.equal(g.rec.a.done, false);
  done(g);
});

test('impossible speed is disqualified', () => {
  const { g, room } = race({ duration: 30 }, P('a', 'b'));
  mock.timers.tick(1000);
  g.handleMessage('a', 'typing-finish', { typed: TEXT, keystrokes: TEXT.length, mistakes: 0 });
  assert.equal(g.rec.a.done, true);
  assert.equal(g.rec.a.result.dq, true);
  assert.equal(g.rec.a.result.wpm, 0);
  mock.timers.tick(32600);
  const res = last(room, 'b', 'typing-state').results;
  assert.equal(res[res.length - 1].id, 'a', 'cheater ranks last');
  assert.equal(res[res.length - 1].rank, 2);
  done(g);
});

test('hostile input is ignored', () => {
  const { g } = race({ duration: 30 }, P('a'));
  mock.timers.tick(2000);
  for (const bad of [undefined, null, 5, {}, { typed: 5 }, { typed: 'x'.repeat(5000) }, { typed: [] }]) g.handleMessage('a', 'typing-progress', bad);
  g.handleMessage('zz', 'typing-progress', { typed: 'a' });
  g.handleMessage('a', 'typing-progress', { typed: 'the', keystrokes: 'lots', mistakes: -5 });
  assert.equal(g.rec.a.typed, 'the');
  assert.equal(g.rec.a.mistakes, 0);
  g.handleMessage('a', 'nonsense', {});
  done(g);
});

test('progress is ignored before the start', () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const room = fakeRoom();
  const g = new Typing(room, P('a'), { language: 'en', duration: 15 }, { text: TEXT });
  g.handleMessage('a', 'typing-page-loaded', {});
  assert.equal(g.phase, 'countdown');
  g.handleMessage('a', 'typing-progress', { typed: 'the', keystrokes: 3, mistakes: 0 });
  assert.equal(g.rec.a.typed, '');
  assert.ok(last(room, 'a', 'typing-state').startIn > 2000);
  done(g);
});

test('a leaver never stalls the race; the last one leaving stops everything', () => {
  const { g, room } = race({ duration: 30 }, P('a', 'b'));
  mock.timers.tick(5000);
  g.handleMessage('a', 'typing-finish', { typed: TEXT, keystrokes: TEXT.length, mistakes: 0 });
  assert.equal(g.phase, 'play');
  g.onPlayerLeft('b');
  assert.equal(g.phase, 'over');
  mock.timers.tick(10000);
  assert.equal(room.finishCount, 1);
  assert.equal(room.finished.rows.length, 1);
  g.onPlayerLeft('a');
  assert.equal(g.isGameActive, false);
  done(g);
});

test('start fallback when a player never loads', () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const g = new Typing(fakeRoom(), P('a', 'b'), { language: 'tr', duration: 15 }, { seed: 4 });
  g.handleMessage('a', 'typing-page-loaded', {});
  assert.equal(g.phase, 'wait');
  mock.timers.tick(8000);
  assert.equal(g.phase, 'countdown');
  mock.timers.tick(COUNTDOWN_MS);
  assert.equal(g.phase, 'play');
  mock.timers.tick(15000 + 2600);
  assert.equal(g.phase, 'over');
  done(g);
});

test('spectator sync shows the live race and no typed text of others', () => {
  const { g, room } = race({ duration: 30 }, P('a', 'b'), ['host']);
  mock.timers.tick(3000);
  g.handleMessage('a', 'typing-progress', { typed: 'the qu', keystrokes: 6, mistakes: 0 });
  g.spectatorSync('host');
  const s = last(room, 'host', 'typing-state');
  assert.equal(s.spectator, true);
  assert.equal(s.phase, 'play');
  assert.equal(s.mine, null);
  assert.ok(s.timeLeft > 0 && s.timeLeft <= 30000);
  assert.equal(s.progress.find((p) => p.id === 'a').pos, 6);
  assert.ok(!JSON.stringify(s.progress).includes('the qu'));
  const b = last(room, 'b', 'typing-state');
  assert.equal(b.mine.typed, '');
  done(g);
});

test('max speed constant is a human cap', () => {
  assert.equal(MAX_WPM, 300);
});

test('every message and option key exists in both languages', async () => {
  const { readFileSync } = await import('node:fs');
  const { GAME_CONFIGS } = await import('../src/games/config.js');
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/typing.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/typing.js', import.meta.url), 'utf8') + readFileSync(new URL('../public_html/games/wordle-core.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/k: '(typing\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 0);
  const has = (k) => ['en', 'tr'].every((l) => k in dict[l] || `${k}_other` in dict[l]);
  for (const k of keys) assert.ok(has(k), k);
  const cfg = GAME_CONFIGS.typing;
  assert.equal(cfg.available, true);
  for (const o of cfg.options) {
    assert.ok(has(`typing.opt.${o.key}`), o.key);
    for (const c of o.choices) assert.ok(has(`typing.opt.${o.key}.${c.value}`), `${o.key}.${c.value}`);
  }
});
