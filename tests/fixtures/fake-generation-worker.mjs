import readline from 'node:readline';
const mode = process.env.TEST_RUNNER_MODE;
if (mode === 'crash') process.exit(2);
if (mode !== 'silent')
  console.log(JSON.stringify({ event: 'ready', protocol: 1, capabilities: { krea2: { ready: true } } }));
if (mode === 'libraries') console.log(JSON.stringify({ event: 'libraries', error: 'torch: DLL load failed' }));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'shutdown') process.exit(0);
  if (method === 'hang') continue;
  if (method === 'broken' || method === 'refused') {
    const error =
      method === 'broken'
        ? { message: "No module named 'diffusers'", code: 'LIBRARIES_FAILED' }
        : { message: 'Invalid job', code: 'INVALID_REQUEST' };
    console.log(JSON.stringify({ id, error }));
    continue;
  }
  if (method === 'generate') console.log(JSON.stringify({ event: 'progress', id, data: { step: 1, total: 8 } }));
  if (method === 'bad') console.log('not json');
  else
    console.log(
      JSON.stringify({ id, result: method === 'release' ? { released: true, allocatedGiB: 0 } : { method, params } }),
    );
}
