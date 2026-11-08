import { spawn } from 'node:child_process';
import { dirname, isAbsolute, posix } from 'node:path';
import { problem } from './engine.mjs';

const kinds = { engine: 'Choisir le moteur llama-server', model: 'Choisir le modèle GGUF', projector: 'Choisir le projecteur de vision' };
function run(command, args, { signal, spawnProcess, env }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', errors = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { finish(signal.reason || new DOMException('Annulé', 'AbortError')); child.kill(); };
    child.stdout.setEncoding?.('utf8');child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 8192) { child.kill(); finish(problem('Réponse du sélecteur trop longue.')); } });
    child.stderr.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-2000); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 || code === 1 ? null : problem(`Le sélecteur de fichiers a échoué. ${errors}`), code === 0 ? output.replace(/[\r\n]+$/, '') : ''));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function chooseLocalFile(kind, { initialPath = '', signal, platform = process.platform, spawnProcess = spawn } = {}) {
  if (!Object.hasOwn(kinds, kind)) throw problem('Type de fichier invalide.');
  if (typeof initialPath !== 'string' || initialPath.length > 4096 || /[\0\r\n]/.test(initialPath)) throw problem('Chemin initial invalide.');
  let selected;
  if (platform === 'win32') {
    const filter = kind === 'engine' ? 'llama-server.exe|llama-server.exe|Exécutables (*.exe)|*.exe' : 'Modèles GGUF (*.gguf)|*.gguf';
    const script = `Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${kinds[kind]}'
$dialog.Filter = '${filter}'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
if ($env:ATELIER_DIALOG_INITIAL -and (Test-Path -LiteralPath $env:ATELIER_DIALOG_INITIAL)) {
  $dialog.InitialDirectory = Split-Path -LiteralPath $env:ATELIER_DIALOG_INITIAL
}
try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) } } finally { $dialog.Dispose() }`;
    selected = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { signal, spawnProcess, env: { ...process.env, ATELIER_DIALOG_INITIAL: initialPath } });
  } else if (platform === 'linux') {
    const start = initialPath ? `${dirname(initialPath)}/` : '';
    const filter = kind === 'engine' ? '*' : '*.gguf';
    const options = { signal, spawnProcess, env: process.env };
    try { selected = await run('zenity', ['--file-selection', `--title=${kinds[kind]}`, `--file-filter=${kind === 'engine' ? 'Tous les fichiers | *' : 'Modèles GGUF | *.gguf *.GGUF'}`, ...(start ? [`--filename=${start}`] : [])], options); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { selected = await run('kdialog', ['--getopenfilename', start, filter, '--title', kinds[kind]], options); }
      catch (error) { if (error.code !== 'ENOENT') throw error; throw problem('Aucun sélecteur disponible (zenity ou kdialog). Tu peux saisir le chemin directement.', 503); }
    }
  } else throw problem('Le sélecteur est disponible sous Windows et Linux.', 503);
  if (!selected) return null;
  if (!(platform === 'linux' ? posix.isAbsolute(selected) : isAbsolute(selected)) || /[\0\r\n]/.test(selected) || selected.length > 4096) throw problem('Le fichier sélectionné est invalide.');
  if (kind !== 'engine' && !/\.gguf$/i.test(selected)) throw problem('Sélectionne un fichier .gguf.');
  if (kind === 'engine' && platform === 'win32' && !/\.exe$/i.test(selected)) throw problem('Sélectionne un moteur .exe.');
  return selected;
}
