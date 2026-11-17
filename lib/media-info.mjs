/**
 * The sheet of a creation written into its own file (public/media-info.mjs says where and how it
 * is read back). Done once the creation is recorded, so that the sheet says all the application
 * knows of it: its model, its prompt, its settings, its seed, its inputs, its take.
 *
 * Never what belongs to this computer: the paths of the models, the time it took, the internal
 * counts. A file may be given to someone else; its sheet goes with it.
 */
import { copyFile, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { generatedFile } from './generated-media.mjs';
import { MAX_INFO, layout, mp4Box, pngChunk, wavChunk } from '../public/media-info.mjs';

// What a record holds that is this computer's own, or of no use to read a creation back.
const PRIVATE = new Set([
  'native_components',
  'workflow_digest',
  'generation_duration_ms',
  'runner_duration_ms',
  'reference_count',
  'reference_capacity',
  'reference_mode',
  'reference_default_count',
  'reference_defaults',
  'routing_notes',
  'replay_args',
]);
// Of an input, what names it (never where its file is).
const INPUT = ['input', 'role', 'label', 'output_id', 'output_index', 'output_conversation', 'resource_id'];

/**
 * The sheet of one output of a record: `{ moodix: 1, id, output, mediaType, workflowId, workflowName,
 * prompt, parameters, createdAt, take, conversationId, app }`.
 */
export function describe(record, index = 0, { version = '' } = {}) {
  const parameters = {};
  for (const [key, value] of Object.entries(record.parameters ?? {})) {
    if (PRIVATE.has(key)) continue;
    parameters[key] =
      key === 'references' && Array.isArray(value)
        ? value.map(ref => Object.fromEntries(INPUT.filter(name => ref?.[name] !== undefined).map(name => [name, ref[name]])))
        : value;
  }
  const output = record.outputs?.[index] ?? {};
  return {
    moodix: 1,
    ...(version ? { app: version } : {}),
    id: record.id,
    output: index,
    conversationId: record.conversationId,
    mediaType: record.mediaType || 'image',
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    prompt: String(record.prompt ?? ''),
    parameters,
    createdAt: record.createdAt,
    ...(Number.isInteger(output.take) ? { take: output.take } : {}),
  };
}

const sourceOf = async path => {
  const handle = await open(path, 'r'),
    { size } = await handle.stat();
  return {
    size,
    read: async (offset, length) => {
      const bytes = new Uint8Array(length),
        { bytesRead } = await handle.read(bytes, 0, length, offset);
      return bytes.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
};
/** Puts the new file in the place of the old one; on Windows a file being read resists a moment. */
async function replace(temporary, path) {
  for (let tries = 0; ; tries++)
    try {
      return await rename(temporary, path);
    } catch (error) {
      if (tries >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await delay(120 * (tries + 1));
    }
}

/** The sheet a file carries, or null. */
export async function readFileInfo(path) {
  let source;
  try {
    source = await sourceOf(path);
    return (await layout(source))?.info ?? null;
  } catch {
    return null;
  } finally {
    await source?.close().catch(() => {});
  }
}

/**
 * Writes `info` into the file at `path` (a PNG, an MP4 or a WAV), in the place of the sheet it had.
 * The file is replaced in one move: never half written. False when it is none of the three, or not
 * formed as expected (it is then left as it is).
 */
export async function stamp(path, info) {
  if (JSON.stringify(info).length > MAX_INFO) return false;
  let source, found;
  try {
    source = await sourceOf(path);
    found = await layout(source);
  } finally {
    await source?.close().catch(() => {});
  }
  if (!found?.parts.length) return false;
  const { kind, parts } = found,
    temporary = path + '.moodix.tmp';
  try {
    if (kind === 'png') {
      // Rewritten whole: its chunks as they were, but the sheet before the pixels, and nothing of the
      // engine's own notes (they name the files of this computer).
      const bytes = await readFile(path),
        first = parts.findIndex(part => part.type === 'IDAT');
      if (first < 0 || parts.at(-1).type !== 'IEND') return false;
      const out = [bytes.subarray(0, 8)];
      parts.forEach((part, index) => {
        if (index === first) out.push(pngChunk(info));
        if (!part.mine && !part.engine) out.push(bytes.subarray(part.at, part.at + part.size));
      });
      await writeFile(temporary, Buffer.concat(out), { flag: 'w' });
    } else {
      // After everything else: a copy, cut where the former sheet began if it was the last piece.
      const last = parts.at(-1);
      if (kind === 'mp4' && parts.some(part => part.open)) return false;
      if (parts.some(part => part.mine && part !== last)) return false;
      const end = last.mine ? last.at : last.at + last.size,
        // A sound whose last chunk has an odd length and no pad byte (Python's « wave » writes none:
        // a mono sound of 24 bits with an odd number of samples): the byte RIFF asks for comes first.
        // Written at that odd place, the sheet was never read back.
        pad = kind === 'wav' && end % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
        added = Buffer.concat([pad, kind === 'mp4' ? mp4Box(info) : wavChunk(info)]);
      await copyFile(path, temporary);
      await truncate(temporary, end);
      const handle = await open(temporary, 'r+');
      try {
        await handle.write(added, 0, added.length, end);
        if (kind === 'wav') {
          // The length RIFF announces: all but its own first eight bytes.
          const total = Buffer.alloc(4);
          total.writeUInt32LE(end + added.length - 8);
          await handle.write(total, 0, 4, 4);
        }
      } finally {
        await handle.close();
      }
    }
    await replace(temporary, path);
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Every file of a record gets its sheet. Resolves the names of those written; a file that could not
 * be (missing, of another kind, held by another program) is left as it is: the creation is made.
 */
export async function stampRecord(outputDir, record, options = {}) {
  const written = [];
  for (const [index, output] of (record.outputs ?? []).entries())
    try {
      const { path } = await generatedFile(outputDir, output.source);
      if ((await stat(path)).isFile() && (await stamp(path, describe(record, index, options)))) written.push(output.source.filename);
    } catch (error) {
      console.error('Fiche de la création non écrite dans son fichier :', error.message);
    }
  return written;
}
