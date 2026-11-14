import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wordle, wordLists } from '../src/games/wordle.js';
import { cleanWord, feedback, hardViolation, lower, upper, solvePoints, speedBonus, letterStates, LAYOUT, ALPHABET } from '../public_html/games/wordle-core.js';
import * as EN from '../src/games/data/wordle-en.js';
import * as TR from '../src/games/data/wordle-tr.js';

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
const last = (room, to, type) => [...room.sent].reverse().find((m) => m.to === to && m.type === type);
function game(opts = {}, players = P('a', 'b'), words = ['crane', 'apple', 'ghost'], spectators = []) {
  const room = fakeRoom(spectators);
  const g = new Wordle(room, players, { language: 'en', rounds: 3, hard: 'off', time: 0, ...opts }, { words });
  for (const id of Object.keys(players)) g.handleMessage(id, 'wordle-page-loaded', {});
  return { g, room };
}

test('feedback with duplicate letters', () => {
  assert.equal(feedback('crane', 'crane'), 'ggggg');
  assert.equal(feedback('speed', 'abide'), 'xxyxy');
  assert.equal(feedback('allow', 'apple'), 'gyxxx');
  assert.equal(feedback('eerie', 'crane'), 'xxyxg');
  assert.equal(feedback('lolly', 'hello'), 'xyggx');
  assert.equal(feedback('aabbb', 'baaxx'), 'ygyxx');
  assert.equal(feedback('mamma', 'llama'), 'xyxgg');
  assert.equal(feedback('rotor', 'robot'), 'ggygx');
});

test('Turkish casing and alphabet', () => {
  assert.equal(lower('IĞDIR', 'tr'), 'ığdır');
  assert.equal(lower('İZMİR', 'tr'), 'izmir');
  assert.equal(upper('ışık', 'tr'), 'IŞIK');
  assert.equal(upper('iğne', 'tr'), 'İĞNE');
  assert.equal(lower('IĞDIR', 'en'), 'iğdir', 'English rules differ');
  assert.equal(cleanWord('KAPI ', 'tr'), null);
  assert.equal(cleanWord('KAPIŞ', 'tr'), 'kapış');
  assert.equal(cleanWord('İĞNEÇ', 'tr'), 'iğneç');
  assert.equal(cleanWord('quake', 'tr'), null, 'q is not a Turkish letter');
  assert.equal(cleanWord('ÇİÇEK', 'en'), null);
  assert.equal(cleanWord('abcd', 'en'), null);
  assert.equal(cleanWord(12345, 'en'), null);
  for (const l of ['en', 'tr']) {
    const keys = LAYOUT[l].join('');
    assert.equal([...keys].sort().join(''), [...ALPHABET[l]].sort().join(''), `${l} keyboard covers the alphabet`);
  }
});

test('hard mode', () => {
  const hist = [{ word: 'crane', fb: 'gxyxx' }];
  assert.equal(hardViolation('cabin', hist, 'en'), null);
  assert.equal(hardViolation('apple', hist, 'en').k, 'wordle.err.hardGreen');
  assert.equal(hardViolation('chest', hist, 'en').k, 'wordle.err.hardYellow');
  assert.deepEqual(hardViolation('ghost', hist, 'en').p, { pos: 1, letter: 'C' });
});

test('scoring helpers and letter states', () => {
  assert.equal(solvePoints(6), 1);
  assert.equal(solvePoints(1), 6);
  assert.equal(speedBonus(1, 3), 3);
  assert.equal(speedBonus(3, 3), 1);
  assert.equal(speedBonus(1, 1), 0);
  assert.equal(speedBonus(4, 5), 0);
  assert.deepEqual(letterStates([{ word: 'aab', fb: 'xgy' }, { word: 'bba', fb: 'gxy' }]), { a: 'g', b: 'g' });
});

test('word lists are sane', () => {
  for (const [name, mod] of [['en', EN], ['tr', TR]]) {
    const valid = mod.VALID.split('\n');
    const answers = mod.ANSWERS.split('\n');
    const alpha = ALPHABET[name];
    for (const list of [valid, answers]) {
      assert.equal(new Set(list).size, list.length, `${name} unique`);
      for (const w of list) {
        assert.equal([...w].length, 5, `${name} ${w} has 5 letters`);
        assert.ok([...w].every((c) => alpha.includes(c)), `${name} ${w} alphabet`);
        assert.equal(lower(w, name), w);
      }
    }
    assert.deepEqual(valid, [...valid].sort((a, b) => a.localeCompare(b, name)), `${name} valid sorted`);
    const vs = new Set(valid);
    for (const a of answers) assert.ok(vs.has(a), `${name} answer ${a} is valid`);
    assert.ok(answers.length >= 1000 && valid.length >= 5000);
    const file = readFileSync(new URL(`../public_html/data/wordle-${name}-valid.txt`, import.meta.url), 'utf8');
    assert.equal(file.trimEnd(), mod.VALID, `${name} static list matches the bundled one`);
  }
  assert.ok(TR.VALID.includes('çiçek') && TR.VALID.includes('ışık'));
  assert.ok(wordLists('en').valid.has('crane') && wordLists('en').valid.has('ghost'));
});

