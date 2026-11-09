import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenerationAssets } from '../lib/generation-assets.mjs';

async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-assets-'));
  try { await fn(directory, new GenerationAssets(join(directory, 'assets.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function weights(path, tensors) {
  const header = Buffer.from(JSON.stringify(tensors));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  await writeFile(path, Buffer.concat([prefix, header, Buffer.alloc(Math.min(10240,Math.max(...Object.values(tensors).map(tensor=>tensor.data_offsets[1]))))]));
}
const tensor = { dtype:'F32', shape:[1], data_offsets:[0,4] };
const encoderTensor={dtype:'F32',shape:[1,2560],data_offsets:[0,10240]};

test('registered assets use inspected local checkpoint headers and persisted stable IDs', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory, 'anything.safetensors');
    await weights(path, {'model.embed_tokens.weight':encoderTensor});
    const saved = await assets.register({id:'encoder',name:'My encoder',path,kind:'textEncoder',family:'krea2'});
    assert.equal(saved.path, await realpath(path));
    assert.equal((await assets.resolve('encoder',{kind:'textEncoder',family:'krea2'})).path,await realpath(path));
    assert.equal((await new GenerationAssets(assets.file).read('encoder')).name,'My encoder');
    await assert.rejects(assets.resolve('encoder',{kind:'vae',family:'krea2'}), /kind|compatible/i);
    await assert.rejects(assets.resolve('encoder',{kind:'textEncoder',family:'ltx25'}), /family|compatible/i);
    assert.equal((await assets.list()).length,1);
  });
});

test('invalid header and incompatible layouts cannot overwrite a registered asset', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory,'valid.safetensors');
    await weights(path,{'model.embed_tokens.weight':encoderTensor});
    await assets.register({id:'encoder',path,kind:'textEncoder',family:'krea2'});
    const before = await readFile(assets.file,'utf8');
    const bad = join(directory,'bad.safetensors'); await writeFile(bad,'not weights');
    await assert.rejects(assets.register({id:'encoder',path:bad,kind:'textEncoder',family:'krea2'}), /header|safetensors/i);
    await assert.rejects(assets.register({id:'encoder',path,kind:'vae',family:'krea2'}), /layout|compatible/i);
    assert.equal(await readFile(assets.file,'utf8'),before);
    await weights(bad,{'model.embed_tokens.weight':{...tensor,data_offsets:[0,400]}});
    await assert.rejects(assets.register({path:bad,kind:'textEncoder',family:'krea2'}), /offset|size|header/i);
  });
});

test('corrupted registry entries are isolated with an actionable warning', async () => {
  await fixture(async (directory, assets) => {
    const path = join(directory,'encoder.safetensors');await weights(path,{'model.embed_tokens.weight':encoderTensor});
    const saved = await assets.register({id:'encoder',path,kind:'textEncoder',family:'krea2'});
    await writeFile(assets.file,JSON.stringify({schemaVersion:1,assets:[saved,{id:'../unsafe'}]}));
    assert.deepEqual((await assets.list()).map(asset=>asset.id),['encoder']);
    assert.match(assets.warnings[0],/unsafe|invalid|entry/i);
  });
});

test('checkpoint role checks reject tensor names with the wrong basic shape', async()=>{
  await fixture(async(directory,assets)=>{
    const path=join(directory,'wrong-shape.safetensors');
    await weights(path,{'model.embed_tokens.weight':tensor});
    await assert.rejects(assets.register({id:'wrong',path,kind:'textEncoder',family:'krea2'}),/layout|shape|compatible/i);
  });
});
