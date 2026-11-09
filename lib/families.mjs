import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generation families are declared once, in runner/families/<name>.json, and read by both
 * this server and the Python worker. Nothing else in the application names a family.
 */
const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'runner', 'families');
let cache;

function check(manifest, file) {
  const name = file.slice(0, -5);
  if (manifest.family !== name || !/^[a-z][a-z0-9_]{0,39}$/.test(name))
    throw Error(`Family manifest ${file} must declare family "${name}"`);
  for (const key of ['label', 'mediaType', 'tasks', 'components', 'parameters', 'roles'])
    if (manifest[key] === undefined) throw Error(`Family manifest ${file} lacks ${key}`);
  for (const [role, spec] of Object.entries(manifest.roles))
    if (!spec.as || !['image', 'video', 'audio'].includes(spec.media))
      throw Error(`Family ${name} role ${role} needs "as" and an image, video or audio media`);
  return Object.freeze(manifest);
}

/** All family manifests by name. */
export function families() {
  if (!cache) {
    cache = {};
    let files = [];
    try {
      files = readdirSync(directory);
    } catch (error) {
      // Without the runner folder the application still chats; it simply offers no generation family.
      if (error.code !== 'ENOENT') throw error;
    }
    for (const file of files.filter(name => name.endsWith('.json')).sort())
      cache[file.slice(0, -5)] = check(JSON.parse(readFileSync(join(directory, file), 'utf8')), file);
  }
  return cache;
}

export function family(name) {
  const manifest = typeof name === 'string' ? families()[name] : undefined;
  if (!manifest) throw Object.assign(new Error('Unsupported pipeline'), { status: 400 });
  return manifest;
}

/** Summary sent to the browser: everything the workflow editor needs to render a family. */
export function familyCatalog() {
  return Object.values(families()).map(({ template, ...manifest }) => manifest);
}

/** A new, disabled workflow pre-filled from the family's template. */
export function familyTemplate(manifest) {
  return {
    schemaVersion: 1,
    id: `${manifest.family}-${manifest.mediaType}`,
    enabled: false,
    pipeline: manifest.family,
    mediaType: manifest.mediaType,
    ...structuredClone(manifest.template),
  };
}
