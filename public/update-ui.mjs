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
  // Busy for a moment (a model loading after the settings were saved, a generation ending): the
  // server says so, and the click is kept, asked again until it can start.
  const startBy = Date.now() + 90000;
  for (;;) {
    try {
      await api('updates/install', { session });
      break;
    } catch (error) {
      if (!error?.busy || Date.now() > startBy) throw error;
      onProgress(`${error.message} La mise à jour démarrera ensuite.`, 'download');
      await pause();
    }
  }
  const deadline = Date.now() + 360000;
  // Its steps as the panel shows them (etats-maquette.md, 56): download, install, restart.
  onProgress('Téléchargement et préparation de la mise à jour…', 'download');
  while (Date.now() < deadline) {
    let status;
    try {
      status = await (await api('updates/install')).json();
    } catch {
      /* The old server closes during replacement: the application restarts. */
      onProgress('Redémarrage de l’application…', 'restart');
    }
    if (status?.state === 'error') throw new Error(status.error || 'La mise à jour a échoué.');
    if (status?.state === 'restarting') onProgress('Installation et redémarrage de l’application…', 'install');
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
    'Redémarrage non confirmé. Votre brouillon reste dans cette page. Si Moodix ne revient pas, relancez-le avec Lancer-Windows.cmd.',
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
