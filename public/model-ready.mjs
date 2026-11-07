function pause(signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 500);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForModel(api, signal, onStatus) {
  const read = async (route, body) => {
    signal.throwIfAborted();
    return (await api(route, body, { signal })).json();
  };
  let status = await read('status');
  if (['stopped', 'error'].includes(status.state)) {
    try { status = await read('start', {}); }
    catch (error) {
      if (error.status !== 409) throw error;
      status = await read('status');
      if (!['loading', 'ready'].includes(status.state)) throw error;
    }
  }
  while (status.state === 'loading') {
    onStatus(status);
    await pause(signal);
    status = await read('status');
  }
  signal.throwIfAborted();
  onStatus(status);
  if (status.state !== 'ready') throw new Error(status.error || 'Le démarrage du modèle a été interrompu. Votre message a été conservé.');
  return status;
}
