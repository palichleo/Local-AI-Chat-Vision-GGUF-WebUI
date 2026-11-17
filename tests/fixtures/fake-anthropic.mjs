// Test fixture only: the Messages API of Anthropic as far as Moodix uses it, on 127.0.0.1.
import { createServer } from 'node:http';

/** The Messages API as far as Moodix uses it, on this computer. */
export async function fakeAnthropic(key) {
  const seen = { messages: [], listed: 0 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    const json = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    // The key as the library sends it (in Authorization since 1.x, or x-api-key).
    if ((req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '')) !== key)
      return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    if (url.pathname === '/v1/models') {
      seen.listed++;
      const caps = (adaptive, efforts) => ({
        thinking: { supported: true, types: { adaptive: { supported: adaptive } } },
        effort: {
          supported: efforts.length > 0,
          ...Object.fromEntries(
            ['low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, { supported: efforts.includes(level) }]),
          ),
        },
        image_input: { supported: true },
      });
      return json({
        data: [
          {
            type: 'model',
            id: 'claude-opus-5-5',
            display_name: 'Claude Opus 5.5',
            created_at: '2026-10-01T00:00:00Z',
            capabilities: caps(true, ['low', 'medium', 'high', 'xhigh', 'max']),
          },
          {
            type: 'model',
            id: 'claude-sonnet-4-6',
            display_name: 'Claude Sonnet 4.6',
            created_at: '2026-01-01T00:00:00Z',
            capabilities: caps(true, ['low', 'medium', 'high', 'max']),
          },
          {
            type: 'model',
            id: 'claude-haiku-4-5',
            display_name: 'Claude Haiku 4.5',
            created_at: '2025-10-01T00:00:00Z',
            capabilities: caps(false, []),
          },
        ],
        has_more: false,
        first_id: 'claude-opus-5-5',
        last_id: 'claude-haiku-4-5',
      });
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks));
      seen.messages.push({ body, beta: req.headers['anthropic-beta'] ?? '' });
      if (body.model === 'claude-missing')
        return json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-missing' } }, 404);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: body.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 40, output_tokens: 1 },
        },
      });
      const last = body.messages
        .at(-1)
        .content.filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ');
      if (last.startsWith('generate') && body.tools?.some(tool => tool.name === 'create_image')) {
        send({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_boat', name: 'create_image', input: {} },
        });
        send({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"prompt":"A red' },
        });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' boat"}' } });
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 15 },
        });
      } else if (last.startsWith('refuse')) {
        send({
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_sequence: null,
            stop_details: { type: 'refusal', category: 'cyber', explanation: null },
          },
          usage: { output_tokens: 0 },
        });
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bonjour' } });
        send({ type: 'content_block_stop', index: 0 });
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        });
      }
      send({ type: 'message_stop' });
      return res.end();
    }
    json({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close() {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}
