import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// "No emojis anywhere" is a project rule. Letters of any language (Turkish ç ğ ı ö ş ü) are fine.
// Banned: emoji and pictographs, dingbats, arrows, geometric shapes, misc technical/symbols, variation selectors.
const BANNED = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/u;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIRS = ['src', 'public_html', 'test', 'styles', 'scripts'];
const FILES = ['README.md'];
const EXT = new Set(['.js', '.mjs', '.html', '.css', '.json', '.md', '.webmanifest', '.svg', '.toml']);
const SKIP = new Set(['node_modules', '.git', '.wrangler', 'vendor', 'tailwind.css', 'package-lock.json']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.has(extname(name))) out.push(full);
  }
  return out;
}

test('no emoji or emoji-like symbols anywhere in the project', () => {
  const files = [...DIRS.flatMap((d) => walk(join(ROOT, d))), ...FILES.map((f) => join(ROOT, f))];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(BANNED);
      if (m) offenders.push(`${file.replace(ROOT, '')}:${i + 1} U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
    });
  }
  assert.deepEqual(offenders, [], 'use SVG icons instead of emoji / symbols');
});
