import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONTAGE_LIMITS,
  Montages,
  assemblyOf,
  montageSeconds,
  montageSizes,
  newMontage,
  planStarts,
  validateMontage,
} from '../lib/montages.mjs';

// (0.6.136) The first step of the montage (the user's request of 19/11, « une timeline, une vraie
// cette fois »): takes of a project laid by hand, kept as a file of the project.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const take = n => ({ conversationId: C, runId: id(n), output: 0 });
const film = (changes = {}) => ({
  ...newMontage({ name: 'Le pêcheur à l’aube', id: id(900), now: '2026-11-20T03:00:00.000Z' }),
  plans: [
    { id: id(1), source: take(12), kind: 'video', from: 0, to: 5 },
    { id: id(2), source: take(14), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
    { id: id(3), source: take(9), kind: 'image', to: 2 },
  ],
  sounds: [{ id: id(4), source: take(16), track: 'music', at: 0, from: 0, to: 30, volume: 0.4 }],
  ...changes,
});

test('a new montage is empty, at the usual size of its format, 24 frames a second (0.6.136)', () => {
  const fresh = newMontage({ now: '2026-11-20T03:00:00.000Z' });
  assert.deepEqual(
    [fresh.name, fresh.format, fresh.width, fresh.height, fresh.fps, fresh.plans, fresh.sounds, fresh.createdAt],
    ['Sans titre', '16:9', 1344, 768, 24, [], [], '2026-11-20T03:00:00.000Z'],
  );
  assert.match(fresh.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    ['9:16', '1:1'].map(format => [newMontage({ format }).width, newMontage({ format }).height]),
    [
      [768, 1344],
      [1024, 1024],
    ],
  );
  // The sizes offered are those of the format the other pages know, without the smallest drafts.
  assert.deepEqual(montageSizes('16:9').map(size => size.width), [512, 768, 1024, 1344, 1600, 1920]);
  assert.deepEqual(montageSizes('7:5'), []);
  assert.throws(() => newMontage({ format: '7:5' }), /Format de bobine inconnu/);
});

test('a montage is kept as it is said, plans end to end: nothing else is carried over (0.6.136)', () => {
  const kept = validateMontage({ ...film(), extra: 'x', plans: film().plans.map(plan => ({ ...plan, note: 'x' })) });
  assert.equal(kept.extra, undefined);
  // (0.6.149) Without instants (a file of before), each is given its own, end to end.
  assert.deepEqual(kept.plans[0], { id: id(1), at: 0, source: take(12), kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 });
  assert.deepEqual(kept.plans[1], { id: id(2), at: 5, source: take(14), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 });
  // An image starts at 0 and has no sound of its own.
  assert.deepEqual(kept.plans[2], { id: id(3), at: 8, source: take(9), kind: 'image', from: 0, to: 2, frame: 'fit' });
  assert.equal(montageSeconds(kept), 10);
  assert.deepEqual(planStarts(kept), [0, 5, 8]);
  // (0.6.149) With them, each where it is said, a hole between two; one over the plan before it goes after it.
  const holed = validateMontage(film({ plans: film().plans.map((plan, at) => ({ ...plan, at: [0, 7, 8.2][at] })) }));
  assert.deepEqual([planStarts(holed), montageSeconds(holed)], [[0, 7, 10], 12]);
  // A plan to make keeps the mark of a suite; anything else than yes or no is refused.
  const todo = { id: id(6), at: 12, kind: 'video', todo: { prompt: 'Il se lève.', suite: true }, from: 0, to: 2, frame: 'fit', volume: 1 };
  assert.deepEqual(validateMontage(film({ plans: [...film().plans, todo] })).plans[3], todo);
  assert.equal('suite' in validateMontage(film({ plans: [...film().plans, { ...todo, todo: { prompt: '', suite: false } }] })).plans[3].todo, false);
  assert.throws(() => validateMontage(film({ plans: [{ ...todo, todo: { prompt: '', suite: 'oui' } }] })), /Prise 1 : suite invalide/);
  // What the page computes by dragging is rounded to the millisecond: no 0.30000000000000004.
  const dragged = validateMontage(film({ plans: [{ id: id(1), source: take(1), kind: 'video', from: 0.1 + 0.2, to: 1.3004 }] }));
  assert.deepEqual([dragged.plans[0].from, dragged.plans[0].to, montageSeconds(dragged)], [0.3, 1.3, 1]);
});

test('what cannot be a montage is refused in the user’s words (0.6.136)', () => {
  const plan = film().plans[0],
    sound = film().sounds[0];
  for (const [changes, said] of [
    [{ name: '  ' }, /nom de la bobine/],
    [{ name: 'x'.repeat(81) }, /nom de la bobine/],
    [{ format: '7:5' }, /Format de bobine inconnu/],
    [{ width: 1000 }, /n’est pas une taille du format 16:9/],
    [{ fps: 16 }, /Cadence/],
    [{ schemaVersion: 2 }, /Version de bobine inconnue/],
    [{ plans: [{ ...plan, to: 0.05 }] }, /Prise 1 : sa durée va de 0.1 à 600 secondes/],
    [{ plans: [{ ...plan, from: 3, to: 2 }] }, /Prise 1 : sa durée/],
    [{ plans: [{ ...plan, kind: 'audio' }] }, /Prise 1 : ni vidéo ni image/],
    [{ plans: [{ ...plan, kind: 'image', from: 1, to: 3 }] }, /une image commence à 0/],
    [{ plans: [{ ...plan, frame: 'stretch' }] }, /cadre invalide/],
    [{ plans: [{ ...plan, volume: 3 }] }, /volume invalide/],
    [{ plans: [{ ...plan, source: { conversationId: C, runId: '../x' } }] }, /Prise 1 : prise invalide/],
    [{ plans: [{ ...plan, at: -1 }] }, /Prise 1 : durée invalide/],
    [{ plans: [{ ...plan, at: '5' }] }, /Prise 1 : durée invalide/],
    [{ plans: [plan, { ...film().plans[1], id: plan.id }] }, /même identifiant/],
    [{ plans: Array.from({ length: MONTAGE_LIMITS.plans + 1 }, (_, n) => ({ ...plan, id: id(n + 1) })) }, /au plus 200 prises/],
    [{ sounds: [{ ...sound, track: 'voice' }] }, /Son 1 : piste inconnue/],
    [{ sounds: [{ ...sound, at: -1 }] }, /Son 1 : durée invalide/],
    [{ sounds: [{ ...sound, to: 0 }] }, /Son 1 : trop court/],
  ])
    assert.throws(() => validateMontage(film(changes)), said, JSON.stringify(changes).slice(0, 80));
  for (const wrong of [null, [], 'x']) assert.throws(() => validateMontage(wrong), /Bobine invalide/);
});

test('the montages of a project are files of it: kept, listed, read, and set aside rather than destroyed (0.6.136)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(await montages.list(project), []);
  const first = await montages.save(project, film());
  assert.deepEqual(JSON.parse(await readFile(join(dir, project, id(900) + '.json'), 'utf8')), first);
  // Saved again: the date it was made stays, the date it was changed moves, whatever the page sends.
  await new Promise(done => setTimeout(done, 15));
  const again = await montages.save(project, { ...film({ name: 'Autre nom' }), createdAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z' });
  assert.equal(again.createdAt, first.createdAt);
  assert.ok(again.updatedAt > first.updatedAt);
  await montages.save(project, newMontage({ id: id(901) }));
  const listed = await montages.list(project);
  assert.deepEqual(listed.map(item => item.id), [id(901), id(900)], 'the last changed first');
  assert.deepEqual(
    { ...listed[1], updatedAt: '' },
    { id: id(900), name: 'Autre nom', format: '16:9', plans: 3, sounds: 1, seconds: 10, updatedAt: '' },
  );
  assert.deepEqual(await montages.read(project, id(900)), again);
  // A file that is no montage (left by a copy, a hand) hides nothing of the others.
  await writeFile(join(dir, project, id(902) + '.json'), '{ not json');
  await writeFile(join(dir, project, 'notes.json'), '{}');
  assert.equal((await montages.list(project)).length, 2);
  // Another project sees none of them; « inbox » is a project as the others.
  assert.deepEqual(await montages.list('inbox'), []);
  await assert.rejects(montages.read('inbox', id(900)), { status: 404 });
  await assert.rejects(montages.list('../autre'), /Projet invalide/);
  await assert.rejects(montages.read(project, '../' + id(900)), /identifiant invalide/);
  // Removed: out of the list, its file set aside, never deleted.
  assert.deepEqual(await montages.remove(project, id(900)), { removed: id(900) });
  assert.deepEqual((await montages.list(project)).map(item => item.id), [id(901)]);
  await assert.rejects(montages.read(project, id(900)), { status: 404 });
  const aside = await readdir(join(dir, project, 'corbeille'));
  assert.equal(aside.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, project, 'corbeille', aside[0]), 'utf8')).name, 'Autre nom');
  await assert.rejects(montages.remove(project, id(900)), { status: 404 });
});

