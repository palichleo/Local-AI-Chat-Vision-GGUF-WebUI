import http from 'node:http';
if (process.argv[2] === '--version') {
  // As llama-server says it, on its error stream.
  console.error('version: 1 (fake)');
  process.exit(0);
}
const args = process.argv.slice(2),
  arg = name => args[args.indexOf(name) + 1],
  key = arg('--api-key');
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end();
  }
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end('{"status":"ok"}');
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)),
    last = body.messages.at(-1).content;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  if (last === 'slow resource test') {
    emit({ choices: [{ delta: { content: 'Waiting' } }] });
    const timer = setInterval(() => res.write(': wait\n\n'), 50);
    res.once('close', () => clearInterval(timer));
    return;
  }
  if (last === 'inspect resources') emit({ local_test_payload: body });
  else if (typeof last === 'string' && last.startsWith('inspect output '))
    emit({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'output_call',
                type: 'function',
                function: { name: 'local_read_output', arguments: JSON.stringify(JSON.parse(last.slice(15))) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  else if (typeof last === 'string' && (last.startsWith('inspect unread ') || last.startsWith('inspect twice '))) {
    // Several takes asked to be looked at in one message (the local model, 19/11).
    const unread = last.startsWith('inspect unread '),
      given = last.slice(unread ? 15 : 14),
      args = given === 'nothing' ? null : JSON.stringify(JSON.parse(given));
    const call = (index, id) => ({ index, id, type: 'function', function: { name: 'local_read_output', arguments: args } });
    emit({ choices: [{ delta: { reasoning_content: 'Let me read these images first.' } }] });
    if (args) emit({ choices: [{ delta: { tool_calls: [call(0, 'first_call')] } }] });
    if (unread) {
      // What llama.cpp says once the answer is whole, when another call follows the one it may hold.
      emit({
        error: {
          code: 500,
          message:
            'Failed to parse input at pos 693: <tool_call>\n<function=local_read_output>\n<parameter=run_id>\n' +
            'd6b246cc-477d-48bc-9e9c-4c220ebe25cd\n</parameter>\n</function>\n</tool_call>',
          type: 'server_error',
        },
      });
      return res.end();
    }
    emit({ choices: [{ delta: { tool_calls: [call(1, 'second_call')] }, finish_reason: 'tool_calls' }] });
  } else if (typeof last === 'string' && last.startsWith('read-many '))
    emit({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'resources_call',
                type: 'function',
                function: {
                  name: 'local_read_resource',
                  arguments: JSON.stringify({ resource_ids: last.slice(10).split(',') }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  else if (typeof last === 'string' && last.startsWith('read '))
    emit({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'resource_call',
                type: 'function',
                function: { name: 'local_read_resource', arguments: JSON.stringify({ resource_id: last.slice(5) }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  else emit({ choices: [{ delta: { content: 'Resource inspected.' }, finish_reason: 'stop' }] });
  res.end('data: [DONE]\n\n');
});
server.listen(Number(arg('--port')), '127.0.0.1');
