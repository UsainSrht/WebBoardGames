import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { GAME_CONFIGS } from '../../src/games/config.js';

const ROOT = new URL('../../', import.meta.url);

export const dictionary = (ns) => JSON.parse(readFileSync(new URL(`public_html/i18n/${ns}.json`, ROOT), 'utf8'));

/** Every dictionary key of `ns` written as a string literal in the given files (server, client script, fragment). */
export function usedKeys(ns, files) {
  const quote = '[\'"`]';
  const re = new RegExp(`${quote}(${ns}[.][A-Za-z0-9_.+-]*[A-Za-z0-9_])${quote}`, 'g');
  const out = new Set();
  for (const f of files) {
    const text = readFileSync(new URL(f, ROOT), 'utf8');
    for (const m of text.matchAll(re)) out.add(m[1]);
  }
  return out;
}

const has = (d, key) => key in d || `${key}_other` in d;

/** Every key referenced by the game's server and client code exists in both languages. */
export function assertKeysExist(ns, files) {
  const d = dictionary(ns);
  const keys = usedKeys(ns, files);
  assert.ok(keys.size > 0, `no ${ns} keys found in ${files.join(', ')}`);
  for (const k of keys) {
    assert.ok(has(d.en, k), `${k} missing in en`);
    assert.ok(has(d.tr, k), `${k} missing in tr`);
  }
  return keys;
}

/** The lobby translates option labels, hints and choices through the dictionary. */
export function assertOptionKeys(id) {
  const d = dictionary(id);
  for (const opt of GAME_CONFIGS[id].options) {
    const base = `${id}.opt.${opt.key}`;
    const need = [base, ...(opt.hint ? [`${base}.hint`] : []), ...opt.choices.map((c) => `${base}.${c.value}`)];
    for (const k of need) {
      assert.ok(k in d.en && k in d.tr, `${k} missing`);
    }
  }
}

/** Server message values: a { k, p } object whose key exists in the dictionary. */
export function assertMsg(ns, msg, key) {
  assert.ok(msg && typeof msg === 'object' && typeof msg.k === 'string', `expected a message object, got ${JSON.stringify(msg)}`);
  const d = dictionary(ns);
  assert.ok(has(d.en, msg.k) && has(d.tr, msg.k), `${msg.k} is not translated`);
  if (key) assert.equal(msg.k, key);
  for (const v of Object.values(msg.p || {})) if (v && typeof v === 'object' && v.k) assertMsg(ns, v);
}