test('what the engine assembles is the montage with the file of each take (0.6.136)', async () => {
  const asked = [];
  const fileOf = async (source, label) => {
    asked.push(label);
    return `D:\\sorties\\${source.runId.slice(0, 8)}.mp4`;
  };
  const late = { id: id(5), source: take(17), track: 'effects', at: 12, from: 0, to: 3, volume: 1 };
  const made = await assemblyOf(validateMontage(film({ sounds: [...film().sounds, late] })), fileOf);
  assert.deepEqual(made, {
    width: 1344,
    height: 768,
    fps: 24,
    plans: [
      { path: 'D:\\sorties\\00000012.mp4', at: 0, kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
      { path: 'D:\\sorties\\00000014.mp4', at: 5, kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
      { path: 'D:\\sorties\\00000009.mp4', at: 8, kind: 'image', from: 0, to: 2, frame: 'fit', volume: 1 },
    ],
    // (A sound that starts after the end of the film, 10 s, is not part of it.)
    sounds: [{ path: 'D:\\sorties\\00000016.mp4', at: 0, from: 0, to: 30, volume: 0.4 }],
  });
  assert.deepEqual(asked, ['Prise 1', 'Prise 2', 'Prise 3', 'Son 1']);
  // (0.6.149) With holes, each plan says its instant to the engine (runner/video/montage.py makes the
  // holes black and silent); a sound in a hole is part of the film.
  const holed = validateMontage(film({ plans: film().plans.map((plan, at) => ({ ...plan, at: [1, 7, 12][at] })), sounds: [late] }));
  const withHoles = await assemblyOf(holed, fileOf);
  assert.deepEqual([withHoles.plans.map(plan => plan.at), withHoles.sounds.map(sound => sound.at)], [[1, 7, 12], [12]]);
  await assert.rejects(assemblyOf(newMontage(), fileOf), /aucune prise/);
  // A take that is gone stops the export with the plan that names it.
  const gone = async (source, label) => {
    throw new Error(`${label} : cette prise n’existe plus.`);
  };
  await assert.rejects(assemblyOf(validateMontage(film()), gone), /Prise 1 : cette prise n’existe plus/);
});

test('the film of a montage is assembled from the files of its takes and kept as a take of the conversation (0.6.136)', async () => {
  const { exportMontage, takeFiles } = await import('../lib/montage-export.mjs');
  const project = '22222222-2222-4222-8222-222222222222',
    runs = new Map([12, 14, 9, 16].map(n => [id(n), { id: id(n), outputs: [{ source: { filename: `prise-${n}.mp4`, subfolder: 'video', type: 'output' } }] }])),
    kept = [];
  const gallery = {
    get: async (conversationId, runId) => runs.get(runId) ?? Promise.reject(Object.assign(new Error('gone'), { status: 404 })),
    put: async (record, options) => (kept.push([record, options]), { ...record, outputs: record.outputs.map(output => ({ ...output, take: 18 })) }),
  };
  const fileOf = takeFiles({ project, gallery, pathOf: async source => `D:/sorties/${source.subfolder}/${source.filename}`, projectOf: async () => project });
  const asked = [];
  const assemble = async (request, options) => {
    asked.push(request);
    options.onProgress({ stage: 'assembling film' });
    return { jobId: request.id, outputs: [{ filename: request.outputName + '.mp4', subfolder: 'video', type: 'output', width: 1344, height: 768 }], metadata: {} };
  };
  const told = [],
    times = [new Date('2026-11-20T03:00:00.000Z'), new Date('2026-11-20T03:00:02.500Z')];
  const saved = await exportMontage({
    montage: validateMontage(film()),
    conversationId: C,
    fileOf,
    assemble,
    gallery,
    persist: true,
    onProgress: value => told.push(value.stage),
    id: id(500),
    name: '2026-11-20_03-00-00_bobine_ab12',
    now: () => times.shift(),
  });
  // The engine is asked for the film of the montage, each plan by its file.
  assert.deepEqual(asked[0].plans.map(plan => plan.path), ['D:/sorties/video/prise-12.mp4', 'D:/sorties/video/prise-14.mp4', 'D:/sorties/video/prise-9.mp4']);
  assert.deepEqual([asked[0].id, asked[0].outputName, asked[0].width, asked[0].fps, asked[0].sounds.length], [id(500), '2026-11-20_03-00-00_bobine_ab12', 1344, 24, 1]);
  assert.deepEqual(told, ['assembling film']);
  // The film is a video of the conversation, named by its montage, with what tells its length.
  const [[record, options]] = kept;
  assert.deepEqual(options, { persist: true });
  assert.deepEqual(
    { ...record, parameters: undefined },
    {
      mediaType: 'video',
      provider: 'native',
      id: id(500),
      conversationId: C,
      workflowId: 'montage',
      workflowName: 'Bobine',
      prompt: 'Le pêcheur à l’aube',
      parameters: undefined,
      createdAt: '2026-11-20T03:00:02.500Z',
      outputs: [{ source: { filename: '2026-11-20_03-00-00_bobine_ab12.mp4', subfolder: 'video', type: 'output', width: 1344, height: 768 }, width: 1344, height: 768 }],
    },
  );
  assert.deepEqual(record.parameters, { montage: id(900), plans: 3, sounds: 1, seconds: 10, width: 1344, height: 768, fps: 24, frames: 240, generation_duration_ms: 2500 });
  assert.equal(saved.outputs[0].take, 18);
  // A take that is gone, or of another project, stops the export by the plan that names it; nothing is kept.
  const lacking = validateMontage(film({ plans: [{ id: id(1), source: take(77), kind: 'video', from: 0, to: 2 }], sounds: [] }));
  await assert.rejects(exportMontage({ montage: lacking, conversationId: C, fileOf, assemble, gallery }), /Prise 1 : cette prise n’existe plus/);
  const elsewhere = takeFiles({ project, gallery, pathOf: async () => 'x', projectOf: async () => 'inbox' });
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf: elsewhere, assemble, gallery }), /Prise 1 : cette prise est d’un autre projet/);
  const unreadable = takeFiles({ project, gallery, pathOf: async () => Promise.reject(new Error('no file')), projectOf: async () => project });
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf: unreadable, assemble, gallery }), /Prise 1 : cette prise n’existe plus/);
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf, assemble: async () => ({ outputs: [] }), gallery }), /n’a pas rendu de film/);
  assert.equal(kept.length, 1);
});

