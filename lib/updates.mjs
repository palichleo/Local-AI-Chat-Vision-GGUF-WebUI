/**
 * The repository on GitHub. By its number where GitHub takes one: its name can change, its number
 * cannot. Renamed on 17/11 (Local-AI-Chat-Vision-GGUF-WebUI, then Moodix-AI), GitHub answered the
 * request that pins the commit to install (api.github.com/repos/<name>) by a redirect, which was
 * refused: every copy installed saw the new version and could not install it. Its files and its
 * archives are still served under a former name; they are asked for under the present one.
 */
export const REPOSITORY = 'palichleo/Moodix-AI';
export const REPOSITORY_ID = 1449534927;
const versionUrl = `https://raw.githubusercontent.com/${REPOSITORY}/main/package.json`;
// The hosts of GitHub an update is read from: a redirect from one of them to one of them is
// followed (a repository renamed again), twice at most; any other is refused, as all were.
const GITHUB_HOSTS = new Set(['api.github.com', 'codeload.github.com', 'raw.githubusercontent.com']);

/** `fetchUpdate(url, options)` without following a redirect, except between the hosts above. */
export async function githubFetch(fetchUpdate, url, options) {
  for (let hop = 0; ; hop++) {
    const response = await fetchUpdate(url, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    let next = null;
    try {
      if (location) next = new URL(location, url);
    } catch {}
    if (hop >= 2 || next?.protocol !== 'https:' || !GITHUB_HOSTS.has(next.hostname))
      throw new Error('Redirection de la mise à jour refusée.');
    url = next.href;
  }
}
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(value) {
  if (typeof value !== 'string' || !stableVersion.test(value)) return null;
  const numbers = value.split('.').map(Number);
  return numbers.every(Number.isSafeInteger) ? numbers : null;
}

export function newerVersion(candidate, current) {
  const next = parts(candidate),
    installed = parts(current);
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
    const response = await githubFetch(fetchVersion, versionUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'AtelierLocal-update-check' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 32768) {
      await response.body?.cancel();
      return { available: false };
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 32768) return { available: false };
      chunks.push(Buffer.from(chunk));
    }
    const remote = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return remote?.name === 'atelier-local' && newerVersion(remote.version, currentVersion)
      ? { available: true, version: remote.version }
      : { available: false };
  } catch {
    return { available: false };
  }
}
