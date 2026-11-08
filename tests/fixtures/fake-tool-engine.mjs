// Test fixture only: deterministic native tools, without loading a model.
import http from 'node:http';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
if (!args.includes('--offline') || arg('--host') !== '127.0.0.1') process.exit(2);
const key = arg('--api-key');
const send = (res, event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end(); }
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"ok"}'); }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const last = body.messages.at(-1).content;
  const text = typeof last === 'string' ? last : last.filter((part) => part.type === 'text').map((part) => part.text).join(' ');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (body.messages.some((message) => message.role === 'tool')) {
    const native = body.messages.find((message) => message.role === 'assistant' && message.tool_calls);
    const result = body.messages.find((message) => message.role === 'tool');
    const review = Array.isArray(last) && last.some((part) => part.type === 'image_url');
    send(res, { choices: [{ delta: { content: native?.tool_calls[0].id === result.tool_call_id && review ? 'The red boat is visible in the generated image.' : 'Invalid native continuation.' }, finish_reason: 'stop' }] });
    return res.end('data: [DONE]\n\n');
  }
  if (!text.startsWith('generate')) {
    send(res, { choices: [{ delta: { content: 'Ordinary chat, no generation.' }, finish_reason: 'stop' }] });
    return res.end('data: [DONE]\n\n');
  }
  if (body.tools?.[0]?.function?.name !== 'comfy_generate_image') {
    send(res, { error: 'The native Comfy schema is missing.' });
    return res.end('data: [DONE]\n\n');
  }
  const invalid = text.includes('malformed');
  const argumentsText = invalid ? '{"workflow_id":' : JSON.stringify({ workflow_id: 'integration-boat', prompt: 'A red boat' });
  const middle = Math.floor(argumentsText.length / 2);
  send(res, { choices: [{ delta: { reasoning_content: 'I will use the registered workflow.' } }] });
  send(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_red_boat', type: 'function', function: { name: 'comfy_generate_', arguments: argumentsText.slice(0, middle) } }] } }] });
  send(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'image', arguments: argumentsText.slice(middle) } }] } }] });
  if (!text.includes('truncated')) send(res, { choices: [{ delta: {}, finish_reason: text.includes('length') ? 'length' : 'tool_calls' }] });
  res.end('data: [DONE]\n\n');
});
server.listen(Number(arg('--port')), '127.0.0.1');
