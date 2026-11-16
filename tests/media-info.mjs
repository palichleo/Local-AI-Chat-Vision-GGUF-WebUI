import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, readFileInfo, stamp, stampRecord } from '../lib/media-info.mjs';
import { bytesInfo, crc32, fileInfo, kindOf, layout } from '../public/media-info.mjs';

// What Moodix knows of a creation is written in its own file, and read back from it alone.
const be = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
};
const chunk = (type, data = Buffer.alloc(0)) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([be(data.length), body, be(crc32(body))]);
};
/** A real PNG of 2 × 1 pixels, with what the engine writes in it today (the paths of its files). */
function png({ engine = true } = {}) {
  const header = Buffer.concat([be(2), be(1), Buffer.from([8, 2, 0, 0, 0])]),
    pixels = deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(engine ? [chunk('tEXt', Buffer.from('atelier\0{"job":{"components":{"model":"D:\\\\models\\\\krea2.safetensors"}}}', 'latin1'))] : []),
    chunk('tEXt', Buffer.from('Software\0Autre programme', 'latin1')),
    chunk('IDAT', pixels),
    chunk('IEND'),
  ]);
}
const box = (type, data) => Buffer.concat([be(8 + data.length), Buffer.from(type, 'ascii'), data]);
/** The boxes of an MP4 as ffmpeg writes them with « faststart ». */
const mp4 = () =>
  Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2avc1mp41', 'latin1')), box('moov', Buffer.alloc(40, 7)), box('free', Buffer.alloc(8)), box('mdat', Buffer.alloc(300, 9))]);
/** A WAV of 24 bits, mono, with an odd number of bytes of sound. */
function wav() {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(48000, 4);
  format.writeUInt32LE(144000, 8);
  format.writeUInt16LE(3, 12);
  format.writeUInt16LE(24, 14);
  const sound = Buffer.alloc(9, 3),
    riff = len => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32LE(len);
      return bytes;
    },
    body = Buffer.concat([Buffer.from('WAVEfmt '), riff(16), format, Buffer.from('data'), riff(sound.length), sound, Buffer.alloc(1)]);
  return Buffer.concat([Buffer.from('RIFF'), riff(body.length), body]);
}
const record = {
  id: 'c0f7ab71-8d76-489e-a099-56db66c84653',
  conversationId: '129dd11b-90e5-48d3-9407-990310f8b175',
  mediaType: 'video',
  workflowId: 'e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f',
  workflowName: 'MiniMax H3 Omni',
  prompt: 'Un éléphant d’Afrique lève sa trompe — plan fixe, « heure dorée ».',
  createdAt: '2026-11-16T15:02:11.000Z',
  parameters: {
    seed: 1050750569041,
    seed_given: true,
    width: 768,
    height: 448,
    frames: 124,
    fps: 24,
    stage: 'draft',
    loras: [{ id: 'grain', strength: 0.8 }],
    styles: [{ name: 'sub\\light.safetensors', strength: 1 }],
    references: [{ input: 'subject-1', role: 'reference_image', output_id: '8d0511eb', label: 'Krea 2', path: 'F:\\output\\x.png', url: '/gallery/x' }],
    // This computer's own, or of no use to read the creation back: never written in the file.
    native_components: { model: 'D:\\models\\minimax.safetensors' },
    workflow_digest: 'a'.repeat(64),
    generation_duration_ms: 116300,
    runner_duration_ms: 116000,
    reference_count: 1,
    reference_capacity: 3,
    reference_mode: 'pixels',
    reference_default_count: 0,
    reference_defaults: [],
    replay_args: { workflow_id: 'e06b6ac9', prompt: 'x' },
    routing_notes: ['note'],
  },
  outputs: [{ source: { filename: 'clip.mp4', subfolder: '', type: 'output' }, take: 7 }],
};

