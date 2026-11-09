import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chooseLocalFile } from '../lib/file-picker.mjs';
function fake(answer, calls = [], code = 0) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('close', 1);
    queueMicrotask(() => {
      if (answer?.code) child.emit('error', answer);
      else {
        child.stdout.emit('data', Buffer.from(answer));
        child.emit('close', code);
      }
    });
    return child;
  };
}
test('Windows picker returns Unicode paths without uploading or interpolating user paths into code', async () => {
  const calls = [],
    initialPath = 'C:\\modèles\\$(unsafe).gguf';
  const selected = await chooseLocalFile('model', {
    platform: 'win32',
    initialPath,
    spawnProcess: fake('C:\\modèles\\vision.gguf\r\n', calls),
  });
  assert.equal(selected, 'C:\\modèles\\vision.gguf');
  assert.equal(calls[0].options.shell, false);
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(!script.includes(initialPath));
  assert.equal(calls[0].options.env.ATELIER_DIALOG_INITIAL, initialPath);
  assert.ok(script.includes('OpenFileDialog'));
  assert.ok(calls[0].args.includes('-STA'));
});
test('cancellation returns null; invalid kinds and wrong files fail', async () => {
  assert.equal(await chooseLocalFile('model', { platform: 'win32', spawnProcess: fake('') }), null);
  await assert.rejects(chooseLocalFile('unknown'), /Type/);
  await assert.rejects(chooseLocalFile('model', { platform: 'win32', spawnProcess: fake('C:\\image.png') }), /gguf/);
});
test('Linux tries native dialogs and preserves paths with spaces', async () => {
  const calls = [];
  const fallback = fake('/models/a b.gguf\n', calls);
  const spawnProcess = (cmd, args, options) =>
    cmd === 'zenity'
      ? fake(Object.assign(Error('missing'), { code: 'ENOENT' }), calls)(cmd, args, options)
      : fallback(cmd, args, options);
  assert.equal(await chooseLocalFile('projector', { platform: 'linux', spawnProcess }), '/models/a b.gguf');
  assert.deepEqual(
    calls.map(c => c.command),
    ['zenity', 'kdialog'],
  );
  await assert.rejects(
    chooseLocalFile('model', {
      platform: 'linux',
      spawnProcess: fake(Object.assign(Error('missing'), { code: 'ENOENT' })),
    }),
    /zenity|kdialog/,
  );
});

test('a Windows selector failure is reported instead of being treated as cancellation', async () => {
  await assert.rejects(chooseLocalFile('model', { platform: 'win32', spawnProcess: fake('', [], 1) }), /sélecteur/);
});

test('Linux cancellation and POSIX initial paths work even when tests run on Windows', async () => {
  const calls = [];
  assert.equal(
    await chooseLocalFile('model', {
      platform: 'linux',
      initialPath: '/models/name\\with\\slashes.gguf',
      spawnProcess: fake('', calls, 1),
    }),
    null,
  );
  assert.ok(calls[0].args.includes('--filename=/models/'));
});

test('quoted initial paths are normalized without interpolating them into PowerShell', async () => {
  const calls = [];
  await chooseLocalFile('engine', {
    platform: 'win32',
    initialPath: '  "C:\\my engine\\llama-server.exe"  ',
    spawnProcess: fake('', calls),
  });
  assert.equal(calls[0].options.env.ATELIER_DIALOG_INITIAL, 'C:\\my engine\\llama-server.exe');
});

test('aborting waits for the native process to close before releasing the picker', async () => {
  const controller = new AbortController();
  let child,
    killed = false,
    settled = false;
  const result = chooseLocalFile('model', {
    platform: 'win32',
    signal: controller.signal,
    spawnProcess: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        killed = true;
      };
      return child;
    },
  });
  const rejection = assert.rejects(result, { name: 'AbortError' }).then(() => {
    settled = true;
  });
  controller.abort();
  await new Promise(setImmediate);
  assert.equal(killed, true);
  assert.equal(settled, false);
  child.emit('close', null);
  await rejection;
  assert.equal(settled, true);
});

test('excessive native output fails even when killing emits close synchronously', async () => {
  await assert.rejects(
    chooseLocalFile('model', { platform: 'win32', spawnProcess: fake('x'.repeat(8193)) }),
    /trop longue/,
  );
});

test('Windows folder picking uses a directory dialog and workflow picking filters JSON', async () => {
  const calls = [];
  assert.equal(
    await chooseLocalFile('directory', {
      platform: 'win32',
      initialPath: 'C:\\models\\$(unsafe)',
      spawnProcess: fake('C:\\models\\checkpoints', calls),
    }),
    'C:\\models\\checkpoints',
  );
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /FolderBrowserDialog/);
  assert.doesNotMatch(script, /\$dialog\.Filter|\$\(unsafe\)/);
  await chooseLocalFile('workflow', { platform: 'win32', spawnProcess: fake('C:\\workflow.json', calls) });
  assert.match(Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le'), /\*\.json/);
  await assert.rejects(chooseLocalFile('workflow', { platform: 'win32', spawnProcess: fake('C:\\wrong.txt') }), /JSON/);
});

test('Linux folder picking requests directories in Zenity and KDialog', async () => {
  const calls = [],
    missing = Object.assign(Error('missing'), { code: 'ENOENT' }),
    spawnProcess = (command, args, options) =>
      fake(command === 'zenity' ? missing : '/models/checkpoints', calls)(command, args, options);
  assert.equal(await chooseLocalFile('directory', { platform: 'linux', spawnProcess }), '/models/checkpoints');
  assert.ok(calls[0].args.includes('--directory'));
  assert.ok(calls[1].args.includes('--getexistingdirectory'));
  assert.equal(calls[1].args.includes('*.gguf *.GGUF'), false);
});
