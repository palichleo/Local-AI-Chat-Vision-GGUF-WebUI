import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createApplication } from '../server.mjs';
import { readSSE } from '../public/stream.mjs';
import { collectToolCalls } from '../lib/tool-runtime.mjs';
import { CLAUDE_DEFAULT, ClaudeAccess, claudeChunks, claudeMessages, claudeRequest } from '../lib/claude.mjs';
import { choiceLabel } from '../public/model-choice.mjs';
import { fakeAnthropic } from './fixtures/fake-anthropic.mjs';

/**
 * Claude as the chat model (0.6.38): by the key of the Claude Console only (Anthropic lets no
 * application sign in with a Claude.ai account), through Anthropic's library installed on demand.
 * The conversation of the chat as the Messages API takes it, its stream read as the chat reads
 * llama.cpp's, its refusals in words, and a turn of the chat against a fake Anthropic. Nothing here
 * calls the real API.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const installed = await access(join(root, 'node_modules', '@anthropic-ai', 'sdk', 'package.json')).then(
  () => true,
  () => false,
);
const needsLibrary = installed ? {} : { skip: 'la bibliothèque @anthropic-ai/sdk n’est pas installée (npm ci)' };
const folder = async t => {
  const path = await mkdtemp(join(tmpdir(), 'moodix-claude-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
async function* events(...list) {
  for (const event of list) yield event;
}
async function drain(chunks) {
  const out = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

test('the conversation of the chat as the Messages API takes it: system apart, calls and results as blocks', () => {
  const { system, messages } = claudeMessages([
    { role: 'system', content: 'Tu es Moodix.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Un bateau' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    {
      role: 'assistant',
      content: 'Je le crée.',
      reasoning_content: 'pensée gardée',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}' },
    { role: 'user', internal: true, content: [{ type: 'text', text: 'Voici la copie.' }] },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Merci' },
  ]);
  assert.equal(system, 'Tu es Moodix.');
  assert.deepEqual(
    messages.map(message => [message.role, message.content.map(block => block.type)]),
    [
      ['user', ['text', 'image']],
      // No thinking block sent back: Moodix rebuilds the start of a conversation at each turn.
      ['assistant', ['text', 'tool_use']],
      // The result first, then what follows it in the same turn of the user; an empty answer left.
      ['user', ['tool_result', 'text', 'text']],
    ],
  );
  assert.deepEqual(messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: 'AAAA' });
  assert.deepEqual(messages[1].content[1], {
    type: 'tool_use',
    id: 'call_1',
    name: 'create_image',
    input: { prompt: 'boat' },
  });
  assert.deepEqual(messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '{"status":"success"}',
  });
  // A conversation that would begin with Moodix begins with the user.
  assert.equal(
    claudeMessages([
      { role: 'assistant', content: 'Bonjour' },
      { role: 'user', content: 'Salut' },
    ]).messages[0].role,
    'user',
  );
});

test('the request for Claude: adaptive reflection, the effort chosen, one call at a time, no temperature', () => {
  const body = {
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ],
    stream: true,
    temperature: 0.7,
    top_p: 0.95,
    top_k: 20,
    max_tokens: 4096,
    tools: [
      { type: 'function', function: { name: 'create_image', description: 'Crée', parameters: { type: 'object' } } },
    ],
    chat_template_kwargs: { enable_thinking: true },
  };
  const request = claudeRequest(body, { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(
    [request.model, request.system, request.max_tokens, request.output_config, request.thinking],
    ['claude-opus-5-5', 'S', 64000, { effort: 'high' }, { type: 'adaptive', display: 'summarized' }],
  );
  for (const field of ['temperature', 'top_p', 'top_k', 'chat_template_kwargs'])
    assert.equal(field in request, false, field);
  assert.deepEqual(request.tools, [
    { name: 'create_image', description: 'Crée', input_schema: { type: 'object' }, eager_input_streaming: true },
  ]);
  assert.deepEqual(request.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  // The fallback of Anthropic on a refusal, for the models that have one.
  assert.deepEqual([request.fallbacks, request.betas], ['default', ['server-side-fallback-2026-07-01']]);
  assert.equal('fallbacks' in claudeRequest(body, { model: 'claude-haiku-5-5', effort: 'high' }), false);
  // A quick decision of the chat (no reflection asked): the lowest effort; not streamed, less room.
  const quick = claudeRequest(
    { ...body, stream: false, chat_template_kwargs: { enable_thinking: false } },
    { model: 'claude-opus-5-5', effort: 'max' },
  );
  assert.deepEqual(
    [quick.output_config.effort, quick.max_tokens, quick.tools[0].eager_input_streaming],
    ['low', 16000, undefined],
  );
  assert.equal(claudeRequest(body, { model: 'claude-opus-5-5', effort: '' }).output_config.effort, 'medium');
});

test('the events of Claude read as the chat reads llama.cpp: words, reflection, one call, its end and usage', async () => {
  const chunks = await drain(
    claudeChunks(
      events(
        {
          type: 'message_start',
          message: { usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 1 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Je réfléchis.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Je le crée.' } },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_image', input: {} },
        },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"prompt":' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"boat"}' } },
        { type: 'content_block_stop', index: 2 },
        // A second call in the same answer is left: one generation at a time.
        {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'create_video', input: {} },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
        { type: 'message_stop' },
      ),
    ),
  );
  const said = key => chunks.map(chunk => chunk.choices?.[0]?.delta?.[key] ?? '').join('');
  assert.deepEqual([said('reasoning_content'), said('content')], ['Je réfléchis.', 'Je le crée.']);
  const calls = [];
  for (const chunk of chunks) collectToolCalls(calls, chunk.choices?.[0]?.delta ?? {});
  assert.deepEqual(calls, [
    { id: 'toolu_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } },
  ]);
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });

  // A call without arguments reads as an empty object.
  const bare = await drain(
    claudeChunks(
      events(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'local_read_output', input: {} },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ),
    ),
  );
  const bareCalls = [];
  for (const chunk of bare) collectToolCalls(bareCalls, chunk.choices?.[0]?.delta ?? {});
  assert.equal(bareCalls[0].function.arguments, '{}');
  // A refusal, a length reached, a stream cut: said.
  await assert.rejects(
    drain(
      claudeChunks(
        events(
          { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { category: 'cyber' } } },
          { type: 'message_stop' },
        ),
      ),
    ),
    /Claude a refusé de répondre à cette demande \(motif : cyber\)/,
  );
  const cut = await drain(
    claudeChunks(events({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' })),
  );
  assert.equal(cut.at(-2).choices[0].finish_reason, 'length');
  await assert.rejects(
    drain(claudeChunks(events({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }))),
    /interrompue/,
  );
});

test('the label of the bar of the chat: the model and its effort, or the reflection of the local model', () => {
  assert.equal(choiceLabel({ remote: null }, null, true), 'Réflexion');
  assert.equal(choiceLabel({ remote: null }, null, false), 'Sans réflexion');
  const status = { remote: { id: 'x', model: 'claude-opus-5-5', effort: 'high' } };
  assert.equal(choiceLabel(status, null, true), 'claude-opus-5-5 · Élevée');
  assert.equal(
    choiceLabel(
      status,
      { model: 'claude-opus-5-5', effort: 'xhigh', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }] },
      true,
    ),
    'Claude Opus 5.5 · Très élevée',
  );
  assert.equal(choiceLabel({ remote: { model: 'openrouter/free', effort: '' } }, null, true), 'openrouter/free');
});

test('without its library, Claude says so and offers to install it; npm is asked as package-lock.json says', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/sdk': '1.4.0' } }));
  const ran = [];
  const access_ = new ClaudeAccess({
    root: dir,
    spawnProcess: (command, args, options) => {
      ran.push([command, args, options.cwd]);
      const child = new EventEmitter();
      child.stdout = child.stderr = null;
      queueMicrotask(async () => {
        await mkdir(join(dir, 'node_modules', '@anthropic-ai', 'sdk'), { recursive: true });
        await writeFile(join(dir, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), '{"version":"1.4.0"}');
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.deepEqual(await access_.status(), { library: 'missing', error: '' });
  await assert.rejects(
    access_.respond({ messages: [], stream: true }, { model: CLAUDE_DEFAULT, key: 'k' }),
    /n’est pas installée/,
  );
  await assert.rejects(
    access_.respond({ messages: [], stream: true }, { model: CLAUDE_DEFAULT, key: '' }),
    /Associez d’abord votre clé/,
  );
  await access_.install();
  assert.deepEqual(await access_.status(), { library: 'ready', error: '' });
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0][1].slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(ran[0][2], dir);
});

test(
  'Claude through its library: the models of the key, an answer streamed, the errors in words',
  needsLibrary,
  async t => {
    const key = 'sk-ant-test-' + randomUUID();
    const fake = await fakeAnthropic(key);
    t.after(() => fake.close());
    const claude = new ClaudeAccess({ root, baseURL: fake.base, retries: 0 });
    // Only the current models (adaptive reflection), each with the efforts it takes.
    assert.deepEqual(await claude.models(key), [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        vision: true,
      },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: ['low', 'medium', 'high', 'max'], vision: true },
    ]);
    await assert.rejects(
      claude.models('sk-ant-wrong'),
      error => error.status === 502 && /La clé d’API Claude est refusée/.test(error.message),
    );
    const response = await claude.respond(
      { messages: [{ role: 'user', content: 'bonjour' }], stream: true },
      { model: CLAUDE_DEFAULT, key, effort: 'high' },
    );
    const events_ = [];
    await readSSE(response.body, event => events_.push(event));
    assert.equal(events_.map(event => event.choices?.[0]?.delta?.content ?? '').join(''), 'Bonjour');
    assert.equal(fake.seen.messages.at(-1).body.output_config.effort, 'high');
    assert.match(fake.seen.messages.at(-1).beta, /server-side-fallback-2026-07-01/);
    // Not streamed (a prompt of the Studio): its words as JSON.
    const json = await (
      await claude.respond(
        { messages: [{ role: 'user', content: 'bonjour' }], stream: false },
        { model: CLAUDE_DEFAULT, key },
      )
    ).json();
    assert.equal(json.choices[0].message.content, 'Bonjour');
    await assert.rejects(
      claude.respond({ messages: [{ role: 'user', content: 'x' }], stream: true }, { model: 'claude-missing', key }),
      /Modèle Claude inconnu : « claude-missing »/,
    );
    // A refusal comes as the error of the stream, in words.
    const refused = await claude.respond(
      { messages: [{ role: 'user', content: 'refuse this' }], stream: true },
      { model: CLAUDE_DEFAULT, key },
    );
    await assert.rejects(
      readSSE(refused.body, () => {}),
      /Claude a refusé de répondre/,
    );
  },
);

test(
  'a turn of the chat with Claude: its key associated, a call of a tool, the effort chosen in the bar',
  needsLibrary,
  async t => {
    const key = 'sk-ant-test-' + randomUUID();
    const fake = await fakeAnthropic(key);
    t.after(() => fake.close());
    const data = await folder(t),
      spawned = [];
    await mkdir(join(data, 'output'));
    const app = await createApplication({
      port: 0,
      dataDir: data,
      outputDir: join(data, 'output'),
      openUrl: () => {},
      claude: { baseURL: fake.base, retries: 0 },
      spawnProcess: (...args) => {
        spawned.push(args);
        throw Error('llama.cpp started');
      },
    });
    t.after(() => app.close());
    const boot = await (await fetch(app.url + '/api/bootstrap')).json();
    const api = async (path, body, status = 200) => {
      const response = await fetch(app.url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, status, await response.clone().text());
      return response;
    };
    assert.equal((await (await api('remote')).json()).claude.library, 'ready');
    // A wrong key is refused before anything is kept; the right one is kept and Claude chosen.
    assert.match(
      (await (await api('remote/provider', { provider: 'claude', key: 'sk-ant-wrong' }, 502)).json()).error,
      /clé d’API Claude est refusée/,
    );
    assert.equal((await (await api('remote')).json()).connections.length, 0);
    const chosen = await (await api('remote/provider', { provider: 'claude', key })).json();
    assert.equal(JSON.stringify(chosen).includes(key), false, 'the key never reaches the page');
    assert.deepEqual(
      [chosen.status.remote.kind, chosen.status.remote.name, chosen.status.remote.model, chosen.status.remote.leaves],
      ['claude', 'Claude', CLAUDE_DEFAULT, true],
    );
    const { options } = await (await api('remote/options')).json();
    assert.deepEqual([options.effort, options.efforts], ['medium', ['low', 'medium', 'high', 'xhigh', 'max']]);
    assert.equal((await (await api('remote/choice', { effort: 'xhigh' })).json()).status.remote.effort, 'xhigh');

    const chat = async text =>
      (
        await (
          await api('chat', {
            messages: [
              { role: 'system', content: 'Tu es Moodix.' },
              { role: 'user', content: text },
            ],
            conversationId: randomUUID(),
            turnId: randomUUID(),
          })
        ).text()
      )
        .split(/\r?\n\r?\n/)
        .filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
        .map(frame => JSON.parse(frame.slice(6)));
    assert.equal((await chat('bonjour')).map(event => event.choices?.[0]?.delta?.content ?? '').join(''), 'Bonjour');
    const sent = fake.seen.messages.at(-1).body;
    assert.equal(sent.output_config.effort, 'xhigh');
    assert.equal(sent.system, 'Tu es Moodix.');
    assert.equal(sent.messages[0].role, 'user');
    assert.equal(spawned.length, 0, 'llama.cpp was never started');
    // The key taken off this computer: the chat comes back to the local model.
    const gone = await (await api('remote/forget', { provider: 'claude' })).json();
    assert.deepEqual([gone.connections.length, gone.status.remote], [0, null]);
  },
);
