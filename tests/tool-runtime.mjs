import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime, collectToolCalls } from '../lib/tool-runtime.mjs';
const id = 'a1111111-1111-4111-8111-111111111111';
test('native deltas assemble tool arguments; text never becomes a tool', () => {
  const calls=[];
  collectToolCalls(calls,{tool_calls:[{index:0,id:'call_1',function:{name:'comfy_generate_image',arguments:'{"prompt":'}}]});
  collectToolCalls(calls,{tool_calls:[{index:0,function:{arguments:'"cat"}'}}]});
  assert.equal(calls[0].function.arguments,'{"prompt":"cat"}');
  collectToolCalls(calls,{content:'{"tool":"comfy_generate_image"}'});
  assert.equal(calls.length,1);
});
test('approval pins workflow, is consumed once, and enforces a turn limit', async () => {
  let digest='one', runs=0; const order=[];
  const workflow={id:'wf',name:'test',digest,bindings:{prompt:{node:'1',input:'text'}}};
  const catalog={read:async()=>({...workflow,digest}),prepare:async()=>({graph:{},workflow,outputNodes:['1']})};
  const engine={state:'ready',busy:false,stop:async()=>{order.push('stop');engine.state='stopped';},start:async()=>{order.push('start');engine.state='ready';}};
  const client={status:async()=>({idle:true}),run:async()=>{runs++;order.push('run');return {outputs:[{filename:'x.png',subfolder:'',type:'output'}]};},free:async()=>{order.push('free');}};
  const gallery={put:async(r)=>r};
  const rt=new ToolRuntime({engine,catalog,gallery,getConfig:()=>({enabled:true,baseUrl:'http://127.0.0.1:8188',autoAllow:false,maxIterations:1}),engineConfig:()=>({}),clientFactory:()=>client});
  const calls=[{id:'call_1',type:'function',function:{name:'comfy_generate_image',arguments:'{"workflow_id":"wf","prompt":"cat"}'}}];
  const pending=await rt.request(calls,{conversationId:id,turnId:id,messages:[]});
  await assert.rejects(rt.execute({requestId:pending.requestId,permission:'none'}),/autorisation/i);
  digest='changed';
  await assert.rejects(rt.execute({requestId:pending.requestId,permission:'once'}),/modifié/i);
  digest='one'; const p=await rt.request(calls,{conversationId:id,turnId:id,messages:[]});
  const job=await rt.execute({requestId:p.requestId,permission:'once'});
  await rt.finished;
  assert.equal(rt.job.state,'done'); assert.equal(job.id,rt.job.id);
  assert.deepEqual(order,['stop','run','free','start']); assert.equal(runs,1);
  await assert.rejects(rt.execute({requestId:p.requestId,permission:'once'}),/expiré/i);
  await assert.rejects(rt.request(calls,{conversationId:id,turnId:id,messages:[]}),/limite/i);
});
test('Comfy release failure keeps LLM stopped and records error',async()=>{
  let starts=0;
  const engine={state:'ready',stop:async()=>{},start:async()=>{starts++;}};
  const rt=new ToolRuntime({engine,catalog:{read:async()=>({digest:'1',name:'wf'}),prepare:async()=>({graph:{},workflow:{name:'wf',digest:'1'}})},gallery:{put:async r=>r},getConfig:()=>({enabled:true,autoAllow:true,maxIterations:3}),engineConfig:()=>({}),clientFactory:()=>({status:async()=>({idle:true}),run:async()=>{throw Error('failed');},free:async()=>{throw Error('VRAM');}})});
  const p=await rt.request([{id:'c',type:'function',function:{name:'comfy_generate_image',arguments:'{"workflow_id":"wf","prompt":"cat"}'}}],{conversationId:id,turnId:id,messages:[]});
  await rt.execute({requestId:p.requestId}); await rt.finished;
  assert.equal(rt.active,true); assert.equal(starts,0); assert.equal(rt.job.state,'error'); assert.match(rt.job.error,/VRAM/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function runtimeFixture() {
  const seen = { runs: 0, stops: 0, starts: 0, references: [] };
  const workflow = { id: 'wf', name: 'Portrait', digest: 'approved' };
  const engine = {
    state: 'ready', busy: false,
    async stop() { seen.stops++; engine.state = 'stopped'; },
    async start() { seen.starts++; engine.state = 'ready'; },
  };
  const catalog = {
    async read() { return { ...workflow }; },
    async prepare(_id, _args, { referenceImage } = {}) {
      seen.references.push(referenceImage);
      return { graph: { '7': { class_type: 'SaveImage', inputs: {} } }, workflow: { ...workflow }, outputNodes: ['7'] };
    },
  };
  const client = {
    async status() { return { idle: true }; },
    async run() { seen.runs++; return { promptId: 'owned', outputs: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] }; },
    async free() { return { idle: true, memory: { torchAllocated: 0 } }; },
  };
  const rt = new ToolRuntime({
    engine, catalog, gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, baseUrl: 'http://127.0.0.1:8188', autoAllow: false, maxIterations: 1 }),
    engineConfig: () => ({}), clientFactory: () => client,
  });
  const request = (args = {}, messages = []) => rt.request([{
    id: 'call_1', type: 'function',
    function: { name: 'comfy_generate_image', arguments: JSON.stringify({ workflow_id: 'wf', prompt: 'portrait', ...args }) },
  }], { conversationId: id, turnId: id, messages });
  return { rt, seen, workflow, catalog, client, request };
}

