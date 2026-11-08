const versionUrl = 'https://raw.githubusercontent.com/palichleo/Local-AI-Chat-Vision-GGUF-WebUI/main/package.json';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(value) {
  if (typeof value !== 'string' || !stableVersion.test(value)) return null;
  const numbers = value.split('.').map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

export function newerVersion(candidate, current) {
  const next = parts(candidate), installed = parts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

export async function checkForUpdates({ currentVersion, signal, fetchVersion = fetch }) {
  if (!parts(currentVersion)) return { available: false };
  const timeout = AbortSignal.timeout(4000);
  try {
    const response = await fetchVersion(versionUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'AtelierLocal-update-check' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 32768) {
      await response.body?.cancel();
      return { available: false };
    }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 32768) return { available: false };
      chunks.push(Buffer.from(chunk));
    }
    const remote = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return remote?.name === 'atelier-local' && newerVersion(remote.version, currentVersion)
      ? { available: true, version: remote.version } : { available: false };
  } catch { return { available: false }; }
}
