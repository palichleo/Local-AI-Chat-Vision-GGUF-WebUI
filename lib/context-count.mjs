// Older engines can count the text template, but cannot account for vision tokens here.
export async function countContext({ base, apiKey, payload, signal }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const post = (path, body) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const response = await post('/v1/chat/completions/input_tokens', payload);
  if (response.ok) {
    const result = await response.json();
    if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) throw Error('Invalid token count');
    return { used: result.input_tokens, precision: 'exact' };
  }
  await response.body?.cancel();
  if (![404, 405, 501].includes(response.status)) throw Error('Token counting unavailable');
  let images = false;
  const messages = payload.messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.filter(part => { if (part.type === 'image_url') images = true; return part.type === 'text'; }).map(part => part.text).join('\n')
    : message.content }));
  const template = await post('/apply-template', { ...payload, messages });
  if (!template.ok) { await template.body?.cancel(); throw Error('Template unavailable'); }
  const { prompt } = await template.json();
  if (typeof prompt !== 'string') throw Error('Invalid template');
  const tokens = await post('/tokenize', { content: prompt, add_special: true, parse_special: true });
  if (!tokens.ok) { await tokens.body?.cancel(); throw Error('Tokenizer unavailable'); }
  const result = await tokens.json();
  if (!Array.isArray(result.tokens)) throw Error('Invalid tokens');
  return { used: result.tokens.length, precision: images ? 'text-only' : 'estimated' };
}
