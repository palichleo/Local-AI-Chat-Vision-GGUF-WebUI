export async function readSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  const consume = async () => {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        complete = true;
        return;
      }
      const event = JSON.parse(data);
      if (event.error)
        throw new Error(typeof event.error === 'string' ? event.error : event.error.message || 'Erreur du moteur.');
      await onEvent(event);
    }
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Une trame de réponse dépasse la taille autorisée.');
      await consume();
      if (done) break;
    }
    if (!complete) throw new Error('La connexion au moteur a été interrompue. La réponse reçue est conservée.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