test('concurrent execute claims one approval before asynchronous preflight', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const gate = deferred();
  client.status = async () => { await gate.promise; return { idle: true }; };
  const pending = await request();
  const first = rt.execute({ requestId: pending.requestId, permission: 'once' });
  assert.equal(rt.active, true, 'preflight owns the GPU before the first await');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  gate.resolve();
  const job = await first;
  await rt.finished;
  assert.equal(seen.runs, 1);
  assert.equal(rt.status().id, job.id);
  assert.equal(rt.status().state, 'done');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), /expiré/i);
});

test('a workflow changed during the Comfy status check never reaches execution', async () => {
  const { rt, seen, workflow, client, request } = runtimeFixture();
  const pending = await request();
  client.status = async () => { workflow.digest = 'replaced'; return { idle: true }; };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(seen.runs, 0);
  assert.equal(rt.status().state, 'error');
  assert.match(rt.status().error, /workflow.*modifié/i);
});

test('uploaded references retain the complete subfolder descriptor for graph preparation', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const uploaded = { filename: 'reference.png', name: 'reference.png', subfolder: 'references/portraits', type: 'input' };
  client.upload = async bytes => {
    assert.deepEqual(bytes, Buffer.from('89504e470d0a1a0a', 'hex'));
    return { ...uploaded };
  };
  const pending = await request({ reference_image: 0 }, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }]);
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.deepEqual(seen.references.at(-1), uploaded);
  assert.equal(seen.runs, 1);
  assert.equal(rt.status().state, 'done');
});

test('unconfirmed cleanup blocks execution until explicit recovery succeeds', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const pending = await request();
  client.free = async () => { throw new Error('allocation still unknown'); };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  assert.equal(rt.status().state, 'error');
  assert.equal(seen.starts, 0);
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  await assert.rejects(rt.recover(), /allocation still unknown/);
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  const gate = deferred();
  client.free = async () => { await gate.promise; return { idle: true, memory: { torchAllocated: 0 } }; };
  const recovery = rt.recover();
  assert.equal(rt.active, true, 'recovery owns the GPU until release confirmation');
  gate.resolve();
  const recovered = await recovery;
  assert.equal(recovered.blocked, false);
  assert.equal(rt.active, false);
  assert.equal(recovered.state, 'done');
  await assert.rejects(rt.recover(), { status: 409 });
});