// ---- 0.6.154, lot 5 de la Bobine -----------------------------------------------------------------------

test('« Enregistrer » puts the bobine in the Archives as it is then; what changes after it leaves that version as it was (0.6.154)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222';
  // Kept on its own: not in the Archives.
  await montages.save(project, film());
  assert.equal('archived' in (await montages.read(project, id(900))), false);
  assert.equal('archived' in (await montages.list(project))[0], false);
  // « Enregistrer »: the bobine as it is now, and when.
  const put = await montages.save(project, film(), { archive: true });
  const { name, format, width, height, fps, plans, sounds } = put;
  assert.deepEqual(put.archived, { at: put.updatedAt, name, format, width, height, fps, plans, sounds });
  // Changed after it, kept on its own: what is in the Archives stays as it was, whatever the page sends of it.
  const changed = await montages.save(project, { ...film({ name: 'Autre nom', plans: [] }), archived: { at: '2001-01-01T00:00:00.000Z', name: 'Faux', plans: [] } });
  assert.deepEqual([changed.name, changed.plans.length, changed.archived], ['Autre nom', 0, put.archived]);
  assert.deepEqual((await montages.read(project, id(900))).archived, put.archived);
  // Nor for a bobine never put there: what the page sends of a version is never taken.
  const { name: _, ...content } = put.archived;
  await montages.save(project, { ...newMontage({ id: id(901) }), archived: { ...content, name: 'Faux', at: '2001-01-01T00:00:00.000Z' } });
  assert.equal('archived' in (await montages.read(project, id(901))), false);
  // Listed with what the Archives show of it: when, how long, how many takes, the first two made.
  const listed = (await montages.list(project)).find(item => item.id === id(900));
  assert.deepEqual(listed.archived, { at: put.archived.at, seconds: 10, plans: 3, pictures: [take(12), take(14)] });
  assert.equal(listed.name, 'Autre nom');
  // A version that cannot be read any more is left out; the bobine itself stays.
  const kept = JSON.parse(await readFile(join(dir, project, id(900) + '.json'), 'utf8'));
  await writeFile(join(dir, project, id(900) + '.json'), JSON.stringify({ ...kept, archived: { ...kept.archived, fps: 7 } }));
  const read = await montages.read(project, id(900));
  assert.deepEqual([read.name, 'archived' in read], ['Autre nom', false]);
});

