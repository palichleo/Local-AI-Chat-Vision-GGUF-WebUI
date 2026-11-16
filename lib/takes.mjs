import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { projectId } from './projects.mjs';

/**
 * The numbers of the takes, « PRISE n » (claude_design/maquettes/reference-maquettes.md):
 * - one counter per project, every kind together, in the order of creation;
 * - a number is given when the take is made and never changes, except when its conversation
 *   goes to another project (moved, or its project deleted): it then takes the numbers that follow
 *   in the project it joins;
 * - a number is never given twice in a project: a counter only goes up.
 * The counters are kept in data/takes.json, the number of each take in the manifest of its run
 * (lib/gallery.mjs).
 */
export class Takes {
  constructor(path) {
    this.path = path;
    this.counters = null;
    // false until the file is there: the takes made before 0.6.4 are numbered once (server.mjs).
    this.known = false;
    this.pending = Promise.resolve();
  }

  async #load() {
    if (this.counters) return;
    this.counters = {};
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version === 1 && data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)) {
        for (const [id, last] of Object.entries(data.projects))
          if (Number.isInteger(last) && last >= 0) this.counters[id] = last;
        this.known = true;
      }
    } catch (error) {
      // Missing or unreadable: the counters are made again from the manifests (server.mjs).
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  async #save() {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, projects: this.counters }, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
    this.known = true;
  }

  #queue(work) {
    const run = this.pending.then(async () => {
      await this.#load();
      return work();
    });
    this.pending = run.catch(() => {});
    return run;
  }

  /** Whether the counters are written (false: the takes of earlier versions are to be numbered). */
  ready() {
    return this.#queue(() => this.known);
  }

  /** The last number given in a project (0 before any). */
  last(project) {
    return this.#queue(() => this.counters[projectId(project || 'inbox')] ?? 0);
  }

  /** `count` new numbers in `project`, those that follow its counter. */
  next(project, count) {
    return this.#queue(async () => {
      if (!Number.isInteger(count) || count < 0 || count > 100000) throw new Error('Nombre de prises invalide.');
      const id = projectId(project || 'inbox'),
        first = (this.counters[id] ?? 0) + 1;
      if (!count) return [];
      this.counters[id] = first + count - 1;
      await this.#save();
      return Array.from({ length: count }, (_, index) => first + index);
    });
  }

  /** The counters made again (numbering of the takes of earlier versions): never lowered. */
  raise(counters) {
    return this.#queue(async () => {
      for (const [id, last] of Object.entries(counters))
        if (Number.isInteger(last) && last > (this.counters[id] ?? 0)) this.counters[id] = last;
      await this.#save();
    });
  }
}

/**
 * The numbers of runs, in their order of creation: each output keeps its number, those without
 * one take the numbers that follow `last`. Returns the runs to write again and the new counter.
 */
export function numbered(runs, last = 0) {
  let counter = Math.max(last, 0, ...runs.flatMap(run => run.outputs.map(output => output.take ?? 0)));
  const changed = [];
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    if (run.outputs.every(output => Number.isInteger(output.take))) continue;
    changed.push({ run, takes: run.outputs.map(output => output.take ?? ++counter) });
  }
  return { changed, last: counter };
}
