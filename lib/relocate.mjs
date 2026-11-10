import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A path this installation saved while it lived in another folder: when it no longer exists,
 * the same file under this installation's own models/ or data/ folder, if there is one.
 * Moving or renaming the application folder then keeps the chat model and its settings.
 */
export function relocate(path, root) {
  if (!path || existsSync(path)) return path;
  const parts = path.split(/[\\/]+/).filter(Boolean),
    lower = parts.map(part => part.toLowerCase());
  for (const anchor of ['models', 'data']) {
    const at = lower.lastIndexOf(anchor);
    if (at < 0 || at === parts.length - 1) continue;
    const candidate = join(root, anchor, ...parts.slice(at + 1));
    if (existsSync(candidate)) return candidate;
  }
  return path;
}
