import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../lib/engine.mjs';

// A program standing for the engine file: it answers --version with `answer`, on its error stream.
const imitating = answer => (_command, args, options) =>
  spawn(
    process.execPath,
    ['--input-type=module', '-e', `console.error(${JSON.stringify(answer)}); process.exit(1)`, '--', ...args],
    options,
  );

test('a file that is not llama-server is named before the model is loaded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const enginePath = join(directory, process.platform === 'win32' ? 'llama.exe' : 'llama'),
    modelPath = join(directory, 'model.gguf');
  await writeFile(enginePath, 'engine', { mode: 0o700 });
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  const engine = new Engine({ spawnProcess: imitating("error: unknown command '--version'"), cacheDir: directory });
  await assert.rejects(
    engine.start({ enginePath, modelPath, projectorPath: '', contextSize: 4096, gpuLayers: 0 }),
    /n’est pas llama-server : llama(\.exe)? répond « error: unknown command '--version' ».*Choisis llama-server/,
  );
  assert.equal(engine.state, 'error');
  assert.equal(engine.child, null, 'nothing is left running');
});

test('a stop while the file is asked what it is leaves nothing launched behind it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const enginePath = join(directory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'),
    modelPath = join(directory, 'model.gguf');
  await writeFile(enginePath, 'engine', { mode: 0o700 });
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  const launched = [];
  let asked;
  const asking = new Promise(resolve => (asked = resolve));
  // Answers --version like llama-server, after a moment: the stop arrives in between.
  const slow = (_command, args, options) => {
    launched.push(args[0]);
    asked();
    return spawn(
      process.execPath,
      ['--input-type=module', '-e', 'setTimeout(() => console.error("version: 1 (test)"), 300)', '--', ...args],
      options,
    );
  };
  const engine = new Engine({ spawnProcess: slow, cacheDir: directory });
  const starting = engine.start({ enginePath, modelPath, projectorPath: '', contextSize: 4096, gpuLayers: 0 });
  await asking;
  await engine.stop();
  await assert.rejects(starting, /Démarrage interrompu/);
  assert.deepEqual(launched, ['--version'], 'the model is not launched after the stop');
  assert.equal(engine.state, 'stopped');
  assert.equal(engine.child, null);
});
