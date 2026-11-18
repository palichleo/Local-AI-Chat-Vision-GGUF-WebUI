/**
 * Before the first message (etats-maquette.md, 50): with no llama-server or no LLM registered, the
 * message box gives way to a card of the same glass, in two steps.
 * - The engine: the official build for this computer (« Installer », as in Mise à jour ›
 *   Composants: downloaded, checked, then used), or the user's own (« Choisir le mien… »).
 * - The LLM: a GGUF file of this computer (« Choisir un fichier… »), registered and chosen.
 * Each step has its ring: empty, ringed in the accent while it runs, a green tick once done. Both
 * done, the card is the message box again and the model loads (`onDone`).
 * `config()` is the configuration as the page has it; `onConfig(config, models)` takes the new one.
 */
const WORKING = ['checking', 'downloading', 'unpacking', 'trying', 'switching'];
// What the server says while Windows holds a file it just wrote (lib/llama-builds.mjs).
const WAITING = /en attente que Windows libère/;
const megabytes = bytes => Math.max(1, Math.round((bytes || 0) / 1048576)).toLocaleString('fr-FR') + ' Mo';

export function setupFirstLaunch({ api, node, icon, host, config, onConfig, onDone = () => {} }) {
  let shown = false,
    // The official build, read once per showing: « b12359 · CUDA 13.5 · 578 Mo ».
    offer = null,
    asked = false,
    // The engine being installed: { percent, label } (percent null while it unpacks or tries).
    installing = null,
    picking = '',
    errors = { engine: '', llm: '' },
    following = false;

  const done = () => ({ engine: Boolean(config().enginePath), llm: Boolean(config().modelPath) });

  function ring(state) {
    const mark = node('span', 'setup-ring' + (state === 'done' ? ' is-done' : state === 'busy' ? ' is-current' : ''));
    mark.setAttribute('aria-hidden', 'true');
    if (state === 'done') mark.append(icon('check'));
    return mark;
  }
  function button(className, text, onclick, disabled = false) {
    const element = node('button', className, text);
    element.type = 'button';
    element.disabled = disabled;
    element.onclick = onclick;
    return element;
  }
  function step({ title, text, state, actions, error }) {
    const row = node('div', 'setup-step' + (state === 'done' ? ' is-done' : '')),
      words = node('div', 'setup-words');
    words.append(node('p', 'setup-title', title), node('p', 'setup-text', text));
    if (error) {
      const alert = node('p', 'setup-error', error);
      alert.setAttribute('role', 'alert');
      words.append(alert);
    }
    const side = node('div', 'setup-actions');
    side.append(...actions);
    row.append(ring(state), words, side);
    return row;
  }
  /** « TÉLÉCHARGEMENT · 64 % » and its line, in place of the buttons while the engine comes. */
  function progress() {
    const box = node('div', 'setup-progress'),
      head = node('div', 'setup-progress-head'),
      line = node('span', 'setup-progress-line'),
      fill = node('span', 'setup-progress-fill');
    head.append(
      node('span', '', installing.label),
      node('span', '', Number.isFinite(installing.percent) ? installing.percent + ' %' : ''),
    );
    fill.style.width = (Number.isFinite(installing.percent) ? installing.percent : 100) + '%';
    if (!Number.isFinite(installing.percent)) line.classList.add('is-indeterminate');
    line.append(fill);
    box.append(head, line);
    if (installing.note) box.append(node('p', 'setup-progress-note', installing.note));
    box.setAttribute('role', 'status');
    return box;
  }
  function render() {
    if (!shown) return;
    const state = done(),
      count = Number(state.engine) + Number(state.llm),
      head = node('div', 'setup-head'),
      best = offer?.candidates?.[0];
    head.append(node('span', 'setup-kicker', 'Avant le premier message'), node('span', 'setup-count', `${count} / 2`));
    const engineText =
      'llama-server fait tourner Moodix AI sur cet ordinateur.' +
      (best ? ` La version officielle pour votre carte : ${offer.tag} · ${best.label} · ${megabytes(best.size)}.` : '');
    const engine = step({
      title: 'Le moteur',
      text: state.engine ? 'llama-server est prêt sur cet ordinateur.' : engineText,
      state: state.engine ? 'done' : installing || picking === 'engine' ? 'busy' : 'todo',
      error: errors.engine,
      actions: state.engine
        ? []
        : installing
          ? [progress()]
          : [
              button('secondary setup-install', 'Installer', () => void install(), !best || Boolean(picking)),
              button('text-button setup-own', 'Choisir le mien…', () => void chooseEngine(), Boolean(picking)),
            ],
    });
    const llm = step({
      title: 'Le LLM',
      text: state.llm
        ? 'Moodix AI est choisi.'
        : 'Un fichier GGUF sur cet ordinateur : Qwen 3.5, Gemma 4, Mistral Small… Le projecteur de vision est facultatif.',
      state: state.llm ? 'done' : picking === 'model' ? 'busy' : 'todo',
      error: errors.llm,
      actions: state.llm
        ? []
        : [button('secondary setup-model', 'Choisir un fichier…', () => void chooseModel(), Boolean(picking))],
    });
    host.replaceChildren(
      head,
      engine,
      llm,
      node('p', 'setup-foot', 'Les images, les vidéos et les sons se règlent ensuite, dans Paramètres › Workflows.'),
    );
  }
  async function readOffer() {
    if (asked) return;
    asked = true;
    try {
      const job = await (await api('llama')).json();
      if (WORKING.includes(job.state)) void follow();
      offer = await (await api('llama/check', {})).json();
    } catch {
      // No official build to offer (offline): « Choisir le mien… » stays.
    }
    render();
  }
  async function install() {
    errors.engine = '';
    installing = { label: 'Téléchargement', percent: 0 };
    render();
    try {
      await api('llama/install', {});
    } catch (error) {
      installing = null;
      errors.engine = error.message;
      render();
      return;
    }
    await follow();
  }
  /** The installation as it goes (GET /api/llama), until the engine is in the configuration. */
  async function follow() {
    if (following) return;
    following = true;
    try {
      for (;;) {
        const job = await (await api('llama')).json();
        if (job.state === 'done') {
          installing = null;
          onConfig({ ...config(), enginePath: job.result.enginePath });
          return;
        }
        if (job.state === 'error') {
          installing = null;
          errors.engine = job.error;
          return;
        }
        // Said while Windows holds a file it just wrote (0.6.90: « 100 % » for a minute, without a word).
        const note = WAITING.test(job.step ?? '') ? job.step : '';
        installing =
          job.state === 'downloading'
            ? { label: 'Téléchargement', percent: job.total ? Math.floor((job.received / job.total) * 100) : 0, note }
            : { label: 'Installation', percent: null, note };
        render();
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    } catch (error) {
      installing = null;
      errors.engine = error.message;
    } finally {
      following = false;
      render();
    }
  }
  async function choose(kind) {
    const result = await (await api('files/choose', { kind, initialPath: '' })).json();
    return result.path || '';
  }
  async function chooseEngine() {
    errors.engine = '';
    picking = 'engine';
    render();
    try {
      const path = await choose('engine');
      if (path) onConfig((await (await api('config', { ...config(), enginePath: path })).json()).config);
    } catch (error) {
      errors.engine = error.message;
    } finally {
      picking = '';
      render();
    }
  }
  async function chooseModel() {
    errors.llm = '';
    picking = 'model';
    render();
    try {
      const path = await choose('model');
      if (path) {
        const name = path.split(/[\\/]/).pop().replace(/\.gguf$/i, '');
        const added = await (await api('models/add', { name, modelPath: path, projectorPath: '' })).json();
        const selected = await (await api('models/select', { id: added.profile.id })).json();
        onConfig(selected.config, added.models);
      }
    } catch (error) {
      errors.llm = error.message;
    } finally {
      picking = '';
      render();
    }
  }
  return {
    /** Shown while a step is left (`needed`); both done after it was shown, the model loads. */
    sync(needed) {
      if (needed) {
        const first = !shown;
        shown = true;
        host.hidden = false;
        if (first) void readOffer();
        render();
        return;
      }
      if (!shown) return;
      shown = false;
      host.hidden = true;
      host.replaceChildren();
      onDone();
    },
    get shown() {
      return shown;
    },
  };
}
