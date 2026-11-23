// A quick static check of the module graph: every relative import resolves to a file that exists,
// and every named import is actually exported by that file. Catches the class of bug that otherwise
// only shows up as a blank canvas in headless Chrome.
//
// Usage: node tools/lint-imports.mjs

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const SRC = resolve(join(here, 'game/src'));

/** Every `export` name a module offers, including `export { a, b }` re-export lists. */
function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.split('=');
      const name = bits[0].trim();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const bits = part.split(/\s+as\s+/);
      const name = (bits[1] ?? bits[0]).trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(text)) names.add('default');
  return names;
}

/** Every named import, as { from, names[] }. */
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    const names = [];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const bits = part.split(/\s+as\s+/);
        const name = bits[0].trim();
        if (name) names.push(name);
      }
    }
    // A default import that is not braced (import x from './y.js').
    const bare = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (bare && !bare.startsWith('*')) names.push('default');
    out.push({ from: spec, names, raw: clause, spec });
  }
  return out;
}

const files = (await readdir(SRC)).filter((f) => f.endsWith('.js'));
const cache = new Map();
const problems = [];

async function exportsOfFile(path) {
  if (cache.has(path)) return cache.get(path);
  const text = await readFile(path, 'utf8');
  const set = exportsOf(text);
  cache.set(path, set);
  return set;
}

for (const file of files) {
  const path = join(SRC, file);
  const text = await readFile(path, 'utf8');
  for (const imp of importsOf(text)) {
    if (!imp.from.startsWith('.')) {
      problems.push(`${file}: bare specifier "${imp.from}" (the page's import map does not map it)`);
      continue;
    }
    if (!imp.from.endsWith('.js')) {
      problems.push(`${file}: relative import "${imp.from}" has no .js extension (the browser will 404)`);
    }
    const target = resolve(dirname(path), imp.from);
    let set;
    try {
      set = await exportsOfFile(target);
    } catch {
      problems.push(`${file}: cannot read ${imp.from}`);
      continue;
    }
    for (const name of imp.names) {
      if (!set.has(name)) problems.push(`${file}: imports { ${name} } from ${imp.from}, which does not export it`);
    }
  }
}

// Also check the HTML's script tags point at real files.
const html = await readFile(join(here, 'game/index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) {
    problems.push(`index.html: external reference "${ref}" (no network is allowed)`);
    continue;
  }
  if (!ref.startsWith('#')) {
    try {
      await readFile(resolve(join(here, 'game'), ref.replace(/^\.\//, '')));
    } catch {
      problems.push(`index.html: "${ref}" does not exist under game/`);
    }
  }
}

if (problems.length === 0) {
  console.log(`ok: ${files.length} modules, every import resolves and every name is exported`);
} else {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log('  -', p);
  process.exitCode = 1;
}
