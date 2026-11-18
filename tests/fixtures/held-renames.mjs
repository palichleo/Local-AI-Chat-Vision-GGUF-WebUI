import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

/**
 * Windows refusing for an instant to put a file in its place (an antivirus reading what was just
 * written or downloaded, the indexer): the first two renames onto each file of `paths` refused
 * (EPERM, then EBUSY), every other rename let through. Each module imports fs.rename itself: it is
 * replaced for the time of `work` (module.syncBuiltinESMExports). Resolves with the number of
 * refusals of each file: 2 for a file put in its place once its refusals were tried again.
 * `onRefused(path)`: at each refusal, while the work waits (what it says meanwhile, 0.6.87).
 */
export async function held(paths, work, { onRefused = () => {} } = {}) {
  const rename = fs.rename,
    refused = new Map(paths.map(path => [resolve(path), 0]));
  fs.rename = async (from, to) => {
    const count = refused.get(resolve(to));
    if (count === undefined || count >= 2) return rename(from, to);
    refused.set(resolve(to), count + 1);
    const code = count ? 'EBUSY' : 'EPERM';
    onRefused(resolve(to));
    throw Object.assign(new Error(`${code}: refused for an instant, rename '${from}' -> '${to}'`), { code });
  };
  syncBuiltinESMExports();
  try {
    await work();
  } finally {
    fs.rename = rename;
    syncBuiltinESMExports();
  }
  return Object.fromEntries(refused);
}

/** What `held` resolves with when each file of `paths` was refused twice, then put in its place. */
export const twice = paths => Object.fromEntries(paths.map(path => [resolve(path), 2]));
