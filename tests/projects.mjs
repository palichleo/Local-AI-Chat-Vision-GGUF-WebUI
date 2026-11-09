import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { Projects, projectId } from '../lib/projects.mjs';
import { Gallery } from '../lib/gallery.mjs';
const png = 'data:image/png;base64,iVBORw0KGgo=';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-projects-')),
    historyDir = join(directory, 'history');
  let app = await createApplication({ port: 0, dataDir: directory, historyDir }),
    token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    directory,
    historyDir,
    call,
    url: () => app.url,
    async restart() {
      await app.close();
      app = await createApplication({ port: 0, dataDir: directory, historyDir });
      token = (await (await fetch(app.url + '/api/bootstrap')).json()).token;
    },
  };
}
test('projects persist names and assignments while each conversation retains only its own messages and instructions', async t => {
  const f = await fixture(t);
  assert.deepEqual((await (await f.call('projects')).json()).projects, [{ id: 'inbox', name: 'Conversations' }]);
  const project = (await (await f.call('projects/save', { name: 'Research' })).json()).project,
    id = randomUUID(),
    other = randomUUID(),
    messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First prompt' },
          { type: 'image_url', image_url: { url: png } },
        ],
      },
    ];
  await f.call('history/save', { id, messages, instructions: 'Only this conversation' });
  await f.call('history/save', { id: other, messages: [{ role: 'user', content: 'Another conversation' }] });
  let moved = await f.call('projects/move', { id, projectId: project.id });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).conversation.projectId, project.id);
  await f.call('history/save', { id, messages, instructions: 'Only this conversation' });
  await f.restart();
  const restored = await (await f.call('history/' + id)).json();
  assert.equal(restored.projectId, project.id);
  assert.deepEqual(restored.messages, messages);
  assert.equal(restored.instructions, 'Only this conversation');
  const sibling = await (await f.call('history/' + other)).json();
  assert.equal(sibling.projectId, 'inbox');
  assert.equal(sibling.instructions, undefined);
  assert.deepEqual(sibling.messages, [{ role: 'user', content: 'Another conversation' }]);
  await f.call('projects/save', { id: project.id, name: 'Renamed' });
  assert.equal((await (await f.call('projects')).json()).projects[1].name, 'Renamed');
  assert.equal((await f.call('projects/move', { id, projectId: randomUUID() })).status, 404);
  assert.equal((await f.call('history/save', { id: randomUUID(), messages, projectId: '../outside' })).status, 400);
});
test('home summaries expose bounded prompts and signed compressed previews without requesting Comfy originals', async t => {
  const f = await fixture(t),
    id = randomUUID();
  await f.call('history/save', {
    id,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'A'.repeat(1000) },
          { type: 'image_url', image_url: { url: png } },
        ],
      },
    ],
  });
  let record = (await (await f.call('history')).json()).conversations[0];
  assert.equal(record.firstPrompt.length, 360);
  assert.doesNotMatch(JSON.stringify(record), /base64/);
  assert.equal((await fetch(f.url() + record.previewUrl)).status, 200);
  assert.equal((await fetch(f.url() + record.previewUrl.replace(/key=.*/, 'key=invalid'))).status, 401);
  const run = {
    id: randomUUID(),
    conversationId: id,
    workflowId: 'user',
    workflowName: 'User workflow',
    prompt: 'Result',
    parameters: {},
    comfyUrl: 'http://127.0.0.1:1',
    createdAt: new Date().toISOString(),
    outputs: [{ source: { filename: 'image.png', subfolder: '', type: 'output' }, analysisDataUrl: png }],
  };
  await new Gallery({ historyDir: f.historyDir }).put(run, { persist: true });
  await f.call('history/save', {
    id,
    messages: [
      { role: 'user', content: 'Generate' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'comfy_generate_image', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_one', content: JSON.stringify({ run_id: run.id }) },
    ],
  });
  record = (await (await f.call('history')).json()).conversations[0];
  const preview = await fetch(f.url() + record.previewUrl);
  assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
  await f.call('preferences', { saveHistory: false });
  assert.equal((await fetch(f.url() + record.previewUrl)).status, 403);
});
test('concurrent project edits are serialized and malformed names never overwrite the registry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-project-names-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'projects.json'),
    projects = new Projects(file);
  await Promise.all(['A', 'B', 'C'].map(name => projects.save({ name })));
  assert.equal((await projects.list()).length, 4);
  const before = await readFile(file, 'utf8');
  await assert.rejects(projects.save({ name: ' ' }));
  await assert.rejects(projects.save({ id: '../file', name: 'X' }));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('accepted saves awaiting project validation finish before deletion, clearing, moving or disabling history', async t => {
  for (const action of ['delete', 'clear', 'move', 'disable'])
    await t.test(action, async t => {
      const f = await fixture(t),
        id = randomUUID(),
        messages = [{ role: 'user', content: 'Latest accepted message' }];
      await f.call('history/save', { id, messages: [{ role: 'user', content: 'Original' }] });
      const project = (await (await f.call('projects/save', { name: 'Target' })).json()).project,
        original = Projects.prototype.require;
      let release, entered;
      const gate = new Promise(resolve => {
          release = resolve;
        }),
        started = new Promise(resolve => {
          entered = resolve;
        });
      Projects.prototype.require = async function (value) {
        if (value === 'inbox') {
          entered();
          await gate;
        }
        return original.call(this, value);
      };
      let save, operation;
      try {
        save = f.call('history/save', { id, messages, projectId: 'inbox' });
        await started;
        const route = action === 'move' ? 'projects/move' : action === 'disable' ? 'preferences' : 'history/' + action;
        const body =
          action === 'move'
            ? { id, projectId: project.id }
            : action === 'disable'
              ? { saveHistory: false }
              : { id, confirm: true };
        let completed = false;
        operation = f.call(route, body).then(result => {
          completed = true;
          return result;
        });
        await new Promise(resolve => setTimeout(resolve, 45));
        assert.equal(completed, false, 'The operation must wait for the already accepted save');
        release();
        assert.equal((await save).status, 200);
        assert.equal((await operation).status, 200);
        if (action === 'disable') await f.call('preferences', { saveHistory: true });
        const restored = await f.call('history/' + id);
        if (['delete', 'clear'].includes(action)) assert.equal(restored.status, 404);
        else {
          assert.equal(restored.status, 200);
          const value = await restored.json();
          assert.deepEqual(value.messages, messages);
          if (action === 'move') assert.equal(value.projectId, project.id);
        }
      } finally {
        release();
        await Promise.allSettled([save, operation].filter(Boolean));
        Projects.prototype.require = original;
      }
    });
});
test('project identifiers reject arrays and corrupt registries fail clearly without being overwritten', async t => {
  assert.throws(() => projectId([randomUUID()]), { status: 400 });
  const directory = await mkdtemp(join(tmpdir(), 'atelier-bad-projects-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'projects.json');
  await writeFile(path, '[null]');
  const projects = new Projects(path);
  await assert.rejects(projects.list(), { status: 400 });
  await assert.rejects(projects.save({ name: 'Keep broken data' }));
  assert.equal(await readFile(path, 'utf8'), '[null]');
});

test('a missing latest generation preview falls back to an older local compressed image', async t => {
  const f = await fixture(t),
    id = randomUUID(),
    missing = randomUUID();
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Reference' },
        { type: 'image_url', image_url: { url: png } },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_preview', type: 'function', function: { name: 'comfy_generate_image', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_preview', content: JSON.stringify({ run_id: missing }) },
  ];
  await f.call('history/save', { id, messages });
  const item = (await (await f.call('history')).json()).conversations[0],
    response = await fetch(f.url() + item.previewUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
  await f.call('history/delete', { id, confirm: true });
  assert.equal((await fetch(f.url() + item.previewUrl)).status, 404);
});
