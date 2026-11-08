import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chooseLocalFile } from '../lib/file-picker.mjs';
function fake(answer, calls = [], code = 0) { return (command, args, options) => {
  calls.push({ command, args, options }); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', 1);
  queueMicrotask(() => { if(answer?.code) child.emit('error',answer); else { child.stdout.emit('data',Buffer.from(answer)); child.emit('close',code); } });return child;
}; }
test('Windows picker returns Unicode paths without uploading or interpolating user paths into code', async () => {
  const calls = [], initialPath = 'C:\\modèles\\$(unsafe).gguf';
  const selected = await chooseLocalFile('model', { platform: 'win32', initialPath, spawnProcess: fake('C:\\modèles\\vision.gguf\r\n',calls) });
  assert.equal(selected,'C:\\modèles\\vision.gguf');assert.equal(calls[0].options.shell,false);
  const script=Buffer.from(calls[0].args.at(-1),'base64').toString('utf16le');assert.ok(!script.includes(initialPath));assert.equal(calls[0].options.env.ATELIER_DIALOG_INITIAL,initialPath);
  assert.ok(script.includes('OpenFileDialog'));assert.ok(calls[0].args.includes('-STA'));
});
test('cancellation returns null; invalid kinds and wrong files fail', async () => {
  assert.equal(await chooseLocalFile('model',{platform:'win32',spawnProcess:fake('')}),null);
  await assert.rejects(chooseLocalFile('unknown'),/Type/);
  await assert.rejects(chooseLocalFile('model',{platform:'win32',spawnProcess:fake('C:\\image.png')}),/gguf/);
});
test('Linux tries native dialogs and preserves paths with spaces', async () => {
  const calls=[];const fallback=fake('/models/a b.gguf\n',calls);
  const spawnProcess=(cmd,args,options)=>cmd==='zenity'?fake(Object.assign(Error('missing'),{code:'ENOENT'}),calls)(cmd,args,options):fallback(cmd,args,options);
  assert.equal(await chooseLocalFile('projector',{platform:'linux',spawnProcess}),'/models/a b.gguf');assert.deepEqual(calls.map(c=>c.command),['zenity','kdialog']);
  await assert.rejects(chooseLocalFile('model',{platform:'linux',spawnProcess:fake(Object.assign(Error('missing'),{code:'ENOENT'}))}),/zenity|kdialog/);
});
