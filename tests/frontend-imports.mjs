import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The browser refuses the whole page when one named import is missing: other tests replace
// app.js imports with stubs, so this checks every import between the page's modules directly.
test('every named import between the page modules exists', async () => {
  const folder = new URL('../public/', import.meta.url);
  const files = (await readdir(folder)).filter(name => /\.(mjs|js)$/.test(name));
  const sources = new Map();
  for (const name of files) sources.set(name, await readFile(new URL(name, folder), 'utf8'));
  const exported = source =>
    new Set([
      ...[...source.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
      ...[...source.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(m =>
        m[1].split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(Boolean),
      ),
    ]);
  const missing = [];
  for (const [name, source] of sources)
    for (const [, names, target] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
      assert.ok(sources.has(target), `${name} imports ${target}, which does not exist`);
      const available = exported(sources.get(target));
      for (const imported of names.split(',').map(part => part.trim().split(/\s+as\s+/)[0]).filter(Boolean))
        if (!available.has(imported)) missing.push(`${name} → ${target}: ${imported}`);
    }
  assert.deepEqual(missing, []);
});
