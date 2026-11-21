/**
 * La Bobine (ex-Montage), 0.6.148: a page of its own, at the level of the project, beside the Studio
 * (maquette « La Bobine », claude_design/maquettes/bobine-maquette.md, captures 70 à 92). Before it,
 * the fourth mode of the Studio (0.6.137 to 0.6.146, montage-fonctionnement.md): what is kept, what
 * is asked of the models and the gestures of the timeline are those; the page is new.
 *
 * Three fixed columns, then the timeline over the whole width: at the left the takes of the project
 * (« Prises »), in the middle the preview, at the right « À créer », always there. The middle never
 * moves. No panel of settings: a small bar opens above the take or the sound chosen, on its track.
 * The fil at the top: « projet / bobine », then (0.6.154) Annuler, Rétablir, « Enregistrer » (the
 * bobine put in the Archives, a point while it changed since) and « Exporter » (« Un seul fichier », « Un
 * fichier par prise »). The words of the page are those of the
 * maquette: prises, prises à créer, suites; the tracks are Photos, Prises, Piste audio 1 and 2. The
 * code keeps its own names (montage, plans, sounds).
 *
 * What is kept (lib/montages.mjs) is unchanged: every change is kept a moment after it is made. A take
 * to create is made by the Studio as one of its takes (`create`), « Créer n prises » making them one
 * after the other at once, in the order of the bobine (no agreement apart any more: « À créer » is
 * the list). The Éclipse has Moodix AI write what happens in those that have no text (`write`).
 */
import { FORMATS } from './formats.mjs';
import { thumbnailOf } from './thumbnails.mjs';
import { sizeText } from './missing-file.mjs';
import { withArrangement } from './montage-arrange.mjs';
import { licenseBlock, restrictedOf } from './model-licenses.mjs';
import { licenseSentence } from './models-page.mjs';
import { closePopup, openPopup } from './glass-menu.mjs';
import { fluxStart, takeFlux } from './take-flux.mjs';
import {
  MONTAGE_LIMITS,
  MONTAGE_RATES,
  TODO_LIMITS,
  creationOf,
  folderName,
  holeAt,
  isTodo,
  linkOf,
  montageSeconds,
  partsOf,
  placed,
  planAt,
  planStarts,
  seriesOf,
  snapped,
  takeSeconds,
  todoPlans,
  trackOf,
  usualSize,
  withEndPulled,
  withItemChanged,
  withPhoto,
  withPhotoIn,
  withPlanMoved,
  withPlanPlaced,
  withTake,
  withTodoDrawn,
  withTodoMade,
  withoutItem,
  withoutPhoto,
} from './montage-model.mjs';

const FILTERS = [
  ['all', 'Tout'],
  ['video', 'Vidéos'],
  ['image', 'Images'],
  ['audio', 'Sons'],
];
// (0.6.148) The tracks under their names of the maquette; a sound goes on the one it is dropped on.
const TRACKS = [
  ['plans', 'Prises'],
  ['music', 'Piste audio 1'],
  ['effects', 'Piste audio 2'],
];
// The timeline shows ten seconds at least: a first take does not fill it from side to side.
const SHORTEST_SPAN = 10;
// (0.6.149) « La bobine ne va jamais jusqu'au bout » : after its end, a quarter of it and five seconds
// at least are left empty, to draw in; the timeline is zoomed up to sixteen times (Ctrl + molette).
const ROOM_AFTER = 5;
const ZOOM_MAX = 16;
const ZOOM_STEP = 1.5;
// How near a cut of the film a sound dragged stops on it, in pixels of the timeline.
const NEAR_PIXELS = 8;
/** « 06.04 », « 1:02.50 »: the instants and lengths of the page, in mono (maquette 70). */
export function mono(seconds) {
  const value = Math.max(0, Math.round(seconds * 100) / 100);
  if (value < 60) return value.toFixed(2).padStart(5, '0');
  const minutes = Math.floor(value / 60);
  return minutes + ':' + (value - minutes * 60).toFixed(2).padStart(5, '0');
}
const plural = (count, one, many = one + 's') => `${count} ${count > 1 ? many : one}`;
// (0.6.162) The earlier requests of a bobine said again to Moodix AI with a new one: the last ones.
const ASKS = 3;
// (0.6.154) How many steps « Annuler » goes back at most, and how long a pause between two keys typed
// in a text makes another step, in milliseconds.
const STEPS = 100,
  TYPED = 1500;
// (0.6.155) How long the end of an export is said in the fil, and how often a download is asked about, in ms.
// (0.6.160) How long after a save refused the page tries again on its own, once.
const SAVE_AGAIN = 5000;
// (0.6.160) Said in the line of the take Moodix AI was writing when the page was left: its series ended there.
const LEFT_WRITING = 'Série arrêtée : vous avez quitté la Bobine pendant que Moodix AI écrivait cette prise.';
const SAID = 4000,
  POLL = 1000;
// (0.6.157) How long the suite shown under the end of a video is, in seconds (capture 72).
const HINT = 2;
// (0.6.169) How long a click on a take of « Prises » waits before it opens it: the time of a double click,
// which lays it on the bobine instead, in milliseconds.
const DOUBLE_CLICK = 240;
// (0.6.169) The identifier of the take being carried over the timeline, laid there to show where it goes.
const CARRIED = 'carried';
// (0.6.169) How long the takes of the timeline slide to their new place, in milliseconds.
const SLIDE = 180;
// (0.6.173, « ça saute ») At its fastest at once, then slower and slower: a sixth of the way at the first
// image of the screen. (The curve of 0.6.169 went more than a third of the way at the first, two thirds
// at the second: a jump, then a crawl.) moodix.css has the same for a take carried from « Prises ».
const SLIDING = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
// (0.6.169) How far the take in the hand must jump, in pixels, to slide there rather than follow it
// (0.6.173: further than the hand itself went, which may go fast).
const JUMP = 24;
/** (0.6.154) Every key in its order, at every depth: two bobines alike say the same. */
const sorted = value =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
      : value;
/** (0.6.173) Two bobines with the same takes and the same sounds at the same places: nothing to draw again from one to the other. */
const alike = (one, other) => JSON.stringify(sorted([one.plans, one.sounds])) === JSON.stringify(sorted([other.plans, other.sounds]));
/** (0.6.154) What a bobine is made of, as one text: its version in the Archives is compared by it. */
const contentKey = ({ name, format, width, height, fps, plans, sounds }) => JSON.stringify(sorted({ name, format, width, height, fps, plans, sounds }));
/** (0.6.154) « 01 À 05 »: the numbers of the files of the takes exported one by one. */
const numbered = count => {
  const width = Math.max(2, String(count).length),
    first = '1'.padStart(width, '0');
  return count > 1 ? `${first} à ${String(count).padStart(width, '0')}` : first;
};