test('the sheet of a creation: what made it, never what is this computer’s own', () => {
  const info = describe(record, 0, { version: '0.6.29' });
  assert.deepEqual(
    { ...info, parameters: undefined },
    {
      moodix: 1,
      app: '0.6.29',
      id: record.id,
      output: 0,
      conversationId: record.conversationId,
      mediaType: 'video',
      workflowId: record.workflowId,
      workflowName: 'MiniMax H3 Omni',
      prompt: record.prompt,
      parameters: undefined,
      createdAt: record.createdAt,
      take: 7,
    },
  );
  assert.deepEqual(info.parameters, {
    seed: 1050750569041,
    seed_given: true,
    width: 768,
    height: 448,
    frames: 124,
    fps: 24,
    stage: 'draft',
    loras: [{ id: 'grain', strength: 0.8 }],
    styles: [{ name: 'sub\\light.safetensors', strength: 1 }],
    // Of an input, what names it: not where its file is.
    references: [{ input: 'subject-1', role: 'reference_image', label: 'Krea 2', output_id: '8d0511eb' }],
  });
  assert.doesNotMatch(JSON.stringify(info), /D:\\\\models|F:\\\\output|workflow_digest|duration_ms/);
  // An image without a number yet, of a record without a kind.
  const image = describe({ id: 'i', outputs: [{}], parameters: {} });
  assert.deepEqual([image.mediaType, image.take, image.app], ['image', undefined, undefined]);
});

test('an image, a clip and a sound each carry their sheet, read back whatever their name becomes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-info-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const info = describe(record, 0, { version: '0.6.29' });
  for (const [name, bytes, kind] of [
    ['image.png', png(), 'png'],
    ['clip.mp4', mp4(), 'mp4'],
    ['son.wav', wav(), 'wav'],
  ]) {
    const path = join(folder, name);
    await writeFile(path, bytes);
    assert.equal(kindOf(bytes), kind);
    assert.equal(await readFileInfo(path), null, name + ': nothing before');
    assert.equal(await stamp(path, info), true, name);
    // Renamed, moved: its sheet is in it.
    const renamed = join(folder, 'renommé ' + name);
    await rename(path, renamed);
    assert.deepEqual(await readFileInfo(renamed), info, name);
    const written = await readFile(renamed);
    // The page reads it the same way, from a file dropped on it, a few bytes at a time.
    assert.deepEqual(await fileInfo(new Blob([written])), info, name + ' in the page');
    assert.deepEqual(await bytesInfo(new Uint8Array(written)), info);
    // Written again (another number, say): one sheet, the last.
    assert.equal(await stamp(renamed, { ...info, take: 8 }), true);
    const again = await readFile(renamed),
      found = await layout({ size: again.length, read: async (at, length) => again.subarray(at, at + length) });
    assert.equal(found.parts.filter(part => part.mine).length, 1, name + ': one sheet');
    assert.equal(found.info.take, 8);
    assert.equal(again.length, written.length, name + ': no longer than with the first');
  }
});

