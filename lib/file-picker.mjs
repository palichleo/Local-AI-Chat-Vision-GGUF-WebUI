import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { problem } from './engine.mjs';

const kinds = { engine: 'Choisir le moteur llama-server', model: 'Choisir le modèle GGUF', projector: 'Choisir le projecteur de vision', generation:'Choisir un modèle de génération',python:'Choisir Python',tokenizer:'Choisir tokenizer.json',workflow:'Choisir un workflow ComfyUI',directory:'Choisir le dossier des modèles' };
function run(command, args, { signal, spawnProcess, env, cancelCode }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnProcess(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '', errors = '', settled = false, failure;
    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    // Keep the server lock until the native dialog has actually exited.
    const stop = error => { if (settled || failure) return; failure = error; child.kill(); };
    const abort = () => stop(signal.reason || new DOMException('Annulé', 'AbortError'));
    child.stdout.setEncoding?.('utf8'); child.stderr.setEncoding?.('utf8');
    child.stdout.on('data', bytes => { if (failure) return; output += bytes.toString('utf8'); if (output.length > 8192) stop(problem('Réponse du sélecteur trop longue.')); });
    child.stderr.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-2000); });
    child.once('error', error => finish(failure || error));
    child.once('close', code => {
      if (failure) finish(failure);
      else if (code === 0) finish(null, output.replace(/[\r\n]+$/, ''));
      else if (code === cancelCode) finish(null, '');
      else finish(problem(`Le sélecteur de fichiers a échoué. ${errors}`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function chooseLocalFile(kind, { initialPath = '', signal, platform = process.platform, spawnProcess = spawn } = {}) {
  if (!Object.hasOwn(kinds, kind)) throw problem('Type de fichier invalide.');
  if (typeof initialPath !== 'string' || initialPath.length > 4096 || /[\0\r\n]/.test(initialPath)) throw problem('Chemin initial invalide.');
  initialPath = initialPath.trim().replace(/^"(.*)"$/, '$1');
  let selected;
  if (platform === 'win32') {
    const filter = kind==='generation'?'Modèles Safetensors (*.safetensors)|*.safetensors':['tokenizer','workflow'].includes(kind)?'Fichiers JSON (*.json)|*.json':kind==='python'?'Python (*.exe)|*.exe':kind === 'engine' ? 'llama-server.exe|llama-server.exe|Exécutables (*.exe)|*.exe' : 'Modèles GGUF (*.gguf)|*.gguf';
    const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.${kind==='directory'?'FolderBrowserDialog':'OpenFileDialog'}
try {
${kind==='directory'?`  $dialog.Description = '${kinds[kind]}'
  $dialog.ShowNewFolderButton = $true
  if ($env:ATELIER_DIALOG_INITIAL -and (Test-Path -LiteralPath $env:ATELIER_DIALOG_INITIAL -PathType Container)) { $dialog.SelectedPath = $env:ATELIER_DIALOG_INITIAL }
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }`:`
  $dialog.Title = '${kinds[kind]}'
  $dialog.Filter = '${filter}'
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  if ($env:ATELIER_DIALOG_INITIAL) {
    try {
      $initial = Get-Item -LiteralPath $env:ATELIER_DIALOG_INITIAL -ErrorAction SilentlyContinue
      if ($initial -and $initial.PSIsContainer) { $dialog.InitialDirectory = $initial.FullName }
      else {
        $parent = [System.IO.Path]::GetDirectoryName($env:ATELIER_DIALOG_INITIAL)
        if ($parent -and (Test-Path -LiteralPath $parent -PathType Container)) { $dialog.InitialDirectory = $parent }
        if ($initial) { $dialog.FileName = $initial.Name }
      }
    } catch { } # An invalid typed path must not prevent browsing for a replacement.
  }
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) }`}
} finally { $dialog.Dispose() }`;
    selected = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { signal, spawnProcess, env: { ...process.env, ATELIER_DIALOG_INITIAL: initialPath } });
  } else if (platform === 'linux') {
    const directory = initialPath && (await stat(initialPath).catch(() => null))?.isDirectory() ? initialPath : posix.dirname(initialPath);
    const start = initialPath ? `${directory.replace(/\/+$/, '')}/` : '';
    const filter = kind==='generation'?'*.safetensors':['tokenizer','workflow'].includes(kind)?'*.json':['engine','python'].includes(kind)?'*':'*.gguf *.GGUF';
    const options = { signal, spawnProcess, env: process.env, cancelCode: 1 };
    try { selected = await run('zenity', ['--file-selection', `--title=${kinds[kind]}`, ...(kind==='directory'?['--directory']:[`--file-filter=${filter}`]), ...(start ? [`--filename=${start}`] : [])], options); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { selected = await run('kdialog', kind==='directory'?['--getexistingdirectory', start, '--title', kinds[kind]]:['--getopenfilename', start, filter, '--title', kinds[kind]], options); }
      catch (error) { if (error.code !== 'ENOENT') throw error; throw problem('Aucun sélecteur disponible (zenity ou kdialog). Tu peux saisir le chemin directement.', 503); }
    }
  } else throw problem('Le sélecteur est disponible sous Windows et Linux.', 503);
  if (!selected) return null;
  if (!(platform === 'linux' ? posix.isAbsolute(selected) : win32.isAbsolute(selected)) || /[\0\r\n]/.test(selected) || selected.length > 4096) throw problem('Le fichier sélectionné est invalide.');
  if (['model','projector'].includes(kind) && !/\.gguf$/i.test(selected)) throw problem('Sélectionne un fichier .gguf.');
  if(kind==='generation'&&!/\.safetensors$/i.test(selected))throw problem('Sélectionne un fichier .safetensors.');
  if(['tokenizer','workflow'].includes(kind)&&!/\.json$/i.test(selected))throw problem('Sélectionne un fichier JSON.');
  if (kind === 'engine' && platform === 'win32' && !/\.exe$/i.test(selected)) throw problem('Sélectionne un moteur .exe.');
  return selected;
}
