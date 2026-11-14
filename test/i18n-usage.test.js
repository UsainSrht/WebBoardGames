import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAME_CONFIGS, CATEGORIES } from '../src/games/config.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const core = JSON.parse(read('public_html/i18n/core.json'));
const has = (key) => key in core.en && key in core.tr;
const hasPlural = (key) => has(key) || (has(`${key}_one`) && has(`${key}_other`));

test('site files only use keys that exist in core.json', () => {
  const missing = [];
  for (const file of ['public_html/game.html', 'public_html/game.js', 'public_html/core.js', 'public_html/index.js', 'public_html/404.html', 'public_html/index.html', 'public_html/tr/index.html']) {
    const src = read(file);
    const keys = new Set();
    for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) keys.add(pair.split(':')[1]?.trim());
    for (const m of src.matchAll(/\bt\(\s*'([a-z][\w.]*\.[\w.]+)'/gi)) keys.add(m[1]);
    for (const k of keys) if (k && !k.endsWith('.') && !hasPlural(k)) missing.push(`${file}: ${k}`);
  }
  assert.deepEqual(missing, []);
});

test('server messages sent as keys exist in core.json', () => {
  const src = read('src/durable-objects/GameRoom.js');
  const missing = [...new Set([...src.matchAll(/\bk:\s*'([\w.]+)'/g)].map((m) => m[1]))].filter((k) => !hasPlural(k));
  assert.deepEqual(missing, []);
});

test('every game and category has translated catalogue text', () => {
  const missing = [];
  for (const [id, cfg] of Object.entries(GAME_CONFIGS)) {
    for (const part of ['name', 'desc']) if (!has(`games.${id}.${part}`)) missing.push(`games.${id}.${part}`);
    if (!cfg.category || !CATEGORIES.includes(cfg.category)) missing.push(`${id}: category`);
  }
  for (const c of CATEGORIES) if (!has(`cat.${c}`)) missing.push(`cat.${c}`);
  assert.deepEqual(missing, []);
});
