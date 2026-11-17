// Test fixture only: deterministic native tools, without loading a model.
import http from 'node:http';

if (process.argv[2] === '--version') {
  // As llama-server says it, on its error stream.
  console.error('version: 1 (fake)');
  process.exit(0);
}
const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--offline') || arg('--host') !== '127.0.0.1') process.exit(2);
const key = arg('--api-key');
const send = (res, event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end();
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  // Asked without a stream (a test of the connection, a prompt of the Studio): one answer in JSON, as a service gives it.
  if (body.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }),
    );
  }
  // (Its start: a remote model may find the references of the project added after it.)
  if (String(body.messages.at(-1).content).startsWith('inspect tool context')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    send(res, { local_test_payload: body });
    return res.end('data: [DONE]\n\n');
  }
  // A model that makes its call again whatever the tool answered (« whatever is said »).
  const asked = body.messages.findLast(message => message.role === 'user')?.content,
    insists = typeof asked === 'string' && asked.includes('whatever is said');
  const last = insists ? asked : body.messages.at(-1).content;
  const text =
    typeof last === 'string'
      ? last
      : last
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join(' ');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (body.messages.some(message => message.role === 'tool') && !insists) {
    const native = body.messages.find(message => message.role === 'assistant' && message.tool_calls);
    const result = body.messages.find(message => message.role === 'tool');
    const review = Array.isArray(last) && last.some(part => part.type === 'image_url');
    send(res, {
      choices: [
        {
          delta: {
            content:
              native?.tool_calls[0].id === result.tool_call_id && review
                ? 'The red boat is visible in the generated image.'
                : 'Invalid native continuation.',
          },
          finish_reason: 'stop',
        },
      ],
    });
    return res.end('data: [DONE]\n\n');
  }
  if (!text.startsWith('generate')) {
    send(res, { choices: [{ delta: { content: 'Ordinary chat, no generation.' }, finish_reason: 'stop' }] });
    return res.end('data: [DONE]\n\n');
  }
  const video = text.startsWith('generate video'),
    toolName = video ? 'create_video' : 'create_image';
  if (!body.tools?.some(tool => tool.function?.name === toolName)) {
    send(res, { error: 'The generation tool schema is missing.' });
    return res.end('data: [DONE]\n\n');
  }
  const invalid = text.includes('malformed');
  const argumentsText = invalid
    ? '{"prompt":'
    : JSON.stringify(
        video
          ? {
              prompt: 'A slow camera pan over a red boat',
              stage: text.includes('final') ? 'final' : 'draft',
              intention: text.includes('final')
                ? 'Produire la vidéo finale avec le mouvement de caméra prévu.'
                : 'Vérifier le mouvement de caméra avant la vidéo finale.',
            }
          : text.includes('invented source')
            ? // What a small model does with an optional source it cannot fill: copy the placeholder.
              { prompt: 'A red boat', source: { output: 'run_id' } }
            : text.startsWith('generate naming ')
              ? // The identifier of an image written in the prompt, the image itself left out.
                { prompt: 'A red boat like ' + text.slice(16, 52) }
              : text.startsWith('generate from take ')
                ? // A take named by its number, as the user says it (« la prise 12 »).
                  { prompt: 'A red boat', source: { take: Number(text.slice(19)) } }
                : text.startsWith('generate from ')
                  ? { prompt: 'A red boat', source: { output: text.slice(14) } }
                  : { prompt: 'A red boat' },
      );
  const middle = Math.floor(argumentsText.length / 2);
  send(res, { choices: [{ delta: { reasoning_content: 'I will use the registered workflow.' } }] });
  send(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_red_boat',
              type: 'function',
              function: { name: 'create_', arguments: argumentsText.slice(0, middle) },
            },
          ],
        },
      },
    ],
  });
  send(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { name: video ? 'video' : 'image', arguments: argumentsText.slice(middle) } },
          ],
        },
      },
    ],
  });
  if (!text.includes('truncated'))
    send(res, { choices: [{ delta: {}, finish_reason: text.includes('length') ? 'length' : 'tool_calls' }] });
  res.end('data: [DONE]\n\n');
});
server.listen(Number(arg('--port')), '127.0.0.1');