test('a race: colours, solve points, speed bonus, round flow', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { g, room } = game({ rounds: 1 });
    assert.equal(g.phase, 'play');
    g.handleMessage('a', 'wordle-guess', { word: 'ghost' });
    const sa = last(room, 'a', 'wordle-state');
    assert.equal(sa.mine.guesses[0].fb, feedback('ghost', 'crane'));
    assert.equal(sa.word, null);
    const sb = last(room, 'b', 'wordle-state');
    assert.deepEqual(sb.players.find((p) => p.id === 'a').board, [feedback('ghost', 'crane')]);
    assert.ok(!JSON.stringify(sb).includes('ghost'), 'others never see letters');
    assert.ok(!JSON.stringify(sb).includes('crane'), 'secret hidden during the round');
    g.handleMessage('b', 'wordle-guess', { word: 'crane' });
    g.handleMessage('a', 'wordle-guess', { word: 'crane' });
    assert.equal(g.phase, 'reveal');
    const s = last(room, 'a', 'wordle-state');
    assert.equal(s.word, 'crane');
    const rb = s.result.find((r) => r.id === 'b');
    const ra = s.result.find((r) => r.id === 'a');
    assert.deepEqual([rb.points, rb.bonus], [6, 3]);
    assert.deepEqual([ra.points, ra.bonus], [5, 2]);
    mock.timers.tick(6000);
    assert.equal(room.finishCount, 1);
    const rows = room.finished.rows;
    assert.equal(rows[0].id, 'b'); assert.equal(rows[0].score, 9); assert.equal(rows[0].rank, 1);
    assert.equal(rows[1].score, 7);
    assert.equal(room.finished.title.k, 'wordle.final.wins');
    assert.equal(rows[0].note.k, 'wordle.note.summary');
    g.cleanup();
  } finally { mock.timers.reset(); }
});

test('invalid guesses are rejected and cost nothing', () => {
  const { g, room } = game();
  for (const w of ['zzzzz', 'abc', '', null, { x: 1 }, 'toolongword', 'ÇİÇEK']) g.handleMessage('a', 'wordle-guess', { word: w });
  assert.equal(g.boards.a.guesses.length, 0);
  const rej = room.sent.filter((m) => m.type === 'wordle-reject');
  assert.equal(rej.length, 7);
  assert.ok(rej.every((m) => m.to === 'a' && m.message.k.startsWith('wordle.err.')));
  g.handleMessage('a', 'wordle-guess', undefined);
  g.handleMessage('zz', 'wordle-guess', { word: 'ghost' });
  g.cleanup();
});

test('six wrong guesses fail; everyone done ends the round with 0 points', () => {
  const { g, room } = game({ rounds: 1 }, P('a'));
  for (const w of ['ghost', 'apple', 'plane', 'brain', 'drain', 'train']) g.handleMessage('a', 'wordle-guess', { word: w });
  assert.equal(g.phase, 'reveal');
  assert.equal(last(room, 'a', 'wordle-state').result[0].status, 'failed');
  g.handleMessage('a', 'wordle-guess', { word: 'crane' });
  assert.equal(g.boards.a.guesses.length, 6);
  g.cleanup();
});

test('solo play has no speed bonus', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { g, room } = game({ rounds: 1 }, P('a'));
    g.handleMessage('a', 'wordle-guess', { word: 'crane' });
    mock.timers.tick(7000);
    assert.equal(room.finished.rows.length, 1);
    assert.equal(room.finished.rows[0].score, 6);
    assert.equal(room.finished.title.k, 'wordle.final.solo');
    g.cleanup();
  } finally { mock.timers.reset(); }
});

test('hard mode is enforced by the server', () => {
  const { g, room } = game({ hard: 'on' }, P('a'));
  g.handleMessage('a', 'wordle-guess', { word: 'crate' });
  g.handleMessage('a', 'wordle-guess', { word: 'ghost' });
  assert.equal(g.boards.a.guesses.length, 1);
  assert.equal(room.sent.filter((m) => m.type === 'wordle-reject').pop().message.k, 'wordle.err.hardGreen');
  g.cleanup();
});

