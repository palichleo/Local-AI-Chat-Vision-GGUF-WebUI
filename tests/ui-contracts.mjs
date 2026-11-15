import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async name => (await readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

/** The names of what a setup function returns: its last `return { … }` (spreads followed). */
async function returned(name, seen = new Set()) {
  const source = await read(name),
    at = source.lastIndexOf('\n  return {');
  assert.ok(at >= 0, name + ' returns nothing');
  let depth = 0,
    end = source.indexOf('{', at);
  const start = end;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  // Without its comments (a key's own documentation precedes it).
  const block = source
      .slice(start + 1, end)
      .replace(/\/\*[^]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''),
    names = new Set();
  // Top level of the object only: what follows its commas.
  let level = 0,
    part = '';
  for (const character of block + ',') {
    if ('{(['.includes(character)) level++;
    if ('})]'.includes(character)) level--;
    if (character === ',' && level === 0) {
      const key = part.trim().match(/^(?:async\s+)?(?:get\s+)?(\.\.\.)?([A-Za-z_$][\w$]*)/);
      if (key && !key[1]) names.add(key[2]);
      part = '';
    } else part += character;
  }
  seen.add(name);
  return names;
}

// Each module's interface as app.js uses it: a name it calls that the module no longer gives is a
// button that stops half-way (« Nouvelle conversation » and workflowsUI.reset, gone in 0.5.87).
const MODULES = {
  workflowsUI: ['native-workflow-ui.mjs', 'generation-runtime.mjs'],
  assetsUI: ['assets-ui.mjs'],
  studioUI: ['studio.mjs'],
  generationUI: ['generation-ui.mjs'],
  projectUI: ['project-navigation.mjs'],
  contextMeter: ['context-meter.mjs'],
};

test('app.js calls only what its modules give', async () => {
  const app = await read('app.js');
  for (const [name, files] of Object.entries(MODULES)) {
    const given = new Set();
    for (const file of files) for (const key of await returned(file)) given.add(key);
    const used = new Set([...app.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map(match => match[1]));
    assert.ok(used.size, name + ' is used');
    assert.deepEqual([...used].filter(key => !given.has(key)), [], name);
  }
});
