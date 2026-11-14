import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'tests', 'fixtures', 'fake-engine.mjs');
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';

function qwenFixture(withMtp, recurrent = false) {
  const u32 = n => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = n => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const layers = withMtp ? 33 : 32;
  const metadata = [
    str('general.architecture'),
    u32(8),
    str('qwen35'),
    str('qwen35.block_count'),
    u32(4),
    u32(33),
    str('qwen35.nextn_predict_layers'),
    u32(4),
    u32(1),
  ];
  if (recurrent)
    metadata.push(
      str('general.name'),
      u32(8),
      str('Test Qwen'),
      str('qwen35.attention.recurrent_layers'),
      u32(9),
      u32(7),
      u64(33),
      Buffer.from(Array.from({ length: 33 }, (_, i) => (i % 4 !== 3 ? 1 : 0))),
    );
  const tensors = [];
  for (let i = 0; i < layers; i++) tensors.push(str(`blk.${i}.attn_norm.weight`), u32(1), u64(1), u32(0), u64(i * 4));
  const header = Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(layers),
    u64(recurrent ? 5 : 3),
    ...metadata,
    ...tensors,
  ]);
  return Buffer.concat([header, Buffer.alloc((32 - (header.length % 32)) % 32), Buffer.alloc(256, 42)]);
}

async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail('Le statut attendu n’a pas été atteint en dix secondes.');
}

