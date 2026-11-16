import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';

/**
 * « Démarrer » on the line of MOSS Image (16/11): the ComfyUI application that serves it, started
 * on its own (detached: it outlives Moodix, which never stops it). Found once, then remembered
 * (data/comfy-engine.json, `launchPath`): the only ComfyUI that Windows lists as installed (its
 * uninstall entries), or the one the user chooses when there are none or several. Only an
 * application whose name says Comfy is started.
 */
const UNINSTALL_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root | ForEach-Object {
    $entry = Get-ItemProperty -LiteralPath $_.PSPath
    if ($entry.DisplayName -match 'comfy' -and $entry.DisplayIcon) { [Console]::WriteLine($entry.DisplayIcon) }
  }
}`;

/** Whether `path` may be started as ComfyUI: an absolute .exe whose name says Comfy. */
export function isComfyApp(path, platform = process.platform) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\r\n]/.test(path)) return false;
  if (platform !== 'win32') return false;
  return win32.isAbsolute(path) && /\.exe$/i.test(path) && /comfy/i.test(win32.basename(path));
}

const isFile = async path => (await stat(path).catch(() => null))?.isFile() === true;

function runPowerShell(script, { spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  return new Promise(resolve => {
    let output = '';
    const child = spawnProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', bytes => {
      output = (output + bytes.toString('utf8')).slice(-65536);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

/**
 * The ComfyUI applications installed here, without duplicates: those of the uninstall entries
 * (their icon is their program), then the usual places of ComfyUI Desktop.
 */
export async function findComfyApps({
  platform = process.platform,
  env = process.env,
  run = runPowerShell,
  exists = isFile,
} = {}) {
  if (platform !== 'win32') return [];
  const listed = String(await run(UNINSTALL_SCRIPT))
    .split(/\r?\n/)
    .map(line => line.trim().replace(/,\s*-?\d+$/, '').replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const usual = env.LOCALAPPDATA
    ? [
        win32.join(env.LOCALAPPDATA, 'Programs', 'ComfyUI', 'ComfyUI.exe'),
        win32.join(env.LOCALAPPDATA, 'Programs', 'Comfy Desktop', 'Comfy Desktop.exe'),
      ]
    : [];
  const found = [];
  for (const path of [...listed, ...usual])
    if (isComfyApp(path, platform) && !found.some(item => item.toLowerCase() === path.toLowerCase()) && (await exists(path)))
      found.push(path);
  return found;
}

/** Starts ComfyUI on its own; an error of the start (a file gone) is only said by its silence. */
export function launchComfy(path, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(path, [], {
    cwd: win32.dirname(path),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
  });
  child.on?.('error', () => {});
  child.unref?.();
}
