// Builds the Wordle / Typing word lists. Run from the dir that has the npm packages installed:
//   node build-lists.mjs <outDir> <downloadsDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const OUT = process.argv[2];
const DL = process.argv[3];
const naughty = require('naughty-words');
const trLower = (s) => s.replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase().normalize('NFC');
const readFreq = (f, lower) => {
  const m = new Map(); let rank = 0;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const [w, c] = line.trim().split(' ');
    if (!w || !c) continue;
    const lw = lower(w);
    if (!m.has(lw)) m.set(lw, { rank: rank++, count: Number(c) });
  }
  return m;
};
const bad = {
  en: new Set(naughty.en.map((x) => x.toLowerCase()).filter((x) => !x.includes(' '))),
  tr: new Set(naughty.tr.map((x) => trLower(x)).filter((x) => !x.includes(' ')))
};
// extra hand-picked exclusions (names, slurs and words that make poor secret words)
const EXTRA = {
  en: 'aaron abbey allah ashes bitch boobs bozos cocks coons crack cunts dicks dildo dyke fagot fucks gooks hoes horny jesus kikes negro nigga paki pussy raped rapes retard shits sluts spics twats whore tits wanks'.split(' '),
  tr: 'allah ahmet mehmet ayşe fatma zeynep hasan ali amcık göt siktir orospu yarak piç kahpe'.split(' ')
};
for (const k of ['en', 'tr']) for (const w of EXTRA[k]) bad[k].add(w);