test('smoke local sans modèle réel', { timeout: 30000 }, async t => {
  assert.ok(existsSync(join(root, 'server.mjs')), 'Le serveur de l’application doit exister.');
  const { createApplication } = await import('../server.mjs');
  const folder = await mkdtemp(join(tmpdir(), 'atelier-local-smoke-'));
  let app;
  try {
    const modelPath = join(folder, 'modèle avec espaces Q6_K.gguf');
    const projectorPath = join(folder, 'projecteur vision.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    await writeFile(projectorPath, Buffer.from('GGUF\x03\0\0\0'));
    app = await createApplication({
      port: 0,
      dataDir: folder,
      spawnProcess: (_command, args, options) => spawn(process.execPath, [fixture, ...args], options),
    });
    const base = app.url;
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' };
    const call = (path, data, extra = {}) =>
      fetch(`${base}/api/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        ...extra,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    const status = async () => (await call('status')).json();
    const config = {
      enginePath: process.execPath,
      modelPath,
      projectorPath,
      contextSize: 8192,
      maxOutputTokens: 4096,
      gpuLayers: 0,
    };

    await t.test('l’application démarre sans moteur et protège son API', async () => {
      assert.equal(bootstrap.status.state, 'stopped');
      const page = await fetch(base);
      assert.equal(page.status, 200);
      const icon = await fetch(base + '/favicon.svg');
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
      assert.match(await page.text(), /<link rel="icon"[^>]*href="\/favicon\.svg"/);
      assert.match(await icon.text(), /<svg[^>]*viewBox="0 0 32 32"/);
      // The small logo, its fallback and its large sizes, and the mark of Moodix AI in the chat.
      for (const [path, type] of [
        ['/favicon.ico', 'image/x-icon'],
        ['/apple-touch-icon.png', 'image/png'],
        ['/icon-512.png', 'image/png'],
        ['/assets/moodix-mark.svg', 'image/svg+xml'],
      ]) {
        const served = await fetch(base + path);
        assert.equal(served.status, 200, path);
        assert.equal(served.headers.get('content-type'), type, path);
      }
      const texture = await fetch(base + '/assets/metallic-grain.png');
      assert.equal(texture.status, 200);
      assert.equal(texture.headers.get('content-type'), 'image/png');
      const textureBytes = Buffer.from(await texture.arrayBuffer());
      assert.deepEqual([...textureBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(textureBytes.length < 1500000);
      assert.equal((await fetch(base + '/material-light.mjs')).status, 200);
      assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(
        (
          await fetch(`${base}/api/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        401,
      );
      assert.equal((await call('start', {}, { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
      assert.equal((await call('chat', { messages: [{ role: 'user', content: 'Bonjour' }] })).status, 503);
    });

    await t.test('les chemins invalides sont signalés, les espaces et accents sont conservés', async () => {
      assert.equal((await call('config', { ...config, contextSize: -1 })).status, 400);
      assert.equal((await call('config', { ...config, modelPath: join(folder, 'absent.gguf') })).status, 200);
      assert.equal((await call('start', {})).status, 400);
      assert.equal((await call('config', config)).status, 200);
      assert.equal(JSON.parse(await readFile(join(folder, 'config.json'), 'utf8')).modelPath, modelPath);
    });

    await t.test('le premier message attend le démarrage automatique avec la vision', async () => {
      const { waitForModel } = await import('../public/model-ready.mjs');
      assert.equal((await fetch(`${base}/model-ready.mjs`)).status, 200);
      const states = [];
      const ready = await waitForModel(call, new AbortController().signal, s => states.push(s.state));
      assert.equal(ready.vision, true);
      assert.ok(states.includes('loading'));
      assert.equal(states.at(-1), 'ready');
      const response = await call('chat', {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Décris cette image.' },
              { type: 'image_url', image_url: { url: png } },
            ],
          },
        ],
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Image reçue par le moteur simulé/);
      await until(async () => !(await status()).busy);
      await call('stop', {});
    });

    await t.test('le moteur démarre, le texte et le raisonnement arrivent progressivement', async () => {
      assert.equal((await call('start', {})).status, 202);
      await until(async () => (await status()).state === 'ready');
      assert.equal((await call('preferences', { theme: 'light' })).status, 200);
      assert.equal((await status()).state, 'ready', 'Changer le thème ne doit pas arrêter le modèle.');
      assert.deepEqual(JSON.parse(await readFile(join(folder, 'config.json'), 'utf8')), config);
      assert.equal((await status()).vision, true);
      const response = await call('chat', { messages: [{ role: 'user', content: 'Bonjour' }], thinking: true });
      assert.equal(response.status, 200);
      const { readSSE } = await import('../public/stream.mjs');
      let text = '',
        reasoning = '';
      await readSSE(response.body, event => {
        text += event.choices?.[0]?.delta?.content ?? '';
        reasoning += event.choices?.[0]?.delta?.reasoning_content ?? '';
      });
      assert.equal(text, 'Bonjour, été ! Contexte 8192.');
      assert.equal(reasoning, 'Je réfléchis. ');
      await until(async () => !(await status()).busy);
    });

    await t.test('une image locale est relayée, les URL distantes sont refusées', async () => {
      const message = {
        role: 'user',
        content: [
          { type: 'text', text: 'Décris cette image.' },
          { type: 'image_url', image_url: { url: png } },
        ],
      };
      const response = await call('chat', { messages: [message] });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Image reçue par le moteur simulé/);
      await until(async () => !(await status()).busy);
      message.content[1].image_url.url = 'https://example.org/image.png';
      assert.equal((await call('chat', { messages: [message] })).status, 400);
      message.content = Array.from({ length: 65 }, () => ({ type: 'image_url', image_url: { url: png } }));
      assert.equal((await call('chat', { messages: [message] })).status, 400);
    });

    await t.test('annuler une réponse libère la conversation', async () => {
      const controller = new AbortController();
      const response = await call(
        'chat',
        { messages: [{ role: 'user', content: 'lent' }] },
        { signal: controller.signal },
      );
      const reader = response.body.getReader();
      await reader.read();
      assert.equal(
        (await call('history/clear', { confirm: true })).status,
        409,
        'La suppression attend la fin de la generation.',
      );
      controller.abort();
      await reader.cancel().catch(() => {});
      await until(async () => !(await status()).busy);
      assert.equal((await status()).state, 'ready');
    });

    await t.test('l’arrêt libère le moteur et la vision est refusée sans projecteur', async () => {
      assert.equal((await call('stop', {})).status, 200);
      assert.equal((await status()).state, 'stopped');
      await call('config', { ...config, projectorPath: '' });
      await call('start', {});
      await until(async () => (await status()).state === 'ready');
      assert.equal((await status()).vision, false);
      assert.equal(
        (
          await call('chat', {
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }] }],
          })
        ).status,
        400,
      );
      await call('stop', {});
    });

    await t.test('ouvrir un mode du Studio décharge le modèle, chargé ou en cours de chargement', async () => {
      await call('start', {});
      await until(async () => (await status()).state === 'ready');
      let body = await (await call('studio/release', {})).json();
      assert.equal(body.released, true);
      assert.equal(body.status.state, 'stopped');
      // Nothing to unload: said, without an error.
      const again = await call('studio/release', {});
      assert.equal(again.status, 200);
      assert.equal((await again.json()).released, false);
      // Still loading: stopped cleanly, and the model starts again afterwards.
      assert.equal((await call('start', {})).status, 202);
      body = await (await call('studio/release', {})).json();
      assert.equal(body.released, true);
      assert.equal((await status()).state, 'stopped');
      assert.equal((await call('start', {})).status, 202);
      await until(async () => (await status()).state === 'ready');
      await call('stop', {});
    });

    await t.test('les bibliothèques CUDA séparées du moteur sont transmises au processus', async () => {
      const native = join(folder, 'moteur local');
      const library = join(native, 'cuda_v12', process.platform === 'win32' ? 'ggml-cuda.dll' : 'libggml-cuda.so');
      const executable = join(native, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
      await mkdir(dirname(library), { recursive: true });
      await writeFile(library, 'fixture');
      await writeFile(executable, 'fixture', { mode: 0o700 });
      await call('config', { ...config, enginePath: executable, gpuLayers: 99 });
      await call('start', {});
      await until(async () => (await status()).state === 'ready');
      assert.ok(
        (await status()).logs.some(line => line.includes(library)),
        'Le moteur enfant doit recevoir le chemin du fichier de bibliothèque CUDA.',
      );
      await call('stop', {});
    });

    await t.test('le MTP déclaré sans tenseurs est neutralisé sans modifier le GGUF', async () => {
      const path = join(folder, 'Qwen3.5 MTP absent.gguf');
      const original = qwenFixture(false);
      await writeFile(path, original);
      await call('config', { ...config, modelPath: path });
      await call('start', {});
      await until(async () => (await status()).state === 'ready');
      assert.ok(
        (await status()).logs.some(line =>
          line.includes('qwen35.block_count=int:32,qwen35.nextn_predict_layers=int:0'),
        ),
      );
      assert.deepEqual(await readFile(path), original);
      await call('stop', {});
      await writeFile(path, qwenFixture(true));
      await call('start', {});
      await until(async () => (await status()).state === 'ready');
      assert.ok((await status()).logs.some(line => line.includes('Métadonnées : sans correction')));
      // llama.cpp's fitting has nothing to adjust (layers and context are set): it is off.
      assert.ok((await status()).logs.some(line => line === 'Ajustement à la carte : off'));
      await call('stop', {});
    });

    await t.test(
      'un tableau par couche est corrigé dans une copie locale, les poids et l’original restent identiques',
      async () => {
        const path = join(folder, 'Qwen3.5 tableau MTP.gguf');
        const original = qwenFixture(false, true);
        await writeFile(path, original);
        await call('config', { ...config, modelPath: path });
        await call('start', {});
        await until(async () => (await status()).state === 'ready');
        const launched = (await status()).logs
          .find(line => line.startsWith('Modèle lancé : '))
          .slice('Modèle lancé : '.length);
        assert.notEqual(launched, path);
        assert.deepEqual(await readFile(path), original);
        const corrected = await readFile(launched);
        assert.equal(corrected.length, original.length);
        assert.deepEqual(corrected.subarray(-256), original.subarray(-256));
        const { missingMtpOverride } = await import('../lib/gguf.mjs');
        assert.equal(await missingMtpOverride(launched), '');
        await call('stop', {});
      },
    );
  } finally {
    await app?.close();
    assert.ok(
      resolve(folder).startsWith(resolve(tmpdir()) + '\\') || resolve(folder).startsWith(resolve(tmpdir()) + '/'),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
