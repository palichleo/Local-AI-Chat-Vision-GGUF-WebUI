/**
 * The time a take took to make (0.6.93). The server counts it (lib/tool-runtime.mjs), from the
 * user's go (« Générer », « Confirmer et générer », an image made at once) to its file written by the
 * engine: the same for every page that shows it, one reloaded meanwhile or another tab. Written
 * « 42 s », « 2 min 05 s », « 1 h 02 min » everywhere; never « Durée », which is the length of a clip
 * or a sound (« 24.71 S »).
 */
const two = value => String(value).padStart(2, '0');
const measured = value => Number.isFinite(value) && value >= 0;

/** « 42 s », « 2 min 05 s », « 1 h 02 min »: the whole seconds gone by, as a clock shows them; '' unknown. */
export function generationTime(ms) {
  if (!measured(ms)) return '';
  const seconds = Math.floor(ms / 1000),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor(seconds / 60) % 60;
  if (hours) return `${hours} h ${two(minutes)} min`;
  return minutes ? `${minutes} min ${two(seconds % 60)} s` : `${seconds} s`;
}

/**
 * What the record of a take says of the time it took. Since 0.6.93 the whole of it (`whole`), from
 * its go to its file, with what came before the engine (`prepare`: the checks, its sources, the chat
 * model leaving the card) and the engine itself (`engine`: its models loaded, the computation, the
 * file written). Before, the engine's alone (`generation_duration_ms`), never to be passed off as the
 * whole: what came before it was not counted. Null when nothing was (a take of ComfyUI before the
 * engine of Moodix).
 */
export function takeTime(record) {
  const parameters = record?.parameters ?? {},
    time = parameters.generation_time;
  if (measured(time?.total_ms))
    return {
      ms: time.total_ms,
      whole: true,
      ...(measured(time.prepare_ms) ? { prepare: time.prepare_ms } : {}),
      ...(measured(time.engine_ms) ? { engine: time.engine_ms } : {}),
    };
  return measured(parameters.generation_duration_ms)
    ? { ms: parameters.generation_duration_ms, whole: false, engine: parameters.generation_duration_ms }
    : null;
}

/** Under a take (« Générée en 1 min 12 s »), once the whole of its time is known; '' otherwise. */
export function madeIn(record) {
  const time = takeTime(record);
  return time?.whole ? 'Générée en ' + generationTime(time.ms) : '';
}

/**
 * How long a take has been in the making, on a page: `update({ ms, running })` with what the server
 * says of it (the fourth value of a progress, generation-runtime.mjs). Between two of its answers
 * (0.7 s) the count goes on by itself, a second at a time; once `running` is false (its file is
 * written), it says that time and stops. Counted from the earliest start the answers imply: one that
 * took longer to come says a later one, and the count never goes back. `write(text)` gets each new text.
 */
export function elapsedClock(write, { now = () => performance.now(), every = 250, timers = globalThis } = {}) {
  let since = null,
    fixed = null,
    timer = null,
    shown = null;
  const tick = () => {
    const text = fixed ?? (since === null ? '' : generationTime(now() - since));
    if (text !== shown) write((shown = text));
  };
  function stop() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  }
  return {
    update(elapsed) {
      if (!measured(elapsed?.ms)) return;
      if (elapsed.running === false) {
        stop();
        fixed = generationTime(elapsed.ms);
        return tick();
      }
      const start = now() - elapsed.ms;
      since = since === null ? start : Math.min(since, start);
      fixed = null;
      tick();
      if (timer === null) {
        timer = timers.setInterval(tick, every);
        // (In Node, for the tests: a count left going keeps no process alive.)
        timer?.unref?.();
      }
    },
    stop,
    /** Another take: counted from nothing again. */
    reset() {
      stop();
      since = fixed = shown = null;
    },
    /** What it says now. */
    get text() {
      return shown ?? '';
    },
  };
}
