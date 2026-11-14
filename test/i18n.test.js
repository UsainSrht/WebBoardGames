import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../public_html/i18n/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// Characters that render as emoji are not allowed in any language.
const EMOJI = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

test('there is a dictionary for the site and every game', () => {
  assert.ok(files.includes('core.json'));
  for (const f of ['chess', 'uno', 'kingdomino', 'dice', 'rock-paper-scissors', 'hamsterball', 'poker', 'okey', 'pool', 'monopoly', 'wordle', 'typing', 'gofish', 'pisti', 'papaz']) {
    assert.ok(files.includes(`${f}.json`), `${f}.json exists`);
  }
});

for (const file of files) {
  const ns = file.replace('.json', '');
  const data = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));

  test(`${file}: English and Turkish have exactly the same keys`, () => {
    const en = Object.keys(data.en).sort();
    const tr = Object.keys(data.tr).sort();
    assert.deepEqual(tr.filter((k) => !(k in data.en)), [], 'keys only in Turkish');
    assert.deepEqual(en.filter((k) => !(k in data.tr)), [], 'keys missing in Turkish');
  });

  test(`${file}: keys are namespaced, texts are non-empty, placeholders match, no emoji`, () => {
    for (const [key, en] of Object.entries(data.en)) {
      assert.ok(ns === 'core' ? /^[a-z0-9]/i.test(key) : key.startsWith(`${ns}.`), `${key} must start with "${ns}."`);
      const tr = data.tr[key];
      assert.equal(typeof en, 'string');
      assert.ok(en.trim().length > 0, `${key} (en) is empty`);
      assert.ok(typeof tr === 'string' && tr.trim().length > 0, `${key} (tr) is empty`);
      assert.equal(placeholders(tr), placeholders(en), `${key}: placeholders differ between en and tr`);
      assert.ok(!EMOJI.test(en) && !EMOJI.test(tr), `${key} contains an emoji`);
    }
  });
}