mkdirSync(OUT + '/src-data', { recursive: true });
mkdirSync(OUT + '/public-data', { recursive: true });
const js = (name, obj) => writeFileSync(`${OUT}/src-data/${name}.js`, Object.entries(obj).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};\n`).join(''));

/* ---------------------------------------------------------------- English */
{
  const dict = readFileSync(process.cwd() + '/node_modules/word-list/words.txt', 'utf8').split('\n').filter(Boolean);
  const dictSet = new Set(dict);
  const d5 = dict.filter((w) => /^[a-z]{5}$/.test(w));
  const freq = readFreq(`${DL}/en_full.txt`, (w) => w.toLowerCase());
  const inflected = (w) =>
    (w.endsWith('s') && !w.endsWith('ss') && (dictSet.has(w.slice(0, -1)) || (w.endsWith('es') && dictSet.has(w.slice(0, -2))) || (w.endsWith('ies') && dictSet.has(w.slice(0, -3) + 'y')))) ||
    (w.endsWith('ed') && (dictSet.has(w.slice(0, -2)) || dictSet.has(w.slice(0, -1)) || dictSet.has(w.slice(0, -3)))) ||
    (w.endsWith('ly') && dictSet.has(w.slice(0, -2))) ||
    (w.endsWith('er') && dictSet.has(w.slice(0, -2)) && freq.get(w.slice(0, -2))?.rank < freq.get(w)?.rank);
  const names = new Set([...require('@stdlib/datasets-male-first-names-en')(), ...require('@stdlib/datasets-female-first-names-en')()].map((x) => x.toLowerCase()));
  const slang = new Set('aargh abbot abode adieu adios ahold aloha ariel baldy bambi bimbo bogus bloke booby booty chemo chico chino cisco clary coach cohen condo congo decaf dicky ditto dowry dunno fatso fella felon gimme golly gonna gotta grail hallo havoc hatch hotch howdy innit jaffa jihad juvie kappa kebab kiddo kinda krang laird lorry louie lupin macho mafia mamma mammy momma mommy nandu nazis pacey papal pappy pasha patsy phony pooja psych pubic sahib sarge sassy senor shush sissy sorta sybil takin taser thine thong twain voila wacko wench youse yahoo shalt tyler wanna haven doesn didn'.split(' '));
  const cand = d5.filter((w) => freq.has(w) && freq.get(w).count >= 900 && !names.has(w) && !slang.has(w) && !bad.en.has(w) && !inflected(w))
    .sort((a, b) => freq.get(a).rank - freq.get(b).rank).slice(0, 3200);
  const answers = [...cand].sort();
  const valid = [...new Set([...d5, ...answers])].sort();
  js('wordle-en', { VALID: valid.join('\n'), ANSWERS: answers.join('\n') });
  writeFileSync(`${OUT}/public-data/wordle-en-valid.txt`, valid.join('\n') + '\n');
  console.log('en valid', valid.length, 'answers', answers.length, '\ntop', cand.slice(0, 60).join(' '), '\ntail', cand.slice(-60).join(' '));

  // typing words: common words 2..9 letters in the dictionary
  const words = [];
  const two = 'an as at be by do go he if in is it me my no of on or so to up us we'.split(' ');
  for (const [w, { rank }] of [...freq.entries()].sort((a, b) => a[1].rank - b[1].rank)) {
    if (rank > 6000) break;
    if (!/^[a-z]{2,9}$/.test(w) || !dictSet.has(w) || bad.en.has(w)) continue;
    if (w.length === 2 && !two.includes(w)) continue;
    words.push(w);
    if (words.length >= 1000) break;
  }
  js('typing-words-en', { WORDS_EN: words.join(' ') });
  console.log('typing en', words.length, words.slice(0, 20).join(' '), '...', words.slice(-15).join(' '));
}

/* ---------------------------------------------------------------- Turkish */
{
  const raw = require('an-array-of-turkish-words');
  const TR = /^[abcçdefgğhıijklmnoöprsştuüvyz]+$/;
  const all = new Set(raw.map(trLower).filter((w) => TR.test(w)));
  const freq = readFreq(`${DL}/tr_full.txt`, trLower);
  // Zemberek master dictionary (Apache-2.0): roots with part of speech; no tag = noun
  const roots = new Map();
  for (const line of readFileSync(`${DL}/master-dictionary.dict`, 'utf8').split('\n')) {
    const m = line.match(/^(\S+)(?:\s+\[P:([A-Za-z]+))?/);
    if (!m) continue;
    const w = trLower(m[1]);
    if (!TR.test(w) || [...w].length !== 5) continue;
    roots.set(w, m[2] || 'Noun');
  }
  const trBlock = new Set('hotel motel cross norma kudüs yusuf reşit ender malik tayin lanet tanrı israr üstad mazur duble krema cemil ceren kemal murat hakan halim pound start trans geyşa light april tokyo porno penis sperm eroin ayyaş enayi hödük bunak ödlek züppe moruk hıyar şişko salak beleş zenci sidik idrar ishal kasık dışkı olmaz uymaz ölmez geçer gelen geçen gelir bilir kaçar çeker koyar çalar sever bindi kondu bastı çıktı girdi verdi yokum kaçta sudan'.split(' '));
  const POS = new Set(['Noun', 'Adj', 'Adv']);
  const cand = [...roots].filter(([w, p]) => POS.has(p) && !/m[ae]k$/.test(w) && freq.has(w) && freq.get(w).count >= 250 && !trBlock.has(w) && !bad.tr.has(w))
    .map(([w]) => w).sort((a, b) => freq.get(a).rank - freq.get(b).rank).slice(0, 3000);
  const answers = [...cand].sort((a, b) => a.localeCompare(b, 'tr'));
  const d5 = [...all].filter((w) => [...w].length === 5 && (freq.get(w)?.count ?? 0) >= 40);
  const extra = [...freq.entries()].filter(([w, v]) => v.count >= 600 && [...w].length === 5 && TR.test(w)).map(([w]) => w);
  const valid = [...new Set([...roots.keys(), ...d5, ...extra, ...answers])].sort((a, b) => a.localeCompare(b, 'tr'));
  js('wordle-tr', { VALID: valid.join('\n'), ANSWERS: answers.join('\n') });
  writeFileSync(`${OUT}/public-data/wordle-tr-valid.txt`, valid.join('\n') + '\n');
  console.log('tr valid', valid.length, 'answers', answers.length, '\ntop', cand.slice(0, 80).join(' '), '\ntail', cand.slice(-60).join(' '));

  const words = [];
  for (const [w, { rank }] of [...freq.entries()].sort((a, b) => a[1].rank - b[1].rank)) {
    if (rank > 8000) break;
    const n = [...w].length;
    if (n < 2 || n > 9 || !TR.test(w) || bad.tr.has(w)) continue;
    if (!all.has(w) && !all.has(w.replace(/(lar|ler)$/, ''))) continue;
    words.push(w);
    if (words.length >= 1000) break;
  }
  js('typing-words-tr', { WORDS_TR: words.join(' ') });
  console.log('typing tr', words.length, words.slice(0, 30).join(' '), '...', words.slice(-15).join(' '));
}