test('« Un seul fichier »: the film is named after its bobine (0.6.154)', async () => {
  const { exportMontage } = await import('../lib/montage-export.mjs');
  const asked = [];
  await exportMontage({
    montage: validateMontage(film()),
    conversationId: C,
    fileOf: async source => `D:/sorties/video/${source.runId}.mp4`,
    assemble: async request => (asked.push(request), { outputs: [{ filename: request.outputName + '.mp4', subfolder: 'video', type: 'output' }] }),
    gallery: { put: async record => record },
  });
  assert.match(asked[0].outputName, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_le-pecheur-a-l-aube_[0-9a-f]{4}$/);
});

test('« Un fichier par prise »: the takes made, each alone, numbered in a folder of their own under BOBINES; none written over (0.6.154)', async t => {
  const { exportTakes } = await import('../lib/montage-export.mjs');
  const { folderName } = await import('../public/montage-model.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'moodix-bobines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asked = [],
    labels = [];
  const assemble = async (request, options) => {
    asked.push({ request, options });
    return { outputs: [{ filename: request.exportTo.split('/').pop(), subfolder: request.exportTo.split('/').slice(0, 2).join('/'), type: 'export' }] };
  };
  const fileOf = async (source, label) => (labels.push(label), `D:/sorties/video/${source.runId}.mp4`);
  // A take to create between two made, a hole before the last: they are left out, and each is alone in its file.
  const montage = validateMontage(
    film({
      plans: [
        { id: id(1), source: take(12), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
        { id: id(2), kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 2 },
        { id: id(3), at: 8, source: take(9), kind: 'image', to: 2 },
      ],
    }),
  );
  let count = 0;
  const done = await exportTakes({ montage, fileOf, assemble, outputDir: dir, id: () => id(600 + count), name: () => `2026-11-20_03-00-0${count++}_bobine_ab12` });
  assert.deepEqual(done, { folder: 'bobines/Le pêcheur à l’aube', files: ['01.mp4', '02.mp4'] });
  assert.deepEqual(labels, ['Prise 1', 'Prise 3']);
  assert.deepEqual(asked.map(({ request }) => [request.id, request.outputName, request.exportTo, request.width, request.fps, request.sounds, request.plans.map(plan => [plan.at, plan.kind, plan.from, plan.to, plan.frame, plan.volume])]), [
    [id(600), '2026-11-20_03-00-00_bobine_ab12', 'bobines/Le pêcheur à l’aube/01.mp4', 1344, 24, [], [[0, 'video', 1, 4, 'fill', 0.5]]],
    [id(601), '2026-11-20_03-00-01_bobine_ab12', 'bobines/Le pêcheur à l’aube/02.mp4', 1344, 24, [], [[0, 'image', 0, 2, 'fit', 1]]],
  ]);
  // Its folder there already: the next free one.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'bobines', 'Le pêcheur à l’aube'), { recursive: true });
  await mkdir(join(dir, 'bobines', 'Le pêcheur à l’aube 2'));
  assert.equal((await exportTakes({ montage, fileOf, assemble, outputDir: dir })).folder, 'bobines/Le pêcheur à l’aube 3');
  assert.match(asked.at(-1).request.outputName, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_bobine_[0-9a-f]{4}$/);
  // Ten takes and more: two figures; a hundred: three.
  const many = validateMontage(film({ plans: Array.from({ length: 100 }, (_, at) => ({ id: id(1000 + at), source: take(12), kind: 'video', from: 0, to: 1 })), sounds: [] }));
  const hundred = await exportTakes({ montage: many, fileOf, assemble, outputDir: dir });
  assert.deepEqual([hundred.files[0], hundred.files.at(-1)], ['001.mp4', '100.mp4']);
  // Nothing made yet: refused in the user's words.
  const none = validateMontage(film({ plans: [{ id: id(2), kind: 'video', todo: { prompt: '' }, from: 0, to: 2 }], sounds: [] }));
  await assert.rejects(exportTakes({ montage: none, fileOf, assemble, outputDir: dir }), /Aucune prise de cette bobine n’est encore créée/);
  // The folder, as Windows takes it.
  assert.deepEqual(['Le renard / l’hiver ?', 'CON', '  ', 'Fin…  .'].map(folderName), ['Le renard l’hiver', 'Bobine CON', 'Bobine', 'Fin…']);
});