export function setupMontage({
  api,
  node,
  icon,
  notice = () => {},
  // The project the Bobine works in, and its creations (those the Studio reads for it).
  project,
  runs,
  // Reads the creations of the project again: a film exported is one of them.
  refresh = async () => {},
  // The conversation a film is kept in, made when it has none yet.
  ensureConversation,
  // Opens a take with its details, as a click in the Sortie of the Studio does.
  showTake = () => {},
  // (0.6.169) What the hand carries from « Prises », as in the Studio: `dragImage(tile, dataTransfer,
  // media, take, { width, height })` draws the take small, tilted, under the pointer.
  dragImage = null,
  newId = () => globalThis.crypto.randomUUID(),
  // How long a change waits before it is kept (several made in a row are kept once).
  saveDelay = 500,
  timers = { set: (work, delay) => setTimeout(work, delay), clear: id => clearTimeout(id) },
  now = () => performance.now(),
  // Makes the small picture of a clip that has none yet, from its first picture (as the Sortie does).
  thumbnail = thumbnailOf,
  // What hears the pointer while something of the timeline is dragged (0.6.138): the window.
  page = globalThis.window,
  // (0.6.142) What makes a take to create: the Studio's own creation, asked as one of its takes is
  // (`create({ verb, args, size }, { onProgress })` gives the record made, or throws why not), what
  // stops it, and how the Studio names a take as an input of a creation.
  create = null,
  halt = () => {},
  // (0.6.175) Why nothing can be created nor asked to Moodix AI now, a work going on outside the Bobine
  // (a creation of the Studio or of the Chat, Moodix answering, another conversation), in the user's
  // words; '' when it can. Its controls are greyed by it and say it, as « Générer » does; `busyChanged`
  // tells it changed. `create` refused all the same (the work began meanwhile) rejects with an error
  // marked `refused`, its message that reason ('': nothing to say, the user said no himself).
  busyWith = () => '',
  // (0.6.181) A take to create of a bobine being made though this page did not ask for it (asked before a
  // reload, the Studio follows it again): `followed()` gives { id, plan, fraction }, its bobine, its take to
  // create and how far it is, or null. `busyChanged` tells it changed.
  followed = () => null,
  inputOf = record => ({ output: record.id }),
  // (0.6.144) The model a creation would be made with, nothing being made nor kept: `estimate({ verb,
  // args, size })` gives { workflowName, missing }. (0.6.148) No time is said any more.
  estimate = null,
  // (0.6.151) The model a take of the Bobine is asked to, by its name (`workflow`), when it is on this
  // computer: `modelFor(verb)` gives its id, or null (the server chooses, as for any creation). His
  // answer of 20/11 « Oui, LTX 2.5 »: a take drawn of 1,90 s had gone to MiniMax H3 Omni, which
  // made 5,17 s of it in 201 s.
  modelFor = () => null,
  // (0.6.152) The longest that model makes at once, by verb (seconds), or null: a take to create
  // longer than it is made in equal parts (montage-model.mjs `partsOf`).
  longestFor = () => null,
  // (0.6.153, captures 84 et 85) The text of a take to create detailed by the chat model (framing,
  // light, movement) without changing what happens in it, as the wand of the Studio does:
  // `enrich({ prompt, verb }, { signal })` gives { prompt }, or throws why not.
  enrich = null,
  // (0.6.146) What happens in a take to create, written by the chat model from its pictures:
  // `write({ verb, seconds, start, end, previous }, { signal })` gives { prompt }, or throws why not.
  write = null,
  // (0.6.162, his choice of 20/11: under the preview) The plan of a request written in the Bobine
  // (« invente la suite », « un film de 20 secondes sur… »), asked to the chat model in a request of its
  // own (lib/arrange.mjs): `arrange({ montage, request, previous }, { signal })` gives { arrangement,
  // problems }, or throws why not. It is laid here (public/montage-arrange.mjs): nothing is created.
  arrange = null,
}) {
  let root = null,
    filRoot = null,
    ownFil = false,
    readFor = null,
    list = [],
    montage = null,
    stored = false,
    chosen = null,
    filter = 'all',
    head = 0,
    playing = null,
    status = '',
    saving = null,
    pending = false,
    retried = false, // (0.6.160) a save refused was already tried again on its own
    exporting = false,
    // (0.6.148) What the fil asks before it is done: « Renommer », « Supprimer ».
    asking = null,
    carried = null,
    media = null,
    // The four blocks as last drawn: a change draws two of them again, not the preview nor the takes.
    parts = null,
    // While something is dragged on the timeline: its scale held as it was (it would change under
    // the pointer with the length of the film), where the takes were (a start that is cut follows
    // the pointer, the others wait), and the click that ends a drag, which chooses nothing.
    held = null,
    ghost = null,
    slid = false,
    // (0.6.143) While the end of a video is pulled beyond its take: its continuation, { id, at, seconds }.
    pulling = null,
    // (0.6.142) The take to create being made: { id, label, fraction, preview }.
    making = null,
    // (0.6.148) The takes to create being made one after the other: { stage: 'running' | 'paused',
    // ids (in their order), done (how many are made), pausing, stopping }.
    filling = null,
    // (0.6.146) Moodix AI is writing the takes: { id (the one it writes), at, of, controller }.
    writing = null,
    // (0.6.149) How much the timeline is zoomed (1: the whole bobine), and how far it is scrolled.
    zoom = 1,
    scrolled = 0,
    // (0.6.149) The take to create being drawn in a hole: { from, to } in seconds of the bobine.
    drawing = null,
    // (0.6.153) Enrichir: the wand is in the hand (« Le mode reste ouvert »), the take being enriched,
    // the one just enriched (it lights up a moment), what Ctrl+Z gives back ({ id, prompt, after }).
    wand = false,
    enrichingId = null,
    // (0.6.162) What is written under the preview for Moodix AI, the request it is arranging ({ request,
    // controller, bobine }), what it laid last ({ count, filled, say, notes, open } or { problem }), and
    // the earlier requests of this bobine ([{ request, say }]).
    wish = '',
    arranging = null,
    laid = null,
    asks = [],
    lit = null,
    // (0.6.153, capture 78) The take whose line or piece is under the pointer: lit on both sides, drawn again so.
    hovered = null,
    // (0.6.153) What lets the enrichment being asked go.
    enriched = null,
    // (0.6.155) The model being downloaded from « À créer »: { name, offer, stage: 'confirm' | 'running',
    // received, total }; why it could not be (said above the button).
    downloading = null,
    fetchError = '',
    // (0.6.154) A drag of the timeline being made: all its moves are one step of « Annuler ».
    dragging = null,
    // (0.6.154) The bobine as « Enregistrer » put it in the Archives (contentKey), or null; « Enregistrer »
    // being done; the menu of « Exporter » open; the bobine to open when those of the project are read.
    archivedKey = null,
    archiving = false,
    exportMenu = null,
    wantedId = null,
    reading = null,
    // (0.6.169) The click on a take of « Prises » that waits to open it (a second one lays it instead); the
    // take dragged along its track; where the take carried from « Prises » would go, as last shown.
    opening = null,
    moving = null,
    landing = '',
    // (0.6.173) How far the hand that drags a take went at its last move, in pixels.
    strode = 0;
  // (0.6.173) The slides going on: for a take or a photo of the timeline (`id|rank`), where it left from
  // and where it goes on the screen, and since when. The timeline is drawn again at each change (a take
  // that follows the hand: at each move): a slide goes on from where it was, it does not begin again.
  const flights = new Map();
  // (What contentKey said of the bobine shown, kept while it is the same.)
  let keyed = { of: null, key: '' };
  // (0.6.154) Annuler, Rétablir (Ctrl+Z, Ctrl+Maj+Z): the bobine as it was before each change, and as it
  // was after each one undone. A text typed in a row, a drag, a volume slid, the texts Moodix AI writes
  // at once: one step each. A take created is one too: undone, it is a take to create again (the take
  // made stays in « Prises »), and « Rétablir » puts it back.
  const past = [],
    future = [];
  let step = null;
  // (0.6.148) Why a take to create could not be made, by its id: said in its line, in amber.
  const failed = new Map();
  // (0.6.181) The takes made that this page laid in a bobine, by their id: never laid twice (layMissed).
  const laidHere = new Set();
  // The take followed from outside (goingOn) the page last drew as « En cours »: drawn again when it changes.
  let shownGoing = null;
  // (0.6.148) The model of each kind of take to create, as the server would choose it: { name, missing }.
  const models = new Map();
  // (0.6.155) The models whose download under way elsewhere (Paramètres › Modèles) was looked for.
  const watched = new Set();
  const inSeries = () => filling?.stage === 'running' || filling?.stage === 'paused';
  // (0.6.152) What the model of the takes makes at once: what a take to create is cut by.
  const limits = () => ({ create_video: longestFor('create_video'), extend_video: longestFor('extend_video') });
  const busy = () => Boolean(making || writing || inSeries() || arranging);
  /**
   * (0.6.175) Why the Bobine cannot begin anything now, a work going on outside it (`busyWith`); '' while
   * it is at a work of its own, which it says itself. « Créer » stayed lit during a creation of the Chat
   * or of the Studio: its click was refused there without a word, and the take was noted « Échec · La
   * création n'a pas pu commencer. »
   */
  const outside = () => (making || writing || arranging || enrichingId || filling?.stage === 'running' ? '' : busyWith() || '');
  /** Whether such a work holds what was just asked: said then, in the place of beginning it. */
  function heldOutside() {
    const why = outside();
    if (why) notice(why);
    return Boolean(why);
  }
  /**
   * (0.6.155) A take to create without its text that Moodix AI can write at its turn in the series, as
   * the Éclipse does: it has something to look at (a photo, the video it goes on from, the take to
   * create it goes on from).
   */
  const writable = plan =>
    Boolean(write) && Boolean(plan.photos?.start || plan.photos?.end || ['suite', 'last', 'wait'].includes(linkOf(montage, plan.id, lengthOf).kind));

  const fresh = (format = '16:9') => ({
    schemaVersion: 1,
    id: newId(),
    name: 'Sans titre',
    format,
    ...usualSize(format),
    fps: MONTAGE_RATES[0],
    plans: [],
    sounds: [],
  });
  // (A take to create has no take yet: nothing is found for it.)
  const recordOf = source =>
    (source && (runs() ?? []).find(run => run.id === source.runId && run.conversationId === source.conversationId)) || null;
  const outputOf = source => recordOf(source)?.outputs?.[source.output] ?? null;
  const lengthOf = source => {
    const record = recordOf(source);
    return record ? takeSeconds(record) : null;
  };
  const itemOf = id => montage.plans.find(plan => plan.id === id) ?? montage.sounds.find(sound => sound.id === id) ?? null;
  /**
   * (0.6.181, audit of 21/11, A5) The take to create `id` of this bobine is being made though this page did
   * not ask for it: asked before a reload, the Studio follows it again (`followed`). Its line and its take
   * say « En cours »; made, it is laid at its place (layMissed). It stayed « à créer », nothing saying that
   * its take was on its way.
   */
  const goingOn = id => {
    const going = followed();
    return going && going.id === montage.id && going.plan === id && isTodo(itemOf(id)) ? going : null;
  };
  /** What makes the take to create `id` now, { fraction }: this page (making), or a work followed (goingOn). */
  const beingMade = id => (making?.id === id ? making : goingOn(id));
  /**
   * (0.6.181) The takes made for a take to create of this bobine that no page laid: reloaded or closed while
   * it was made, the page left the take « à créer » and its take in « Prises ». Its record says its place
   * (`bobine`: this bobine, that take to create, from which second it is shown), and it is laid there as
   * makePlan lays it, one step of « Annuler ». Only a take made since the bobine was last kept: one laid
   * then put back to create (Ctrl+Z) left a bobine kept after it, and stays where the user put it.
   */
  function layMissed() {
    if (making || !stored || !montage?.updatedAt) return false;
    const since = Date.parse(montage.updatedAt),
      made = record => Date.parse(record.createdAt),
      missed = (runs() ?? [])
        .filter(record => record.bobine?.id === montage.id && !laidHere.has(record.id) && made(record) > since)
        .sort((one, other) => made(one) - made(other));
    let laid = false;
    for (const record of missed) {
      const { plan, from } = record.bobine;
      if (!isTodo(itemOf(plan))) continue;
      if (!laid) remember(montage);
      montage = withTodoMade(montage, plan, record, { from, limits: limits(), partId: newId() });
      laidHere.add(record.id);
      laid = true;
    }
    if (laid) {
      pending = true;
      void keep();
    }
    return laid;
  }
  const total = () => montageSeconds(montage);
  // (0.6.149) Room after the end, then to the ten seconds above: the scale changes seldom as the bobine is made.
  const span = () =>
    held ??
    Math.max(
      SHORTEST_SPAN,
      Math.ceil(Math.max(total() + Math.max(ROOM_AFTER, total() / 4), ...montage.sounds.map(sound => sound.at + (sound.to - sound.from))) / 10 - 1e-9) * 10,
    );
  const percent = seconds => (100 * seconds) / span() + '%';
  const takeLabel = (source, before = '') => {
    const take = outputOf(source)?.take;
    return Number.isInteger(take) ? before + 'Prise ' + take : '';
  };
  const pictureOf = record => {
    const output = record?.outputs?.[0] ?? {};
    return output.thumbUrl || (record?.mediaType === 'video' || record?.mediaType === 'audio' ? '' : output.originalUrl) || '';
  };
  const button = (className, text, onclick, glyph, tip = '') => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = onclick;
    if (tip) {
      control.title = tip;
      control.setAttribute('aria-label', tip);
    }
    return control;
  };
  const block = (kind, name) => {
    const section = node('section', `studio-block ${kind} ${name}`),
      body = node('div', 'studio-block-body');
    section.append(body);
    return { section, body };
  };

  // What is kept ---------------------------------------------------------------------------------
  async function read() {
    const place = project();
    readFor = place;
    // (0.6.154) Read now: the bobine asked from the Archives waits for it (opened).
    const mine = (reading = {});
    list = [];
    montage = fresh();
    archivedKey = null;
    stored = false;
    chosen = null;
    head = 0;
    status = '';
    failed.clear();
    forget();
    unkept();
    try {
      const found = (await (await api('montages/' + encodeURIComponent(place))).json()).montages ?? [];
      if (project() !== place) return void (reading === mine && (reading = null));
      list = found;
      // (0.6.154) The one opened from the Archives, else the last changed.
      const wanted = found.some(item => item.id === wantedId) ? wantedId : found[0]?.id;
      wantedId = null;
      if (wanted) await open(wanted);
    } catch (error) {
      status = 'Bobines illisibles : ' + error.message;
    }
    if (reading === mine) reading = null;
    draw();
  }
  /** (0.6.154) The bobine asked from the Archives, opened once those of its project are read. */
  function opened() {
    if (!wantedId || reading || readFor !== project()) return;
    const id = wantedId;
    wantedId = null;
    if (montage?.id !== id) void choose(id);
  }
  async function open(id) {
    const place = project();
    const found = await (await api(`montages/${encodeURIComponent(place)}/${id}`)).json();
    if (project() !== place) return;
    stop();
    // (0.6.149) Each take at its instant (the server says them; a bobine of before, end to end).
    // (0.6.154) Its version in the Archives is said by its key only: never sent back.
    const { archived = null, ...opened } = found;
    montage = placed(opened);
    archivedKey = archived ? contentKey(placed(archived)) : null;
    stored = true;
    forget();
    unkept();
    chosen = null;
    head = 0;
    status = '';
    failed.clear();
    // (0.6.181) A take made for it while no page was there: at its place.
    layMissed();
  }
  /** Keeps the bobine now; resolves once it is kept (or could not be: said in the fil). */
  async function keep() {
    if (saving) timers.clear(saving);
    saving = null;
    if (!pending) return;
    pending = false;
    const sent = montage,
      place = project();
    try {
      const kept = await (await api('montages/save', { project: place, montage: sent })).json();
      stored = true;
      retried = false;
      if (montage === sent) montage = { ...sent, createdAt: kept.createdAt, updatedAt: kept.updatedAt };
      listed(kept);
      // (0.6.154) Kept on its own, as before, but said only when it could not be: « Enregistrer » puts
      // the bobine in the Archives now, its point says what changed since.
      if (status.startsWith('Non gardée')) status = '';
    } catch (error) {
      status = 'Non gardée : ' + error.message;
      // (0.6.160) What could not be kept is still to keep. It was held for kept: leaving the page, which
      // « keeps what is not kept yet », found nothing to keep, and the bobine stayed as the disk had it.
      // Tried again on its own too, once, a moment later: a refusal that passes (the server starting
      // again); after it, the next change, an export or leaving the page try.
      pending = true;
      if (!saving && !retried) {
        retried = true;
        saving = timers.set(() => void keep(), SAVE_AGAIN);
      }
    }
    say();
  }
  /** (0.6.160) Another bobine comes on the page: what the one before could not keep is not kept in its name. */
  function unkept() {
    if (saving) timers.clear(saving);
    saving = null;
    pending = retried = false;
  }
  /** (0.6.155) The end of an export, said a few seconds in the fil, then nothing: only errors stay there. */
  function fades() {
    const said = status;
    timers.set(() => {
      if (status !== said) return;
      status = '';
      say();
    }, SAID);
  }
  /** The bobine kept is the first of the menu of the fil; a new one, or a new name, is said there. */
  function listed(kept) {
    const known = list.some(item => item.id === kept.id && item.name === kept.name);
    list = [{ id: kept.id, name: kept.name, updatedAt: kept.updatedAt }, ...list.filter(item => item.id !== kept.id)];
    if (!known) fil();
  }
  /** (0.6.154) Whether the bobine changed since « Enregistrer » put it in the Archives (its point says it). */
  function unsaved() {
    if (keyed.of !== montage) keyed = { of: montage, key: contentKey(montage) };
    return archivedKey ? keyed.key !== archivedKey : Boolean(montage.plans.length || montage.sounds.length);
  }
  /**
   * (0.6.154, capture 90) « Enregistrer »: the bobine put in the Archives as it is now, « comme une bobine
   * qu'on rouvre, pas comme un film »; its card there opens it again. What changes after it is kept as
   * before, and its point says so.
   */
  async function archive() {
    if (archiving || exporting || (!montage.plans.length && !montage.sounds.length)) return;
    archiving = true;
    if (saving) timers.clear(saving);
    saving = null;
    const sent = montage,
      place = project();
    pending = false;
    sayFil();
    try {
      const kept = await (await api('montages/save', { project: place, montage: sent, archive: true })).json();
      stored = true;
      archivedKey = contentKey(sent);
      if (montage === sent) montage = { ...sent, createdAt: kept.createdAt, updatedAt: kept.updatedAt };
      listed(kept);
      // (0.6.155) Nothing said: its point is gone.
      status = '';
    } catch (error) {
      // (Not kept either: kept on its own a moment later.)
      pending = true;
      saving = timers.set(() => void keep(), saveDelay);
      status = 'Non enregistrée : ' + error.message;
    }
    archiving = false;
    say();
  }
  /**
   * A change made by hand: shown at once, kept a moment later. `sliding`: a text being written in « À
   * créer », not drawn again under the hand; `still`: a bar being slid on the timeline, nothing is drawn
   * again (what it shows is said by the bar itself), until it is let go.
   */
  function change(next, { select, sliding = false, still = false, group = dragging } = {}) {
    if (next === montage) return;
    const why = refusal();
    if (why) return void notice(why);
    remember(montage, group);
    settle(next, { select, sliding, still });
  }
  /** Why the bobine cannot be changed now ('' when it can). */
  function refusal() {
    // (0.6.146) Not while Moodix AI writes the takes: its texts are written back in this bobine.
    if (writing) return 'Moodix AI écrit les prises : attendez la fin, ou arrêtez l’écriture.';
    // (0.6.162) Nor while it arranges the bobine: its plan is laid on the bobine it was asked for.
    if (arranging) return 'Moodix AI arrange la bobine : attendez la fin, ou arrêtez.';
    // (0.6.144) Nor while takes are created, even between two of them or in pause.
    if (inSeries())
      return filling.stage === 'paused'
        ? 'La création est en pause : reprenez-la ou arrêtez-la avant de modifier la bobine.'
        : 'Des prises sont en cours de création : attendez la fin, ou arrêtez.';
    if (making) return 'Une prise est en cours de création : attendez sa fin, ou arrêtez-la.';
    return '';
  }
  /**
   * (0.6.154) The bobine as it was, kept for « Annuler »; what was undone cannot come back any more.
   * `group`: the changes of one gesture make one step (a text typed in a row: a moment at most between
   * two keys; a drag, the texts of Moodix AI: as long as it lasts).
   */
  function remember(previous, group = null) {
    // (0.6.162) What Moodix AI laid is said while it is the last step only: its « Annuler » undoes it.
    laid = null;
    const at = now(),
      same = group && step?.group === group && (typeof group !== 'string' || at - step.at < TYPED);
    if (!same) {
      past.push(previous);
      if (past.length > STEPS) past.shift();
    }
    future.length = 0;
    step = { group, at };
  }
  /** (0.6.154) No step to undo nor to do again: another bobine is open. */
  function forget() {
    past.length = future.length = 0;
    step = null;
    // (0.6.162) Nor anything asked to Moodix AI in the bobine before.
    laid = null;
    asks = [];
  }
  /** (0.6.154) « Annuler » (`back`) or « Rétablir »: the bobine as it was before the last change, or after it again. */
  function travel(back) {
    const from = back ? past : future,
      to = back ? future : past;
    if (!from.length) return false;
    const why = refusal();
    if (why) return void notice(why), false;
    to.push(montage);
    step = null;
    laid = null;
    settle(from.pop());
    return true;
  }
  /** A change shown at once, kept a moment later. */
  function settle(next, { select, sliding = false, still = false } = {}) {
    // Another shape of film: the preview takes it. Anything else leaves the preview and the takes as they are.
    const reshaped = next.format !== montage.format || next.width !== montage.width || next.height !== montage.height,
      // (0.6.154) Another name (« Annuler » after « Renommer »): the fil says it.
      renamed = next.name !== montage.name;
    montage = next;
    if (select !== undefined) chosen = select;
    if (chosen && !itemOf(chosen)) chosen = null;
    head = Math.min(head, total());
    pending = true;
    if (saving) timers.clear(saving);
    saving = timers.set(() => void keep(), saveDelay);
    status = '';
    if (renamed && !reshaped) fil();
    if (reshaped) draw();
    else if (still) sayGo();
    else update({ panel: !sliding });
  }
  function lay(record, where = {}) {
    const id = newId(),
      next = withTake(montage, record, { id, ...where });
    if (next === montage) return notice('Cette bobine est pleine.');
    change(next, { select: id });
  }
  async function exportFilm() {
    if (exporting || !montage.plans.length || todoPlans(montage).length || busy()) return;
    exporting = true;
    stop();
    fil();
    try {
      pending = pending || !stored;
      await keep();
      if (status.startsWith('Non gardée')) throw new Error(status);
      const conversation = await ensureConversation();
      const film = await (await api('montages/export', { project: project(), id: montage.id, conversation })).json();
      const take = film.outputs?.[0]?.take;
      status = Number.isInteger(take) ? `Film exporté · Prise ${take}` : 'Film exporté';
      fades();
      await refresh();
    } catch (error) {
      status = 'Export impossible : ' + error.message.replace(/^Non gardée : /, '');
    }
    exporting = false;
    draw();
  }
  /**
   * (0.6.154) « Un fichier par prise »: the takes already made, cut as the bobine shows them, numbered in
   * its order, in a folder of their own under BOBINES (« BOBINES / LE RENARD EN HIVER / 01 À 05 »), beside
   * VIDEO; without the audio tracks. They are not takes of the project.
   */
  async function exportTakes() {
    if (exporting || busy() || !montage.plans.some(plan => !isTodo(plan))) return;
    exporting = true;
    stop();
    fil();
    try {
      pending = pending || !stored;
      await keep();
      if (status.startsWith('Non gardée')) throw new Error(status);
      const done = await (await api('montages/export-takes', { project: project(), id: montage.id })).json();
      status = `${plural(done.files.length, 'prise exportée', 'prises exportées')} · ${done.folder.replace('/', ' / ')}`;
      fades();
    } catch (error) {
      status = 'Export impossible : ' + error.message.replace(/^Non gardée : /, '');
    }
    exporting = false;
    draw();
  }
  async function remove() {
    // (0.6.144) Not under a take being created: it would have no bobine to go to.
    if (writing) return void notice('Moodix AI écrit les prises : attendez la fin, ou arrêtez l’écriture.');
    if (making || inSeries()) return void notice('Une prise est en cours de création : attendez sa fin, ou arrêtez-la.');
    asking = null;
    stop();
    try {
      if (stored) await api('montages/remove', { project: project(), id: montage.id });
      notice('Bobine mise de côté.');
    } catch (error) {
      status = 'Suppression impossible : ' + error.message;
      return draw();
    }
    await read();
  }
  async function choose(wanted) {
    await keep();
    stop();
    asking = null;
    if (wanted === 'new') {
      montage = fresh();
      archivedKey = null;
      forget();
      unkept();
      stored = false;
      chosen = null;
      head = 0;
      status = '';
      failed.clear();
    } else
      try {
        await open(wanted);
      } catch (error) {
        status = 'Bobine illisible : ' + error.message;
      }
    draw();
  }

  // Reading the film in the preview --------------------------------------------------------------
  function stop() {
    if (playing) playing.frame ? page.cancelAnimationFrame?.(playing.frame) : timers.clear(playing.timer);
    playing = null;
    for (const player of media?.players ?? []) player.pause?.();
    for (const sound of media?.sounds.values() ?? []) sound.pause?.();
  }
  /**
   * (0.6.169) The player of the preview that holds the clip at `url`: two take turns, the one shown and
   * the one that loads the next clip of the bobine meanwhile (`ahead`). Changed under the eyes, the
   * address of a single player showed black between two takes, the time the next clip was loaded.
   */
  function playerOf(url) {
    const { video, spare } = media;
    if (video.dataset.url === url || spare.dataset.url !== url) return video;
    // The next clip is ready in the other one: it is shown, the one before waits for the clip after.
    video.pause?.();
    video.hidden = true;
    media.video = spare;
    media.spare = video;
    return spare;
  }
  /** (0.6.169) The clip after the take shown, loaded in the player not shown, at the instant it starts. */
  function ahead(index) {
    const next = montage.plans[index + 1],
      url = next && !isTodo(next) && next.kind === 'video' ? outputOf(next.source)?.originalUrl : null;
    if (next && !isTodo(next) && next.kind === 'image') {
      // (A picture after it: asked to the browser now, there when its turn comes.)
      const picture = outputOf(next.source)?.originalUrl;
      if (picture && media.warm.dataset.url !== picture) Object.assign(media.warm, { src: picture }).dataset.url = picture;
    }
    if (!url || url === media.video.dataset.url) return;
    const { spare } = media;
    if (spare.dataset.url !== url) {
      Object.assign(spare, { src: url, preload: 'auto' }).dataset.url = url;
      spare.currentTime = next.from;
    } else if (spare.paused !== false && Math.abs((spare.currentTime ?? 0) - next.from) > 0.05) spare.currentTime = next.from;
    spare.muted = true;
    spare.pause?.();
    spare.hidden = true;
  }
  /**
   * (0.6.169) A take being made, in the preview: the Flux of the Studio (take-flux.mjs), from the picture
   * it starts on, then from what the engine shows of it; its end photo stays at the bottom right.
   */
  function fluxOf(frame, from) {
    if (!making || !frame) {
      media?.flux?.stop();
      if (media) media.flux = media.fluxFrom = null;
      return;
    }
    if (!media.flux) {
      media.flux = takeFlux(frame, { node, win: page });
      media.fluxFrom = null;
      if (!from) media.flux.neutral();
    }
    if (from && from !== media.fluxFrom) {
      media.fluxFrom = from;
      media.flux.source(from);
    }
    if (Number.isFinite(making.fraction)) media.flux.progress(making.fraction);
  }
  /**
   * Puts in the preview what the film shows at `head`, the clip and the sounds at their place. `tick`: a
   * moment of the film being read, sixty a second: only the time is said again, nothing else changed.
   */
  function show({ sync = true, tick = false } = {}) {
    if (!media) return;
    const { picture, blank, frame } = media,
      at = montage.plans.length ? planAt(montage, Math.min(head, Math.max(0, total() - 0.001))) : null,
      // (0.6.149) A hole of the bobine: black, as in the film; the empty bobine shows its Éclipse.
      hole = Boolean(montage.plans.length) && !at,
      todo = Boolean(at) && isTodo(at.plan),
      link = todo ? linkOf(montage, at.plan.id, lengthOf) : null,
      before = todo ? montage.plans[at.index - 1] : null,
      busy = todo && making?.id === at.plan.id,
      // (0.6.148, capture 83) A take to create shows where it starts from, veiled: its start photo, or
      // the last picture of the video it continues; being made, what the engine shows of it, blurred.
      seen = !at
        ? null
        : !todo
          ? at.plan
          : busy && making.preview
            ? { kind: 'image', url: making.preview }
            : at.plan.photos?.start
              ? { source: at.plan.photos.start, kind: 'image' }
              : (link.kind === 'suite' || link.kind === 'last') && before?.source
                ? { source: before.source, kind: 'video', last: true }
                : null,
      url = seen ? (seen.url ?? outputOf(seen.source)?.originalUrl) : null;
    // (0.6.169) Said again only when it changes: sixty times a second while the film is read.
    const put = (where, key, value) => {
      if (where[key] !== value) where[key] = value;
    };
    put(frame.dataset, 'todo', String(todo));
    put(frame.dataset, 'busy', String(busy));
    put(frame.dataset, 'hole', String(hole));
    blank.hidden = Boolean(url) || hole;
    const said = !at
      ? ''
      : busy
        ? 'En cours' + (Number.isFinite(making.fraction) ? ` · ${Math.round(making.fraction * 100)} %` : '')
        : todo
          ? 'À créer' + (link.kind === 'suite' || link.kind === 'last' ? ' · suite de la ' + (takeLabel(before?.source) || 'prise à créer').toLowerCase() : '')
          : takeLabel(at.plan.source) || 'Prise introuvable';
    if (media.caption.textContent !== said) media.caption.textContent = said;
    // What happens in it, and the photo it arrives on. (0.6.159, capture 87) Not while it is made: the
    // preview shows what the engine draws, « EN COURS · 46 % », nothing else. Its text, three lines at
    // most, leaves the place of its end photo only when there is one (moodix.css). (0.6.169) Longer, its
    // last line fades out, as the other texts of the page do: cut, a fourth line showed half under it.
    const words = todo && !busy ? at.plan.todo.prompt.trim() : '';
    if (media.text.textContent !== words) {
      media.text.textContent = words;
      media.measured = false;
    }
    media.words.hidden = !words;
    const end = todo && at.plan.photos?.end ? recordOf(at.plan.photos.end) : null;
    media.end.hidden = !end;
    put(frame.dataset, 'end', String(Boolean(end)));
    if (end) {
      put(media.end.style, 'backgroundImage', `url("${pictureOf(end)}")`);
      const label = 'Fin · ' + mono(at.start + (at.plan.to - at.plan.from));
      if (media.end.children[0].textContent !== label) media.end.children[0].textContent = label;
    }
    // (Measured once the place of the end photo is kept, which narrows it; again at each look but those of
    // the film being read, the frame having perhaps changed size.)
    if (words && (!media.measured || !tick) && media.text.clientHeight > 0) {
      put(media.words.dataset, 'more', String(media.text.scrollHeight > media.text.clientHeight + 1));
      media.measured = true;
    }
    if (url && seen.kind === 'image') {
      if (picture.dataset.url !== url) Object.assign(picture, { src: url }).dataset.url = url;
      media.video.pause?.();
    } else if (url) {
      const video = playerOf(url),
        wanted = seen.last ? Math.max(0, before.to - 0.05) : at.plan.from + (head - at.start);
      if (video.dataset.url !== url) Object.assign(video, { src: url }).dataset.url = url;
      const volume = todo ? 0 : (at.plan.volume ?? 1);
      video.volume = Math.min(1, volume);
      video.muted = !(volume > 0);
      // Put back where the film is when it drifted, or when the head was moved by hand.
      if (sync || seen.last || Math.abs((video.currentTime ?? 0) - wanted) > 0.35) video.currentTime = wanted;
      if (playing && !todo) void video.play?.()?.catch?.(() => {});
      else video.pause?.();
    } else media.video.pause?.();
    picture.hidden = !(url && seen.kind === 'image');
    media.video.hidden = !(url && seen.kind === 'video');
    media.spare.hidden = true;
    // (0.6.169) The clip after it waits in the other player; a take being made shows the Flux of the Studio.
    // (0.6.170) In a hole, the clip after the hole: black is the hole, not the time it loads.
    if (at) ahead(at.index);
    else if (hole) {
      const after = planStarts(montage).findIndex(start => start > head);
      if (after >= 0) ahead(after - 1);
    }
    // (Its colours until the engine shows something: its start photo; or else the clip it goes on from, or
    // the photo it arrives on, rather than grey.)
    fluxOf(
      busy ? frame : null,
      busy
        ? making.preview ||
            // (0.6.179) By the rule of every screen (fluxStart): where it starts from, else where it arrives.
            fluxStart([
              { role: 'start_image', preview: seen?.kind === 'image' ? url : seen?.last ? pictureOf(recordOf(before.source)) : null },
              { role: 'end_image', preview: end ? pictureOf(end) : null },
            ])
        : null,
    );
    for (const sound of montage.sounds) {
      const url = outputOf(sound.source)?.originalUrl,
        inside = head >= sound.at && head < sound.at + (sound.to - sound.from);
      let player = media.sounds.get(sound.id);
      if (!url || !inside || !playing) {
        player?.pause?.();
        continue;
      }
      if (!player) media.sounds.set(sound.id, (player = Object.assign(node('audio'), { src: url, preload: 'auto' })));
      const wanted = sound.from + (head - sound.at);
      player.volume = Math.min(1, sound.volume);
      if (player.paused !== false || Math.abs((player.currentTime ?? 0) - wanted) > 0.35) player.currentTime = wanted;
      void player.play?.()?.catch?.(() => {});
    }
    for (const [id, player] of media.sounds) if (!montage.sounds.some(sound => sound.id === id)) player.pause?.();
    if (tick) sayTime();
    else say();
  }
  function play() {
    if (playing) return stop(), show();
    if (!montage.plans.length) return;
    if (head >= total() - 0.05) head = 0;
    // (0.6.169) At each image of the screen when the page has them: the head glides, and a take ends
    // where it ends (twenty times a second, a clip went on 50 ms past its cut).
    const smooth = typeof page?.requestAnimationFrame === 'function',
      next = () => (smooth ? (playing.frame = page.requestAnimationFrame(tick)) : (playing.timer = timers.set(tick, 50)));
    const tick = () => {
      // Another page of the application is shown: the film does not go on playing behind it.
      const view = globalThis.document?.body?.dataset?.view;
      if (view && view !== 'bobine') return stop();
      const moment = now();
      head = Math.min(total(), head + (moment - playing.at) / 1000);
      playing.at = moment;
      if (head >= total()) {
        stop();
        return show();
      }
      next();
      show({ sync: false, tick: true });
    };
    playing = { at: now() };
    next();
    show();
  }
  function seek(seconds) {
    head = Math.min(total(), Math.max(0, seconds));
    show();
  }

  // What is said without drawing everything again: the clock, the head, the state, the button.
  const live = {};
  /** (0.6.169) The time alone: what a moment of the film being read changes. */
  function sayTime() {
    const time = mono(head),
      whole = ' / ' + mono(total()),
      left = percent(head);
    if (live.clock && live.clock.textContent !== time) live.clock.textContent = time;
    if (live.whole && live.whole.textContent !== whole) live.whole.textContent = whole;
    if (live.head && live.head.style.left !== left) live.head.style.left = left;
  }
  function say() {
    sayTime();
    if (live.play) {
      live.play.disabled = !montage.plans.length;
      live.play.setAttribute('aria-label', playing ? 'Mettre en pause' : 'Lire la bobine');
      if (live.play.dataset.playing !== String(Boolean(playing))) live.play.replaceChildren(icon(playing ? 'stop' : 'play'));
      live.play.dataset.playing = String(Boolean(playing));
    }
    if (live.status) {
      live.status.textContent = status;
      live.status.dataset.problem = String(/impossible|Non gardée|Non enregistrée|illisible/.test(status));
    }
    sayFil();
    sayGo();
  }

  // The fil ------------------------------------------------------------------------------------------
  /** « / bobine ⌄ », what it asks (rename, take out), then what is said, Annuler, Rétablir, « Enregistrer », « Exporter ». */
  function fil() {
    if (!filRoot) return;
    // (Its menu goes with the button it opens from.)
    closeExport();
    const parts = [node('span', 'thread-slash bobine-slash', '/')];
    if (asking?.kind === 'rename') {
      const name = node('input', 'bobine-name');
      Object.assign(name, { type: 'text', value: montage.name, maxLength: MONTAGE_LIMITS.name });
      name.setAttribute('aria-label', 'Nom de la bobine');
      const done = keepIt => {
        if (asking?.kind !== 'rename') return;
        asking = null;
        const wanted = name.value.trim();
        if (keepIt && wanted && wanted !== montage.name) change({ ...montage, name: wanted });
        fil();
      };
      name.onkeydown = event => {
        if (event.key === 'Enter') done(true);
        if (event.key === 'Escape') done(false);
      };
      name.onblur = () => done(true);
      parts.push(name);
      timers.set(() => name.focus?.(), 0);
    } else {
      const pick = node('select', 'montage-pick');
      pick.setAttribute('aria-label', 'Bobine ouverte');
      const named = [{ id: montage.id, name: montage.name }, ...list.filter(item => item.id !== montage.id)];
      for (const item of named) pick.append(Object.assign(node('option', '', item.name), { value: item.id, selected: item.id === montage.id }));
      pick.append(
        Object.assign(node('option', '', '+ Nouvelle bobine'), { value: 'new' }),
        Object.assign(node('option', '', 'Renommer la bobine'), { value: 'rename' }),
        ...(stored ? [Object.assign(node('option', '', 'Supprimer la bobine'), { value: 'remove' })] : []),
      );
      pick.disabled = busy() || exporting;
      pick.onchange = () => {
        const wanted = pick.value;
        if (wanted === 'rename' || wanted === 'remove') {
          asking = { kind: wanted };
          return fil();
        }
        if (wanted !== montage.id) void choose(wanted);
      };
      parts.push(pick);
    }
    if (asking?.kind === 'remove')
      parts.push(
        node('span', 'bobine-ask', `Supprimer « ${montage.name} » ?`),
        button('bobine-ask-go', 'Supprimer', () => void remove()),
        button('bobine-ask-no', 'Garder', () => {
          asking = null;
          fil();
        }),
      );
    // (0.6.154) Annuler, Rétablir (the arrow of « Annuler » turned round), « Enregistrer », « Exporter ⌄ ».
    const state = node('span', 'montage-status'),
      undo = button('bobine-step', '', () => travel(true), 'undo', 'Annuler (Ctrl+Z)'),
      redo = button('bobine-step is-again', '', () => travel(false), 'undo', 'Rétablir (Ctrl+Maj+Z)'),
      save = button('bobine-save', archiving ? 'Enregistrement…' : 'Enregistrer', () => void archive(), 'save'),
      go = button('montage-export', exporting ? 'Export…' : 'Exporter', toggleExport, 'download');
    go.append(icon('chevron'));
    go.setAttribute('aria-haspopup', 'menu');
    go.setAttribute('aria-expanded', 'false');
    parts.push(node('span', 'bobine-fil-gap'), state, undo, redo, save, go);
    filRoot.replaceChildren(...parts);
    Object.assign(live, { status: state, export: go, undo, redo, save });
    say();
  }
  /**
   * What the buttons of the fil say of the bobine as it is now: they follow every change without the
   * fil being drawn again (a name being written there would be lost).
   */
  function sayFil() {
    if (!montage) return;
    const { export: go, undo, redo, save } = live;
    if (undo) undo.disabled = !past.length || busy();
    if (redo) redo.disabled = !future.length || busy();
    if (save) {
      const empty = !montage.plans.length && !montage.sounds.length,
        changed = !empty && unsaved();
      save.disabled = archiving || exporting || empty;
      // (Its point: what is in the Archives is not what is open here.)
      save.dataset.unsaved = String(changed);
      save.title = empty
        ? 'Posez au moins une prise pour enregistrer la bobine'
        : changed
          ? 'Enregistrer la bobine dans les Archives : elle a changé depuis'
          : 'Enregistrer la bobine dans les Archives';
    }
    // (0.6.154, capture 91) « Exporter » is greyed only for an empty bobine (and while takes are made):
    // its menu says what cannot be done yet.
    if (go) {
      go.disabled = exporting || !montage.plans.length || busy();
      go.title = montage.plans.length ? 'Exporter la bobine' : 'Posez au moins une prise pour exporter';
    }
  }
  /**
   * (0.6.154, captures 90 et 91) The menu of « Exporter », of dark glass: « Un seul fichier » (the film in
   * VIDEO, a take of the project; greyed while takes are to create, why under the pointer) and « Un fichier
   * par prise » (the takes made, in BOBINES). Échap or a click beside closes it.
   */
  function toggleExport() {
    if (exportMenu) return closeExport({ refocus: true });
    if (!live.export || live.export.disabled) return;
    const menu = node('div', 'glass-menu bobine-export-menu'),
      waiting = todoPlans(montage).length,
      made = montage.plans.filter(plan => !isTodo(plan)).length,
      item = (name, where, why, act) => {
        const choice = node('button', 'glass-menu-item bobine-export-item' + (why ? ' is-off' : ''));
        choice.type = 'button';
        choice.setAttribute('role', 'menuitem');
        choice.append(node('span', 'bobine-export-name', name), node('span', 'bobine-export-where', where));
        if (why) {
          choice.setAttribute('aria-disabled', 'true');
          choice.dataset.tip = why;
          // (0.6.155) At its left: above, it hid « Enregistrer ».
          choice.dataset.tipSide = 'left';
        }
        choice.onclick = () => {
          if (why) return;
          closeExport();
          void act();
        };
        return choice;
      };
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Exporter la bobine');
    const all = [
      item('Un seul fichier', `video / ${montage.name}.mp4`, waiting ? `${plural(waiting, 'prise est encore', 'prises sont encore')} à créer` : '', exportFilm),
      item('Un fichier par prise', `bobines / ${folderName(montage.name)} / ${numbered(made)}`, made ? '' : 'Aucune prise n’est encore créée', exportTakes),
    ];
    menu.append(...all);
    const choices = () => all.filter(choice => choice.getAttribute('aria-disabled') !== 'true');
    menu.onkeydown = event => {
      const list = choices(),
        at = list.indexOf(page?.document?.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeExport({ refocus: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault?.();
        list[(at + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus?.();
      } else if (event.key === 'Tab') closeExport();
    };
    exportMenu = { menu, beside: event => !menu.contains?.(event.target) && !live.export?.contains?.(event.target) && closeExport() };
    filRoot.append(menu);
    openPopup(menu, live.export, { align: 'end' });
    live.export.setAttribute('aria-expanded', 'true');
    page?.addEventListener?.('pointerdown', exportMenu.beside, true);
    choices()[0]?.focus?.();
  }
  function closeExport({ refocus = false } = {}) {
    if (!exportMenu) return;
    const { menu, beside } = exportMenu;
    exportMenu = null;
    page?.removeEventListener?.('pointerdown', beside, true);
    closePopup(menu);
    menu.remove?.();
    live.export?.setAttribute('aria-expanded', 'false');
    if (refocus) live.export?.focus?.();
  }

  // The blocks -------------------------------------------------------------------------------------
  function takes() {
    const { section, body } = block('is-settings', 'montage-takes'),
      all = runs() ?? [],
      shown = all.filter(record => filter === 'all' || (record.mediaType || 'image') === filter),
      headRow = node('div', 'montage-head'),
      filters = node('div', 'montage-filters'),
      grid = node('div', 'montage-grid');
    section.setAttribute('aria-label', 'Prises du projet');
    headRow.append(node('span', 'montage-label', 'Prises'), node('span', 'montage-count', String(all.length)));
    for (const [id, label] of FILTERS) {
      const pill = button('montage-filter', label, () => {
        filter = id;
        draw();
      });
      pill.setAttribute('aria-pressed', String(filter === id));
      filters.append(pill);
    }
    for (const record of shown) {
      const output = record.outputs?.[0] ?? {},
        track = trackOf(record),
        seconds = takeSeconds(record),
        name = Number.isInteger(output.take) ? 'Prise ' + output.take : 'Création',
        tile = button('montage-take', '', null);
      tile.dataset.kind = track;
      tile.dataset.id = record.id;
      tile.title = name + ' : cliquez pour l’ouvrir en grand, double-cliquez pour la poser à la fin, ou glissez-la sur la bobine';
      tile.setAttribute('aria-label', name);
      const picture = pictureOf(record);
      if (picture) tile.append(Object.assign(node('img'), { src: picture, alt: '', loading: 'lazy', draggable: false }));
      else if (track === 'video' && output.originalUrl) {
        // Its first picture, of which a small one is made for the next time (and for the timeline).
        const first = Object.assign(node('video'), { muted: true, preload: 'metadata', playsInline: true, draggable: false });
        first.src = output.originalUrl + '#t=0.1';
        // (0.6.142) Once made it is shown on the timeline too.
        first.onloadeddata = () =>
          void Promise.resolve(thumbnail(api, record, 0, first))
            .then(() => {
              if (pictureOf(record) && montage?.plans.some(plan => plan.source?.runId === record.id)) update({ panel: false });
            })
            .catch(() => {});
        tile.append(first);
      } else tile.append(node('span', track === 'video' ? 'montage-take-blank' : 'montage-wave'));
      // (Capture 70: « PRISE n » at the left, its length, or « IMAGE », at the right, on dark grounds.)
      tile.append(
        node('span', 'montage-take-number', Number.isInteger(output.take) ? 'Prise ' + output.take : ''),
        node('span', 'montage-take-length', track === 'image' ? 'Image' : seconds ? mono(seconds) + ' s' : ''),
      );
      // (0.6.169, his words of 21/11) « Un click simple dans un média à gauche doit l'ouvrir en grand. Le
      // double click doit le mettre dans la timeline. » The click waits the time of a double click: the
      // second one lays it, the take not opened.
      tile.onclick = event => {
        if ((event?.detail ?? 1) > 1) return;
        if (opening) timers.clear(opening);
        opening = timers.set(() => {
          opening = null;
          showTake(record);
        }, DOUBLE_CLICK);
      };
      tile.ondblclick = () => {
        if (opening) timers.clear(opening);
        opening = null;
        lay(record);
      };
      tile.onkeydown = event => {
        if (event.key !== 'Enter') return;
        // (Entrée lays it, as before: not the click a button gets from it, which would open it too.)
        event.preventDefault?.();
        lay(record);
      };
      tile.draggable = true;
      tile.ondragstart = event => {
        if (opening) timers.clear(opening);
        opening = null;
        carried = record;
        event.dataTransfer?.setData?.('text/plain', name);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        // (0.6.169) « Aussi intuitif que dans Studio »: carried small, at the size of a take of the track,
        // tilted, as the Studio carries its takes; the tile stays where it was, dimmed; the tracks it can
        // go on light up (moodix.css), and the timeline shows where it would go (carry).
        dragImage?.(tile, event.dataTransfer, track === 'music' || track === 'effects' ? 'audio' : track, output.take, carriedSize(record));
        tile.classList?.add?.('is-carried');
        if (root) root.dataset.carrying = track === 'music' || track === 'effects' ? 'sound' : track;
        // (0.6.152) A photo carried lights up the places where it can go: the timeline is drawn with them.
        if (track === 'image') update({ panel: false });
      };
      tile.ondragend = () => {
        const was = carried;
        carried = null;
        tile.classList?.remove?.('is-carried');
        if (root) delete root.dataset.carrying;
        uncarry();
        if (was && track === 'image') update({ panel: false });
      };
      grid.append(tile);
    }
    if (!shown.length) grid.append(node('p', 'montage-none', all.length ? 'Aucune prise de ce type.' : 'Aucune prise dans ce projet.'));
    body.append(headRow, filters, grid);
    return section;
  }
  /**
   * (0.6.169) The size a take carried from « Prises » is drawn at under the pointer: that of a take on
   * the track of the takes, at its own format; a sound, a strip of a sound.
   */
  function carriedSize(record) {
    const lane = live.lane?.getBoundingClientRect?.(),
      tall = Math.round(Math.min(64, Math.max(36, (lane?.height || 56) - 8))),
      track = trackOf(record);
    if (track === 'music' || track === 'effects') return { width: Math.round(tall * 2.2), height: Math.round(tall * 0.6) };
    const { width, height } = record.outputs?.[0] ?? {},
      ratio = width > 0 && height > 0 ? width / height : 16 / 9;
    return { width: Math.round(tall * Math.min(2, Math.max(0.6, ratio))), height: tall };
  }

  function screen() {
    const { section, body } = block('is-preview', 'montage-screen'),
      stage = node('div', 'montage-stage'),
      frame = node('div', 'montage-frame'),
      blank = node('div', 'montage-blank'),
      video = node('video'),
      // (0.6.169) The player that loads the next clip while the one shown is read; the picture after it.
      spare = node('video'),
      warm = node('img'),
      picture = node('img'),
      caption = node('span', 'montage-caption'),
      words = node('p', 'montage-frame-words'),
      text = node('span', 'montage-frame-text'),
      end = node('span', 'montage-frame-end'),
      transport = node('div', 'montage-transport'),
      playButton = button('montage-play', '', play, 'play'),
      time = node('span', 'montage-clock'),
      whole = node('span', 'montage-clock-total', ' / ' + mono(total())),
      format = node('select', 'montage-format');
    section.setAttribute('aria-label', 'Aperçu de la bobine');
    // The frame has the shape of the film, as large as its block lets it be (moodix.css).
    frame.style.aspectRatio = `${montage.width} / ${montage.height}`;
    frame.style.setProperty?.('--ratio', String(montage.width / montage.height));
    // (0.6.159) An upright film: the text of a take to create goes above its end photo, not beside it.
    frame.dataset.tall = String(montage.height > montage.width);
    // (An empty bobine: its frame and the Éclipse, no words; capture 71.)
    blank.append(icon('eclipse'));
    for (const player of [video, spare]) Object.assign(player, { playsInline: true, preload: 'auto', hidden: true });
    Object.assign(picture, { alt: '', hidden: true });
    Object.assign(warm, { alt: '', hidden: true });
    end.append(node('span', 'montage-frame-end-label', ''));
    end.hidden = true;
    words.hidden = true;
    words.append(text);
    // (The player of the next clip after what is said over the frame: the page puts it under, moodix.css.)
    frame.append(blank, picture, video, caption, words, end, spare);
    // (0.6.148, capture 82) The format of the bobine, under the preview at the right of the time: it
    // decides the size of all that will be created; the takes laid follow their own frame setting.
    format.setAttribute('aria-label', 'Format de la bobine');
    for (const item of FORMATS) {
      const size = item.id === montage.format ? { width: montage.width, height: montage.height } : usualSize(item.id);
      const option = Object.assign(node('option', '', item.label), { value: item.id, selected: item.id === montage.format });
      // (What the list shows of the one chosen: « 16:9  1344 × 768 », glass-menu.mjs.)
      if (size) option.dataset.face = `${item.id}  ${size.width} × ${size.height}`;
      format.append(option);
    }
    format.disabled = busy();
    format.onchange = () => change({ ...montage, format: format.value, ...usualSize(format.value) });
    // (0.6.162) Between the time and the format, where nothing was: what is asked to Moodix AI.
    transport.append(playButton, time, whole, arrange ? askBox() : node('span', 'bobine-fil-gap'), format);
    stage.append(frame);
    body.append(stage, transport);
    stop();
    media?.flux?.stop();
    media = { video, spare, players: [video, spare], warm, picture, blank, caption, words, text, end, frame, sounds: new Map(), flux: null, fluxFrom: null, measured: false };
    // (0.6.162) Drawn again while a line of Moodix AI is said under it: its text stays above that line.
    frame.dataset.asked = askedState();
    Object.assign(live, { clock: time, whole, play: playButton });
    return section;
  }

  // « À créer » -------------------------------------------------------------------------------------
  /** (0.6.144) The arguments a take to create is asked with (creationOf): thrown, in the user's words, when a take it needs is gone. */
  function argsOf(wanted) {
    const named = (item, what) => {
      const record = recordOf(item.source);
      if (!record) throw new Error(`${what} n’est plus dans le projet.`);
      return { ...inputOf(record), ...(item.frame ? { frame: item.frame } : {}) };
    };
    const args = { prompt: wanted.prompt, intention: 'Prise d’une bobine, demandée dans la Bobine.', duration: wanted.duration },
      model = modelFor(wanted.verb);
    if (model) args.workflow = model;
    if (wanted.format) args.format = wanted.format;
    if (wanted.start) args.start_image = named(wanted.start, wanted.start.frame ? 'La vidéo d’avant' : 'La photo de début');
    if (wanted.end) args.end_image = named(wanted.end, 'La photo de fin');
    if (wanted.continues) args.source = named({ source: wanted.continues }, 'La vidéo continuée');
    return args;
  }
  /** (0.6.144) The size a take is made at: the one of its film (a continuation keeps the size of its video, the server sees to it). */
  const filmSize = () => ({ width: montage.width, height: montage.height });
  /**
   * (0.6.148) The model a take to create would be made with: asked to the server once for each kind of
   * take (its verb and its inputs, never its text), kept, and said in its line. Null while it is asked.
   */
  function modelOf(id) {
    const plan = itemOf(id);
    if (!plan || !estimate) return null;
    const probe = plan.todo.prompt.trim() ? montage : withItemChanged(montage, id, { prompt: 'Prise.' }),
      wanted = creationOf(probe, id, lengthOf, { limits: limits() });
    if (wanted.reason) return null;
    let args;
    try {
      args = argsOf(wanted);
    } catch {
      return null;
    }
    const { prompt: _prompt, intention: _intention, duration: _duration, ...inputs } = args,
      key = JSON.stringify([wanted.verb, inputs, filmSize()]),
      known = models.get(key);
    if (known) return known === 'asking' ? null : known;
    models.set(key, 'asking');
    void Promise.resolve(estimate({ verb: wanted.verb, args: { ...args, prompt: 'Prise.' }, size: filmSize() }))
      .then(seen => {
        // (0.6.153) A model this computer lacks: what its download is (files, size), from the server.
        models.set(key, { name: seen?.workflowName ?? '', missing: Boolean(seen?.missing), offer: seen?.missing && typeof seen.missing === 'object' ? seen.missing : null });
        if (parts?.create && !inPanel()) update();
        else sayModels();
      })
      // (Not known now, the chat model answering say: asked again the next time.)
      .catch(() => models.delete(key));
    return null;
  }
  const inPanel = () => Boolean(page?.document?.activeElement && parts?.create?.contains?.(page.document.activeElement));
  function sayModels() {
    for (const [id, span] of live.models ?? []) {
      const model = itemOf(id) ? modelOf(id) : null;
      if (model && !span.dataset.state) span.textContent = model.name;
    }
  }
  /** What a line of « À créer » says of what it is: « Suite de la prise 24 · photo de fin », « Nouvelle prise ». */
  function whatOf(plan) {
    const link = linkOf(montage, plan.id, lengthOf),
      before = montage.plans[montage.plans.indexOf(plan) - 1],
      // (0.6.149) Only a suite goes on from the take before it (after a take to create, once that one is
      // made: « Suite de la prise à créer »); one no longer joined to its video says so.
      suite = Boolean(plan.todo.suite) && !plan.photos?.start,
      photos = [plan.photos?.start && !suite ? 'photo de début' : '', plan.photos?.end ? 'photo de fin' : ''].filter(Boolean);
    const first = !suite
      ? 'Nouvelle prise'
      : link.kind === 'loose'
        ? 'Suite détachée de sa vidéo'
        : 'Suite de la ' + (takeLabel(before?.source) || 'prise à créer').toLowerCase();
    return [first, photos.length === 2 ? 'photos de début et de fin' : photos[0]].filter(Boolean).join(' · ');
  }
  const stateOf = id =>
    beingMade(id)
      ? 'En cours' + (Number.isFinite(beingMade(id).fraction) ? ` · ${Math.round(beingMade(id).fraction * 100)} %` : '')
      : writing?.id === id
        ? 'Moodix AI écrit'
        : inSeries() && filling.ids.slice(filling.done).includes(id)
          ? 'En attente'
          : failed.has(id)
            ? 'Échec'
            : '';
  /**
   * (0.6.148) « À créer », always there (capture 70): one line by take to create, in the order of the
   * bobine, its instants, what it is, its model, and its text, written in place. Then the button.
   */
  function createPanel() {
    const { section, body } = block('is-settings', 'bobine-create'),
      lines = node('div', 'bobine-lines'),
      starts = planStarts(montage),
      series = seriesOf(montage, lengthOf, { limits: limits(), writable }),
      ready = creatable(),
      can = new Set(ready.map(item => item.id));
    section.setAttribute('aria-label', 'À créer');
    live.models = new Map();
    live.states = new Map();
    live.lines = new Map();
    live.wand = live.agent = null;
    // (0.6.153, capture 89) The model a take needs and this computer lacks: said once, above the button.
    let absent = null;
    for (const item of series) {
      const plan = itemOf(item.id),
        index = montage.plans.indexOf(plan),
        line = node('div', 'bobine-line'),
        top = node('div', 'bobine-line-top'),
        state = stateOf(item.id),
        model = modelOf(item.id),
        // (Capture 86: while Moodix AI writes it, its model stays at the right, its field says it.)
        written = writing?.id === item.id,
        right = node('span', 'bobine-line-right', (written ? '' : state) || model?.name || ''),
        field = node('textarea', 'bobine-line-words'),
        reason =
          failed.get(item.id) ||
          (item.reason && (item.prompt || item.blocked)
            ? item.reason
            : item.ready && !can.has(item.id) && !model?.missing
              ? 'Elle continue la prise d’avant, qui ne peut pas être créée.'
              : '');
      if (model?.missing) absent ??= model;
      line.dataset.id = item.id;
      line.dataset.state = failed.has(item.id) && !state.startsWith('En') ? 'failed' : beingMade(item.id) ? 'making' : enrichingId === item.id ? 'enriching' : '';
      if (model?.missing) right.dataset.missing = 'true';
      if (state && !written) right.dataset.state = 'true';
      line.setAttribute('aria-pressed', String(chosen === item.id));
      // (0.6.153, captures 84 et 85) What has a text can be enriched; just enriched, it lights up a moment.
      line.dataset.enrichable = String(Boolean(enrich) && Boolean(item.prompt));
      if (lit === item.id) line.dataset.lit = 'true';
      top.append(node('span', 'bobine-line-when', `${mono(starts[index])} → ${mono(starts[index] + plan.to - plan.from)}`), right);
      Object.assign(field, { value: plan.todo.prompt, rows: 2, maxLength: 4000, disabled: busy() || enrichingId === item.id });
      field.dataset.id = item.id;
      field.setAttribute('aria-label', `Ce qui se passe, de ${mono(starts[index])} à ${mono(starts[index] + plan.to - plan.from)}`);
      field.oninput = () => change(withItemChanged(montage, item.id, { prompt: field.value }), { sliding: true, group: 'text:' + item.id });
      // (With the wand, the field is not written in: the click enriches it.)
      field.onpointerdown = event => {
        if (wand) event.preventDefault?.();
      };
      // A line chosen chooses its take, and brings the head and the timeline to it (capture 78); with
      // the wand, a click enriches it.
      line.onclick = event => {
        if (wand) return void enrichOne(item.id);
        if (event.target === field) return;
        chosen = item.id;
        head = starts[index];
        update();
        reveal(item.id);
      };
      line.onpointerenter = () => linked(item.id, true);
      line.onpointerleave = () => linked(item.id, false);
      if (hovered === item.id) line.dataset.linked = 'true';
      // (0.6.152, capture 74) Made in parts: how many, of how long each, at the right of what it is.
      const middle = node('div', 'bobine-line-middle'),
        box = node('div', 'bobine-line-field');
      middle.append(node('span', 'bobine-line-what', whatOf(plan)));
      if (item.parts > 1) middle.append(node('span', 'bobine-line-parts', `${item.parts} × ${mono(item.part)} s`));
      box.append(field);
      if (written) box.append(node('span', 'bobine-line-writing', 'Moodix AI écrit'));
      if (enrichingId === item.id) box.append(node('span', 'bobine-line-writing', 'Moodix AI enrichit'));
      line.append(top, middle, box);
      if (reason) line.append(node('p', 'bobine-line-reason', reason));
      live.models.set(item.id, right);
      live.states.set(item.id, right);
      live.lines.set(item.id, line);
      lines.append(line);
    }
    const row = node('div', 'bobine-foot');
    // (Capture 86: « Arrêter » at the left of the button while Moodix AI writes; in a series, its own stop.)
    if (writing && !writing.series) row.append(button('bobine-halt', 'Arrêter', () => writing?.controller.abort()));
    const foot = node('div', 'bobine-go');
    // What is said above the button, in amber: the model this computer lacks, or why it cannot be downloaded.
    let said = absent ? `${absent.name} n’est pas sur cet ordinateur.` : '',
      licences = null;
    live.download = null;
    if (downloading || (absent?.offer && !ready.length && !inSeries())) {
      // (Capture 89: nothing can be created without it: « Télécharger · 20,0 Go » takes the place of « Créer ».)
      const { name, offer } = downloading ?? absent,
        fetch = button('bobine-go-main bobine-go-download', '', () => void download({ name, offer }, { accepted: downloading?.stage === 'confirm' })),
        label = node('span', 'bobine-go-label', ''),
        fill = node('span', 'bobine-go-fill'),
        size = sizeText(offer.left || offer.bytes);
      fetch.append(fill, icon('download'), label);
      fetch.dataset.state = downloading?.stage ?? '';
      if (downloading?.stage === 'running') {
        // Its line, its figures, « Arrêter » at its left.
        row.append(button('bobine-halt', 'Arrêter', () => void api('downloads/cancel', {}).catch(error => notice(error.message))));
        fetch.disabled = true;
        live.download = { fill, label };
      } else if (downloading?.stage === 'confirm') {
        // A licence with conditions: read here, accepted or refused, before anything is downloaded.
        row.append(button('bobine-halt', 'Refuser', () => ((downloading = null), update())));
        label.textContent = 'J’ai lu, télécharger · ' + size;
        licences = licenseBlock({ node, files: offer.files, confirm: true });
        said = '';
      } else {
        label.textContent = 'Télécharger · ' + size;
        // Its licences under the pointer.
        fetch.title = licenseSentence(offer.files) || `Télécharger ${name} (${size})`;
        if (offer.needsToken) {
          fetch.disabled = true;
          said = `${name} demande un compte Hugging Face : acceptez sa licence${offer.page ? ' sur ' + offer.page : ''}, puis enregistrez votre jeton dans Paramètres › Mise à jour.`;
        }
        watch({ name, offer });
      }
      if (fetchError) said = fetchError;
      foot.append(fetch);
      Object.assign(live, { goMain: null, goLabel: null, goFill: null, pause: null });
    } else {
      // The button: « ▶ Créer 2 prises » | the wand (Enrichir) | the Éclipse (Moodix AI); being made, it fills.
      const main = button('bobine-go-main', '', () => (heldOutside() ? undefined : filling?.stage === 'paused' ? void run(filling) : void createAll())),
        label = node('span', 'bobine-go-label', ''),
        fill = node('span', 'bobine-go-fill');
      // (The fill under the rest: it grows from the left as the takes are made.)
      main.append(fill, icon('play'), label);
      foot.append(main);
      if (inSeries()) {
        const pause = button('bobine-go-part', '', () => {
            if (filling.stage !== 'running') return;
            filling.pausing = true;
            sayGo();
          }, 'pause', 'Mettre en pause après cette prise'),
          stopAll = button('bobine-go-part', '', () => stopSeries(), 'stop', 'Arrêter');
        pause.hidden = filling.stage !== 'running';
        foot.append(pause, stopAll);
        live.pause = pause;
      } else live.pause = null;
      // (Capture 87: while takes are created, the pause and the stop take the place of the wand and the Éclipse.)
      if (enrich && !inSeries()) {
        const magic = button('bobine-go-part bobine-go-wand', '', () => toggleWand(), 'wand', 'Enrichir : Moodix AI détaille le texte d’une prise (cadre, lumière, mouvement) ; Échap pour finir');
        magic.setAttribute('aria-pressed', String(wand));
        foot.append(magic);
        live.wand = magic;
      }
      if (write && !inSeries()) {
        const agent = button('bobine-go-part bobine-go-agent' + (writing ? ' is-thinking' : ''), '', () => void askAgent(), 'eclipse', 'Moodix AI écrit ce qui se passe dans les prises sans texte');
        foot.append(agent);
        live.agent = agent;
      }
      Object.assign(live, { goMain: main, goLabel: label, goFill: fill });
    }
    row.append(foot);
    // (0.6.155) The list that scrolls fades at its bottom, never under what is said above the button.
    lines.onscroll = () => fade(lines);
    // (0.6.175) Why « Créer » is greyed by a work going on outside the Bobine, in the same place (sayGo).
    live.waiting = node('p', 'bobine-waits', '');
    live.waiting.hidden = true;
    body.append(
      node('h2', 'bobine-create-title', 'À créer'),
      lines,
      ...(said ? [node('p', 'bobine-missing', said)] : []),
      live.waiting,
      ...(licences ? [licences] : []),
      row,
    );
    live.list = lines;
    sayGo();
    sayDownload();
    return section;
  }
  /** (0.6.155) Whether there is more of « À créer » under its bottom: it fades there (moodix.css). */
  function fade(lines = live.list) {
    if (!lines || !(lines.clientHeight > 0)) return;
    lines.dataset.more = String(lines.scrollTop + lines.clientHeight < lines.scrollHeight - 2);
  }
  /** What the button says: how many takes « Créer » makes, or where the creation is. */
  function sayGo() {
    if (!montage) return;
    // (0.6.175) A work going on outside the Bobine: said above the button, which waits for its end.
    const held = outside();
    if (live.waiting) {
      live.waiting.textContent = held;
      live.waiting.hidden = !held;
    }
    if (!live.goMain) return;
    const ready = creatable().reduce((sum, item) => sum + item.parts, 0),
      running = inSeries(),
      count = running ? filling.ids.length : ready;
    live.goMain.disabled =
      writing || enrichingId || held ? true : running ? filling.stage === 'running' : !create || !ready || Boolean(making);
    live.goMain.dataset.state = running ? filling.stage : '';
    live.goLabel.textContent = running
      ? filling.stage === 'paused'
        ? `Reprendre · ${filling.done} sur ${count}`
        : `${Math.min(filling.done + 1, count)} sur ${count}` + (Number.isFinite(making?.fraction) ? ` · ${Math.round(making.fraction * 100)} %` : '') + (filling.pausing ? ' · pause demandée' : '')
      : ready
        ? `Créer ${plural(ready, 'prise')}`
        : 'Créer';
    // (Being made, the button fills from the left as the take is made.)
    live.goFill.style.width = running && filling.stage === 'running' ? Math.round((((filling.done + (making?.fraction ?? 0)) / Math.max(1, count)) * 100)) + '%' : '0%';
    if (live.pause) {
      live.pause.hidden = !running || filling.stage !== 'running';
      live.pause.disabled = Boolean(filling?.pausing);
    }
    // (0.6.153) The wand and the Éclipse follow the texts as they are written, the panel not drawn again.
    const texts = seriesOf(montage, lengthOf).map(item => Boolean(item.prompt));
    if (live.wand) live.wand.disabled = !wand && (busy() || Boolean(enrichingId) || Boolean(held) || !texts.some(Boolean));
    if (live.agent) live.agent.disabled = busy() || wand || Boolean(held) || !texts.some(has => !has);
  }
  const modelMissing = id => Boolean(modelOf(id)?.missing);
  /**
   * The takes « Créer » makes, in the order of the bobine: those ready whose model is on this computer,
   * and those that go on from one of them (a take whose model is missing leaves its suite aside too).
   */
  function creatable() {
    const ready = [];
    for (const item of seriesOf(montage, lengthOf, { limits: limits(), writable }))
      if (item.ready && !modelMissing(item.id) && (!item.after || ready.some(other => other.id === item.after))) ready.push({ id: item.id, parts: item.parts });
    return ready;
  }

  // Creating ----------------------------------------------------------------------------------------
  /**
   * (0.6.142) Creates a take to create: what is asked is read on the bobine (creationOf), made by the
   * Studio as one of its takes (`create`), and the take to create becomes the take made. One at a time;
   * the bobine is not changed meanwhile. Its failure is said in its line.
   */
  async function makePlan(id) {
    if (making || writing || !create) return null;
    const wanted = creationOf(montage, id, lengthOf, { limits: limits() });
    if (wanted.reason) {
      failed.set(id, wanted.reason);
      return null;
    }
    let args;
    try {
      args = argsOf(wanted);
    } catch (error) {
      failed.set(id, error.message);
      return null;
    }
    stop();
    await keep();
    failed.delete(id);
    making = { id, label: 'Préparation…', fraction: null, preview: null };
    chosen = id;
    head = planStarts(montage)[montage.plans.findIndex(plan => plan.id === id)] ?? head;
    status = '';
    draw();
    let record = null,
      problem = '',
      // (0.6.175) Refused by a work begun outside the Bobine meanwhile: its reason, no failure of the take.
      refused = null,
      // (0.6.176) Stopped from outside the Bobine (« Arrêter » of the Studio, « Interrompre la réponse » of
      // the Chat): a stop as its own is, nothing failed. It was noted « Échec · Génération arrêtée. »
      halted = false;
    try {
      record = await create(
        // (0.6.181) `place`: where its take goes here, kept by the server with it (layMissed).
        { verb: wanted.verb, args, size: filmSize(), place: { id: montage.id, plan: id, from: wanted.from } },
        {
          onProgress: (label, fraction, preview) => {
            if (!making) return;
            Object.assign(making, {
              label: label || making.label,
              fraction: Number.isFinite(fraction) ? fraction : making.fraction,
              preview: preview ?? making.preview,
            });
            sayMaking(id);
            show({ sync: false });
          },
        },
      );
      if (!record) problem = 'la création n’a pas pu commencer.';
    } catch (error) {
      if (error?.refused) refused = String(error.message ?? '');
      else if (error?.stopped) halted = true;
      else problem = error.message;
    }
    const stopped = Boolean(filling?.stopping) || halted;
    making = null;
    if (record) {
      // (0.6.152) A take made in parts: its first part made, what is left of it stays to create.
      remember(montage);
      montage = withTodoMade(montage, id, record, { from: wanted.from, limits: limits(), partId: newId() });
      laidHere.add(record.id);
      pending = true;
      // Kept at once: the take exists, the bobine must say so.
      await keep();
    } else if (refused !== null) {
      if (refused) notice(refused);
    } else if (!stopped) failed.set(id, problem.charAt(0).toUpperCase() + problem.slice(1));
    draw();
    return record;
  }
  /** How far the take being made is, where it is said without drawing again: the bar and the words of its take, its line. */
  function sayMaking(id) {
    if (live.bar) live.bar.style.width = Math.round((beingMade(id)?.fraction ?? 0) * 100) + '%';
    if (live.making) live.making.textContent = stateOf(id);
    const line = live.states?.get(id);
    if (line) line.textContent = stateOf(id);
  }
  /** (0.6.148) « Créer n prises »: at once, in the order of the bobine, one after the other. */
  async function createAll() {
    if (busy() || !create) return;
    // (0.6.152) A take made in parts is in the series once by part: « Créer 3 prises ».
    const ids = creatable().flatMap(item => Array.from({ length: item.parts }, () => item.id));
    if (!ids.length) return;
    for (const id of ids) failed.delete(id);
    // (`most`: how long the series may become, its parts counted again as they are made, recount.)
    filling = { stage: 'running', ids, done: 0, pausing: false, stopping: false, most: ids.length * 2 };
    return run(filling);
  }
  /**
   * (0.6.160) A part of a take was just made: the parts left to make are counted again on what is left of
   * it. They were counted once, at « Créer »; but a model makes a part a little shorter or longer than it
   * is asked. Shorter, what is left no longer fits in the parts foreseen: the series ended with a piece
   * of the take still to create. Much longer, a part was asked of a take already whole, refused, and the
   * series stopped before the takes after it.
   */
  function recount(series, id) {
    const left = itemOf(id),
      need = isTodo(left) ? partsOf(left, limits()).count : 0;
    let have = 0;
    while (series.ids[series.done + have] === id) have++;
    // (Never without end: a model that made next to nothing each time would be asked again and again.)
    const count = Math.min(need, have + Math.max(0, series.most - series.ids.length));
    if (count !== have) series.ids.splice(series.done, have, ...Array.from({ length: count }, () => id));
  }
  /** The takes of the series not made yet, each in its turn; a pause waits for the end of the one being made. */
  async function run(series) {
    if (filling !== series || making) return;
    Object.assign(series, { stage: 'running', pausing: false });
    draw();
    while (series.done < series.ids.length) {
      if (filling !== series) return;
      if (series.stopping) break;
      if (series.pausing) {
        Object.assign(series, { stage: 'paused', pausing: false });
        return draw();
      }
      // (0.6.155) Without its text: Moodix AI writes it first, then it is made.
      const id = series.ids[series.done];
      if (isTodo(itemOf(id)) && !itemOf(id).todo.prompt.trim() && !(await writeFor(id, series))) break;
      if (filling !== series) return;
      if (series.stopping) break;
      const record = await makePlan(id);
      if (filling !== series) return;
      // (Refused or stopped: the series ends there, what is made stays.)
      if (!record) break;
      series.done++;
      recount(series, id);
    }
    if (filling === series) filling = null;
    draw();
  }
  function stopSeries() {
    if (!filling) return;
    // (0.6.155) Moodix AI writing a take of the series: let go, at once.
    filling.controller?.abort();
    if (writing?.series) writing = null;
    if (filling.stage === 'paused' || !making) {
      filling = null;
      return draw();
    }
    filling.stopping = true;
    halt();
  }

  /**
   * (0.6.155) A take of the series without its text: Moodix AI writes it from its pictures, as the Éclipse
   * does, « MOODIX AI ÉCRIT » in its line; then it is made. What it could not write is said in its line,
   * and the series ends there. Whether it was written.
   */
  async function writeFor(id, series) {
    const plan = itemOf(id),
      asked = plan ? picturesFor(plan) : null;
    if (!write || !asked) {
      failed.set(id, 'Moodix AI n’a rien à regarder : posez une photo de début ou de fin, ou écrivez ce qui se passe.');
      return false;
    }
    const controller = (series.controller = new AbortController());
    writing = { id, at: 1, of: 1, controller, series: true };
    chosen = id;
    draw();
    try {
      const written = String((await write(asked, { signal: controller.signal }))?.prompt ?? '').trim();
      if (controller.signal.aborted || filling !== series) return false;
      if (!written) throw new Error('Moodix AI n’a rien écrit.');
      writing = null;
      remember(montage);
      montage = withItemChanged(montage, id, { prompt: written });
      pending = true;
      await keep();
      return true;
    } catch (error) {
      if (!controller.signal.aborted) failed.set(id, 'Texte non écrit : ' + error.message);
      return false;
    } finally {
      if (writing?.controller === controller) writing = null;
      if (series.controller === controller) series.controller = null;
    }
  }

  // Enrichir (0.6.153) -------------------------------------------------------------------------------
  /** The wand taken or put down (« jusqu'à Échap ou un nouveau clic sur la baguette »). */
  function toggleWand(on = !wand) {
    if (on && (busy() || !enrich || heldOutside())) return;
    wand = on;
    if (root) root.dataset.wand = String(wand);
    update();
  }
  /**
   * The keys heard by the page itself, wherever the focus is (a click with the wand takes none): Échap
   * puts the wand down; (0.6.154) Ctrl+Z « Annuler », Ctrl+Maj+Z and Ctrl+Y « Rétablir », but in a field
   * being typed in (its own text comes back there).
   */
  function pageKeys(event) {
    if (!root) return;
    // (0.6.160) A window open over the page (Paramètres, a confirmation) has the keys: Ctrl+Z pressed in
    // it undid a gesture of the bobine behind it, unseen.
    if (page?.document?.querySelector?.('dialog[open]')) return;
    if (wand && event.key === 'Escape') return toggleWand(false);
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const { tagName, isContentEditable } = event.target ?? {};
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || isContentEditable) return;
    const view = globalThis.document?.body?.dataset?.view;
    if (view && view !== 'bobine') return;
    const key = String(event.key).toLowerCase(),
      back = key === 'z' && !event.shiftKey;
    if (!back && !(key === 'z' && event.shiftKey) && key !== 'y') return;
    event.preventDefault?.();
    travel(back);
  }
  /**
   * A take to create enriched by Moodix AI: its text detailed, nothing changed of what happens in it.
   * An empty text is not enriched. Written meanwhile by the user, theirs stays. « Annuler » (Ctrl+Z)
   * gives back the text of before.
   */
  async function enrichOne(id) {
    if (!enrich || enrichingId || busy() || heldOutside()) return;
    const plan = itemOf(id);
    if (!isTodo(plan)) return;
    const before = plan.todo.prompt,
      asked = before.trim();
    if (!asked) return void notice('Un texte vide ne s’enrichit pas : écrivez d’abord ce qui se passe.');
    enrichingId = id;
    update();
    let written = '';
    // (Let go with the page: its answer, late, writes nothing.)
    const controller = (enriched = new AbortController());
    try {
      written = String((await enrich({ prompt: asked, verb: plan.todo.suite ? 'extend_video' : 'create_video' }, { signal: controller.signal }))?.prompt ?? '').trim();
      if (controller.signal.aborted) return;
      if (!written) throw new Error('Moodix AI n’a rien écrit.');
    } catch (error) {
      if (controller.signal.aborted) return;
      enrichingId = null;
      notice('Texte non enrichi : ' + error.message);
      return update();
    }
    enrichingId = null;
    const now = itemOf(id);
    if (!isTodo(now) || now.todo.prompt !== before) return update();
    change(withItemChanged(montage, id, { prompt: written }));
    lit = id;
    update();
    timers.set(() => {
      if (lit !== id) return;
      lit = null;
      update({ panel: !inPanel() });
    }, 1200);
  }

  // The list and the track (0.6.153, capture 78) -------------------------------------------------------
  /** The line of a take to create and the take on the track, with its photos: lit together under the pointer. */
  function linked(id, on) {
    hovered = on ? id : hovered === id ? null : hovered;
    for (const element of [live.lines?.get(id), ...(live.pieces?.get(id) ?? [])]) if (element?.dataset) element.dataset.linked = String(on);
  }
  /** The take chosen from its line, brought into the timeline when it is zoomed; its line brought into the list. */
  function reveal(id, { line = false } = {}) {
    const target = line ? live.lines?.get(id) : live.pieces?.get(id)?.[0];
    target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  // A model this computer lacks (0.6.153, capture 89) -------------------------------------------------
  /**
   * (0.6.155) « Télécharger · 20,0 Go », as in Paramètres › Modèles (19/11): the click downloads at once,
   * its licences under the pointer; one with conditions is shown at the click, to accept or to refuse,
   * and nothing is downloaded before (the server asks for it). The button keeps its place meanwhile: its
   * line, « 3,4 / 20,0 Go », « Arrêter » at its left; « À créer » keeps its lines. Once the model is
   * there, the models of the takes are asked again.
   */
  async function download({ name, offer }, { accepted = false } = {}) {
    if (!offer || offer.needsToken || downloading?.stage === 'running') return;
    fetchError = '';
    if (!accepted && restrictedOf(offer.files).length) {
      downloading = { name, offer, stage: 'confirm' };
      return update();
    }
    downloading = { name, offer, stage: 'running', received: 0, total: offer.bytes };
    update();
    try {
      const job = await (await api('downloads/start', { id: offer.workflowId, ...(accepted ? { accepted: true } : {}) })).json();
      if (!downloading) return;
      Object.assign(downloading, { received: job.received ?? 0, total: job.total || offer.bytes });
    } catch (error) {
      downloading = null;
      fetchError = 'Téléchargement impossible : ' + error.message;
      return update();
    }
    sayDownload();
    timers.set(followDownload, POLL);
  }
  /** (0.6.155) The download as it goes (GET /api/downloads), until the model is there, stopped or failed. */
  async function followDownload() {
    if (downloading?.stage !== 'running') return;
    const { workflowId } = downloading.offer;
    let job;
    try {
      ({ job } = await (await api('downloads')).json());
    } catch {
      return void timers.set(followDownload, POLL);
    }
    if (downloading?.offer.workflowId !== workflowId) return;
    if (job.state === 'running' && job.workflowId !== workflowId) {
      downloading = null;
      fetchError = `Un autre téléchargement est en cours (${job.name}) : attendez sa fin.`;
      return update();
    }
    if (job.state !== 'running') {
      downloading = null;
      if (job.state === 'error') fetchError = 'Téléchargement impossible : ' + job.error;
      // (There, or stopped: what is left of it, asked again with the models.)
      models.clear();
      return update();
    }
    Object.assign(downloading, { received: job.received ?? 0, total: job.total || downloading.total });
    sayDownload();
    timers.set(followDownload, POLL);
  }
  /** Its line and its figures, the panel not drawn again (a text being written there stays in the hand). */
  function sayDownload() {
    const said = live.download;
    if (!said || downloading?.stage !== 'running') return;
    const { received = 0, total = 0 } = downloading;
    said.fill.style.width = (total ? Math.min(100, Math.round((received / total) * 1000) / 10) : 0) + '%';
    // (« 3,4 / 20,0 Go »: what has come, in the unit of the whole.)
    const giga = total >= 1024 ** 3,
      come = received > 0 ? (giga ? (received / 1024 ** 3).toFixed(1).replace('.', ',') : Math.round(received / 1024 ** 2).toLocaleString('fr-FR')) : '0';
    said.label.textContent = `${come} / ${sizeText(total)}`;
  }
  /** (0.6.155) A download of this model already under way (from Paramètres › Modèles): followed here. */
  function watch(absent) {
    const id = absent?.offer?.workflowId;
    if (!id || downloading || watched.has(id)) return;
    watched.add(id);
    void api('downloads')
      .then(response => response.json())
      .then(({ job }) => {
        if (job?.state !== 'running' || job.workflowId !== id || downloading) return;
        downloading = { name: absent.name, offer: absent.offer, stage: 'running', received: job.received ?? 0, total: job.total || absent.offer.bytes };
        update();
        timers.set(followDownload, POLL);
      })
      .catch(() => {});
  }

  // Moodix AI writes ------------------------------------------------------------------------------
  /**
   * (0.6.146) What Moodix AI is shown of a take to create to write what happens in it: the picture it
   * starts on (its start photo, else the end of the video it goes on from, else the photo the take
   * before it arrives on), the picture it ends on (its end photo), its length, and what happens in the
   * take before it. Null when it has nothing to look at.
   */
  function picturesFor(plan) {
    const before = montage.plans[montage.plans.indexOf(plan) - 1],
      link = linkOf(montage, plan.id, lengthOf),
      named = (source, more = {}) => {
        const record = recordOf(source);
        return record ? { ...inputOf(record), ...more } : null;
      },
      start = plan.photos?.start
        ? named(plan.photos.start)
        : link.kind === 'suite' || link.kind === 'last'
          ? named(before.source, { frame: 'last' })
          : link.kind === 'wait' && before.photos?.end
            ? named(before.photos.end)
            : null,
      end = plan.photos?.end ? named(plan.photos.end) : null,
      previous = String((before ? (isTodo(before) ? before.todo.prompt : recordOf(before.source)?.prompt) : '') ?? '').trim();
    if (!start && !end) return null;
    return {
      // (0.6.159) A suite towards its photo too: it is made as a continuation since 0.6.152 (creationOf),
      // and was still written as a clip of its own, the whole scene said again.
      verb: link.kind === 'suite' || link.kind === 'last' ? 'extend_video' : 'create_video',
      seconds: Math.round((plan.to - plan.from) * 10) / 10,
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      ...(previous ? { previous: previous.slice(0, 1200) } : {}),
    };
  }
  /**
   * (0.6.146) The Éclipse: Moodix AI writes what happens in each take to create that has no text yet,
   * from its pictures, one at a time and in the order of the bobine; what the user wrote is left as it
   * is. Nothing is made: « Créer » does.
   */
  async function askAgent() {
    if (busy() || !write || heldOutside()) return;
    const blank = montage.plans.filter(plan => isTodo(plan) && !plan.todo.prompt.trim()).map(plan => plan.id);
    if (!blank.length) return;
    stop();
    const controller = new AbortController(),
      mine = (writing = { id: null, at: 0, of: blank.length, controller });
    let problem = '',
      done = 0,
      unseen = 0;
    status = '';
    draw();
    await keep();
    for (const id of blank) {
      if (writing !== mine) return;
      if (controller.signal.aborted) break;
      const plan = itemOf(id),
        start = planStarts(montage)[montage.plans.indexOf(plan)],
        asked = plan ? picturesFor(plan) : null;
      mine.at++;
      // (Nothing to look at: left to the user.)
      if (!asked) {
        unseen++;
        continue;
      }
      mine.id = id;
      update();
      try {
        const written = String((await write(asked, { signal: controller.signal }))?.prompt ?? '').trim();
        if (writing !== mine) return;
        if (!written) throw new Error('Moodix AI n’a rien écrit.');
        remember(montage, mine);
        montage = withItemChanged(montage, id, { prompt: written });
        pending = true;
        done++;
      } catch (error) {
        if (writing !== mine) return;
        // (Named by its instants: « Prise 24 » is the name of a take made.)
        if (!controller.signal.aborted) problem = `Prise de ${mono(start)} à ${mono(start + plan.to - plan.from)} non écrite : ${error.message}`;
        break;
      }
    }
    if (writing !== mine) return;
    const stopped = controller.signal.aborted;
    writing = null;
    await keep();
    // (0.6.155) Stopped by the user: nothing to say.
    status = stopped ? '' : problem || (unseen && !done ? 'Moodix AI n’a rien à regarder : posez une photo de début ou de fin, ou écrivez vous-même.' : '');
    draw();
  }

  // Asking Moodix AI (0.6.162) -----------------------------------------------------------------------
  /**
   * (Maquette A1 à A10, claude_design/arrangeur/maquette.) The box under the preview: a field (« Demandez
   * un film, une suite… »), which grows upwards; while Moodix AI arranges, its request and « Arrêter »;
   * above it, what was laid last, in one line. The field stays as it is while the rest is drawn again
   * (it is being typed in): only what is above it, and what it shows of what can be asked, change.
   */
  function askBox() {
    const host = node('div', 'bobine-ask'),
      stack = node('div', 'bobine-ask-stack'),
      slot = node('div', 'bobine-ask-answer');
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Moodix AI');
    slot.setAttribute('role', 'status');
    stack.append(slot);
    host.append(stack);
    live.ask = { host, stack, slot, kind: null, box: null };
    sayAsk();
    return host;
  }
  /**
   * (0.6.163) What the preview does of the text it shows of a take to create while Moodix AI says
   * something under it: 'true', its line: the text goes up above it; 'open', its plate unfolded, or what
   * it said with nothing laid: the text is not shown (seen with his own ChatGPT on 21/11: the plate lay
   * across it, the text read on both sides); 'false' otherwise.
   */
  const askedState = () => (!laid ? 'false' : laid.open || !(laid.count || laid.filled) ? 'open' : 'true');
  function sayAsk() {
    const shown = live.ask;
    if (!shown) return;
    const kind = arranging ? 'working' : 'field';
    if (shown.kind !== kind) {
      // (The field gives its place to « Moodix AI arrange », and takes it back: what is said stays above.)
      const box = kind === 'working' ? workingBox() : fieldBox();
      shown.stack.replaceChildren(shown.slot, box);
      Object.assign(shown, { kind, box });
    }
    tuneAsk();
    shown.slot.replaceChildren(...answerOf());
    shown.slot.hidden = !laid;
    // (Maquette A8: the line passed over the text the preview shows of a take to create: that text goes up.)
    if (media?.frame) media.frame.dataset.asked = askedState();
  }
  function fieldBox() {
    const box = node('div', 'bobine-ask-field'),
      mark = icon('eclipse'),
      field = node('textarea', 'bobine-ask-words'),
      send = button('bobine-ask-send', '', () => void ask(), 'arrow', 'Demander à Moodix AI');
    mark.setAttribute('class', 'bobine-ask-mark');
    Object.assign(field, { value: wish, rows: 1, maxLength: 2000, placeholder: 'Demandez un film, une suite…' });
    field.setAttribute('aria-label', 'Demander à Moodix AI : un film, une suite');
    field.oninput = () => {
      wish = field.value;
      tuneAsk();
    };
    // Entrée asks; Maj+Entrée goes to the next line.
    field.onkeydown = event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault?.();
      void ask();
    };
    box.append(mark, field, send);
    Object.assign(live.ask, { field, send });
    return box;
  }
  function workingBox() {
    const box = node('div', 'bobine-ask-field'),
      head = node('div', 'bobine-ask-working');
    box.dataset.state = 'working';
    head.append(node('span', 'bobine-ask-label', 'Moodix AI arrange'), button('bobine-halt', 'Arrêter', stopAsking));
    box.append(head, node('div', 'bobine-ask-asked', arranging.request));
    Object.assign(live.ask, { field: null, send: null });
    return box;
  }
  /** What the field shows of what can be asked now: nothing while the bobine is at work, nor without words. */
  function tuneAsk() {
    const { field, send, box, kind } = live.ask ?? {};
    if (kind !== 'field' || !field) return;
    const taken = busy(),
      // (0.6.175) A work outside the Bobine: the words can be written meanwhile, not sent.
      held = Boolean(outside()),
      words = Boolean(wish.trim());
    field.disabled = taken;
    send.disabled = taken || held || !words;
    box.dataset.state = words && !taken && !held ? 'typed' : 'rest';
  }
  /** The instants of a take of the bobine, as its line of « À créer » says them. */
  function whenOf(id) {
    const index = montage.plans.findIndex(plan => plan.id === id);
    if (index < 0) return '';
    const start = planStarts(montage)[index],
      plan = montage.plans[index];
    return `${mono(start)} → ${mono(start + plan.to - plan.from)}`;
  }
  /**
   * What Moodix AI laid last, above the field (maquette A4 à A6): one line, the facts counted here
   * (« 2 prises ajoutées »), « Détail » or its adjustments, « Annuler »; unfolded, what it said and each
   * adjustment with the instants of its take. Nothing laid: what it said, and a cross.
   */
  function answerOf() {
    if (!laid) return [];
    const done = Boolean(laid.count || laid.filled),
      line = node('div', 'bobine-ask-done'),
      facts = node('span', 'bobine-ask-facts'),
      notes = laid.notes ?? [],
      said =
        [laid.count ? plural(laid.count, 'prise ajoutée', 'prises ajoutées') : '', laid.filled ? plural(laid.filled, 'texte écrit', 'textes écrits') : '']
          .filter(Boolean)
          .join(' · ') || 'Moodix AI',
      link = (className, text, onclick, glyph, after = false) => {
        const control = node('button', 'bobine-ask-link' + (className ? ' ' + className : ''));
        control.type = 'button';
        if (glyph && !after) control.append(icon(glyph));
        if (text) control.append(node('span', '', text));
        if (glyph && after) control.append(icon(glyph));
        control.onclick = onclick;
        return control;
      },
      toggle = () => {
        laid.open = !laid.open;
        sayAsk();
      };
    if (done) facts.append(icon('check'));
    facts.append(node('span', '', said));
    line.append(facts);
    if (done) {
      const more = notes.length
        ? link('is-quiet', plural(notes.length, 'ajustement'), toggle, 'chevron', true)
        : link('is-faint', 'Détail', toggle, 'chevron', true);
      more.setAttribute('aria-expanded', String(Boolean(laid.open)));
      line.append(more);
    }
    line.append(node('span', 'bobine-ask-gap'));
    if (done) line.append(link('', 'Annuler', () => void travel(true), 'undo'));
    else {
      const close = link('is-faint', '', () => ((laid = null), sayAsk()), 'close');
      close.setAttribute('aria-label', 'Fermer');
      line.append(close);
    }
    if (done && !laid.open) return [line];
    const plate = node('div', 'bobine-ask-said');
    plate.append(line);
    if (laid.problem) plate.append(node('p', 'bobine-ask-say is-problem', laid.problem));
    else if (laid.say) plate.append(node('p', 'bobine-ask-say', laid.say));
    if (notes.length) {
      const list = node('ul', 'bobine-ask-notes');
      for (const note of notes) {
        const item = node('li'),
          when = note.id ? whenOf(note.id) : '';
        if (when) item.append(node('span', 'bobine-ask-when', when));
        item.append(node('span', '', note.text));
        list.append(item);
      }
      plate.append(list);
    }
    return [plate];
  }
  /**
   * The request written under the preview, asked to Moodix AI: its plan is laid on the bobine in takes
   * to create, after its end (and the texts of those that had none written), in one step of « Annuler ».
   * Nothing is created: the user reads, then « Créer ». Nothing of what they laid is changed.
   */
  async function ask() {
    const request = wish.trim();
    if (!arrange || !request || busy() || heldOutside()) return;
    stop();
    // (Asked from its field, by Entrée: the keys are its own again once it is answered, for the next request.)
    const typing = Boolean(live.ask?.field) && page?.document?.activeElement === live.ask.field,
      back = () => {
        const focused = page?.document?.activeElement;
        if (typing && root && (!focused || focused === root || focused === page.document.body)) live.ask?.field?.focus?.({ preventScroll: true });
      };
    const controller = new AbortController(),
      mine = (arranging = { request, controller, bobine: montage.id });
    laid = null;
    status = '';
    draw();
    await keep();
    let answer = null,
      problem = '';
    try {
      answer = await arrange({ montage, request, previous: asks.slice(-ASKS) }, { signal: controller.signal });
    } catch (error) {
      problem = error.message;
    }
    // (Let go meanwhile: stopped, the page left, another bobine come in its place.)
    if (arranging !== mine) return;
    arranging = null;
    if (controller.signal.aborted || montage.id !== mine.bobine) return draw();
    const plan = answer?.arrangement;
    if (!plan) {
      laid = { problem: problem || 'Moodix AI n’a rien répondu.' };
      draw();
      return back();
    }
    const before = montage,
      result = withArrangement(before, plan, { takes: runs(), newId, lengthOf });
    asks = [...asks, { request, say: plan.say ?? '' }].slice(-ASKS);
    if (result.montage !== before) {
      remember(before);
      montage = result.montage;
      pending = true;
      // (Done: the field is empty for the next one. Nothing laid, its words stay to be said otherwise.)
      wish = '';
      await keep();
    }
    laid = {
      count: result.added.length,
      filled: result.filled.length,
      say: plan.say ?? '',
      // (What could not be read of its plan, then what was adjusted as it was laid.)
      notes: [...(answer.problems ?? []).map(text => ({ id: null, text })), ...result.notes],
      open: false,
    };
    draw();
    back();
  }
  /** « Arrêter »: its request is let go at once; its words are in the field again. */
  function stopAsking() {
    if (!arranging) return;
    arranging.controller.abort();
    arranging = null;
    draw();
  }

  // The timeline ----------------------------------------------------------------------------------
  /** (0.6.148, captures 80 et 81) The small bar above the take or the sound chosen: icons, their words on hover. */
  function popOf(item, record, shown = null) {
    const bar = node('div', 'montage-pop'),
      set = changes => change(withItemChanged(montage, item.id, changes, { longest: record ? takeSeconds(record) : null }), { select: item.id }),
      out = () => change(withoutItem(montage, item.id));
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', item.track ? 'Réglages du son' : 'Réglages de la prise');
    // (0.6.155) Half its width, what keeps it inside the track once centred: a sound has its volume, a
    // take its buttons (thirty-two pixels each, and the rules between them).
    const half = () => {
      const kids = [...bar.children],
        buttons = kids.filter(child => String(child.className).includes('montage-pop-button')).length,
        rules = kids.filter(child => String(child.className).includes('montage-pop-rule')).length;
      return item.track ? 96 : Math.ceil((10 + buttons * 32 + rules * 9) / 2);
    };
    const part = () => node('span', 'montage-pop-rule');
    if (item.track) {
      // A sound: its volume, a bar and its figure; open it; take it out.
      const volume = node('input', 'studio-bar montage-range montage-pop-volume'),
        figure = node('span', 'montage-pop-figure', Math.round((item.volume ?? 1) * 100) + ' %');
      Object.assign(volume, { type: 'range', min: '0', max: '200', step: '5', value: String(Math.round((item.volume ?? 1) * 100)) });
      volume.setAttribute('aria-label', 'Volume');
      volume.style.setProperty?.('--fill', String((item.volume ?? 1) / 2));
      // (The bar stays in the hand while it is slid: nothing is drawn again, it says the volume itself,
      // and the sound on its track with it; let go, the timeline is drawn as it now is.)
      volume.oninput = () => {
        volume.style.setProperty?.('--fill', String(Number(volume.value) / 200));
        figure.textContent = volume.value + ' %';
        if (shown) shown.textContent = volume.value + ' %';
        change(withItemChanged(montage, item.id, { volume: Number(volume.value) / 100 }), { still: true, group: 'volume:' + item.id });
      };
      volume.onchange = () => update();
      bar.append(volume, figure, part());
    } else if (isTodo(item)) {
      if (item.photos?.start) bar.append(button('montage-pop-button', '', () => change(withoutPhoto(montage, item.id, 'start')), 'start', 'Retirer la photo de début'));
      if (item.photos?.end) bar.append(button('montage-pop-button', '', () => change(withoutPhoto(montage, item.id, 'end')), 'end', 'Retirer la photo de fin'));
      if (item.photos?.start || item.photos?.end) bar.append(part());
    } else {
      if (item.kind === 'video') {
        const sound = button('montage-pop-button', '', () => set({ volume: item.volume > 0 ? 0 : 1 }), 'sound', item.volume > 0 ? 'Couper le son de la prise' : 'Remettre le son de la prise');
        sound.setAttribute('aria-pressed', String(item.volume > 0));
        bar.append(sound, part());
      }
      for (const [frame, glyph, tip] of [
        ['fit', 'fit', 'Ajuster : la prise entière, avec des bandes si son format diffère'],
        ['fill', 'fill', 'Remplir : plein cadre, ce qui dépasse est coupé'],
      ]) {
        const choice = button('montage-pop-button', '', () => set({ frame }), glyph, tip);
        choice.setAttribute('aria-pressed', String(item.frame === frame));
        bar.append(choice);
      }
      bar.append(part());
    }
    if (record && !isTodo(item)) bar.append(button('montage-pop-button', '', () => showTake(record), 'open', 'Ouvrir la prise'));
    bar.append(button('montage-pop-button', '', out, 'trash', item.replaces ? 'Retirer, et rendre sa fin à la vidéo' : 'Retirer de la bobine (Suppr)'));
    bar.style.setProperty?.('--half', half() + 'px');
    bar.onpointerdown = event => event.stopPropagation?.();
    return bar;
  }

  function timeline() {
    const { section, body } = block('is-output', 'montage-timeline'),
      ruler = node('div', 'montage-ruler'),
      lanes = node('div', 'montage-lanes'),
      headLine = node('span', 'montage-playhead'),
      starts = planStarts(montage),
      whole = span();
    section.setAttribute('aria-label', 'Timeline de la bobine');
    // (It takes the keys when it is pressed: the space bar reads the film.)
    section.tabIndex = -1;
    live.bar = live.making = live.pop = live.drop = null;
    // (0.6.169) Drawn again under a take carried: where it goes is shown again at the next move.
    landing = '';
    live.pieces = new Map();
    // A mark a second up to a minute shown, then every five or ten: the ruler never turns into a comb.
    const seen = whole / zoom,
      step = seen <= 60 ? 1 : seen <= 300 ? 5 : 10;
    for (let second = 0; second <= whole; second += step) {
      const major = second % (step * 5) === 0,
        tick = node('span', 'montage-tick' + (major ? ' is-major' : ''), major ? String(second).padStart(2, '0') + ' s' : '');
      tick.style.left = percent(second);
      ruler.append(tick);
    }
    const timeAt = (event, lane) => {
      const box = lane.getBoundingClientRect?.();
      return box?.width ? Math.max(0, ((event.clientX - box.left) / box.width) * whole) : 0;
    };
    // The head goes where the ruler is pressed, and follows the pointer while it is held.
    ruler.onpointerdown = event => {
      seek(timeAt(event, ruler));
      follow(event, ruler, { slack: 0, kind: '', move: (far, time) => seek(time) });
    };
    // (0.6.142) The photos the takes go by, above them. A start photo sits against the left edge of its
    // take and an end photo against its right edge, never beyond. A photo of the project is laid here
    // by dragging it: where it lands says what it becomes (withPhoto).
    {
      const track = node('div', 'montage-track'),
        lane = node('div', 'montage-lane montage-photos');
      track.dataset.track = 'photos';
      // (0.6.152, captures 77 et 79) A photo being carried: every place where it can go lights up, the
      // photos already laid are framed (it can replace them), and the end of the bobine offers to begin
      // a new take on it. It goes in the place it is dropped on; none serves two takes.
      const carrying = Boolean(carried) && trackOf(carried) === 'image';
      lane.dataset.carrying = String(carrying);
      const into = (target, laid) => {
        target.ondragover = event => {
          if (!carried || trackOf(carried) !== 'image') return;
          event.preventDefault();
          target.dataset.over = 'true';
        };
        target.ondragleave = () => delete target.dataset.over;
        target.ondrop = event => {
          if (!carried) return;
          event.preventDefault();
          event.stopPropagation?.();
          const dropped = carried;
          carried = null;
          const done = laid(dropped);
          if (done.reason) return notice(done.reason);
          change(done.montage, { select: done.chosen });
        };
      };
      montage.plans.forEach((plan, index) => {
        const todo = isTodo(plan),
          span = `prise de ${mono(starts[index])} à ${mono(starts[index] + plan.to - plan.from)}`;
        for (const side of ['start', 'end']) {
          const photo = plan.photos?.[side],
            // (A take to create shows its empty places: start and end, the end only for a suite.)
            empty = !photo && todo && !(side === 'start' && plan.todo.suite);
          if (!photo && !empty) continue;
          const record = photo ? recordOf(photo) : null,
            picture = pictureOf(record),
            pin = button('montage-photo is-' + side + (empty ? ' is-slot' : ''), '', () => {
              chosen = plan.id;
              update();
            });
          pin.dataset.plan = plan.id;
          pin.dataset.missing = String(Boolean(photo) && !record);
          pin.setAttribute('aria-label', `${side === 'start' ? 'Photo de début' : 'Photo de fin'}, ${span}${empty ? ' : glissez une image ici' : ''}`);
          pin.setAttribute('aria-pressed', String(chosen === plan.id));
          if (picture) pin.style.backgroundImage = `url("${picture}")`;
          if (side === 'start') pin.style.left = percent(starts[index]);
          else pin.style.right = `calc(${100 - (100 * (starts[index] + plan.to - plan.from)) / whole}% + 4px)`;
          if (empty) pin.append(icon('image'));
          pin.append(node('span', 'montage-photo-side', side === 'start' ? 'Début' : 'Fin'));
          if (todo) into(pin, dropped => withPhotoIn(montage, dropped, plan.id, side));
          // (Lit with its take and its line.)
          if (hovered === plan.id) pin.dataset.linked = 'true';
          if (!live.pieces.has(plan.id)) live.pieces.set(plan.id, []);
          live.pieces.get(plan.id).push(pin);
          lane.append(pin);
        }
      });
      // (0.6.157, capture 71) An empty bobine: its ghost of 5 s has its two empty places of photo, there at
      // rest; a photo dropped there makes it a take to create that starts, or arrives, on it.
      if (!montage.plans.length)
        for (const side of ['start', 'end']) {
          const slot = button(`montage-photo is-${side} is-slot is-ghost`, '', null);
          slot.setAttribute('aria-label', `${side === 'start' ? 'Photo de début' : 'Photo de fin'} d’une nouvelle prise : glissez une image ici`);
          if (side === 'start') slot.style.left = percent(0);
          else slot.style.right = `calc(${100 - (100 * TODO_LIMITS.usual) / whole}% + 4px)`;
          slot.append(icon('image'), node('span', 'montage-photo-side', side === 'start' ? 'Début' : 'Fin'));
          into(slot, dropped => {
            const laid = withTodoDrawn(montage, { id: newId(), at: 0, seconds: TODO_LIMITS.usual });
            return laid.reason ? laid : withPhotoIn(laid.montage, dropped, laid.chosen, side);
          });
          lane.append(slot);
        }
      else if (carrying) {
        const fresh = button('montage-photo is-start is-slot is-new', '', null);
        fresh.setAttribute('aria-label', 'Une nouvelle prise, qui part de cette photo, à la fin de la bobine');
        fresh.style.left = `calc(${percent(total())} + 4px)`;
        fresh.append(icon('image'), node('span', 'montage-photo-side', 'Début'));
        into(fresh, dropped => {
          const laid = withTodoDrawn(montage, { id: newId(), at: total(), seconds: TODO_LIMITS.usual });
          return laid.reason ? laid : withPhotoIn(laid.montage, dropped, laid.chosen, 'start');
        });
        lane.append(fresh);
      }
      lane.ondragover = event => {
        if (carried && trackOf(carried) === 'image') event.preventDefault();
      };
      lane.ondrop = event => {
        if (!carried) return;
        event.preventDefault();
        const dropped = carried;
        carried = null;
        const laid = withPhoto(montage, dropped, timeAt(event, lane), { id: newId() });
        if (laid.reason) return notice(laid.reason);
        change(laid.montage, { select: laid.chosen });
      };
      track.append(node('span', 'montage-track-name', 'Photos'), lane);
      lanes.append(track);
    }
    for (const [id, name] of TRACKS) {
      const track = node('div', 'montage-track'),
        lane = node('div', 'montage-lane'),
        // (The small bar of what is chosen, at the scale of the lane but above it: the lane cuts what overflows.)
        layer = node('div', 'montage-pop-layer');
      track.dataset.track = id;
      const items = id === 'plans' ? montage.plans : montage.sounds.filter(sound => sound.track === id);
      items.forEach(item => {
        // (What a sound says of its volume on its track: its bar, once chosen, says it there too.)
        let loudness = null;
        // (While the start of a take is cut, the takes stay where they were: only that edge moves.)
        const at = id !== 'plans' ? item.at : ghost?.starts.has(item.id) ? ghost.starts.get(item.id) + (ghost.id === item.id ? ghost.shift : 0) : starts[montage.plans.indexOf(item)],
          todo = isTodo(item),
          made = todo && Boolean(beingMade(item.id)),
          // (A take to create that takes the place of the end of a video shows it, greyed, until it is made.)
          record = recordOf(todo ? item.replaces?.source : item.source),
          picture = id === 'plans' ? pictureOf(record) : '',
          // (0.6.143) A take to create that goes on from the video before it: its continuation, drawn joined
          // to it. (0.6.149) Only a suite does; one no longer joined to its video is drawn apart.
          link = todo && id === 'plans' ? linkOf(montage, item.id, lengthOf) : null,
          suite = todo && id === 'plans' && Boolean(item.todo.suite),
          joined = suite && ['suite', 'last', 'wait'].includes(link?.kind),
          state = todo ? stateOf(item.id) : '',
          label =
            id !== 'plans'
              ? (takeLabel(item.source) || 'Son') + (record?.prompt ? ' · ' + String(record.prompt).split('\n')[0].slice(0, 60) : '')
              : todo
                ? state || (item.replaces ? 'Sera remplacé' : suite ? '↳ Suite' : '')
                : takeLabel(item.source) || 'Prise introuvable',
          look = id !== 'plans' ? ' is-sound' : todo ? ' is-todo' + (item.replaces ? ' is-replacing' : '') + (suite ? ' is-suite' : '') + (writing?.id === item.id ? ' is-writing' : '') + (made ? ' is-making' : '') + (failed.has(item.id) && !state.startsWith('En') ? ' is-failed' : '') : '',
          piece = button('montage-piece' + look, '', event => {
            // (The click that ends a drag chooses nothing.)
            if (slid) return void (slid = false);
            // (0.6.169) Nor the second of a double click: the first laid it in the void, chosen.
            if ((event?.detail ?? 1) > 1) return;
            // (0.6.153) With the wand, a take to create with a text is enriched.
            if (wand && todo) return void enrichOne(item.id);
            chosen = chosen === item.id ? null : item.id;
            update();
            if (todo && chosen) reveal(item.id, { line: true });
          });
        piece.dataset.id = item.id;
        piece.dataset.missing = String(!record && !todo);
        if (id === 'plans') {
          // (0.6.153) Lit with its line and its photos; enrichable with the wand when it has a text.
          // (Its photos are drawn before it, on the track above: the take first, then them.)
          live.pieces.set(item.id, [piece, ...(live.pieces.get(item.id) ?? [])]);
          piece.onpointerenter = () => linked(item.id, true);
          piece.onpointerleave = () => linked(item.id, false);
          if (hovered === item.id) piece.dataset.linked = 'true';
          if (todo) piece.dataset.enrichable = String(Boolean(enrich) && Boolean(item.todo.prompt.trim()));
          if (lit === item.id) piece.dataset.lit = 'true';
          if (enrichingId === item.id) piece.dataset.enriching = 'true';
        }
        piece.setAttribute('aria-pressed', String(chosen === item.id));
        // (Four pixels between two neighbours: the surface shows between them. A continuation takes
        // those of the video it continues: the two touch.)
        piece.style.left = joined ? `calc(${percent(at)} - 4px)` : percent(at);
        piece.dataset.joined = String(joined);
        // (0.6.169) Dragged against a neighbour, it holds there: the edge that touches says so, lightly.
        if (id === 'plans' && moving === item.id) {
          const index = montage.plans.indexOf(item),
            before = montage.plans[index - 1],
            after = montage.plans[index + 1],
            touches = [
              before && Math.abs(starts[index - 1] + (before.to - before.from) - at) < 0.002 ? 'start' : '',
              after && Math.abs(starts[index + 1] - (at + item.to - item.from)) < 0.002 ? 'end' : '',
            ].filter(Boolean);
          if (touches.length) piece.dataset.snap = touches.join(' ');
        }
        piece.style.width = joined ? percent(item.to - item.from) : `calc(${percent(item.to - item.from)} - 4px)`;
        if (picture) piece.style.backgroundImage = `url("${picture}")`;
        piece.append(node('span', 'montage-piece-name', label));
        if (id === 'plans') {
          // What a take to create says: its text, on two lines.
          const words = node('span', 'montage-piece-kind', todo ? item.todo.prompt.trim().split('\n')[0].slice(0, 160) : '');
          piece.append(words, node('span', 'montage-piece-length', (suite ? '+' : '') + mono(item.to - item.from) + ' s'));
          // (0.6.152, capture 74) Made in parts: where each part after the first begins, a suite.
          if (todo) {
            const { count } = partsOf(item, limits());
            for (let part = 1; part < count; part++) {
              const cut = node('span', 'bobine-part', '↳ Suite');
              cut.style.left = (100 * part) / count + '%';
              piece.append(cut);
            }
          }
          if (made) {
            const bar = node('span', 'montage-piece-bar'),
              done = node('span', 'montage-piece-bar-done');
            done.style.width = Math.round((beingMade(item.id).fraction ?? 0) * 100) + '%';
            bar.append(done);
            piece.append(bar);
            Object.assign(live, { bar: done, making: piece.children[0] });
          }
        } else {
          loudness = node('span', 'montage-piece-length', Math.round((item.volume ?? 1) * 100) + ' %');
          piece.append(loudness);
        }
        piece.onkeydown = event => {
          if (event.key === 'Delete' || event.key === 'Backspace') change(withoutItem(montage, item.id));
          if (event.key === 'Escape' && chosen === item.id) {
            chosen = null;
            update();
          }
          // Alt and an arrow: the take one place earlier or later.
          const step = event.altKey && id === 'plans' ? { ArrowLeft: -1, ArrowRight: 1 }[event.key] : 0;
          if (step) change(withPlanMoved(montage, item.id, step), { select: item.id });
        };
        // Dragged along its track: a take goes where it is dropped (0.6.149: before or after the take it
        // is dropped on, by its middle; in a hole, where it is, against a neighbour a few pixels away),
        // with the suites to create that go on from it; a sound to its moment.
        piece.onpointerdown = event => {
          const pressed = montage,
            first = at,
            // (What is dragged is chosen, even when it ends where it was.)
            put = next => {
              // (0.6.173, « ça zozote ») The bobine as it is already, read again from the one pressed:
              // nothing is drawn again. (It was at every move of the pointer, and every slide began
              // again with it: the takes waited where they were while the hand moved, then jumped.)
              if (next !== montage && alike(next, montage)) next = montage;
              if (next === montage && chosen === item.id) return;
              chosen = item.id;
              if (next === montage) update();
              else change(next);
            };
          let reach = 0;
          follow(event, lane, {
            // A sound stops on a cut of the film when it is within a few pixels of one.
            move: (far, time, perPixel) => {
              // (0.6.169) It follows the hand; the others slide out of its way (slide).
              moving = item.id;
              // (0.6.173) How far the hand went since its last move: what goes as far follows it.
              const hand = perPixel ? far / perPixel : 0;
              strode = hand - reach;
              reach = hand;
              put(
                id === 'plans'
                  ? withPlanPlaced(pressed, item.id, first + far, { near: NEAR_PIXELS * perPixel })
                  : withItemChanged(montage, item.id, { at: snapped(montage, first + far, Math.max(0.1, NEAR_PIXELS * perPixel)) }),
              );
              // (Counted once: what is drawn again for another reason finds a hand that did not move.)
              strode = 0;
            },
            done: () => (moving = null),
          });
        };
        // Its two edges: what is kept of the take, from its start (a clip) and to its end.
        if (id === 'plans')
          for (const edge of item.kind === 'image' || todo ? ['end'] : ['start', 'end']) {
            const grip = node('span', 'montage-grip is-' + edge);
            // (0.6.157, capture 72) The end of a video under the pointer: in light dots, the suite pulling it
            // would give. Nothing is drawn again: the grip stays under the hand.
            if (edge === 'end' && !todo && item.kind === 'video') {
              grip.onpointerenter = () => hint(at + (item.to - item.from));
              grip.onpointerleave = () => hint(null);
            }
            grip.onpointerdown = event => {
              hint(null);
              event.stopPropagation?.();
              const first = { from: item.from, to: item.to },
                longest = record ? takeSeconds(record) : null,
                before = new Map(montage.plans.map((plan, index) => [plan.id, starts[index]])),
                // (0.6.143) The end of a video pulled beyond its take: what exceeds is its continuation
                // to create, right after it. Read on the bobine as it was pressed: pulled back, it is gone.
                pressed = montage,
                beyond = edge === 'end' && !todo && item.kind === 'video' ? newId() : null;
              follow(event, lane, {
                slack: 2,
                kind: 'trim',
                move: far => {
                  const next = beyond
                    ? withEndPulled(pressed, item.id, first.to + far, { longest, suiteId: beyond })
                    : withItemChanged(montage, item.id, edge === 'start' ? { from: first.from + far } : { to: first.to + far }, { longest });
                  if (edge === 'start') ghost = { starts: before, id: item.id, shift: next.plans.find(plan => plan.id === item.id).from - first.from };
                  chosen = item.id;
                  const added = beyond ? next.plans.find(plan => plan.id === beyond) : null,
                    kept = next.plans.find(plan => plan.id === item.id);
                  // (Where the continuation ends, at the scale of the timeline: what is said of it is said there.)
                  pulling = added ? { id: beyond, at: before.get(item.id) + (kept.to - kept.from) + (added.to - added.from), seconds: added.to - added.from } : null;
                  if (next === montage || (beyond && JSON.stringify(next.plans) === JSON.stringify(montage.plans))) update();
                  else change(next);
                },
                // Let go with its continuation: that one is chosen, what happens next is written in its line.
                done: () => {
                  if (pulling && itemOf(pulling.id)) chosen = pulling.id;
                  pulling = null;
                },
              });
            };
            piece.append(grip);
          }
        lane.append(piece);
        // (Not over a take being made: nothing can be changed in it.)
        if (chosen === item.id && !held && making?.id !== item.id) {
          const bar = popOf(item, recordOf(item.source), loudness);
          // (0.6.155) Centred above it, kept inside the track; over its photos, it goes into the take (fitBar).
          bar.style.left = `clamp(var(--half), ${percent(at + (item.to - item.from) / 2)}, calc(100% - var(--half)))`;
          // (0.6.158) Where it goes in a take too narrow for it between its places of photo: at its start.
          bar.style.setProperty?.('--take', percent(at));
          live.pop = { bar, id: item.id };
          layer.append(bar);
        }
      });
      // (0.6.149) In the void of the takes, after the bobine or in a hole (captures 71, 75, 76): a take to
      // create of 5 s, a ghost, follows the pointer with a « + »; (0.6.169, his words of 21/11) a simple
      // click lays it there, no longer a double one; pressed and pulled, a take to create is drawn there,
      // as long as it is pulled, within its hole.
      let tap = null;
      if (id === 'plans') {
        tap = drawable(lane, timeAt);
        live.hint = node('span', 'bobine-edge-hint');
        live.hint.hidden = true;
        lane.append(live.hint);
      }
      // A press on the lane itself, beside what it holds: the head goes there, what was chosen is let go.
      // (0.6.169) On the track of the takes, where its ghost is, it lays a take to create.
      lane.onclick = event => {
        if (event.target !== lane && !live.shade?.contains?.(event.target)) return;
        // (The click that ends a drawing chooses nothing.)
        if (slid) return void (slid = false);
        if (tap?.(event)) return;
        if (chosen) {
          chosen = null;
          update();
        }
        seek(timeAt(event, lane));
      };
      const fits = () => {
        const kind = carried ? trackOf(carried) : '';
        return id === 'plans' ? kind === 'video' || kind === 'image' : kind === 'music' || kind === 'effects';
      };
      lane.ondragover = event => {
        if (!carried || !fits()) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        // (0.6.169) « On ne voit pas où on le drop »: it is drawn where it would go, the others making room.
        carry(id, lane, timeAt(event, lane));
      };
      lane.ondragleave = event => {
        if (event?.relatedTarget && lane.contains?.(event.relatedTarget)) return;
        uncarry();
      };
      lane.ondrop = event => {
        if (!carried) return;
        event.preventDefault();
        // (Laid where it was shown: the others are already where they go.)
        landing = '';
        live.drop?.remove?.();
        live.drop = null;
        const dropped = carried,
          time = timeAt(event, lane),
          box = lane.getBoundingClientRect?.();
        carried = null;
        // (0.6.148) A sound goes on the track it is dropped on. (0.6.149) A take where it is dropped: on a
        // take, before or after it by its middle; in a hole, there, against a neighbour a few pixels away.
        if (id !== 'plans') lay(dropped, { at: Math.round(time * 10) / 10, track: id });
        else lay(dropped, { at: Math.round(time * 100) / 100, near: box?.width ? (NEAR_PIXELS * whole) / box.width : 0 });
      };
      track.append(node('span', 'montage-track-name', name), lane, layer);
      lanes.append(track);
    }
    // The head is laid over the lanes, at their scale.
    const over = node('div', 'montage-over');
    over.append(headLine);
    // (0.6.155) While the end of a video is pulled, nothing is said over the ruler: « +12.10 S » on the take says it.
    lanes.append(over);
    // (0.6.149) Zoomed, the bobine scrolls under the names of its tracks: −, + and « Voir toute la
    // bobine » at the top left, and Ctrl + molette, around the pointer.
    const reel = node('div', 'bobine-reel'),
      inner = node('div', 'bobine-reel-inner'),
      rule = node('div', 'bobine-rule-row'),
      zooms = node('div', 'bobine-zoom');
    for (const [glyph, tip, wanted, off] of [
      ['minus', 'Zoom arrière', () => zoom / ZOOM_STEP, zoom <= 1],
      ['plus', 'Zoom avant (Ctrl + molette)', () => zoom * ZOOM_STEP, zoom >= ZOOM_MAX],
      ['whole', 'Voir toute la bobine', () => 1, zoom <= 1],
    ]) {
      const control = button('bobine-zoom-button', '', () => zoomTo(wanted()), glyph, tip);
      control.disabled = off;
      zooms.append(control);
    }
    inner.style.setProperty?.('--zoom', String(zoom));
    reel.dataset.zoomed = String(zoom > 1);
    // (How far it is scrolled is given back once it is on the page: draw, update.)
    reel.onscroll = () => (scrolled = reel.scrollLeft);
    reel.onwheel = event => {
      if (event.ctrlKey) {
        event.preventDefault?.();
        return zoomTo(zoom * (event.deltaY < 0 ? 1.25 : 0.8), event.clientX);
      }
      // (Zoomed, the wheel scrolls it from side to side.)
      if (zoom > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX ?? 0)) {
        event.preventDefault?.();
        reel.scrollLeft = scrolled = Math.max(0, (reel.scrollLeft ?? 0) + event.deltaY);
      }
    };
    rule.append(zooms, ruler);
    inner.append(rule, lanes);
    reel.append(inner);
    body.append(reel);
    Object.assign(live, { head: headLine, reel });
    return section;
  }

  /**
   * (0.6.149) The void of the takes (`lane`): a ghost of a take of 5 s follows the pointer in a hole,
   * a click lays it there (0.6.169: a simple one, his words of 21/11), a press pulled draws a take to
   * create, as long as it is pulled (within its hole and within what a clip can be: longer ones are cut
   * in parts at the next step). Drawn takes stay where they are drawn and never go on from what is
   * around them (withTodoDrawn). Gives what a click there does: whether it laid one.
   */
  function drawable(lane, timeAt) {
    const usual = TODO_LIMITS.usual,
      shade = node('span', 'bobine-ghost'),
      length = node('span', 'bobine-ghost-length', ''),
      empty = !montage.plans.length;
    shade.append(node('span', 'bobine-ghost-plus', '+'), length);
    shade.title = 'Cliquez pour poser une prise à créer de 5 s ; tirez pour la dessiner plus longue ou plus courte';
    const show = (from, seconds, drawn = false) => {
      shade.hidden = false;
      shade.dataset.drawn = String(drawn);
      shade.style.left = percent(from);
      shade.style.width = `calc(${percent(seconds)} - 4px)`;
      length.textContent = drawn ? mono(seconds) + ' s' : '';
    };
    const hide = () => (empty ? show(0, usual) : (shade.hidden = true));
    // Where the ghost goes for the pointer at `time`: in its hole, centred on it; null on a take.
    const ghostAt = time => {
      const hole = holeAt(montage, time);
      if (!hole) return null;
      let from = Math.max(hole.from, time - usual / 2);
      from = hole.to - hole.from >= usual ? Math.min(from, hole.to - usual) : hole.from;
      return Math.round(from * 10) / 10;
    };
    const inVoid = target => target === lane || shade.contains?.(target);
    if (drawing) show(drawing.from, drawing.to - drawing.from, true);
    else hide();
    shade.dataset.breathing = String(empty);
    lane.append(shade);
    Object.assign(live, { shade, lane });
    lane.onpointermove = event => {
      if (held || drawing || busy()) return;
      const from = inVoid(event.target) ? ghostAt(timeAt(event, lane)) : null;
      if (from === null) hide();
      else show(from, usual);
    };
    lane.onpointerleave = () => {
      if (!drawing) hide();
    };
    lane.onpointerdown = event => {
      if (!inVoid(event.target) || busy()) return;
      const start = timeAt(event, lane),
        hole = holeAt(montage, start);
      if (!hole) return;
      follow(event, lane, {
        slack: 4,
        kind: 'draw',
        move: (far, time, perPixel) => {
          const near = NEAR_PIXELS * perPixel;
          let from = Math.max(hole.from, Math.min(start, time)),
            to = Math.min(hole.to, Math.max(start, time));
          // Against a neighbour a few pixels away; within what a clip can be.
          if (from - hole.from <= near) from = hole.from;
          if (to < hole.to && hole.to - to <= near) to = hole.to;
          if (to - from > TODO_LIMITS.longest) {
            if (time >= start) to = from + TODO_LIMITS.longest;
            else from = to - TODO_LIMITS.longest;
          }
          drawing = { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 };
          show(drawing.from, drawing.to - drawing.from, true);
        },
        done: () => {
          const wanted = drawing;
          drawing = null;
          if (wanted) drawn(wanted.from, wanted.to - wanted.from);
        },
      });
    };
    return event => {
      if (!inVoid(event.target) || busy() || held || drawing) return false;
      const from = ghostAt(timeAt(event, lane));
      if (from === null) return false;
      drawn(from, usual);
      return true;
    };
  }
  /**
   * (0.6.169) The take carried from « Prises » over the track `track` (`lane`), the pointer at `time`
   * seconds: drawn where it would be laid (withTake, as the drop lays it), and on the track of the takes
   * those it would push later slide there already. Nothing is changed in the bobine.
   */
  function carry(track, lane, time) {
    // (0.6.170) Not while the bobine cannot change (a take being made, Moodix AI writing or arranging):
    // the drop says why, nothing is shown that it would refuse. (What begins such a state draws the
    // timeline again: what was shown before is gone with it.)
    if (!carried || refusal()) return uncarry();
    const sound = track !== 'plans',
      box = lane.getBoundingClientRect?.(),
      near = box?.width ? (NEAR_PIXELS * span()) / box.width : 0,
      next = sound
        ? withTake(montage, carried, { id: CARRIED, at: Math.round(time * 10) / 10, track })
        : withTake(montage, carried, { id: CARRIED, at: Math.round(time * 100) / 100, near }),
      laid = (sound ? next.sounds : next.plans).find(item => item.id === CARRIED);
    // (A bobine that is full takes nothing more.)
    if (!laid) return uncarry();
    const key = `${track}|${laid.at}|${laid.to - laid.from}`;
    if (key === landing) return;
    landing = key;
    let shadow = live.drop;
    if (!shadow || shadow.dataset.track !== track) {
      shadow?.remove?.();
      const picture = pictureOf(carried),
        take = carried.outputs?.[0]?.take;
      shadow = live.drop = node('span', 'bobine-drop' + (sound ? ' is-sound' : ''));
      shadow.dataset.track = track;
      shadow.setAttribute('aria-hidden', 'true');
      if (picture && !sound) shadow.style.backgroundImage = `url("${picture}")`;
      shadow.append(node('span', 'montage-piece-name', Number.isInteger(take) ? 'Prise ' + take : ''));
      lane.append(shadow);
    }
    shadow.style.left = percent(laid.at);
    shadow.style.width = `calc(${percent(laid.to - laid.from)} - 4px)`;
    slideTo(sound ? montage : next);
  }
  /** (0.6.169) Nothing carried over the timeline any more: the takes go back to their place. */
  function uncarry() {
    live.drop?.remove?.();
    live.drop = null;
    if (!landing) return;
    landing = '';
    slideTo(montage);
  }
  /** (0.6.169) The takes of the track, and their photos, put where `next` has them (moodix.css slides them). */
  function slideTo(next) {
    const starts = new Map(placed(next).plans.map(plan => [plan.id, plan]));
    for (const [id, [piece, ...pins]] of live.pieces ?? []) {
      const plan = starts.get(id);
      if (!plan || !piece) continue;
      piece.style.left = piece.dataset.joined === 'true' ? `calc(${percent(plan.at)} - 4px)` : percent(plan.at);
      for (const pin of pins)
        if (String(pin.className).includes('is-start')) pin.style.left = percent(plan.at);
        else pin.style.right = `calc(${100 - (100 * (plan.at + plan.to - plan.from)) / span()}% + 4px)`;
    }
  }
  /** A take to create laid at `from` seconds, `seconds` long, chosen: its line of « À créer » waits for its text. */
  function drawn(from, seconds) {
    const laid = withTodoDrawn(montage, { id: newId(), at: from, seconds });
    if (laid.reason) return notice(laid.reason);
    change(laid.montage, { select: laid.chosen });
  }

  /**
   * (0.6.149) The timeline zoomed to `wanted` (1: the whole bobine, up to ZOOM_MAX), the instant under
   * `clientX` (the pointer; by default the middle of what is shown) staying where it is on the screen.
   */
  function zoomTo(wanted, clientX = null) {
    const next = Math.min(ZOOM_MAX, Math.max(1, Math.round(wanted * 100) / 100));
    if (next === zoom || !parts) return;
    const reelBox = live.reel?.getBoundingClientRect?.(),
      x = clientX ?? (reelBox ? reelBox.left + reelBox.width / 2 : 0),
      box = live.lane?.getBoundingClientRect?.(),
      time = box?.width ? ((x - box.left) / box.width) * span() : head;
    zoom = next;
    if (zoom === 1) scrolled = 0;
    update({ panel: false });
    const after = live.lane?.getBoundingClientRect?.();
    if (zoom > 1 && after?.width && live.reel) live.reel.scrollLeft = scrolled = Math.max(0, (live.reel.scrollLeft ?? 0) + after.left + (time / span()) * after.width - x);
  }

  /**
   * Follows the pointer pressed on `lane` (0.6.138): `move(far, time, perPixel)` as it goes, `far` how
   * far it went and `time` where it is, both in seconds of the film at the scale the timeline had when
   * it was pressed (`perPixel` seconds a pixel); `done()` once it is let go. `kind`: what is being done
   * (« move », « trim »), said to the desk while it lasts. A press that does not move (`slack` pixels) is a click:
   * nothing is called.
   */
  function follow(event, lane, { move, done = () => {}, slack = 4, kind = 'move' }) {
    if (event.button > 0 || !page?.addEventListener) return;
    const box = lane.getBoundingClientRect?.() ?? { left: 0, width: 0 },
      scale = box.width ? span() / box.width : 0,
      from = event.clientX;
    let moved = false;
    const onMove = now => {
      const far = now.clientX - from;
      if (!moved && Math.abs(far) < slack) return;
      if (!moved) {
        held = span();
        // (0.6.154) Its moves: one step of « Annuler ».
        dragging = {};
        // (Said to the desk: one cursor everywhere while it lasts, moodix.css.)
        if (kind) root.dataset.held = kind;
      }
      moved = true;
      move(far * scale, Math.max(0, (now.clientX - box.left) * scale), scale);
    };
    const heard = [
      ['pointermove', onMove],
      ['pointerup', onUp],
      ['pointercancel', onUp],
    ];
    function onUp() {
      for (const [type, listener] of heard) page.removeEventListener(type, listener);
      if (!moved) return;
      held = ghost = dragging = null;
      delete root.dataset.held;
      // The click the browser sends after a drag chooses nothing; without one (let go elsewhere), forgotten at once.
      slid = true;
      timers.set(() => (slid = false), 0);
      done();
      update();
    }
    for (const [type, listener] of heard) page.addEventListener(type, listener);
  }

  function draw() {
    if (!root || !montage) return;
    const focused = page?.document?.activeElement,
      inside = focused && focused !== root && root.contains?.(focused);
    parts = { takes: takes(), screen: screen(), create: createPanel(), timeline: timeline() };
    root.replaceChildren(...(ownFil ? [filRoot] : []), parts.takes, parts.screen, parts.create, parts.timeline);
    // (0.6.149) The timeline zoomed stays where it was scrolled: set once it is on the page.
    if (live.reel) live.reel.scrollLeft = scrolled;
    fil();
    fitBar();
    if (inside) refocus(focused, root);
    show();
  }
  /**
   * What a change of the bobine alters (0.6.138): its timeline, « À créer » and what is chosen. The
   * preview goes on with the clip it shows and the grid of the takes keeps its place. `panel: false`:
   * a text being written in « À créer », a bar being slid: they are not drawn again under the hand.
   */
  /** (0.6.157, capture 72) The suite pulling the end of a video at `end` seconds would give, in light dots: two seconds of it. */
  function hint(end) {
    const shown = live.hint;
    if (!shown) return;
    shown.hidden = end === null || Boolean(held);
    if (shown.hidden) return;
    shown.style.left = percent(end);
    shown.style.width = `calc(${percent(Math.min(HINT, Math.max(0, span() - end)))} - 4px)`;
  }
  /**
   * (0.6.155) The bar of the take chosen never lies over its photos nor their empty places (capture 78:
   * its trash covered the place of the start): centred, it does when the take is narrow; it then goes
   * into the take, at its top. Measured once on the page; the list of « À créer » says if it goes on.
   */
  function fitBar() {
    fade();
    const { bar, id } = live.pop ?? {};
    if (!bar?.isConnected || !bar.getBoundingClientRect) return;
    const box = bar.getBoundingClientRect();
    if (!box.width) return;
    const over = (live.pieces?.get(id) ?? []).slice(1).some(pin => {
      const at = pin.getBoundingClientRect();
      return at.width > 0 && at.left < box.right - 1 && at.right > box.left + 1;
    });
    bar.dataset.inside = String(over);
  }
  /**
   * (0.6.169) Where each take of the timeline and its photos are on the screen now, and at what scale; null
   * when nothing will slide (an edge pulled or a take drawn: what touches it follows the hand; the motion
   * reduced), the page not measured for nothing.
   */
  function placesNow() {
    if (['trim', 'draw'].includes(root?.dataset?.held)) return null;
    if (page?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || page?.document?.documentElement?.dataset?.motion === 'fige') return null;
    const places = new Map();
    for (const [id, elements] of live.pieces ?? [])
      elements.forEach((element, at) => {
        const box = element?.getBoundingClientRect?.();
        if (box?.width > 0) places.set(id + '|' + at, box.left);
      });
    return { places, span: span(), zoom };
  }
  /**
   * (0.6.169) « C'est fluide et ça colle tout seul » : the takes a change moves slide from where they were
   * to their place (a take laid before them, one taken away, one dragged among them), the one in the hand
   * too when it jumps past a neighbour; a take that comes appears softly. Not when the scale changed, nor
   * when placesNow measured nothing.
   * (0.6.173, « ça zozote, ça saute quand on drag des prises ») The timeline is drawn again at each change,
   * so at each move of a hand that drags a take: a slide going on then goes on (`flights`), from where it
   * left and at the time it has reached. It began again each time, and never went further than its first
   * image while the hand moved: the takes waited where they were, then jumped once the hand stopped.
   */
  function slide(before) {
    if (!before?.places.size || before.span !== span() || before.zoom !== zoom) return void flights.clear();
    const at = now();
    for (const [key, flight] of flights) if (at - flight.since >= SLIDE) flights.delete(key);
    for (const [id, elements] of live.pieces ?? []) {
      elements.forEach((element, rank) => {
        if (typeof element?.animate !== 'function') return;
        const key = id + '|' + rank,
          box = element.getBoundingClientRect(),
          was = before.places.get(key);
        if (!(box.width > 0)) return;
        if (was === undefined) {
          flights.delete(key);
          if (!held) element.animate([{ opacity: 0, transform: 'scale(0.97)' }, { opacity: 1, transform: 'none' }], { duration: SLIDE, easing: SLIDING });
          return;
        }
        // (The take in the hand follows it as it goes; it slides only when it jumps, past a neighbour:
        // when it goes further than the hand itself did.)
        const to = box.left,
          slack = id === moving ? Math.abs(strode) + JUMP : 0.5,
          going = flights.get(key);
        let flight = null;
        // Going where it went already (the take in the hand: as the hand goes): the same slide, further on.
        if (going && Math.abs(to - going.to) <= slack) flight = { from: going.from + (to - going.to), to, since: going.since };
        // Going elsewhere: a slide from where it is now.
        else if (Math.abs(to - was) > slack) flight = { from: was, to, since: at };
        if (!flight) return void flights.delete(key);
        flights.set(key, flight);
        const motion = element.animate([{ transform: `translateX(${flight.from - to}px)` }, { transform: 'none' }], { duration: SLIDE, easing: SLIDING });
        if (motion && at > flight.since) motion.currentTime = at - flight.since;
      });
    }
  }
  function update({ panel = true } = {}) {
    if (!root || !montage) return;
    if (!parts || !root.replaceChild) return draw();
    const focused = page?.document?.activeElement,
      before = placesNow();
    for (const [name, make] of [
      ['create', createPanel],
      ['timeline', timeline],
    ]) {
      if (name === 'create' && !panel) continue;
      const old = parts[name],
        next = make();
      root.replaceChild(next, old);
      parts[name] = next;
      if (focused && old.contains?.(focused)) refocus(focused, next);
    }
    if (live.reel) live.reel.scrollLeft = scrolled;
    slide(before);
    sayGo();
    sayAsk();
    show({ sync: false });
    fitBar();
  }
  /**
   * The focus put back on what replaces `was` in `part` (the same take, the same control), else on the
   * desk: what had it has just left the page, and the keys of the bobine would no longer be heard.
   */
  function refocus(was, part) {
    const key = item => item.dataset?.id || item.getAttribute?.('aria-label') || item.className + '|' + item.textContent,
      again = [...(part.querySelectorAll?.(was.tagName) ?? [])].find(item => key(item) === key(was) && !item.disabled);
    (again ?? root).focus?.({ preventScroll: true });
  }

  return {
    /**
     * The page of the bobine, drawn for the project; `fil`: where « / bobine ⌄ … Exporter » goes (the
     * head of the page, beside the project). Without one it is drawn at the top of the desk.
     */
    desk({ fil: given = null } = {}) {
      ownFil = !given;
      filRoot = given ?? node('div', 'bobine-fil');
      root = node('div', 'studio-desk bobine-desk');
      root.dataset.wand = String(wand);
      page?.removeEventListener?.('keydown', pageKeys);
      page?.addEventListener?.('keydown', pageKeys);
      // (A press anywhere on the desk gives it the keys.)
      root.tabIndex = -1;
      parts = null;
      // The space bar reads the film or pauses it, wherever nothing is being typed or pressed.
      root.onkeydown = event => {
        // (A take, a sound or a tile is a button too: Enter chooses it, the space bar reads the film.)
        const { tagName, className } = event.target ?? {},
          typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || (tagName === 'BUTTON' && !/\bmontage-(piece|take)\b/.test(className));
        // (0.6.153) Échap puts the wand down (heard by the page too, pageKeys).
        if (event.key === 'Escape' && wand) return toggleWand(false);
        if (event.key === ' ' && !typing) {
          event.preventDefault?.();
          play();
        } else if (event.key === 'Home' && !typing) seek(0);
        else if (event.key === 'End' && !typing) seek(total());
        // Échap lets go of what is chosen, and closes its bar.
        else if (event.key === 'Escape' && chosen && !typing) {
          chosen = null;
          update();
        }
      };
      if (readFor !== project() || !montage) {
        montage = fresh();
        stored = false;
        void read();
      } else {
        opened();
        // (0.6.181) A take made for it while another page was shown: at its place.
        layMissed();
      }
      draw();
      return root;
    },
    /**
     * (0.6.154) The bobine a card of the Archives opens: at once when those of its project are read,
     * else once they are (it is the project of the page then).
     */
    wanted(id) {
      wantedId = id;
      if (root && montage && readFor === project()) opened();
    },
    /** The creations of the project were read again (one made, one removed): shown as they are now. Another project: its bobines. */
    /** (0.6.175) What `busyWith` says may have changed (a work began or ended outside the Bobine): its controls follow. */
    busyChanged() {
      if (!root || !montage) return;
      // (0.6.181) Its take followed from outside (goingOn): drawn « En cours » when it begins and as it was
      // when it ends; meanwhile its words alone follow it, nothing drawn again under the hands.
      const going = montage.plans.find(plan => goingOn(plan.id))?.id ?? null;
      if (going !== shownGoing) {
        shownGoing = going;
        draw();
      } else if (going) sayMaking(going);
      sayGo();
      tuneAsk();
    },
    refreshed() {
      if (root && readFor !== project()) {
        // (0.6.160) Another project chosen on the page while Moodix AI writes a take of a series, or
        // between two of its takes: nothing keeps the bobine in its project then (a take being made
        // does, 0.6.81). The series ends with it: its text was written in the bobine of the other
        // project, kept there, and its take asked there.
        writing?.controller.abort();
        writing = null;
        arranging?.controller.abort();
        arranging = null;
        if (filling && !making) {
          filling.controller?.abort();
          filling = null;
        }
        montage = fresh();
        stored = false;
        void read();
        // (0.6.181) A take made for this bobine that this page did not lay (followed after a reload): at its place.
      } else if (root && montage) layMissed();
      draw();
    },
    /** Leaving the page: nothing goes on playing, what is not kept yet is. */
    leave() {
      stop();
      // (0.6.169) Nothing goes on moving behind another page: the Flux of a take being made, a take opened late.
      media?.flux?.stop();
      if (media) media.flux = media.fluxFrom = null;
      if (opening) timers.clear(opening);
      opening = null;
      // (A creation in pause ends with the page; one running goes on, its take kept when made.)
      if (filling?.stage === 'paused') filling = null;
      // (0.6.146) What Moodix AI is writing is let go. (0.6.160) The text of a take of a series too, and
      // the series ends there: the Studio keeps the bobine in its conversation while a take is made
      // (0.6.81), not while one is written. But it ended without a word, while a series left a moment
      // later, a take being made, went on: the line of that take says why now.
      // (Ended now: not when the chat model, let go, answers at last.)
      if (writing?.series) {
        failed.set(writing.id, LEFT_WRITING);
        filling = null;
      }
      writing?.controller.abort();
      writing = null;
      // (0.6.162) What it is arranging too; what was written for it stays in its field.
      arranging?.controller.abort();
      arranging = null;
      live.ask = null;
      // (0.6.153) The wand is put down, the enrichment asked let go.
      wand = false;
      page?.removeEventListener?.('keydown', pageKeys);
      closeExport();
      enriched?.abort();
      enrichingId = null;
      asking = null;
      root = parts = null;
      held = ghost = null;
      return keep();
    },
    // For the tests and the pointer of a later step: what is on the page, and the hands that change it.
    state: () => ({ wish, arranging, laid, asks, montage, stored, chosen, head, status, playing: Boolean(playing), list, making, filling, writing, failed: new Map(failed), zoom, scrolled, drawing, wand, enrichingId, lit, downloading, fetchError, past: past.length, future: future.length }),
    undo: () => travel(true),
    redo: () => travel(false),
    lay,
    zoomTo,
    createAll,
    askAgent,
    select: id => {
      chosen = id;
      draw();
    },
    play,
    seek,
    keep,
    exportFilm,
    exportTakes,
    archive,
    fitBar,
  };
}
