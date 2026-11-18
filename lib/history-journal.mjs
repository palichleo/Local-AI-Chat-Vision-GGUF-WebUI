import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What became of the conversations of the history (0.6.103): one line of JSON per conversation put in
 * the bin, given back, erased, purged after its 30 days, found again, set aside because its file could
 * not be read, or kept as it was before a save took messages out of it; and each deletion refused. Its
 * date, its identifier, its name, how many messages and takes it had, why, the tab that asked it and
 * the version: never what it said. A conversation of a friend « s'est supprimée » (18/11) and nothing
 * told what had happened to it. `data/history-journal.jsonl`, beside the journal of the generations.
 */
export class HistoryJournal {
  /** `limit`: past it, the oldest half goes (the journal keeps the last months, never grows for ever). */
  constructor(path, { version = '', limit = 512 * 1024 } = {}) {
    this.path = path;
    this.version = version;
    this.limit = limit;
    this.pending = Promise.resolve();
  }

  /** One line; a journal that cannot be written never stops what it tells. */
  write(entry) {
    const line =
      JSON.stringify({
        date: new Date().toISOString(),
        ...entry,
        ...(this.version ? { version: this.version } : {}),
      }) + '\n';
    this.pending = this.pending
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const size = await stat(this.path).then(
          info => info.size,
          () => 0,
        );
        if (size + line.length > this.limit) {
          const kept = (await readFile(this.path, 'utf8')).slice(-Math.floor(this.limit / 2));
          await writeFile(this.path, kept.slice(kept.indexOf('\n') + 1), { mode: 0o600 });
        }
        await appendFile(this.path, line, { mode: 0o600 });
      })
      .catch(() => {});
    return this.pending;
  }

  /** The lines written, the oldest first (for the tests, and whoever reads the journal). */
  async entries() {
    await this.pending;
    try {
      return (await readFile(this.path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}
