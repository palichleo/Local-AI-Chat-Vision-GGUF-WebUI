import { open, mkdir, stat, copyFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Certaines conversions Qwen3.5 déclarent un bloc MTP sans exporter ses tenseurs.
// L'override ne s'applique qu'après vérification des couches principales et ne réécrit pas le fichier.
async function inspect(path) {
  const handle = await open(path, 'r');
  let buffer;
  try {
    const size = Math.min((await handle.stat()).size, 32 * 1024 * 1024);
    buffer = Buffer.alloc(size);
    let total = 0;
    while (total < size) {
      const { bytesRead } = await handle.read(buffer, total, size - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    buffer = buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
  let cursor = 4;
  const advance = length => {
    if (!Number.isSafeInteger(length) || length < 0 || cursor + length > buffer.length) throw new RangeError();
    const start = cursor;
    cursor += length;
    return start;
  };
  const u32 = () => buffer.readUInt32LE(advance(4));
  const u64 = () => {
    const value = Number(buffer.readBigUInt64LE(advance(8)));
    if (!Number.isSafeInteger(value)) throw new RangeError();
    return value;
  };
  const str = (keep = true) => {
    const length = u64(),
      start = advance(length);
    return keep ? buffer.toString('utf8', start, start + length) : null;
  };
  const widths = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  function value(type, keep, depth = 0) {
    if (depth > 3) throw new RangeError();
    if (type === 8) return str(keep);
    if (type === 9) {
      const element = u32(),
        countOffset = cursor,
        count = u64(),
        dataOffset = cursor;
      if (count > buffer.length) throw new RangeError();
      if (widths[element]) advance(widths[element] * count);
      else for (let i = 0; i < count; i++) value(element, false, depth + 1);
      return { element, count, countOffset, dataOffset, width: widths[element] };
    }
    const start = advance(widths[type]);
    if (keep && type === 4) return buffer.readUInt32LE(start);
    if (keep && type === 5) return buffer.readInt32LE(start);
    return null;
  }
  try {
    if (buffer.subarray(0, 4).toString() !== 'GGUF' || u32() !== 3) return '';
    const tensors = u64(),
      pairs = u64();
    if (tensors > 100000 || pairs > 10000) return '';
    const metadata = {},
      records = new Map();
    const wanted = new Set([
      'general.architecture',
      'general.name',
      'qwen35.block_count',
      'qwen35.nextn_predict_layers',
    ]);
    for (let i = 0; i < pairs; i++) {
      const key = str(),
        type = u32();
      const valueOffset = cursor;
      const data = value(type, wanted.has(key));
      if (wanted.has(key)) metadata[key] = data;
      records.set(key, { type, valueOffset, data });
      if (key === 'general.architecture' && data !== 'qwen35') return '';
    }
    const blocks = metadata['qwen35.block_count'];
    if (
      metadata['general.architecture'] !== 'qwen35' ||
      metadata['qwen35.nextn_predict_layers'] !== 1 ||
      !Number.isInteger(blocks) ||
      blocks < 2 ||
      blocks > 256
    )
      return '';
    const names = new Set();
    for (let i = 0; i < tensors; i++) {
      const name = str(),
        dimensions = u32();
      if (dimensions > 8) return '';
      advance(dimensions * 8 + 12);
      if (name.startsWith(`blk.${blocks - 1}.`) || /(?:^|\.)mtp(?:\.|$)/.test(name)) return '';
      names.add(name);
    }
    for (let i = 0; i < blocks - 1; i++) if (!names.has(`blk.${i}.attn_norm.weight`)) return '';
    const override = `qwen35.block_count=int:${blocks - 1},qwen35.nextn_predict_layers=int:0`;
    const arrays = [...records].filter(
      ([key, record]) => key.startsWith('qwen35.') && record.type === 9 && record.data.count === blocks,
    );
    if (!arrays.length) return { override };
    const name = records.get('general.name');
    if (
      !name ||
      name.type !== 8 ||
      records.get('qwen35.block_count').type !== 4 ||
      records.get('qwen35.nextn_predict_layers').type !== 4 ||
      arrays.some(([, record]) => !record.data.width)
    ) {
      throw new Error(
        'Le GGUF déclare une couche MTP absente. Sa structure nécessite une nouvelle conversion par son auteur.',
      );
    }
    const header = Buffer.from(buffer.subarray(0, cursor));
    header.writeUInt32LE(blocks - 1, records.get('qwen35.block_count').valueOffset);
    header.writeUInt32LE(0, records.get('qwen35.nextn_predict_layers').valueOffset);
    const edits = [];
    let removed = 0;
    for (const [, record] of arrays) {
      const { width, dataOffset, countOffset } = record.data;
      header.writeBigUInt64LE(BigInt(blocks - 1), countOffset);
      const start = dataOffset + (blocks - 1) * width;
      edits.push({ start, end: start + width, data: Buffer.alloc(0) });
      removed += width;
    }
    // Compense les octets retirés dans le nom : la table des tenseurs et le début des poids gardent leur position globale.
    const nameLength = Number(header.readBigUInt64LE(name.valueOffset));
    header.writeBigUInt64LE(BigInt(nameLength + removed), name.valueOffset);
    const nameEnd = name.valueOffset + 8 + nameLength;
    edits.push({ start: nameEnd, end: nameEnd, data: Buffer.alloc(removed, 32) });
    const parts = [];
    let start = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      parts.push(header.subarray(start, edit.start), edit.data);
      start = edit.end;
    }
    parts.push(header.subarray(start));
    const corrected = Buffer.concat(parts);
    if (corrected.length !== header.length) throw new Error('Longueur de métadonnées incompatible.');
    return { header: corrected, override: '' };
  } catch (error) {
    if (error instanceof RangeError) return '';
    throw error;
  }
}

export async function missingMtpOverride(path) {
  return (await inspect(path))?.override || '';
}

export async function prepareModel(path, cacheDir, log) {
  const correction = await inspect(path);
  if (!correction) return { path, override: '' };
  if (!correction.header) return { path, override: correction.override };
  const source = await stat(path);
  const key = createHash('sha256').update(`${path}\0${source.size}\0${source.mtimeMs}`).digest('hex').slice(0, 20);
  await mkdir(cacheDir, { recursive: true });
  const target = join(cacheDir, `qwen35-compatible-${key}.gguf`);
  try {
    if ((await stat(target)).size === source.size) {
      const cached = await open(target, 'r');
      try {
        const prefix = Buffer.alloc(correction.header.length);
        await cached.read(prefix, 0, prefix.length, 0);
        if (prefix.equals(correction.header)) {
          log('Copie de compatibilité Qwen3.5 déjà prête. Le fichier original reste inchangé.');
          return { path: target, override: '' };
        }
      } finally {
        await cached.close();
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  log(
    `Préparation d’une copie de compatibilité Qwen3.5 (${(source.size / 1e9).toFixed(2)} Go). Le fichier original reste inchangé.`,
  );
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await copyFile(path, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    const copy = await open(temporary, 'r+');
    try {
      let written = 0;
      while (written < correction.header.length) {
        const { bytesWritten } = await copy.write(
          correction.header,
          written,
          correction.header.length - written,
          written,
        );
        if (!bytesWritten) throw new Error('Écriture de la copie de compatibilité interrompue.');
        written += bytesWritten;
      }
    } finally {
      await copy.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(
      `Impossible de préparer la copie de compatibilité. Vérifie l’espace disque et les permissions. ${error.code || error.message}`,
    );
  }
  log('Copie de compatibilité prête : métadonnées MTP corrigées, poids conservés.');
  return { path: target, override: '' };
}
