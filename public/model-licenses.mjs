/**
 * The licences of the files a workflow lacks, shown before they are downloaded (0.6.34): each by
 * its name, a link to its text, the files it covers and its limits in a sentence. They come from
 * runner/downloads.json, written after the table of THIRD_PARTY_NOTICES.md.
 *
 * A free licence (Apache-2.0, MIT, BSD) is only named. One with conditions (`restricted`: LTX 2.5,
 * MiniMax H3, Krea 2, SAM 3.1) is read and confirmed before the download starts: the card of the
 * chat (missing-file.mjs) and the list of the settings (native-workflow-ui.mjs) then show
 * `licenseBlock` with `confirm`, those licences alone, and send `accepted` with the request.
 * Nothing is refused here: the user decides, once the limits are read.
 */

/** The distinct licences of these files, those with conditions first, each with its files. */
export function licensesOf(files = []) {
  const groups = new Map();
  for (const file of files) {
    const license = file?.license;
    if (!license?.name) continue;
    // The same licence with another remark (a repackaged file) is said apart, for its own files.
    const key = license.name + '\n' + (license.limits || '');
    if (!groups.has(key))
      groups.set(key, {
        name: license.name,
        url: license.url || '',
        limits: license.limits || '',
        restricted: license.restricted === true,
        files: [],
      });
    groups.get(key).files.push(file.file);
  }
  return [...groups.values()].sort((a, b) => Number(b.restricted) - Number(a.restricted));
}

/** The licences with conditions among those of these files: to read and confirm before a download. */
export const restrictedOf = files => licensesOf(files).filter(license => license.restricted);

/**
 * The block of the licences: « LICENCES », then each one (its name as a link to its text, the files
 * it covers when there are several licences, its limits under it). `confirm`: those with conditions
 * alone, under « À LIRE AVANT DE TÉLÉCHARGER ». Null when no file names its licence.
 */
export function licenseBlock({ node, files, confirm = false }) {
  const all = licensesOf(files),
    shown = confirm ? all.filter(license => license.restricted) : all;
  if (!shown.length) return null;
  const block = node('div', 'license-block'),
    list = node('ul', 'license-list');
  if (confirm) block.setAttribute('data-confirm', 'true');
  block.setAttribute('role', 'group');
  block.setAttribute(
    'aria-label',
    confirm ? 'Licences à lire avant de télécharger' : 'Licences des fichiers à télécharger',
  );
  for (const license of shown) {
    const item = node('li', 'license-item'),
      line = node('p', 'license-line');
    if (license.restricted) item.setAttribute('data-restricted', 'true');
    if (license.url) {
      const link = node('a', 'license-name', license.name);
      link.href = license.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Lire le texte de la licence (s’ouvre dans le navigateur)';
      line.append(link);
    } else line.append(node('span', 'license-name', license.name));
    if (license.restricted) line.append(node('span', 'license-tag', 'à conditions'));
    if (all.length > 1) line.append(node('span', 'license-files', license.files.join(', ')));
    item.append(line);
    if (license.limits) item.append(node('p', 'license-limits', license.limits));
    list.append(item);
  }
  block.append(
    node('p', 'license-head', confirm ? 'À lire avant de télécharger' : shown.length > 1 ? 'Licences' : 'Licence'),
    list,
  );
  return block;
}
