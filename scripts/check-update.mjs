/**
 * Before each commit (.githooks/pre-commit): what is about to be published must be installable by the
 * copies of Moodix already installed. An update is checked by the code of the version installed, not
 * by the new one: a change that this old check refuses stops every update, the button of the page and
 * the rescue file alike, and nothing published afterwards can repair the copies in the field except
 * taking the change back. It happened in 0.6.38: a library declared in « dependencies ».
 *
 * The sources of the tree to commit (the index, or the tree named as first argument) are packed as
 * GitHub packs them and given to two checks: the one of this version, and the one the installed
 * copies run, kept as it was in 0.6.30 (tests/fixtures/update-archive-0.6.30.mjs).
 */
import { execFileSync } from 'node:child_process';
import { readUpdateArchive } from '../lib/update-archive.mjs';
import { readUpdateArchive as installedCheck } from '../tests/fixtures/update-archive-0.6.30.mjs';

const git = (args, options = {}) => execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, ...options });

/** Why the copies installed would refuse these sources, in plain words; [] when they take them. */
export function refusals(archive, info) {
  const reasons = [];
  // Said first, by name: the checks below only answer « Archive de mise à jour invalide. ».
  if (Object.keys(info.dependencies || {}).length)
    reasons.push(
      'package.json déclare des « dependencies » (' +
        Object.keys(info.dependencies).join(', ') +
        ') : les versions installées refusent alors toute mise à jour. Une bibliothèque facultative va dans « optionalDependencies ».',
    );
  if (info.name !== 'atelier-local' || info.type !== 'module')
    reasons.push('package.json doit garder "name": "atelier-local" et "type": "module".');
  for (const [name, check] of [
    ['la vérification de cette version', readUpdateArchive],
    ['la vérification des versions installées (0.6.30)', installedCheck],
  ])
    try {
      check(archive, { newerThan: '0.0.0' });
    } catch (error) {
      reasons.push(`${name} refuse ces sources : ${error.message}`);
    }
  return reasons;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  let tree, archive, info;
  try {
    tree = process.argv[2] || git(['write-tree'], { encoding: 'utf8' }).trim();
    archive = git(['archive', '--format=tar.gz', '--prefix=moodix/', tree]);
    info = JSON.parse(git(['show', `${tree}:package.json`], { encoding: 'utf8' }));
  } catch (error) {
    // Not a git checkout, or git missing: nothing to check here, never blocking.
    console.log('Vérification des mises à jour : ignorée (' + String(error.message).split('\n')[0] + ').');
    process.exit(0);
  }
  const reasons = refusals(archive, info);
  if (reasons.length) {
    console.error('Ces sources ne pourraient pas être installées par les copies déjà installées :');
    for (const reason of reasons) console.error(' - ' + reason);
    process.exit(1);
  }
  console.log(`Vérification des mises à jour : la ${info.version} est installable par les versions déjà installées.`);
}
