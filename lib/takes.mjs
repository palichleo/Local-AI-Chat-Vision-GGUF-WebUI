import { readFile } from 'node:fs/promises';
import { projectId } from './projects.mjs';
import { problem } from './engine.mjs';
import { atomicFile } from './update-files.mjs';

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
    const counters = {};
    let known = false;
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (data?.version === 1 && data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)) {
        for (const [id, last] of Object.entries(data.projects))
          if (Number.isInteger(last) && last >= 0) counters[id] = last;
        known = true;
      }
    } catch (error) {
      // Missing or not JSON: the counters are made again from the manifests (server.mjs). Any other
      // failure (the file held by another program at that instant) keeps nothing: read again at the
      // next call. Counted from nothing, each project began again at « PRISE 1 » and the first take
      // made wrote that over the real counters.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    this.counters = counters;
    this.known = known;
  }

  async #save() {
    await atomicFile(this.path, JSON.stringify({ version: 1, projects: this.counters }, null, 2));
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

/**
 * The sources of a call named by their number, `{ take: 12 }`, made the take they stand for:
 * `{ output, index?, conversation? }`, what else the source says kept (`frame`: the first or last
 * image of a video take). `listTakes()` gives the takes of the project ({ take, id, index,
 * conversationId }), read only when a number is named; a number that is none is refused in the
 * user's words. Arguments without a number come back as they were.
 */
export async function takesToOutputs(text, listTakes, conversationId) {
  let args;
  try {
    args = JSON.parse(text);
  } catch {
    return text;
  }
  const named = value => !!value && typeof value === 'object' && !Array.isArray(value) && value.take !== undefined;
  if (
    !args ||
    typeof args !== 'object' ||
    !Object.values(args).some(value => named(value) || (Array.isArray(value) && value.some(named)))
  )
    return text;
  const takes = await listTakes();
  const resolve = ({ take, ...rest }) => {
    const found = takes.find(item => item.take === take);
    if (!found) throw problem(`La prise ${take} n’existe pas dans ce projet.`, 400);
    return {
      ...rest,
      output: found.id,
      ...(found.index ? { index: found.index } : {}),
      ...(found.conversationId !== conversationId ? { conversation: found.conversationId } : {}),
    };
  };
  for (const [key, value] of Object.entries(args))
    if (named(value)) args[key] = resolve(value);
    else if (Array.isArray(value)) args[key] = value.map(item => (named(item) ? resolve(item) : item));
  return JSON.stringify(args);
}
