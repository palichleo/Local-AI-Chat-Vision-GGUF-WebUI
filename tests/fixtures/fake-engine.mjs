// Moteur HTTP de smoke uniquement : il ne charge et n'exécute aucun modèle.
import http from 'node:http';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  // As llama-server says it, on its error stream.
  console.error('version: 1 (fake)\nbuilt with node');
  process.exit(0);
}
const arg = name => args[args.indexOf(name) + 1];
if (!args.includes('--offline') || arg('--host') !== '127.0.0.1') process.exit(2);
const key = arg('--api-key');
console.log(`Bibliothèque GPU : ${process.env.GGML_BACKEND_PATH || 'aucune'}`);
console.log(`Métadonnées : ${args.includes('--override-kv') ? arg('--override-kv') : 'sans correction'}`);
console.log(`Modèle lancé : ${arg('-m')}`);
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end();
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (req.url === '/v1/chat/completions/input_tokens') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ input_tokens: 321 }));
  }
  console.log(`Limite de sortie : ${body.max_tokens}`);
  const content = body.messages.at(-1).content;
  const isImage = Array.isArray(content) && content.some(part => part.type === 'image_url');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Je réfléchis. ' } }] })}\n\n`);
  if (content === 'lent' || /sans réponse$/.test(content)) {
    const timer = setInterval(() => res.write(': attente\n\n'), 100);
    res.on('close', () => clearInterval(timer));
    return;
  }
  const response = isImage ? 'Image reçue par le moteur simulé.' : `Bonjour, été ! Contexte ${arg('--ctx-size')}.`;
  const data = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: response } }] })}\n\n`);
  // Coupe au milieu d'un caractère UTF-8 pour vérifier le relais et le lecteur.
  const split = data.indexOf(Buffer.from('é')) + 1;
  res.write(data.subarray(0, split));
  setTimeout(() => {
    res.write(data.subarray(split));
    res.end('data: [DONE]\n\n');
  }, 15);
});
server.listen(Number(arg('--port')), '127.0.0.1');