test('timer ends the round, multi round flow and ranking ties', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { g, room } = game({ time: 120, rounds: 3 });
    g.handleMessage('a', 'wordle-guess', { word: 'ghost' });
    assert.ok(last(room, 'a', 'wordle-state').timeLeft > 119000);
    mock.timers.tick(120000);
    assert.equal(g.phase, 'reveal');
    assert.equal(last(room, 'b', 'wordle-state').word, 'crane');
    mock.timers.tick(9000);
    assert.equal(g.phase, 'play');
    assert.equal(g.round, 2);
    assert.equal(g.boards.a.guesses.length, 0);
    mock.timers.tick(120000); mock.timers.tick(9000);
    mock.timers.tick(120000); mock.timers.tick(6000);
    assert.equal(room.finishCount, 1);
    assert.equal(room.finished.title.k, 'wordle.final.tie');
    assert.deepEqual(room.finished.rows.map((r) => r.rank), [1, 1]);
    g.cleanup();
  } finally { mock.timers.reset(); }
});

test('a leaver never stalls the round', () => {
  const { g, room } = game({ rounds: 1 }, P('a', 'b', 'c'));
  g.handleMessage('a', 'wordle-guess', { word: 'crane' });
  g.handleMessage('b', 'wordle-guess', { word: 'crane' });
  assert.equal(g.phase, 'play');
  g.onPlayerLeft('c');
  assert.equal(g.phase, 'reveal');
  g.onPlayerLeft('a'); g.onPlayerLeft('b');
  assert.equal(g.isGameActive, false);
  assert.equal(room.finishCount, 0);
});

test('waiting for loads: start fallback timer', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const room = fakeRoom();
    const g = new Wordle(room, P('a', 'b'), { language: 'en', rounds: 1 }, { words: ['crane'] });
    g.handleMessage('a', 'wordle-page-loaded', {});
    assert.equal(g.phase, 'wait');
    mock.timers.tick(8000);
    assert.equal(g.phase, 'play');
    g.cleanup();
  } finally { mock.timers.reset(); }
});

test('spectator sync: public colours only, never the word during play', () => {
  const { g, room } = game({}, P('a', 'b'), ['crane'], ['host']);
  g.handleMessage('a', 'wordle-guess', { word: 'ghost' });
  g.spectatorSync('host');
  const s = last(room, 'host', 'wordle-state');
  assert.equal(s.spectator, true);
  assert.equal(s.mine, null);
  assert.equal(s.word, null);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('crane') && !json.includes('ghost'));
  assert.ok(room.sent.some((m) => m.to === 'host'), 'broadcast reaches spectators');
  g.cleanup();
});

test('Turkish game accepts Turkish input and uses Turkish words', () => {
  const room = fakeRoom();
  const g = new Wordle(room, P('a'), { language: 'tr', rounds: 1 }, { words: ['çiçek'] });
  g.handleMessage('a', 'wordle-page-loaded', {});
  g.handleMessage('a', 'wordle-guess', { word: 'ÇİÇEK' });
  assert.equal(g.phase, 'reveal');
  assert.equal(g.boards.a.guesses[0].fb, 'ggggg');
  const g2 = new Wordle(fakeRoom(), P('a'), { language: 'tr', rounds: 1 });
  assert.ok(wordLists('tr').answers.includes(g2.pickWord()));
  g.cleanup(); g2.cleanup();
});

test('typing indicator reveals only a count', () => {
  const { g, room } = game();
  g.handleMessage('a', 'wordle-typing', { n: 3 });
  assert.deepEqual(room.sent.filter((m) => m.type === 'wordle-typing').pop(), { type: 'wordle-typing', id: 'a', n: 3 });
  g.cleanup();
});

test('every message and option key exists in both languages', async () => {
  const { readFileSync } = await import('node:fs');
  const { GAME_CONFIGS } = await import('../src/games/config.js');
  const dict = JSON.parse(readFileSync(new URL('../public_html/i18n/wordle.json', import.meta.url), 'utf8'));
  const src = readFileSync(new URL('../src/games/wordle.js', import.meta.url), 'utf8') + readFileSync(new URL('../public_html/games/wordle-core.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/k: '(wordle\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 0);
  const has = (k) => ['en', 'tr'].every((l) => k in dict[l] || `${k}_other` in dict[l]);
  for (const k of keys) assert.ok(has(k), k);
  const cfg = GAME_CONFIGS.wordle;
  assert.equal(cfg.available, true);
  for (const o of cfg.options) {
    assert.ok(has(`wordle.opt.${o.key}`), o.key);
    for (const c of o.choices) assert.ok(has(`wordle.opt.${o.key}.${c.value}`), `${o.key}.${c.value}`);
  }
});
