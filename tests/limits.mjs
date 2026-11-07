import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { normalizeConfig } from '../lib/engine.mjs';
import { waitForModel } from '../public/model-ready.mjs';

test('contexte et sortie : migration et validation indépendantes', () => {
  const legacy = { enginePath: '', modelPath: '', projectorPath: '', contextSize: 8192, gpuLayers: 0 };
  assert.equal(normalizeConfig(legacy).maxOutputTokens, 4096);
  assert.equal(normalizeConfig({ ...legacy, contextSize: 262144, maxOutputTokens: 32768 }).maxOutputTokens, 32768);
  for (const invalid of [{ maxOutputTokens: 0 }, { maxOutputTokens: 8193 }, { maxOutputTokens: 40000 }, { contextSize: 262145 }, { contextSize: 1024, maxOutputTokens: 2048 }]) {
    assert.throws(() => normalizeConfig({ ...legacy, ...invalid }));
  }
});

test('chaque choix de contexte arrive au moteur, chaque plafond de sortie arrive aux requêtes', { timeout: 20000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-limits-'));
  let app;
  try {
    const modelPath = join(folder, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    app = await createApplication({ port: 0, dataDir: folder, spawnProcess: (_command, args, options) => spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url)), ...args], options) });
    const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const api = async (route, body, options = {}) => fetch(`${app.url}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
    const html = await (await fetch(app.url)).text();
    const select = html.match(/<select id="context-size">([\s\S]*?)<\/select>/)[1];
    const sizes = [...select.matchAll(/value="(\d+)"/g)].map((match) => Number(match[1]));
    assert.deepEqual(sizes, [4096, 8192, 16384, 32768, 65536, 131072, 262144]);
    for (const [index, contextSize] of sizes.entries()) {
      const maxOutputTokens = [1024, 2048, 4096, 8192, 16384, 32768, 32768][index];
      const config = { enginePath: process.execPath, modelPath, projectorPath: '', contextSize, maxOutputTokens, gpuLayers: 0 };
      assert.equal((await api('config', config)).status, 200);
      await waitForModel(api, new AbortController().signal, () => {});
      const response = await api('chat', { messages: [{ role: 'user', content: 'Test' }] });
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`Contexte ${contextSize}`));
      const status = await (await api('status')).json();
      assert.ok(status.logs.some((line) => line === `Limite de sortie : ${maxOutputTokens}`));
      assert.deepEqual(JSON.parse(await readFile(join(folder, 'config.json'), 'utf8')), config);
      await api('stop', {});
    }
  } finally { await app?.close(); await rm(folder, { recursive: true, force: true }); }
});