test('the file is still the same image, clip or sound: only the sheet is added, the engine’s notes leave the PNG', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-info-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const info = { moodix: 1, id: 'x', prompt: 'été' };
  // PNG: its chunks as they were, each with a right CRC; the sheet before the pixels; the pixels untouched.
  const image = join(folder, 'a.png'),
    before = png();
  await writeFile(image, before);
  await stamp(image, info);
  const after = await readFile(image),
    chunks = [];
  for (let at = 8; at < after.length; ) {
    const length = after.readUInt32BE(at),
      body = after.subarray(at + 4, at + 8 + length);
    assert.equal(after.readUInt32BE(at + 8 + length), crc32(body), 'CRC of ' + body.subarray(0, 4));
    chunks.push([body.subarray(0, 4).toString('ascii'), body.subarray(4)]);
    at += 12 + length;
  }
  assert.deepEqual(chunks.map(([type]) => type), ['IHDR', 'tEXt', 'iTXt', 'IDAT', 'IEND']);
  assert.match(chunks[1][1].toString('latin1'), /^Software\0/, 'the note of another program stays');
  assert.doesNotMatch(after.toString('latin1'), /atelier\0|D:\\\\models/, 'not the paths of this computer');
  assert.deepEqual([...inflateSync(chunks[3][1])], [0, 255, 0, 0, 0, 0, 255]);
  assert.match(chunks[2][1].toString('utf8'), /^moodix\0\0\0\0\0\{"moodix":1,"id":"x","prompt":"été"\}$/);
  // MP4: everything it had, byte for byte, then one box of Moodix's own.
  const clip = join(folder, 'a.mp4'),
    film = mp4();
  await writeFile(clip, film);
  await stamp(clip, info);
  const stamped = await readFile(clip);
  assert.deepEqual(stamped.subarray(0, film.length), film);
  assert.equal(stamped.readUInt32BE(film.length), stamped.length - film.length, 'its length said');
  assert.equal(stamped.subarray(film.length + 4, film.length + 24).toString('ascii'), 'uuidmoodix.creation!');
  // WAV: the sound as it was; RIFF says the new length; the chunk is padded to an even length.
  const sound = join(folder, 'a.wav'),
    wave = wav();
  await writeFile(sound, wave);
  await stamp(sound, info);
  const tagged = await readFile(sound);
  assert.deepEqual(tagged.subarray(8, wave.length), wave.subarray(8));
  assert.equal(tagged.readUInt32LE(4), tagged.length - 8);
  assert.equal(tagged.subarray(wave.length, wave.length + 4).toString('ascii'), 'MDIX');
  assert.equal(tagged.length % 2, 0);
});

test('a file that is none of the three, or broken, is left as it is; a file of someone else has no sheet', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-info-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cases = {
    'photo.jpg': Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]),
    'coupé.png': png().subarray(0, 40),
    'coupé.mp4': mp4().subarray(0, 60),
    // A box that runs to the end of the file: nothing can be put after it.
    'ouvert.mp4': Buffer.concat([box('ftyp', Buffer.from('isom', 'latin1')), be(0), Buffer.from('mdat'), Buffer.alloc(20)]),
    'vide.bin': Buffer.alloc(0),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const path = join(folder, name);
    await writeFile(path, bytes);
    assert.equal(await stamp(path, { moodix: 1 }), false, name);
    assert.deepEqual(await readFile(path), bytes, name + ' untouched');
    assert.equal(await readFileInfo(path), null);
  }
  // A PNG of another program, with a text of its own under another name, or a « moodix » that is not ours.
  for (const text of ['parameters\0a fox, steps 20', 'moodix\0not json'])
    assert.equal(await bytesInfo(new Uint8Array(Buffer.concat([png({ engine: false }).subarray(0, 33), chunk('tEXt', Buffer.from(text, 'latin1')), png({ engine: false }).subarray(33)]))), null);
  assert.equal(await stamp(join(folder, 'absent.png'), { moodix: 1 }).catch(error => error.code), 'ENOENT');
  // A sheet too long to be one is not written.
  const big = join(folder, 'grand.png');
  await writeFile(big, png());
  assert.equal(await stamp(big, { moodix: 1, prompt: 'x'.repeat(300000) }), false);
});

test('every file of a record gets its sheet when the creation is recorded; one that cannot be changes nothing', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'moodix-info-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'un.png'), png());
  await writeFile(join(folder, 'deux.png'), png());
  const made = {
    ...record,
    mediaType: undefined,
    outputs: ['un.png', 'deux.png', 'absent.png'].map((filename, index) => ({ source: { filename, subfolder: '', type: 'output' }, take: 10 + index })),
  };
  const errors = [],
    said = console.error;
  console.error = (...words) => errors.push(words.join(' '));
  try {
    assert.deepEqual(await stampRecord(folder, made, { version: '0.6.29' }), ['un.png', 'deux.png']);
  } finally {
    console.error = said;
  }
  assert.equal(errors.length, 1, 'said in the terminal, the creation is made all the same');
  const [first, second] = await Promise.all(['un.png', 'deux.png'].map(name => readFileInfo(join(folder, name))));
  assert.deepEqual([first.output, first.take, second.output, second.take], [0, 10, 1, 11]);
  assert.equal(first.id, record.id);
});
