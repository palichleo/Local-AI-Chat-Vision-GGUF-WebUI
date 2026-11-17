/**
 * Several images asked in one call of create_image (« fais 10 images de ce style », 17/11): the
 * model prepares every prompt at once (`series`), the first image is made as any creation, and the
 * others one after another, each proposed by the server (/api/tools/series, lib/tool-runtime.mjs)
 * on a card of its own, without asking the model between two. The model then gets one result for
 * its one call: every take, and where the series stopped if it did.
 */
const MADE = new Set(['success', 'generated']);

/** The results of the images of a series (their contents, as requestTool gives them) as one. */
export function seriesContent(contents, total, { stopped = '' } = {}) {
  const results = contents.map(content => {
    try {
      const result = JSON.parse(content);
      return result && typeof result === 'object' ? result : { status: 'error' };
    } catch {
      return { status: 'error', message: String(content) };
    }
  });
  const made = results.filter(result => MADE.has(result.status)),
    first = made[0] ?? results[0] ?? {},
    failure = results.find(result => !MADE.has(result.status));
  // What every image shares (its workflow, its inputs, how takes are named), said once.
  const { run_id, use_as_source, prompt, takes, parameters, status, message, note, ...shared } = first;
  const { seed, ...settings } = parameters ?? {};
  return JSON.stringify({
    status: made.length === total ? 'success' : made.length ? 'partial' : 'error',
    ...shared,
    made: made.length,
    asked: total,
    takes: made.flatMap(result => result.takes ?? []),
    images: results.map(result => ({
      status: result.status,
      // Each image is a creation of its own: the conversation shows it again by this, and the
      // model looks at it by this (left out, a series was gone from its conversation once reopened).
      ...(typeof result.run_id === 'string' ? { run_id: result.run_id } : {}),
      ...(result.takes ? { takes: result.takes } : {}),
      ...(typeof result.prompt === 'string' ? { prompt: result.prompt } : {}),
      ...(result.parameters?.seed !== undefined ? { seed: result.parameters.seed } : {}),
      ...(result.message ? { message: result.message } : {}),
    })),
    ...(parameters ? { parameters: settings } : {}),
    ...(stopped ? { message: stopped } : {}),
    // A failure before any image is settled at the next message as any other (transcript.mjs).
    // After some were made, the note of a single image (« rien n’a été produit », then « refais le
    // même appel ») would have the whole series made again, those already there included.
    ...(failure && made.length
      ? { note: seriesNote(made.length, total) }
      : failure?.note
        ? { note: failure.note }
        : {}),
  });
}

/** What the model is told of a series that stopped midway. */
export const seriesNote = (made, total) =>
  `Série incomplète : ${made} image${made > 1 ? 's' : ''} sur ${total} ${made > 1 ? 'sont faites et montrées' : 'est faite et montrée'} à l’utilisateur, ` +
  'les autres non. Ne refais jamais celles qui existent. Si l’utilisateur demande la suite, appelle l’outil pour celles qui manquent seulement.';

const stoppedAfter = (made, total) =>
  `Série arrêtée par l’utilisateur : ${made} image${made > 1 ? 's' : ''} sur ${total} ${made > 1 ? 'ont été faites' : 'a été faite'}.`;

/**
 * The images after the first (`first`: its result, made and shown): each proposed by the server,
 * mounted on its card (`mount`), run as the first was (`run`), then settled (`settle`). Stops at an
 * image refused or failed (its card says why). The result of the whole series, as one creation:
 * its content for the model, every image, the last take made. Stopped by the user or broken, the
 * error thrown carries what the model is to be told (`series`).
 */
export async function runSeries(request, first, { api, signal, mount, run, settle = () => {} }) {
  const total = request.series.total,
    contents = [first.content],
    images = [...(first.images ?? [])];
  let last = first,
    made = 1,
    stopped = '';
  for (let index = request.series.index + 1; index <= total; index++) {
    let card = null,
      result;
    try {
      signal.throwIfAborted();
      const proposal = await (await api('tools/series', { series: request.series.id }, { signal })).json();
      card = mount(proposal);
      result = await run(proposal, card);
    } catch (error) {
      if (signal.aborted) card?.withdraw();
      else card?.failed(error.message);
      error.series = seriesContent(contents, total, {
        stopped: signal.aborted ? stoppedAfter(made, total) : `Série arrêtée à l’image ${index} : ${error.message}`,
      });
      throw error;
    }
    card.finish(result);
    settle(result);
    contents.push(result.content);
    if (result.denied) {
      stopped = `L’image ${index} a été refusée : la série s’arrête là.`;
      break;
    }
    if (result.failed || !result.record) {
      stopped = `L’image ${index} a échoué : la série s’arrête là.`;
      break;
    }
    made++;
    last = result;
    images.push(...(result.images ?? []));
  }
  return {
    ...last,
    content: seriesContent(contents, total, { stopped }),
    images,
    failed: false,
    denied: false,
    // An image refused or failed ended it: the model does not call again in this message.
    stopped: Boolean(stopped),
  };
}
