import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Real progress of one generation, from its own milestones.
 *
 * A job passes named milestones: the chat model unloading, each runner stage
 * (loading the encoder, encoding, every sampling step, decoding…), then the
 * chat model reloading. The last successful run of the same workflow and size
 * recorded when each milestone was reached; a new run reads its fraction off
 * that timeline, advancing within the current milestone at the pace it took
 * last time and never past the next one. Without a previous run, the sampling
 * steps (exact) carry most of the bar and the other milestones step it forward.
 */

const SEGMENT_CAP = 0.95;

export function milestone(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || typeof value.stage !== 'string') return null;
  return value.step ? `${value.stage}#${value.step}` : value.stage;
}

export function timingKey(workflowId, parameters = {}, references = 0) {
  const size = [parameters.width, parameters.height, parameters.frames].filter(Number.isFinite).join('x');
  return [workflowId, parameters.stage || '', size, `refs${references}`].join('|');
}

export class ProgressClock {
  constructor(reference = null, now = Date.now) {
    this.now = now;
    this.start = now();
    this.marks = [];
    this.highest = 0;
    this.steps = null;
    // A usable reference ends on 'done' and has increasing times.
    const valid =
      Array.isArray(reference) &&
      reference.length > 1 &&
      reference.at(-1).mark === 'done' &&
      reference.every((entry, index) => index === 0 || entry.at >= reference[index - 1].at) &&
      reference.at(-1).at > 0;
    this.reference = valid ? reference : null;
  }

  mark(name, data = {}) {
    if (!name || this.marks.at(-1)?.mark === name) return;
    if (Number.isInteger(data.total) && data.total > 0) this.steps = { step: data.step || 0, total: data.total };
    this.marks.push({ mark: name, at: (this.now() - this.start) / 1000 });
  }

  /** Seconds-since-start of every milestone, closed by 'done', for the next run to follow. */
  timeline() {
    return [...this.marks, { mark: 'done', at: (this.now() - this.start) / 1000 }];
  }

  fraction(state) {
    if (state === 'done') return 1;
    const value = this.reference ? this.#followReference() : this.#estimate(state);
    // Never move backwards, never claim completion before it happens.
    this.highest = Math.min(0.99, Math.max(this.highest, value ?? this.#estimate(state)));
    return this.highest;
  }

  #followReference() {
    const current = this.marks.at(-1);
    if (!current) return 0;
    // Match milestones in order, so repeated names (one per step) line up.
    let cursor = -1;
    for (const { mark } of this.marks) {
      const index = this.reference.findIndex((entry, i) => i > cursor && entry.mark === mark);
      if (index < 0) return null;
      cursor = index;
    }
    const total = this.reference.at(-1).at;
    const begin = this.reference[cursor].at;
    const end = this.reference[cursor + 1]?.at ?? total;
    const elapsed = (this.now() - this.start) / 1000 - current.at;
    return (begin + Math.min(Math.max(elapsed, 0), (end - begin) * SEGMENT_CAP)) / total;
  }

  #estimate(state) {
    if (['checking', 'unloading'].includes(state) || !this.marks.length) return 0.03;
    if (state === 'releasing') return 0.95;
    if (state === 'restarting') return 0.97;
    const runner = this.marks.filter(({ mark }) => !['unloading', 'generating'].includes(mark));
    const firstStep = runner.findIndex(({ mark }) => /#\d+$/.test(mark));
    if (firstStep < 0) return 0.05 + 0.2 * (1 - 0.5 ** runner.length);
    const lastStep = runner.findLastIndex(({ mark }) => /#\d+$/.test(mark));
    const { step = 0, total = 1 } = this.steps || {};
    if (step < total || lastStep === runner.length - 1) return 0.25 + 0.6 * Math.min(1, step / total);
    return 0.85 + 0.1 * (1 - 0.5 ** (runner.length - 1 - lastStep));
  }
}

/** The last successful timeline per workflow and size, kept in one small JSON file. */
export class ProgressHistory {
  constructor(file, limit = 200) {
    this.file = file;
    this.limit = limit;
    this.pending = Promise.resolve();
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      return value && typeof value.timelines === 'object' ? value.timelines : {};
    } catch {
      return {};
    }
  }

  async reference(key) {
    return (await this.#read())[key] || null;
  }

  save(key, timeline) {
    const operation = this.pending.then(async () => {
      const timelines = await this.#read();
      delete timelines[key];
      timelines[key] = timeline.map(({ mark, at }) => ({ mark, at: Math.round(at * 100) / 100 }));
      const keys = Object.keys(timelines);
      for (const old of keys.slice(0, Math.max(0, keys.length - this.limit))) delete timelines[old];
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, timelines }, null, 2), { mode: 0o600 });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
