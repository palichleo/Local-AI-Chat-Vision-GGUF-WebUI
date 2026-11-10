#!/usr/bin/env node
/**
 * Publishes workflows tuned in Atelier as shipped workflows (for the maintainer).
 *
 * Edits made in Settings > Workflows are saved in workflow/, the user's own folder that updates
 * never touch. To ship them to everyone, this script copies them into runner/workflows/ (the
 * folder an update replaces), records the fingerprint of the version they replace in
 * runner/workflow-history.json, and removes the local copy so this installation follows the
 * shipped version again.
 *
 *   node scripts/ship-workflows.mjs            lists the workflows of workflow/
 *   node scripts/ship-workflows.mjs <id>...    ships those (an edited shipped one, or a new one)
 */
import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNativeWorkflow, workflowFingerprint } from '../lib/native-workflows.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'),
  user = join(root, 'workflow'),
  shipped = join(root, 'runner', 'workflows'),
  historyPath = join(root, 'runner', 'workflow-history.json'),
  statePath = join(root, 'data', 'workflow-natives.json');
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => read(path).then(
  value => value,
  () => null,
);

const ids = process.argv.slice(2);
const local = (await readdir(user).catch(() => [])).filter(name => name.endsWith('.json'));
if (!ids.length) {
  if (!local.length) console.log('Aucun workflow dans workflow/ : rien à publier.');
  for (const name of local) {
    const workflow = await read(join(user, name)),
      replaces = await exists(join(shipped, name));
    console.log(`${workflow.id}  ${workflow.name}  ${replaces ? '(remplace la version fournie)' : '(nouveau)'}`);
  }
  console.log('\nPour publier : node scripts/ship-workflows.mjs <id> [<id>…]');
  process.exit(0);
}
const history = (await exists(historyPath)) || { workflows: {} };
const state = (await exists(statePath)) || null;
for (const id of ids) {
  const path = join(user, id + '.json'),
    target = join(shipped, id + '.json');
  const workflow = await exists(path);
  if (!workflow) throw new Error(`workflow/${id}.json introuvable.`);
  const { digest, ...stored } = validateNativeWorkflow(workflow);
  if (stored.importDraft) throw new Error(`${stored.name} est un brouillon importé : activez-le avant de le publier.`);
  const previous = await exists(target);
  const known = new Set(history.workflows[id] || []);
  if (previous) known.add(workflowFingerprint(previous));
  known.add(workflowFingerprint(stored));
  history.workflows[id] = [...known].sort();
  await writeFile(target, JSON.stringify(stored, null, 2) + '\n');
  await rm(path);
  if (state?.basedOn) delete state.basedOn[id];
  console.log(`Publié : ${stored.name} → runner/workflows/${id}.json`);
}
history.workflows = Object.fromEntries(Object.entries(history.workflows).sort());
await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n');
if (state) await writeFile(statePath, JSON.stringify(state, null, 2));
console.log('Committez runner/workflows/ et runner/workflow-history.json pour les livrer.');
