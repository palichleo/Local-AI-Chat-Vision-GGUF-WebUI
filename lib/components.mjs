import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeEnvironment } from './engine.mjs';
import { environmentVariables } from './python-environment.mjs';

/**
 * The versions of what Atelier runs on, for the Update tab of the settings: each program is
 * asked its version, nothing is installed, downloaded or loaded on the graphics card.
 * A row says { id, name, version, detail, state } with state "ok", "missing", "error" or "off".
 */

// Package versions read from the Python environment's metadata: torch is not imported.
const PYTHON_PROBE = [
  'import json,sys',
  'from importlib import metadata',
  'def v(n):',
  '  try: return metadata.version(n)',
  '  except Exception: return ""',
  'print(json.dumps({"python":sys.version.split()[0],"torch":v("torch"),"diffusers":v("diffusers"),"transformers":v("transformers")}))',
].join('\n');

/** Runs a program and gives what it said (stdout and stderr), or null when it did not start or end in time. */
export function runVersion(command, args, { env, timeout = 15000, spawnProcess = spawn } = {}) {
  return new Promise(done => {
    let output = '',
      child;
    try {
      child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      child.kill?.();
      done(null);
    }, timeout);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', chunk => {
        if (output.length < 8000) output += chunk;
      });
    child.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.once('close', code => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/**
 * "version: 6912 (a1b2c3d)" and the first device llama.cpp found. A build made outside the
 * llama.cpp releases (the one Ollama ships says "version: 1") is named by its commit.
 */
export function llamaVersion(output) {
  const text = String(output || '');
  const match = text.match(/\bversion:\s*(\d+)\s*(?:\(([0-9a-f]{6,40})\))?/i);
  if (!match) return null;
  const build = Number(match[1]),
    commit = match[2]?.slice(0, 7) || '';
  const device = text.match(/Device\s+0:\s*([^,\r\n]+)/i)?.[1]?.trim() || '';
  const release = build > 1 || !commit;
  return {
    version: release ? 'b' + build : commit,
    detail: [release ? (commit ? 'commit ' + commit : '') : 'build hors versions publiées', device]
      .filter(Boolean)
      .join(' · '),
  };
}

/** "2.9.1+cu130" → 2.9.1 and CUDA 13.0; a build without CUDA cannot generate. */
export function torchVersion(value) {
  const [version, local = ''] = String(value || '').split('+');
  const cuda = local.match(/^cu(\d+)(\d)$/);
  return { version, cuda: cuda ? `${cuda[1]}.${cuda[2]}` : '', cpu: local === 'cpu' };
}

/** "NVIDIA GeForce RTX 4070, 581.57, 12282" (name, driver, memory in MiB). */
export function nvidiaVersion(output) {
  const line = String(output || '')
    .split(/\r?\n/)
    .map(item => item.trim())
    .find(item => item.split(',').length >= 3);
  if (!line) return null;
  const [name, driver, memory] = line.split(',').map(item => item.trim());
  const gigabytes = Math.round(Number(memory) / 1024);
  return { version: driver, detail: [name, gigabytes > 0 ? gigabytes + ' Go' : ''].filter(Boolean).join(' · ') };
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function llamaRow(config, run) {
  const row = { id: 'llama', name: 'llama.cpp (llama-server)', version: '', detail: '', state: 'ok' };
  if (!config.enginePath) return { ...row, state: 'missing', detail: 'Aucun moteur choisi dans l’onglet LLM.' };
  if (!(await exists(config.enginePath))) return { ...row, state: 'missing', detail: 'Fichier introuvable.' };
  const answer = await run(config.enginePath, ['--version'], { env: await nativeEnvironment(config) });
  const found = answer && llamaVersion(answer.output);
  if (!found) return { ...row, state: 'error', detail: 'Ce programme ne donne pas de version de llama-server.' };
  // Ollama's copy of llama-server is updated with Ollama, not on its own.
  if (/[\\/]ollama[\\/]/i.test(config.enginePath)) found.detail = [found.detail, 'fourni par Ollama'].join(' · ');
  return { ...row, ...found };
}

async function pythonRows({ pythonPath, runtimeDir, platform }, run) {
  const privateEnvironment = !pythonPath;
  const python =
    pythonPath || join(runtimeDir, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const row = { id: 'python', name: 'Python de génération', version: '', detail: '', state: 'ok' };
  if (privateEnvironment && !(await exists(python)))
    return [{ ...row, state: 'missing', detail: 'Pas encore préparé : il s’installe à la première génération.' }];
  const answer = await run(python, ['-I', '-c', PYTHON_PROBE], {
    env: environmentVariables(runtimeDir),
    timeout: 20000,
  });
  let found;
  try {
    found = answer?.code === 0 ? JSON.parse(answer.output.trim().split(/\r?\n/).at(-1)) : null;
  } catch {}
  if (!found) return [{ ...row, state: 'error', detail: 'Ce Python ne répond pas.' }];
  const torch = torchVersion(found.torch);
  const missing = 'Absent de l’environnement.';
  return [
    { ...row, version: found.python, detail: privateEnvironment ? 'Environnement privé d’Atelier' : python },
    {
      id: 'torch',
      name: 'PyTorch',
      version: torch.version,
      detail: torch.cuda ? 'CUDA ' + torch.cuda : torch.version ? (torch.cpu ? 'Sans CUDA' : '') : missing,
      state: !torch.version ? 'missing' : torch.cpu ? 'error' : 'ok',
    },
    ...['diffusers', 'transformers'].map(name => ({
      id: name,
      name: name === 'diffusers' ? 'Diffusers' : 'Transformers',
      version: found[name] || '',
      detail: found[name] ? '' : missing,
      state: found[name] ? 'ok' : 'missing',
    })),
  ];
}

async function nvidiaRow(run) {
  const row = { id: 'nvidia', name: 'Pilote NVIDIA', version: '', detail: '', state: 'ok' };
  const answer = await run(
    'nvidia-smi',
    ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
    { timeout: 8000 },
  );
  const found = answer?.code === 0 && nvidiaVersion(answer.output);
  return found ? { ...row, ...found } : { ...row, state: 'off', detail: 'Aucune carte NVIDIA trouvée.' };
}

/** Every row, asked at the same time: llama.cpp first, the server that runs the page under it. */
export async function componentVersions({
  config,
  pythonPath = '',
  runtimeDir,
  platform = process.platform,
  run = runVersion,
}) {
  const [llama, python, nvidia] = await Promise.all([
    llamaRow(config, run),
    pythonRows({ pythonPath, runtimeDir, platform }, run),
    nvidiaRow(run),
  ]);
  return [
    llama,
    { id: 'node', name: 'Node.js', version: process.versions.node, detail: '', state: 'ok' },
    nvidia,
    ...python,
  ];
}
