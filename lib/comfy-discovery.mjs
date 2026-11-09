import { ComfyClient, normalizeComfyUrl } from './comfy-client.mjs';

export async function testComfyConnection(baseUrl, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const url = normalizeComfyUrl(baseUrl);
  const status = await new ComfyClient(url, { fetchImpl }).status({ signal: AbortSignal.timeout(timeoutMs) });
  if (typeof status.system?.comfyui_version !== 'string')
    throw Object.assign(new Error('Cette adresse ne répond pas comme un serveur ComfyUI.'), { status: 502 });
  return { baseUrl: url, status };
}

export async function discoverComfy(
  savedUrl,
  { candidates = ['http://127.0.0.1:8188', 'http://127.0.0.1:7821'], ...options } = {},
) {
  const urls = [...new Set([savedUrl, ...candidates].filter(Boolean).map(normalizeComfyUrl))];
  const results = await Promise.allSettled(urls.map(url => testComfyConnection(url, options)));
  for (const result of results) if (result.status === 'fulfilled') return { detected: true, ...result.value };
  return { detected: false, baseUrl: savedUrl || urls[0] };
}
