/**
 * Several images asked in one call of create_image (« fais 10 images de ce style », 17/11): the
 * model prepares every prompt at once (`series`), the first image is made as any creation, and the
 * others one after another, each proposed by the server (/api/tools/series, lib/tool-runtime.mjs)
 * on a card of its own, without asking the model between two. The model then gets one result for
 * its one call: every take, and where the series stopped if it did.
 */
const MADE = new Set(['success', 'generated']);

/**
 * The results of the images of a series (their contents, as requestTool gives them) as one.
 * `stopped`: why it has fewer images than asked (ended before its last one, or still being made:
 * what the conversation keeps after each image, until the next result takes its place).
 */
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
      // Not its prompt: the call holds every one of them, in this order (`prompt`, then `series`).
      ...(typeof result.run_id === 'string' ? { run_id: result.run_id } : {}),
      ...(result.takes ? { takes: result.takes } : {}),
      ...(result.parameters?.seed !== undefined ? { seed: result.parameters.seed } : {}),
      ...(result.message ? { message: result.message } : {}),
    })),
    ...(parameters ? { parameters: settings } : {}),
    ...(stopped ? { message: stopped } : {}),
    // A failure before any image is settled at the next message as any other (transcript.mjs).
    // After some were made, the note of a single image (« rien n’a été produit », then « refais le
    // même appel ») would have the whole series made again, those already there included. The
    // same for any series left with fewer images than asked (stopped by the user, kept unfinished).
    ...(made.length && made.length < total
      ? { note: seriesNote(made.length, total) }
      : failure?.note
        ? { note: failure.note }
        : made.length === total
          ? { note: SERIES_MADE }
          : {}),
  });
}

/**
 * What the model is told of a series made whole. Its images are never handed to it by themselves,
 * even when the user chose that the model looks at each image made: up to twenty copies in one
 * message do not fit in the context of a local model. It looks at one when it is asked to.
 */
export const SERIES_MADE =
  'Images générées et affichées à l’utilisateur. Tu ne les as pas vues : n’écris ni commentaire ni description, ton texte ne serait pas affiché. ' +
  'Si l’utilisateur demande une vérification, consulte une image à la fois avec local_read_output (son run_id, dans images), sans demander son identifiant. Sinon termine sans texte.';

/** What the model is told of a series that stopped midway. */
export const seriesNote = (made, total) =>
  `Série incomplète : ${made} image${made > 1 ? 's' : ''} sur ${total} ${made > 1 ? 'sont faites et montrées' : 'est faite et montrée'} à l’utilisateur, ` +
  'les autres non. Ne refais jamais celles qui existent. Si l’utilisateur demande la suite, appelle l’outil pour celles qui manquent seulement.';

const stoppedAfter = (made, total) =>
  `Série arrêtée par l’utilisateur : ${made} image${made > 1 ? 's' : ''} sur ${total} ${made > 1 ? 'ont été faites' : 'a été faite'}.`;
// What the conversation keeps while the series is made: read only if nothing came after it (the
// application closed or the page reloaded between two images). The same once a page finds the
// images made while none followed it (take-recovery.mjs, 0.6.82).
export const interrupted = (made, total) =>
  `Série interrompue avant sa fin : ${made} image${made > 1 ? 's' : ''} sur ${total} ${made > 1 ? 'ont été faites' : 'a été faite'}.`;
/** A result kept so: the series may have more images made than it says. */
export const INTERRUPTED = /^Série interrompue avant sa fin : /;

/**
 * The images after the first (`first`: its result, made and shown): each proposed by the server,
 * mounted on its card (`mount`), run as the first was (`run`), then settled (`settle`). Stops at an
 * image refused or failed (its card says why). The result of the whole series, as one creation:
 * its content for the model, every image, the last take made. Stopped by the user or broken, the
 * error thrown carries what the model is to be told (`series`).
 * `keep(content)`: after each image but the last, what the call has made so far, for the page to
 * save in the conversation: closed in the middle of twenty images, the application had kept none of
 * them in its history. Stopped before its last image, the server is told (`end`): it lets the
 * prompts of the series go and brings the chat model back; the page waits for it where it goes on
 * to write to the model (an image refused or failed).
 */
export async function runSeries(request, first, { api, signal, mount, run, settle = () => {}, keep = async () => {} }) {
  const total = request.series.total,
    contents = [first.content],
    images = [...(first.images ?? [])];
  let last = first,
    made = 1,
    stopped = '';
  const end = () => api('tools/series', { series: request.series.id, end: true }).catch(() => {});
  // (What could not be kept does not stop the series: the page says so itself.)
  const kept = async () => {
    try {
      await keep(seriesContent(contents, total, { stopped: interrupted(made, total) }));
    } catch {}
  };
  for (let index = request.series.index + 1; index <= total; index++) {
    let card = null,
      result;
    try {
      await kept();
      signal.throwIfAborted();
      const proposal = await (await api('tools/series', { series: request.series.id }, { signal })).json();
      card = mount(proposal);
      result = await run(proposal, card);
    } catch (error) {
      // (Not waited for: the turn ends here, and the model comes back behind it.)
      void end();
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
    if (result.failed && result.record) {
      // Made all the same (what failed came after it: its copy, the hand-back of the card): it is
      // one of the images of the series, as its result says, not one that « failed ».
      made++;
      last = result;
      images.push(...(result.images ?? []));
      stopped = `L’image ${index} est faite, mais une erreur a suivi${result.error ? ` (${String(result.error).replace(/\.$/, '')})` : ''} : la série s’arrête là.`;
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
  if (stopped) await end();
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
