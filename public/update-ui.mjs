export async function installFromButton({
  api,
  token,
  session,
  onProgress,
  reload = () => location.reload(),
  bootstrap = async () => {
    const response = await fetch('/api/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Redémarrage en cours.');
    return response.json();
  },
  pause = () => new Promise(resolve => setTimeout(resolve, 750)),
}) {
  await api('updates/install', { session });
  const deadline = Date.now() + 180000;
  onProgress('Téléchargement et préparation de la mise à jour…');
  while (Date.now() < deadline) {
    let status;
    try {
      status = await (await api('updates/install')).json();
    } catch {
      /* The old server closes during replacement. */
    }
    if (status?.state === 'error') throw new Error(status.error || 'La mise à jour a échoué.');
    if (status?.state === 'restarting') onProgress('Installation et redémarrage de l’application…');
    try {
      const next = await bootstrap();
      if (next.token && next.token !== token && !next.updating) {
        reload();
        return;
      }
    } catch {
      /* Wait for the replacement server. */
    }
    await pause();
  }
  throw new Error(
    'Redémarrage non confirmé. Le brouillon reste dans cette page. Consulte data/update-status.json et relance l’application si nécessaire.',
  );
}

export function compactSession(session) {
  const snapshot = session.archiveSnapshot;
  if (
    !snapshot?.messages ||
    snapshot.messages.length < session.messages.length ||
    !session.messages.every(
      (message, index) =>
        snapshot.messages[index] === message || JSON.stringify(snapshot.messages[index]) === JSON.stringify(message),
    )
  )
    return session;
  return {
    ...session,
    archiveSnapshot: { incomplete: snapshot.incomplete, tail: snapshot.messages.slice(session.messages.length) },
  };
}
