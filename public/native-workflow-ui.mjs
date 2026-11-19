import { setupGenerationRuntime } from './generation-runtime.mjs';
import { licenseBlock, restrictedOf } from './model-licenses.mjs';
import {
  GROUPS,
  licenseSentence,
  lineOf,
  linesOf,
  progressShare,
  progressText,
  sizeText,
  speedOf,
  versionData,
} from './models-page.mjs';
import { CHOICE_NAMES, SETTING_HELP, SETTING_NAMES, isSetting } from './setting-names.mjs';

// Interface wording for parameters; component, role and family labels come from the family manifests.
// (0.6.94) In their own module: the server names a setting it refuses the way this editor does.
const labels = SETTING_NAMES;
const choiceLabels = CHOICE_NAMES;
// Each folder setting: its field, and the folder it shows when nothing is set (`folders` of
// the server). The first is the models directory; the others, a folder apart for one kind of file.
const folderControls = {
  modelsDir: ['generation-models-dir', 'models'],
  modelRoot: ['native-convert-root', 'model'],
  vaeRoot: ['generation-vae-root', 'vae'],
  loraRoot: ['generation-lora-root', 'lora'],
  textEncoderRoot: ['generation-text-encoder-root', 'textEncoder'],
  tokenizerRoot: ['generation-tokenizer-root', 'tokenizer'],
  upscaleRoot: ['generation-upscale-root', 'upscaler'],
  latentUpscaleRoot: ['generation-latent-upscale-root', 'latentUpscaler'],
};
// (0.6.131) What the « ? » of each line of « Dossiers à part » says the folder holds.
const folderHelp = {
  modelRoot: 'Les fichiers des modèles eux-mêmes (Krea 2, LTX 2.5, MiniMax H3…).',
  vaeRoot: 'Les fichiers qui transforment le calcul d’un modèle en image, en vidéo ou en son.',
  loraRoot: 'Vos LoRA : ceux que le Studio propose, et ceux des réglages d’un modèle.',
  textEncoderRoot: 'Les fichiers qui lisent le prompt pour un modèle.',
  tokenizerRoot: 'Les dossiers qui découpent le prompt pour un encodeur de texte ; rangés avec les encodeurs de texte.',
  upscaleRoot: 'Les modèles qui agrandissent une image ou une vidéo (Real-ESRGAN).',
  latentUpscaleRoot: 'Les fichiers qui doublent la taille d’une vidéo pendant sa création (LTX 2.5).',
};
// What an optional component that is used, but left to the folders of the settings, holds in
// place of a file: an id no file is registered under, so the server looks in the folders.
const AUTOMATIC = 'automatic';
// What the line of a file shows in the place of its name when the file is nowhere to be found.
const MISSING = 'Introuvable';
/** The versions (draft, final) a workflow can be made at: its profiles apply only to these. */
function stagesOf(manifest, workflow) {
  const stage = workflow.parameters?.stage;
  if (!stage || !workflow.profiles) return [];
  if (stage.policy === 'fixed') return [stage.value];
  return stage.choices ?? manifest?.parameters?.stage?.choices ?? Object.keys(workflow.profiles);
}
const shownChoice = value => choiceLabels[value] ?? (value === '' ? 'vide' : String(value).replace('.', ','));
/**
 * Why a setting of a workflow changes nothing in what is made, or '' when it does (17/11: in the
 * editor, half the fields of some workflows did nothing). `part`: the whole `parameter`, its
 * `value` (a fixed value, or the default of one left to the assistant), its `description` (what
 * the assistant is told of it), or its value in the `draft` or `final` profile. `workflow`: its
 * parameters (policies) and profiles as they stand. tests/workflow-options.mjs holds each reason
 * against what the server sends the engine.
 */
export function inertSetting(manifest, workflow, name, part) {
  const spec = manifest?.parameters?.[name] ?? {},
    policy = workflow.parameters?.[name];
  // Declared by the family, read by no engine of it (`attention` from the time of ComfyUI).
  if (spec.unused) return spec.unused;
  // One value only: any other is refused, and that one is the model's own (LTX's 8 steps).
  if (spec.choices?.length === 1)
    return `Seule valeur que ${manifest.label} accepte : ${shownChoice(spec.choices[0])}.`;
  if (part === 'draft' || part === 'final') {
    const stages = stagesOf(manifest, workflow);
    if (!stages.includes(part))
      return workflow.parameters?.stage
        ? `Jamais utilisé : « ${labels.stage} » ne prend pas cette version.`
        : `Jamais utilisé : ce workflow n’a pas de réglage « ${labels.stage} ».`;
    // The router always passes a length (the one asked, else the default): the profile's is never used.
    if (name === 'frames' && policy?.policy === 'model')
      return `La durée est celle demandée, sinon « ${labels.frames} » des réglages de génération.`;
    return '';
  }
  if (part === 'value') {
    if (name === 'frames' && policy?.policy === 'model') return '';
    const stages = stagesOf(manifest, workflow);
    if (stages.length && stages.every(stage => Object.hasOwn(workflow.profiles[stage]?.parameters ?? {}, name)))
      return 'Remplacé par « Brouillon et vidéo finale », plus bas : c’est là qu’il se règle.';
    return '';
  }
  // A clip length is asked of the model in seconds: what is said of the frame count never reaches it.
  if (part === 'description' && name === 'frames' && workflow.mediaType === 'video')
    return 'Le modèle donne une durée en secondes : cette consigne ne lui est pas transmise.';
  return '';
}
/**
 * What a setting does that the user would not expect, or '': at a denoise of 1, Krea 2 starts from
 * pure noise and the image to modify is encoded, then ignored (runner/pipelines/krea2.py).
 */
export function settingWarning(manifest, workflow, name) {
  if (name !== 'denoise') return '';
  const policy = workflow.parameters?.denoise,
    value = policy?.policy === 'fixed' ? policy.value : policy?.default,
    source = (workflow.references ?? []).some(slot => manifest?.roles?.[slot.role]?.as === 'source');
  return source && value === 1
    ? 'À 1, l’image à modifier est ignorée : le moteur part d’un bruit pur. Baissez le débruitage (0,6, par exemple : au-dessus de 0,7 elle ne compte presque plus) pour qu’elle serve.'
    : '';
}
export function setupNativeWorkflows(options) {
  const {
      api,
      state,
      node,
      notice,
      onSettingsBusyChange = () => {},
      // Brings the Hugging Face token field into view, with a message saying why.
      showTokenField: askToken = () => {},
      // A help bubble whose text changed while it may be shown.
      onHelpChange = () => {},
    } = options,
    $ = id => document.getElementById(id);
  const runtime = setupGenerationRuntime(options);
  let families = [];
  const familyOf = name => families.find(item => item.family === name);
  // Several families share a role or a component name with their own meaning (a source video
  // is extended by LTX, enlarged by Real-ESRGAN): the open workflow's family names it first.
  const ownFirst = () => {
    const own = familyOf(draft?.pipeline);
    return own ? [own, ...families.filter(item => item !== own)] : families;
  };
  const componentLabel = role =>
    ownFirst()
      .map(item => item.components[role]?.label)
      .find(Boolean) ||
    labels[role] ||
    role;
  const parameterSpec = name => familyOf(draft?.pipeline)?.parameters[name] || {};
  const typeFor = (name, policy) =>
    parameterSpec(name).type ||
    policy.type ||
    (typeof policy.value === 'boolean' ? 'boolean' : typeof policy.value === 'string' ? 'string' : 'number');
  let workflows = [],
    assets = [],
    folders = {},
    // The folder of each kind of file when none is set apart for it (« Détecter »).
    folderDefaults = {},
    runner = {},
    busy = false,
    working = false,
    version = 0,
    refreshVersion = 0,
    controller = new AbortController();
  let draft = null,
    baseline = '',
    // What Moodix ships of the open workflow when the user changed nothing of it (baseOf), and the
    // name of its model on the page.
    opened = null,
    shownName = '',
    returnFocus = null,
    parentScroll = 0,
    afterBack,
    readComponents = [],
    readParameters = [],
    readLoras = [],
    readEnhance = null,
    // The lines of the settings by name (what refreshInert warns of), every line that holds a
    // value (what « Remettre les valeurs de base » takes back), and what the lines of the draft
    // and the final write into the profiles.
    parameterControls = {},
    valueLines = [],
    profileWriters = [],
    // While the editor is drawn, refreshInert waits for the end (renderEditor calls it once).
    rendering = false,
    // Shipped workflows the user deleted (hidden until an update changes them).
    hiddenWorkflows = 0,
    // What the shipped workflows can download, the download in progress, whether a token is kept.
    downloads = { offers: {}, job: { state: 'idle' }, hasToken: false },
    following = false,
    // The workflow whose licences with conditions are shown to be confirmed, before its download;
    // its « J’ai lu, télécharger », which takes the focus when the list is drawn again.
    licenseAsked = '',
    confirmFocus = null,
    // (0.6.102) A workflow saved, set back, deleted or shown again since the settings opened: the
    // Studio reads its tools again once they close (takeChanges, app.js).
    changedWorkflows = false;
  // Paths being registered from a file field: Save waits for them.
  const pendingFiles = new Set();
  const element = (tag, id, text = '') => {
    const value = node(tag, '', text);
    if (id) value.id = id;
    return value;
  };
  const icon = name => {
    // A page without SVG (the tests): a plain mark in its place.
    if (typeof document.createElementNS !== 'function') return node('span', 'icon-' + name);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  };
  const formatSize = bytes =>
    bytes >= 1024 ** 3
      ? (bytes / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go'
      : Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';
  const button = (text, action, className = 'secondary') => {
    const value = node('button', className, text);
    value.type = 'button';
    value.onclick = action;
    return value;
  };
  const input = (id, value, type = 'text') => {
    const control = element('input', id);
    control.type = type;
    if (type === 'checkbox') control.checked = Boolean(value);
    else control.value = value ?? '';
    return control;
  };
  const select = (id, items, value) => {
    const control = element('select', id);
    for (const [key, label] of items) {
      const option = element('option', null, label);
      option.value = key;
      control.append(option);
    }
    control.value = value ?? '';
    return control;
  };
  function error(message) {
    $('native-workflow-error').textContent = message;
    $('native-workflow-error').hidden = !message;
    if (message) {
      $('native-workflow-error').scrollIntoView?.({ block: 'nearest' });
      $('native-workflow-error').focus();
    }
  }
  function setBusy(value) {
    busy = value;
    const disabled = busy || working;
    for (const root of [$('workflow-editor'), $('settings-form')])
      for (const control of root.querySelectorAll('input,textarea,select,button')) {
        if (
          root === $('settings-form') &&
          ![
            'generation-enabled',
            'generation-auto',
            'generation-auto-video',
            'generation-review-images',
            'generation-review',
            'generation-test',
            'native-convert-root',
            'native-convert-root-browse',
            'generation-vae-root',
            'generation-vae-root-browse',
            'generation-lora-root',
            'generation-lora-root-browse',
            // (« Détecter » of each folder: greyed while its folder is the one of the models folder.)
            ...Object.values(folderControls).map(([id]) => id + '-detect'),
          ].includes(control.id) &&
          !control.dataset.nativeControl
        )
          continue;
        control.disabled = disabled || control.dataset.unavailable === 'true';
      }
    $('workflow-editor').setAttribute('aria-busy', String(working));
  }
  async function run(action) {
    if (working) return;
    working = true;
    setBusy(busy);
    onSettingsBusyChange(true);
    try {
      return await action(controller.signal);
    } finally {
      working = false;
      setBusy(busy);
      onSettingsBusyChange(false);
    }
  }
  function folderValues() {
    return Object.fromEntries(
      Object.entries(folderControls).map(([key, [id, role]]) => {
        const path = $(id).value.trim();
        // Nothing is kept of a folder that is the one of the models folder: the one shown while
        // none was set apart, or the one « Détecter » gave back.
        return [
          key,
          (path === folders[role] && !state.generation?.[key]) || path === folderDefaults[role] ? '' : path,
        ];
      }),
    );
  }
  /**
   * A line of « Dossiers à part » as its folder stands (0.6.131, maquette D1): its « ? » says what
   * the folder holds and which one it is, « Détecter » is greyed while it is the one of the models
   * folder, and a path longer than its field shows its end (the folder, not the drive).
   */
  function showFolder(key) {
    const [id, role] = folderControls[key],
      field = $(id),
      detect = $(id + '-detect'),
      help = $(id + '-help');
    if (!detect || !help) return;
    const path = field.value.trim(),
      usual = folderDefaults[role] || '',
      own = Boolean(path && usual && path !== usual);
    detect.dataset.unavailable = String(!own);
    detect.disabled = busy || working || !own;
    detect.title = own
      ? 'Reprendre le dossier du dossier des modèles : ' + usual
      : 'C’est déjà le dossier du dossier des modèles.';
    const said = [
      folderHelp[key],
      own ? 'Dossier à part, choisi par vous : ' + path + '.' : path ? 'Dans le dossier des modèles : ' + path + '.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    help.setAttribute('aria-label', 'Aide : ' + said);
    help.dataset.help = said;
    onHelpChange(help);
    field.dataset.long = String(field.scrollWidth > field.clientWidth + 1);
  }
  const showFolders = () => {
    for (const key of Object.keys(folderControls)) showFolder(key);
  };
  function componentFolder(role) {
    // « upscaler » is an image model for Real-ESRGAN and a latent one for LTX: each has its folder.
    const kind =
      role === 'audioVae'
        ? 'vae'
        : familyOf(draft?.pipeline)?.components[role]?.folder === 'latent_upscale_models'
          ? 'latentUpscaler'
          : role;
    const key = Object.keys(folderControls).find(key => folderControls[key][1] === kind);
    return (key && $(folderControls[key][0]).value.trim()) || folders[kind] || folders[role] || '';
  }
  function values() {
    // 100 generations a message, imposed by the server; the Python of before, kept as it is (its
    // setting left the interface: parametres-maquette.md).
    return {
      enabled: $('generation-enabled').checked,
      autoAllow: $('generation-auto').checked,
      autoAllowVideos: $('generation-auto-video').checked,
      confirmReplacements: $('generation-confirm-replace')?.checked === true,
      reviewImages: $('generation-review-images').checked,
      reviewVideos: $('generation-review').checked,
      // (0.6.105) On unless its box is there and unticked.
      warmEngine: $('generation-warm')?.checked !== false,
      pythonPath: state.generation?.pythonPath || '',
      ...folderValues(),
    };
  }
  function runnerStatus() {
    const reasons = runner.error || runner.reason || '',
      labels = {
        installing: 'Préparation automatique',
        starting: 'Démarrage',
        ready: 'Prêt',
        stopped: 'Arrêté',
        unavailable: 'Indisponible',
      };
    $('generation-status').textContent =
      `Environnement de génération : ${labels[runner.state] || runner.state || 'indisponible'}${runner.progress ? ' · ' + runner.progress : ''}${reasons ? ' · ' + reasons : ''}`;
  }
  function updateRunner(value) {
    if (!value) return;
    const ready = runner.state !== 'ready' && value.state === 'ready';
    runner = value;
    runnerStatus();
    if (ready && $('settings').open) void refresh({ settings: false }).catch(failure => notice(failure.message));
  }
  /** A licence with conditions among those of what a workflow downloads: read and confirmed first. */
  const asksLicense = offer => restrictedOf(offer?.files).length > 0;
  // (0.6.119) The page « Modèles » (maquette du 19/11, captures 65 à 69): the lines the server
  // sends (`models`), those the user unfolded, and the speed of the download under way (bytes a
  // second, with what it was last measured from). ComfyUI is no longer said on this page.
  let models = [];
  const openModels = new Set();
  let speed = 0,
    sampled = null;

  /** Starts the download of what `record` lacks; `accepted`: its licences with conditions were read and accepted. */
  async function startDownload(record, accepted) {
    try {
      importStatus('');
      licenseAsked = '';
      speed = 0;
      sampled = null;
      downloads.job = await (await api('downloads/start', { id: record.id, ...(accepted ? { accepted: true } : {}) })).json();
      renderList();
      followDownload();
    } catch (failure) {
      renderList();
      importStatus(failure.message, true);
    }
  }
  /**
   * « Télécharger · 27,3 Go », in the place of the version (capture 65): what the model lacks, the
   * version Moodix ships it with. Its licences are under the pointer; one with conditions is shown
   * at the click, to accept or to refuse (19/11), and nothing is downloaded before.
   */
  function downloadControl(model, record, offer, bytes) {
    const size = sizeText(bytes),
      start = button(
        '',
        () => {
          if (offer.needsToken)
            return askToken(
              `${model.name} demande un compte Hugging Face : acceptez la licence sur ${offer.page} avec ce compte, puis collez ici un jeton de lecture et relancez le téléchargement.`,
            );
          if (asksLicense(offer)) {
            licenseAsked = record.id;
            confirmFocus = null;
            importStatus('');
            renderList();
            return void confirmFocus?.focus();
          }
          return startDownload(record, false);
        },
        'secondary model-download',
      );
    start.append(icon('download'), node('span', '', 'Télécharger · ' + size));
    start.setAttribute('aria-label', `Télécharger ${model.name} (${size})`);
    start.title = licenseSentence(offer.files) || `Télécharger ${model.name} (${size})`;
    start.dataset.nativeControl = 'true';
    if (downloads.job.state === 'running') {
      start.disabled = true;
      start.dataset.unavailable = 'true';
      start.title = 'Un autre téléchargement est en cours.';
    }
    return start;
  }
  /** « Arrêter », in the place of « Télécharger » while its download runs (capture 68). */
  function stopControl() {
    const stop = button(
      'Arrêter',
      async () => {
        try {
          downloads.job = await (await api('downloads/cancel', {})).json();
        } catch (failure) {
          importStatus(failure.message, true);
        }
      },
      'text-button model-stop',
    );
    stop.title = 'Arrêter le téléchargement ; il reprendra où il en était.';
    stop.dataset.nativeControl = 'true';
    return stop;
  }
  /** The licences with conditions of a download, under its line: « Refuser » downloads nothing. */
  function licenseConfirm(record, offer) {
    const block = node('div', 'model-license'),
      actions = node('div', 'model-license-actions'),
      licenses = licenseBlock({ node, files: offer.files, confirm: true }),
      refuse = button(
        'Refuser',
        () => {
          licenseAsked = '';
          renderList();
        },
        'text-button',
      ),
      accept = button('Accepter et télécharger', () => startDownload(record, true), 'secondary');
    refuse.dataset.nativeControl = accept.dataset.nativeControl = 'true';
    confirmFocus = accept;
    actions.append(refuse, accept);
    if (licenses) block.append(licenses);
    block.append(actions);
    return block;
  }
  /** Keeps the version at `path` for the model of the workflow `workflowId`; the page is drawn with it. */
  async function pickVersion(workflowId, path) {
    try {
      importStatus('');
      const result = await run(async signal =>
        (await api('generation/models/version', { workflowId, path }, { signal })).json(),
      );
      if (result) {
        changedWorkflows = true;
        apply(result, { settings: false });
      }
    } catch (failure) {
      importStatus(failure.message, true);
    }
  }
  /**
   * « Proposé à Moodix AI » on the line of a model (0.6.130, maquette M1): the switch of its page,
   * in sight without opening anything, under « Moodix AI » at the head of the list. On when every
   * workflow of the model is offered; a click offers them all, or none. A model that cannot be
   * made here yet (to download, or a card it cannot run on) has it greyed, and says why.
   */
  function offeredControl(model, shown) {
    const records = shown.records.map(([, record]) => record),
      label = node('label', 'history-toggle model-ai'),
      box = input(null, records.length > 0 && records.every(record => record.enabled !== false), 'checkbox'),
      held = !records.length
        ? 'Ce modèle n’est pas installé.'
        : ['download', 'downloading'].includes(shown.state)
          ? 'À télécharger d’abord.'
          : shown.state === 'unavailable'
            ? 'Indisponible sur cet ordinateur.'
            : '';
    box.setAttribute('aria-label', `Proposer ${model.name} à Moodix AI`);
    box.dataset.nativeControl = 'true';
    label.title = held || (box.checked ? 'Proposé à Moodix AI' : 'Pas proposé à Moodix AI : il reste dans le Studio');
    if (held) {
      box.checked = false;
      box.dataset.unavailable = 'true';
      box.disabled = true;
      label.dataset.held = 'true';
    }
    box.onchange = async () => {
      const enabled = box.checked;
      try {
        importStatus('');
        // Each workflow of the model, as its page would save it with the switch turned.
        const done = await run(async signal => {
          for (const record of records)
            if ((record.enabled !== false) !== enabled)
              await (await api('generation/workflows', { ...record, enabled }, { signal })).json();
          return true;
        });
        // Nothing ran (another action of the settings is under way): the switch is as it was.
        if (!done) {
          box.checked = !enabled;
          return;
        }
        changedWorkflows = true;
        await refresh({ settings: false });
      } catch (failure) {
        box.checked = !enabled;
        if (!controller.signal.aborted) importStatus(failure.message, true);
      }
    };
    label.append(box);
    return label;
  }
  /** What a workflow of a model that has several makes (Real-ESRGAN: images, videos). */
  const kindOf = record => ({ video: 'Vidéos', audio: 'Sons' })[record.mediaType] ?? 'Images';
  /** « Réglages » (the sliders): the page of details of a model, the one behind the pencil of before. */
  function settingsControl(record, name) {
    const open = button('', () => edit(record, { name }), 'model-settings');
    open.append(icon('sliders'));
    open.setAttribute('aria-label', 'Réglages de ' + name);
    open.title = 'Réglages de ' + name;
    open.dataset.nativeControl = 'true';
    return open;
  }
  /**
   * A version in the block of its model (capture 66): its name, its format and its steps in mono,
   * « Utilisée » on the one that serves. Another one that the model reads as it is, is kept by a
   * click; one it does not read is greyed, with why under the pointer.
   */
  function versionRow(entry, version, extra = '') {
    const usable = version.how === 'direct' && !version.used,
      row = node(usable ? 'button' : 'div', 'model-version-row'),
      data = [...versionData(version), extra].filter(Boolean);
    if (usable) {
      row.type = 'button';
      row.onclick = () => pickVersion(entry.id, version.path);
      row.dataset.nativeControl = 'true';
    }
    row.dataset.source = version.source;
    if (version.used) row.dataset.used = 'true';
    if (version.how !== 'direct') row.dataset.unavailable = 'true';
    row.title =
      version.how === 'convert'
        ? `${version.file} : un GGUF se convertit avant de servir.`
        : version.how === 'refused'
          ? `${version.file} : format ${version.reason}, que ce modèle ne lit pas.`
          : version.file;
    row.append(node('span', 'model-version-name', version.name), node('span', 'model-version-data', data.join(' · ')));
    if (version.used) row.append(node('span', 'model-version-used', 'Utilisée'));
    else if (version.how === 'convert') row.append(node('span', 'model-version-used', 'À convertir'));
    else if (version.how === 'refused') row.append(node('span', 'model-version-used', 'Non lu'));
    return row;
  }
  /** The versions of a model, unfolded under its line; a model in several workflows says which is which. */
  function versionsBlock(model, shown) {
    const block = node('div', 'model-versions'),
      several = shown.records.length > 1;
    for (const [entry, record] of shown.records) {
      const extra = several ? kindOf(record) : '';
      if (Array.isArray(entry.versions) && entry.versions.length)
        for (const version of entry.versions) block.append(versionRow(entry, version, extra));
      else {
        // One version only, or none on this computer yet: its name, and whether it serves.
        // A model of several workflows (Real-ESRGAN: images, videos): each has its settings, at the
        // end of its own row (a fourth column, which the row says it has).
        const row = node('div', 'model-version-row' + (several ? ' has-settings' : '')),
          name = entry.version || (entry.versions ? 'Version fournie avec Moodix' : record.name);
        if (record.ready !== false) row.dataset.used = 'true';
        else row.dataset.unavailable = 'true';
        row.append(node('span', 'model-version-name', name), node('span', 'model-version-data', extra));
        if (record.ready !== false) row.append(node('span', 'model-version-used', 'Utilisée'));
        if (several) row.append(settingsControl(record, `${model.name} · ${kindOf(record)}`));
        block.append(row);
      }
      // Settings the user changed (« Réglages »): back to those Moodix ships.
      if (record.customized) {
        const reset = button(
          'Rétablir les réglages de Moodix',
          async () => {
            try {
              const result = await run(async signal =>
                (await api('generation/reset', { id: record.id }, { signal })).json(),
              );
              if (result) {
                changedWorkflows = true;
                apply(result, { settings: false });
              }
            } catch (failure) {
              importStatus(failure.message, true);
            }
          },
          'text-button model-reset',
        );
        reset.dataset.nativeControl = 'true';
        block.append(reset);
      }
    }
    return block;
  }
  /**
   * A model on its line (capture 65): its name, what it does, and at the right the version it uses,
   * « Télécharger » when it is to be downloaded, « Arrêter » while it is; then « Réglages » and the
   * chevron of its versions. What is in its way is said under its description, never in its place.
   */
  function modelLine(model) {
    const shown = lineOf(model, workflows, downloads),
      line = node('article', 'model-line'),
      row = node('div', 'model-row'),
      about = node('div', 'model-about'),
      side = node('div', 'model-side'),
      open = openModels.has(model.name),
      first = shown.records[0]?.[1];
    line.dataset.state = shown.state;
    line.dataset.model = model.name;
    if (open) line.dataset.open = 'true';
    about.append(node('span', 'model-does', model.does));
    if (shown.state === 'downloading') {
      const advance = node('span', 'model-progress-line'),
        bar = node('span', 'model-progress'),
        fill = node('span');
      fill.style.width = progressShare(downloads.job) + '%';
      bar.append(fill);
      advance.append(bar, node('span', 'model-progress-text', progressText(downloads.job, speed)));
      about.append(advance);
      side.append(stopControl());
    } else if (shown.state === 'download') side.append(downloadControl(model, shown.offer[0], shown.offer[1], shown.bytes));
    else {
      if (shown.note) {
        const quiet = ['waiting', 'off'].includes(shown.state),
          note = node('span', 'model-note' + (quiet ? '' : ' is-warning'), shown.note);
        note.title = shown.note;
        about.append(note);
      }
      side.append(node('span', 'model-version', shown.label.join(' · ')));
    }
    row.append(node('strong', 'model-name', model.name), about, side, offeredControl(model, shown));
    // (A model of several workflows: « Réglages » of its line are those of the first, and say so.)
    if (first)
      row.append(
        settingsControl(first, shown.records.length > 1 ? `${model.name} · ${kindOf(first)}` : model.name),
      );
    const chevron = button(
      '',
      () => {
        if (openModels.has(model.name)) openModels.delete(model.name);
        else openModels.add(model.name);
        renderList();
        $('workflow-list')
          .querySelector?.(`.model-line[data-model="${model.name.replaceAll('"', '\\"')}"] .model-chevron`)
          ?.focus();
      },
      'model-chevron',
    );
    chevron.append(icon('chevron'));
    chevron.setAttribute('aria-expanded', String(open));
    chevron.setAttribute('aria-label', 'Versions de ' + model.name);
    chevron.dataset.nativeControl = 'true';
    row.append(chevron);
    line.append(row);
    if (shown.state === 'download' && licenseAsked === shown.offer[0].id && asksLicense(shown.offer[1]))
      line.append(licenseConfirm(shown.offer[0], shown.offer[1]));
    if (open) line.append(versionsBlock(model, shown));
    return line;
  }
  /** Follows a download while it runs; at its end, the list says again what each workflow lacks. */
  function followDownload() {
    if (following) return;
    following = true;
    const step = async () => {
      try {
        const next = (await (await api('downloads')).json()).job;
        const ended = downloads.job.state === 'running' && next.state !== 'running';
        downloads.job = next;
        // How fast it comes, for the time left under its line.
        const now = { at: Date.now(), received: next.received ?? 0 };
        speed = ended ? 0 : speedOf(sampled, now, speed);
        sampled = ended ? null : now;
        if (ended) {
          following = false;
          if (next.state === 'error') importStatus(next.error, true);
          else if (next.state === 'done') importStatus(`${next.name} : fichiers téléchargés et rangés.`);
          if ($('settings').open) await refresh({ settings: false }).catch(() => renderList());
          else renderList();
          return;
        }
        if ($('settings').open && !draft) updateProgress();
      } catch {
        /* The next step tries again. */
      }
      if (following) setTimeout(step, 1000);
    };
    setTimeout(step, 1000);
  }
  /** The line of the download in progress, without drawing the list again: its trait, its figures. */
  function updateProgress() {
    const job = downloads.job;
    for (const line of $('workflow-list').querySelectorAll('.model-line[data-state="downloading"]')) {
      const fill = line.querySelector('.model-progress > span'),
        text = line.querySelector('.model-progress-text');
      if (fill) fill.style.width = progressShare(job) + '%';
      if (text) text.textContent = progressText(job, speed);
    }
  }
  function renderList() {
    const list = $('workflow-list'),
      lines = linesOf(models, workflows);
    list.replaceChildren();
    if (!lines.length) list.append(node('p', 'native-empty', 'Aucun modèle.'));
    for (const [key, title] of GROUPS) {
      const own = lines.filter(line => line.group === key);
      if (!own.length) continue;
      const group = node('section', 'model-group'),
        head = node('div', 'model-group-head');
      head.append(node('h3', 'model-group-title', title));
      // The column of the switches is named once, over the first of them.
      if (!list.children.length) head.append(node('span', 'model-ai-head', 'Moodix AI'));
      group.append(head);
      for (const model of own) group.append(modelLine(model));
      list.append(group);
    }
    if (hiddenWorkflows > 0) {
      const restore = button(
        `Réafficher les modèles retirés (${hiddenWorkflows})`,
        async () => {
          try {
            const result = await run(async signal => (await api('generation/unhide', {}, { signal })).json());
            if (result) {
              changedWorkflows = true;
              apply(result, { settings: false });
            }
          } catch (failure) {
            importStatus(failure.message, true);
          }
        },
        'text-button native-unhide',
      );
      restore.dataset.nativeControl = 'true';
      list.append(restore);
    }
    setBusy(busy);
  }
  function apply(result, { settings = true } = {}) {
    workflows = result.workflows || [];
    if (result.models) models = result.models;
    hiddenWorkflows = result.hiddenWorkflows ?? hiddenWorkflows;
    downloads = result.downloads || downloads;
    if (downloads.job?.state === 'running') followDownload();
    assets = result.assets || assets;
    folders = result.folders || folders;
    folderDefaults = result.defaultFolders || folderDefaults;
    if (result.families) families = result.families;
    runner = result.runner || runner;
    const config = result.config;
    if (config) {
      state.generation = config;
      if (settings) {
        $('generation-enabled').checked = config.enabled;
        $('generation-auto').checked = config.autoAllow;
        $('generation-auto-video').checked = config.autoAllowVideos !== false;
        if ($('generation-confirm-replace')) $('generation-confirm-replace').checked = config.confirmReplacements === true;
        $('generation-review-images').checked = config.reviewImages === true;
        $('generation-review').checked = config.reviewVideos === true;
        if ($('generation-warm')) $('generation-warm').checked = config.warmEngine !== false;
        for (const [key, [id, role]] of Object.entries(folderControls))
          $(id).value = config[key] || folders[role] || '';
      }
    }
    showFolders();
    runnerStatus();
    renderList();
  }
  async function refresh(settings) {
    const session = version,
      refresh = ++refreshVersion,
      signal = controller.signal;
    try {
      const result = await (await api('generation', undefined, { signal })).json();
      if (session === version && refresh === refreshVersion && !signal.aborted) apply(result, settings);
    } catch (failure) {
      if (session === version && refresh === refreshVersion && !signal.aborted) throw failure;
    }
  }
  function saved(result) {
    if (result.generation)
      apply({ config: result.generation, workflows: result.workflows || workflows, assets, runner });
  }
  async function browse(kind, initialPath, signal) {
    return (await (await api('files/choose', { kind, initialPath }, { signal })).json()).path;
  }
  // ------------------------------------------------------------------ The page of a model (0.6.128)
  // Maquette v2 du 19/11 : « Proposé à Moodix AI » en tête, puis une ligne par fichier (son nom, le
  // fichier, « Parcourir », « Détecter », « ? ») et une ligne par réglage (son nom, sa valeur, « ? »).
  // Un réglage est à l'utilisateur, jamais à Moodix AI (ownSettings, lib/native-workflows.mjs) : plus
  // de « Fixe / Assistant », plus de bornes. Ce qui fait partie d'une demande (ASKED : le prompt, la
  // taille, la durée…) n'est pas sur cette page, et reste dans le workflow tel qu'il est écrit.
  /** « ? » at the end of a line: its help under the pointer and on the focus (help-tips.mjs). */
  function setHelp(mark, text) {
    mark.setAttribute('aria-label', 'Aide : ' + text);
    mark.dataset.help = text;
    mark.hidden = !text;
    onHelpChange(mark);
  }
  function helpMark(text = '') {
    const mark = node('span', 'help-tip set-help', '?');
    mark.tabIndex = 0;
    mark.setAttribute('role', 'img');
    setHelp(mark, text);
    return mark;
  }
  /** A value as a line writes it: « 0,7 », « Brouillon », « activé », « aucun ». */
  const shownValue = value =>
    typeof value === 'boolean'
      ? value
        ? 'activé'
        : 'désactivé'
      : value === ''
        ? 'aucun'
        : (choiceLabels[value] ?? String(value).replace('.', ','));
  /**
   * The file of a line: pick a registered file from its suggestions, paste a path, or browse.
   * The chosen asset id is kept in a hidden control (`control`, whose onchange other parts of the
   * page listen to); the visible field shows the file's name. `detects`: whether the folders of the
   * settings can answer for it (a file of the model; never a LoRA the user adds).
   */
  function assetPicker(role, id, value, { detects = true, about = '', named = componentLabel(role) } = {}) {
    const spec = familyOf(draft.pipeline)?.components[role] || {},
      folder = ['tokenizer', 'pipeline'].includes(spec.format),
      compatibleAssets = () =>
        assets.filter(
          asset =>
            asset.kind === role &&
            (!(asset.family || asset.pipeline) || (asset.family || asset.pipeline) === draft.pipeline),
        ),
      control = input(id, value === AUTOMATIC ? '' : (value ?? ''), 'hidden'),
      field = input(id + '-file', ''),
      list = element('datalist', id + '-files'),
      // Left without a file, such a component takes the one the folders of the settings hold
      // for it (the server names it in `automatic`): it is a choice, not something missing.
      automatic = detects && (spec.format === 'tokenizer' || Boolean(spec.signature?.length)),
      found = (detects && draft.automatic?.[role]) || '',
      help = helpMark(),
      hint = folder ? 'Choisir un dossier…' : 'Choisir un fichier…';
    const fileName = path => path?.split(/[\\/]/).pop() || '';
    // Two files of the same name (in different folders) are told apart by their folder.
    function display(assetId) {
      const asset = assets.find(item => item.id === assetId);
      // Named by the workflow, and nowhere on this computer: said so, not shown as a file's name.
      if (!asset) return assetId ? MISSING : '';
      const name = asset.name || fileName(asset.path),
        twins = compatibleAssets().filter(item => item.id !== asset.id && (item.name || fileName(item.path)) === name);
      return twins.length ? `${name} (${fileName(asset.path?.replace(/[\\/][^\\/]*$/, ''))})` : name;
    }
    // The file the workflow names is not where it was: the one the folders hold stands in for it,
    // and is the one the line names (until 0.6.127 : « Ce fichier n’est plus à sa place : X le
    // remplace », said of a file found by itself under its own name).
    const stoodIn = () => Boolean(control.value && found && control.value === value);
    /** Where the file comes from, for the « ? » of the line. */
    function where() {
      if (stoodIn()) return `Pris dans le dossier des modèles : ${found}.`;
      if (control.value)
        return (
          assets.find(item => item.id === control.value)?.path ||
          'Ce fichier n’est pas sur cet ordinateur : téléchargez le modèle, ou choisissez-le avec « Parcourir ».'
        );
      if (!automatic) return '';
      return found
        ? `Trouvé seul dans le dossier des modèles : ${found}.`
        : 'Aucun fichier trouvé dans le dossier des modèles : choisissez-le avec « Parcourir ».';
    }
    let shown = '';
    function show() {
      shown = stoodIn() ? found : display(control.value);
      field.value = shown;
      // Found by itself: its name stands where a chosen file's would.
      field.placeholder = !control.value && automatic && found ? found : hint;
      field.dataset.automatic = String(automatic && !control.value);
      field.dataset.missing = String(shown === MISSING);
      // « Détecter »: back to the file of the folders, for a component that had one chosen here.
      // Greyed, and said why, where there is nothing to detect.
      detect.dataset.unavailable = String(!automatic || !control.value);
      detect.disabled = busy || working || detect.dataset.unavailable === 'true';
      detect.title = !automatic
        ? 'Ce fichier ne se reconnaît pas seul : choisissez-le avec « Parcourir ».'
        : control.value
          ? 'Ne plus fixer ce fichier : prendre celui du dossier des modèles.'
          : 'Déjà pris seul dans le dossier des modèles.';
      setHelp(help, [about, spec.help, where()].filter(Boolean).join(' '));
      list.replaceChildren(
        ...compatibleAssets().map(asset => {
          const option = element('option');
          option.value = display(asset.id);
          option.label = asset.path || '';
          return option;
        }),
      );
    }
    field.spellcheck = false;
    field.autocomplete = 'off';
    field.setAttribute('list', id + '-files');
    field.setAttribute('aria-label', 'Fichier · ' + named);
    async function register(chosen, signal) {
      if (!chosen) return;
      const result = await (
        await api('generation/assets', { path: chosen, kind: role, family: draft.pipeline }, { signal })
      ).json();
      signal.throwIfAborted();
      adopt(result.asset || result);
    }
    function adopt(asset) {
      if (!asset?.id) throw Error('Le fichier n’a pas pu être enregistré.');
      assets = assets.filter(item => item.id !== asset.id).concat(asset);
      choose(asset.id);
    }
    function choose(assetId) {
      control.value = assetId;
      show();
      control.onchange?.();
      error('');
    }
    // A registration in progress is awaited by Save, so a pasted path is never lost.
    function registerTyped(text) {
      const task = run(signal => register(text, signal))
        .catch(failure => {
          if (!controller.signal.aborted) error(failure.message);
        })
        .finally(() => pendingFiles.delete(task));
      pendingFiles.add(task);
      return task;
    }
    /** What the field holds now: a known file, a path to register, or nothing usable. */
    function resolveTyped({ final }) {
      const text = field.value.trim();
      if (!text || text === shown) return;
      const lower = text.toLowerCase(),
        known = compatibleAssets().find(
          asset => display(asset.id) === text || asset.path === text || asset.path?.toLowerCase() === lower,
        );
      if (known) return choose(known.id);
      if (!final) return;
      if (/[\\/]/.test(text)) return registerTyped(text);
      error(
        `Aucun fichier « ${text} » : choisissez-le dans la liste, collez son chemin complet ou utilisez « Parcourir ».`,
      );
    }
    // Focused, the field empties so the suggestions list every file; left empty, it shows the choice again.
    field.onfocus = () => {
      if (field.value === shown && shown) {
        field.placeholder = shown;
        field.value = '';
      }
    };
    field.onblur = () => {
      if (!field.value.trim()) show();
    };
    field.oninput = () => resolveTyped({ final: false });
    field.onchange = () => resolveTyped({ final: true });
    field.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      resolveTyped({ final: true });
    };
    const browseButton = button(
      'Parcourir',
      async () => {
        try {
          await run(async signal =>
            register(
              await browse(
                spec.picker || 'generation',
                (field.value.trim() !== shown && field.value.trim()) ||
                  assets.find(asset => asset.id === control.value)?.path ||
                  componentFolder(role) ||
                  '',
                signal,
              ),
              signal,
            ),
          );
        } catch (failure) {
          if (!controller.signal.aborted) error(failure.message);
        }
      },
      'set-act',
    );
    browseButton.setAttribute('aria-label', 'Parcourir · ' + named);
    const detect = button('Détecter', () => choose(''), 'set-act');
    detect.setAttribute('aria-label', 'Détecter · ' + named);
    show();
    return {
      field,
      browse: browseButton,
      detect,
      help,
      control,
      list,
      adopt,
      show,
      // Whether the folders of the settings can answer for this component (see `found`).
      automatic,
      selected() {
        const text = field.value.trim();
        if (text && text !== shown)
          throw Error(
            `Fichier non reconnu pour « ${named} » : choisissez-le dans la liste, collez son chemin complet ou utilisez « Parcourir ».`,
          );
        return control.value;
      },
      get compatible() {
        return compatibleAssets();
      },
    };
  }
  /**
   * A tokenizer must match its text encoder, and Comfy ships it inside its own code where
   * users rarely look: when the encoder is set and no tokenizer is, the server proposes one.
   */
  function suggestTokenizers(controls) {
    const pipeline = draft.pipeline;
    for (const [role, spec] of Object.entries(familyOf(pipeline)?.components || {})) {
      const tokenizer = controls[role],
        encoder = controls[spec.vocabularyOf];
      if (spec.format !== 'tokenizer' || !tokenizer || !encoder) continue;
      const suggest = async () => {
        const encoderId = encoder.picker.control.value;
        if (!encoderId || tokenizer.picker.control.value || !assets.some(asset => asset.id === encoderId)) return;
        try {
          const { asset } = await (
            await api('generation/tokenizer', { encoder: encoderId, family: pipeline }, { signal: controller.signal })
          ).json();
          if (asset && draft.pipeline === pipeline && !tokenizer.picker.control.value) tokenizer.picker.adopt(asset);
        } catch {
          // No suggestion: the user picks the folder.
        }
      };
      const previous = encoder.picker.control.onchange;
      encoder.picker.control.onchange = () => {
        previous?.();
        void suggest();
      };
      void suggest();
    }
  }
  /**
   * A control the page shows but that would change nothing: greyed (`dataset.unavailable`, which
   * setBusy keeps).
   */
  function unavailable(control, flag) {
    control.dataset.unavailable = String(flag);
    control.disabled = flag || busy || working;
  }
  /**
   * A file of the model on its line: its name, the file it is made with, « Parcourir », « Détecter »
   * and its « ? ». A component the family can do without has its switch before the « ? ».
   * (0.6.102) A file is never left to Moodix AI: a workflow saved so shows the file it is made with
   * (its default, else the first allowed), and « Enregistrer » keeps that one.
   */
  function fileLine(role, policy, { optional = false, present = true, name = componentLabel(role) } = {}) {
    const id = 'native-component-' + role,
      line = node('div', 'set-line set-file' + (optional ? ' is-optional' : '')),
      picker = assetPicker(
        role,
        id,
        policy.policy === 'model' ? policy.default || policy.choices?.[0] || '' : policy.asset || policy.default,
      ),
      caption = node('label', 'set-name', name),
      active = input(id + '-enabled', present, 'checkbox');
    caption.setAttribute('for', id + '-file');
    caption.title = name;
    line.append(caption, picker.field, picker.browse, picker.detect);
    if (optional) {
      const label = node('label', 'history-toggle set-switch');
      active.setAttribute('aria-label', 'Utiliser ' + name);
      label.append(active);
      line.append(label);
      const sync = () => {
        line.dataset.off = String(!active.checked);
        for (const control of [picker.field, picker.browse]) unavailable(control, !active.checked);
      };
      active.onchange = sync;
      sync();
    }
    line.append(picker.help, picker.control, picker.list);
    return {
      line,
      picker,
      read() {
        if (optional && !active.checked) return null;
        // Left without a file, where the folders of the settings can answer: a required
        // component is not sent at all, an optional one that is used says so; the server takes
        // the file from the folders. A model folder cannot be told from another: it is asked for.
        return picker.selected() || !picker.automatic
          ? { policy: 'fixed', asset: picker.selected() }
          : optional
            ? { policy: 'fixed', asset: AUTOMATIC }
            : null;
      },
    };
  }
  /**
   * The value of a setting at the right of its line: a switch, a list or a field. `base`: the value
   * Moodix gives it; when the user's differs, « Valeur de base : 9 » stands before it, and takes it
   * again at a click. `get` refuses what is no value, `peek` never does.
   */
  function valueControl({
    id,
    title,
    type,
    choices,
    initial,
    base,
    maxLength,
    held = '',
    lead = '',
    changed = () => {},
  }) {
    const side = node('div', 'set-side');
    // `control`: what holds the value; `shown`: what stands on the line (a switch is in its label).
    let control, shown, get, set;
    if (type === 'boolean') {
      control = input(id, initial ?? false, 'checkbox');
      shown = node('label', 'history-toggle set-switch');
      shown.append(control);
      get = () => control.checked;
      set = value => {
        control.checked = Boolean(value);
      };
    } else if (choices) {
      const numeric = typeof choices[0] === 'number';
      control = shown = select(
        id,
        choices.map(choice => [String(choice), shownValue(choice)]),
        String(initial ?? choices[0]),
      );
      get = () => (numeric ? Number(control.value) : control.value);
      set = value => {
        control.value = String(value);
      };
    } else if (type === 'string') {
      control = shown = input(id, initial ?? '');
      control.maxLength = maxLength || 8000;
      control.placeholder = 'aucun';
      get = () => control.value;
      set = value => {
        control.value = value ?? '';
      };
    } else {
      control = shown = input(id, initial ?? '', 'number');
      control.step = type === 'integer' ? '1' : 'any';
      get = () => {
        if (control.value === '') throw Error(title + ' : ajoutez une valeur.');
        const value = Number(control.value);
        if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))
          throw Error(title + (type === 'integer' ? ' : un nombre entier.' : ' : un nombre.'));
        return value;
      };
      set = value => {
        control.value = value ?? '';
      };
    }
    control.setAttribute('aria-label', title);
    const peek = () => {
      try {
        return get();
      } catch {
        return undefined;
      }
    };
    const differs = () => !held && base !== undefined && peek() !== base;
    const back = button(
      '',
      () => {
        set(base);
        sync();
        changed();
      },
      'set-base',
    );
    back.append(icon('undo'), node('span', '', 'Valeur de base : ' + shownValue(base ?? '')));
    back.title = 'Reprendre la valeur de Moodix';
    // Before the value: what it is (« Intensité »), then why it is not the user's to change (the only
    // one the model takes) or, changed, the value of Moodix to take again.
    if (lead) side.append(node('span', 'set-reason', lead));
    if (held) {
      side.append(node('span', 'set-reason', held));
      unavailable(control, true);
    } else if (base !== undefined) side.append(back);
    side.append(shown);
    function sync() {
      back.hidden = !differs();
      side.dataset.changed = String(differs());
    }
    for (const event of ['input', 'change'])
      control.addEventListener?.(event, () => {
        sync();
        changed();
      });
    sync();
    return {
      side,
      control,
      back,
      get,
      peek,
      differs,
      toBase() {
        if (differs()) set(base);
        sync();
      },
    };
  }
  /** What Moodix ships of the open workflow: its own values when the user changed nothing of it. */
  const baseOf = () => draft.base ?? (draft.builtin && !draft.customized ? opened : null);
  const baseValue = policy => (policy?.policy === 'fixed' ? policy.value : policy?.default);
  /**
   * A setting of the model on its line: its name, its value, its « ? ». One value only (the 8 steps
   * of a distilled model): greyed, with why in the place of « Valeur de base ».
   */
  function settingLine(name, policy) {
    const spec = parameterSpec(name),
      type = typeFor(name, policy),
      title = labels[name] || name,
      id = 'native-value-' + name,
      choices = policy.choices || spec.choices || null,
      single = spec.choices?.length === 1,
      base = single ? undefined : baseValue(baseOf()?.parameters?.[name]),
      line = node('div', 'set-line set-value'),
      caption = node('label', 'set-name', title),
      // What it does that the user would not expect (settingWarning), under its line.
      note = node('p', 'set-note is-warning'),
      value = valueControl({
        id,
        title,
        type,
        choices: choices?.length > 1 ? choices : null,
        initial: baseValue(policy),
        base,
        maxLength: policy.maxLength || spec.maxLength,
        held: single ? 'Seule valeur que ce modèle accepte' : '',
        changed: () => {
          refreshInert();
          syncReset();
        },
      });
    caption.setAttribute('for', id);
    caption.title = title;
    if (single) line.dataset.held = 'true';
    note.hidden = true;
    line.append(
      caption,
      value.side,
      helpMark(
        [spec.help || spec.note || SETTING_HELP[name] || '', base === undefined ? '' : `Valeur de base : ${shownValue(base)}.`]
          .filter(Boolean)
          .join(' '),
      ),
    );
    return {
      line,
      note,
      value: value.control,
      back: value.back,
      differs: value.differs,
      toBase: value.toBase,
      setWarning(text) {
        note.textContent = text;
        note.hidden = !text;
      },
      /** Its policy as it stands, without the refusals of `read` (what makes another line warn). */
      peek: () => (single ? policy : { policy: 'fixed', value: value.peek() }),
      read() {
        if (single) return policy;
        const now = value.get();
        // Saved untouched, a workflow stays as it was stored (the same fingerprint).
        if (policy.policy === 'fixed' && now === policy.value) return policy;
        const result = { policy: 'fixed', value: now };
        // What the workflow narrows it to stays. Its bounds are those of the Studio for one creation
        // (the denoise of Krea 2 on its bar, from 0,6 to 0,7): kept while the user's value is within
        // them, gone with a value beyond, which is then the user's whole choice.
        if (typeof now === 'number' && (policy.min ?? now) <= now && now <= (policy.max ?? now)) {
          if (policy.min !== undefined) result.min = policy.min;
          if (policy.max !== undefined) result.max = policy.max;
        }
        if (policy.choices) result.choices = policy.choices;
        if (type === 'string' && !choices && policy.maxLength) result.maxLength = policy.maxLength;
        return result;
      },
    };
  }
  /**
   * What the draft and the final of a video replace (`profiles`): the size of each on its line, and
   * each other setting they hold on one line when both make it the same (the frames a second), on
   * one a version when they differ. A version the workflow never makes, and what the request
   * decides (the length), have no line: they stay as written.
   */
  function profileLines(name) {
    const manifest = familyOf(draft.pipeline),
      stages = stagesOf(manifest, draft).filter(stage =>
        Object.hasOwn(draft.profiles?.[stage]?.parameters ?? {}, name),
      ),
      spec = manifest?.parameters?.[name] ?? {},
      called = stage => (stage === 'draft' ? 'brouillon' : 'vidéo finale'),
      of = (source, stage, key = name) => source?.[stage]?.parameters?.[key],
      base = baseOf()?.profiles,
      lines = [];
    const changed = () => {
      refreshInert();
      syncReset();
    };
    if (name === 'width') {
      // The size: a width and a height, « 896 × 1600 ».
      for (const stage of stages) {
        if (!Object.hasOwn(draft.profiles[stage].parameters, 'height')) continue;
        const line = node('div', 'set-line set-value'),
          title = stage === 'draft' ? 'Taille du brouillon' : 'Taille de la vidéo finale',
          caption = node('label', 'set-name', title),
          controls = ['width', 'height'].map(key =>
            valueControl({
              id: `native-profile-${stage}-${key}`,
              title: `${labels[key]} · ${called(stage)}`,
              type: manifest.parameters[key]?.type || 'integer',
              initial: of(draft.profiles, stage, key),
              base: of(base, stage, key),
              changed,
            }),
          ),
          side = node('div', 'set-side set-size'),
          differs = () => controls.some(control => control.differs()),
          back = button(
            '',
            () => {
              for (const control of controls) control.toBase();
              sync();
              changed();
            },
            'set-base',
          );
        const sync = () => {
          back.hidden = !differs();
        };
        back.append(
          icon('undo'),
          node('span', '', `Valeur de base : ${of(base, stage, 'width')} × ${of(base, stage, 'height')}`),
        );
        back.title = 'Reprendre la valeur de Moodix';
        if (of(base, stage, 'width') !== undefined) side.append(back);
        side.append(controls[0].control, node('span', 'set-times', '×'), controls[1].control);
        for (const control of controls)
          for (const event of ['input', 'change']) control.control.addEventListener?.(event, sync);
        sync();
        caption.setAttribute('for', `native-profile-${stage}-width`);
        line.append(
          caption,
          side,
          helpMark(
            (stage === 'draft'
              ? 'La taille d’un brouillon, dans le format de la demande : petit, il se fait vite.'
              : 'La taille d’une vidéo finale, dans le format de la demande.') +
              (of(base, stage, 'width') === undefined
                ? ''
                : ` Valeur de base : ${of(base, stage, 'width')} × ${of(base, stage, 'height')}.`),
          ),
        );
        lines.push({
          line,
          differs,
          toBase() {
            for (const control of controls) control.toBase();
            sync();
          },
          write(profiles) {
            profiles[stage].parameters.width = controls[0].get();
            profiles[stage].parameters.height = controls[1].get();
          },
        });
      }
      return lines;
    }
    // What the request decides (the length of a clip), a version never made: no line.
    const shown = stages.filter(stage => {
      const reason = inertSetting(manifest, draft, name, stage);
      return !reason || spec.choices?.length === 1;
    });
    if (!shown.length) return lines;
    const same = shown.every(stage => of(draft.profiles, stage) === of(draft.profiles, shown[0])),
      single = spec.choices?.length === 1;
    for (const group of same ? [shown] : shown.map(stage => [stage])) {
      const stage = group[0],
        title = (labels[name] || name) + (same ? '' : ' · ' + called(stage)),
        id = same ? 'native-value-' + name : `native-profile-${stage}-${name}`,
        line = node('div', 'set-line set-value'),
        caption = node('label', 'set-name', title),
        own = single ? undefined : of(base, stage),
        value = valueControl({
          id,
          title,
          type: spec.type || 'number',
          choices: spec.choices?.length > 1 ? spec.choices : null,
          initial: of(draft.profiles, stage),
          base: own,
          held: single ? 'Seule valeur que ce modèle accepte' : '',
          changed,
        });
      caption.setAttribute('for', id);
      caption.title = title;
      if (single) line.dataset.held = 'true';
      line.append(
        caption,
        value.side,
        helpMark(
          [spec.help || spec.note || SETTING_HELP[name] || '', own === undefined ? '' : `Valeur de base : ${shownValue(own)}.`]
            .filter(Boolean)
            .join(' '),
        ),
      );
      lines.push({
        line,
        value: value.control,
        differs: value.differs,
        toBase: value.toBase,
        write(profiles) {
          if (single) return;
          const now = value.get();
          for (const each of group) profiles[each].parameters[name] = now;
        },
      });
    }
    return lines;
  }
  /** How many LoRAs the family of the open workflow takes: none for most. */
  const loraLimit = () => familyOf(draft.pipeline)?.loras?.max ?? 0;
  function loraCount() {
    const limit = loraLimit(),
      full = readLoras.length >= limit,
      engine = shownName || 'Ce modèle',
      shown = readLoras.filter(item => !item.bound).length;
    $('native-workflow-add-lora').dataset.unavailable = String(full);
    $('native-workflow-add-lora').disabled = busy || working || full;
    // Greyed, and said why: the model takes none, or no more.
    $('native-lora-section').dataset.off = String(!limit);
    $('native-lora-note').textContent = !limit
      ? `${engine} ne prend pas de LoRA.`
      : full
        ? `${limit} LoRA au plus pour ${engine}.`
        : shown
          ? ''
          : 'Aucun LoRA ajouté.';
    $('native-lora-note').hidden = !$('native-lora-note').textContent;
  }
  /**
   * The LoRA the subject references of the model depend on (referenceLora, lib/native-workflows.mjs):
   * the first one left to Moodix AI, in a model that takes such references. It is on exactly when
   * one of them is given, seen by neither the user nor Moodix AI: a file of the model, on a line
   * among its files.
   */
  function boundLora(loras) {
    const roles = familyOf(draft.pipeline)?.roles ?? {};
    if (!(draft.references ?? []).some(slot => roles[slot.role]?.requiresLora)) return null;
    return loras.find(lora => lora.enabled.policy === 'model') ?? null;
  }
  function renderLoras(loras) {
    readLoras = [];
    $('native-workflow-loras').replaceChildren();
    const bound = boundLora(loras);
    for (const lora of loras) addLora(lora, lora === bound);
    loraCount();
  }
  /**
   * A LoRA on its line: its file, its strength, when it is on, and what removes it. « Au choix de
   * Moodix AI » : il l'active quand la demande s'y prête, d'après ce qu'on lui en dit (la ligne du
   * dessous). Its strength is a setting: the user's alone.
   */
  function addLora(lora, bound = false) {
    const id = 'native-lora-asset-' + lora.id,
      picker = assetPicker('lora', id, lora.asset, {
        detects: false,
        named: bound ? 'LoRA des sujets de référence' : 'LoRA',
        about: bound ? 'Activé seul quand un sujet de référence est donné, jamais autrement.' : '',
      });
    if (bound) {
      // Its own line among the files of the model: nothing of it is a choice.
      const line = node('div', 'set-line set-file'),
        caption = node('label', 'set-name', 'LoRA des sujets de référence');
      caption.setAttribute('for', id + '-file');
      caption.title = 'LoRA des sujets de référence';
      line.append(caption, picker.field, picker.browse, picker.detect, picker.help, picker.control, picker.list);
      $('native-workflow-components').append(line);
      readLoras.push({ bound: true, read: () => ({ ...lora, asset: picker.selected() }) });
      return;
    }
    const was =
        lora.enabled.policy === 'off' || (lora.enabled.policy === 'fixed' && !lora.enabled.value)
          ? 'off'
          : lora.enabled.policy,
      line = node('div', 'set-line set-file set-lora'),
      enabled = select(
        'native-lora-enabled-' + lora.id,
        [
          ['fixed', 'Toujours actif'],
          ['model', 'Au choix de Moodix AI'],
          ['off', 'Désactivé'],
        ],
        was,
      ),
      strength = valueControl({
        id: 'native-lora-strength-value-' + lora.id,
        title: 'Intensité du LoRA',
        type: 'number',
        initial: baseValue(lora.strength) ?? 1,
        lead: 'Intensité',
      }),
      description = input('native-lora-description-' + lora.id, lora.description || ''),
      told = node('div', 'set-line set-told'),
      item = {
        read: () => {
          const value = strength.get();
          return {
            id: lora.id,
            asset: picker.selected(),
            description: description.value.trim(),
            // Left as it was, it stays as it was written (saved untouched, the same workflow).
            enabled:
              enabled.value === was
                ? lora.enabled
                : enabled.value === 'off'
                  ? { policy: 'off' }
                  : enabled.value === 'fixed'
                    ? { policy: 'fixed', value: true }
                    : // Off until Moodix AI turns it on for a request it fits.
                      { policy: 'model', default: false },
            strength:
              lora.strength.policy === 'fixed' && lora.strength.value === value
                ? lora.strength
                : { policy: 'fixed', value },
          };
        },
      },
      remove = button(
        '',
        () => {
          readLoras = readLoras.filter(value => value !== item);
          line.remove();
          told.remove();
          loraCount();
        },
        'icon-button set-remove',
      );
    enabled.setAttribute('aria-label', 'Activation du LoRA');
    description.placeholder = 'Ce qu’il apporte (style, effet) : Moodix AI s’en sert pour savoir quand l’activer';
    description.maxLength = 1000;
    description.setAttribute('aria-label', 'Ce que le LoRA apporte');
    remove.append(icon('close'));
    remove.setAttribute('aria-label', 'Retirer ce LoRA');
    remove.title = 'Retirer ce LoRA';
    line.append(picker.field, picker.browse, strength.side, enabled, remove, picker.control, picker.list);
    told.append(description);
    const sync = () => {
      // What it brings is said to Moodix AI only: asked for when the choice is its own.
      told.hidden = enabled.value !== 'model';
      unavailable(strength.control, enabled.value === 'off');
    };
    enabled.onchange = sync;
    sync();
    readLoras.push(item);
    $('native-workflow-loras').append(line, told);
    loraCount();
  }
  /** What a setting does that the user would not expect, under its line (settingWarning). */
  function refreshInert() {
    const manifest = familyOf(draft?.pipeline);
    if (!manifest || rendering) return;
    const state = {
      mediaType: draft.mediaType,
      parameters: {
        ...draft.parameters,
        ...Object.fromEntries(Object.entries(parameterControls).map(([name, control]) => [name, control.peek()])),
      },
      profiles: draft.profiles,
      references: draft.references,
    };
    for (const [name, control] of Object.entries(parameterControls))
      control.setWarning(settingWarning(manifest, state, name));
  }
  /** « Remettre les valeurs de base »: greyed while every value is the one Moodix gives. */
  function syncReset() {
    const reset = $('native-workflow-reset');
    if (!reset || rendering) return;
    const any = valueLines.some(line => line.differs());
    reset.hidden = !baseOf();
    reset.dataset.unavailable = String(!any);
    reset.disabled = busy || working || !any;
    reset.title = any ? 'Chaque réglage reprend la valeur de Moodix ; rien n’est enregistré avant « Enregistrer ».' : 'Chaque réglage est à sa valeur de base.';
  }
  /** What the model is offered for, in the sentence under « Proposé à Moodix AI ». */
  function offerText() {
    const tasks = familyOf(draft.pipeline)?.tasks ?? [],
      video = draft.mediaType === 'video',
      asked = tasks.includes('replace_character')
        ? 'de remplacer un personnage dans une vidéo'
        : tasks.includes('interpolate')
          ? 'de rendre une vidéo plus fluide'
          : tasks.includes('upscale')
            ? `d’agrandir ${video ? 'une vidéo' : 'une image'}`
            : ({ video: 'une vidéo', audio: 'un son' }[draft.mediaType] ?? 'une image');
    return `Moodix AI peut choisir ${shownName || 'ce modèle'} quand vous lui demandez ${asked}.`;
  }
  /**
   * What Moodix AI then chooses of a request, as the workflow leaves it to it (what is part of a
   * request, ASKED, with the policy « model »): « Il écrit le prompt et choisit la taille et le
   * débruitage ; les réglages plus bas restent les vôtres. » (19/11: « le débruitage, la résolution,
   * le temps doivent encore être choisis par Moodix ».) '' when it chooses nothing of it.
   */
  function chosenText() {
    const left = name => draft.parameters[name]?.policy === 'model',
      creates = (familyOf(draft.pipeline)?.tasks ?? []).includes('create_video'),
      chosen = [
        // The size of an image is its own; of a video, Moodix AI chooses the format.
        left('width') && left('height') ? 'la taille' : draft.mediaType === 'video' && creates ? 'le format' : '',
        left('frames') || left('seconds') ? 'la durée' : '',
        left('stage') ? 'la version (brouillon ou finale)' : '',
        left('denoise') ? 'le débruitage' : '',
        left('lyrics') ? 'les paroles' : '',
        left('scale') || left('passes') || left('max_side') ? 'l’agrandissement' : '',
        left('multiplier') || left('mode') ? 'la fluidité' : '',
        left('subject') || left('reference_subject') ? 'qui remplacer' : '',
      ].filter(Boolean),
      listed = chosen.length > 1 ? chosen.slice(0, -1).join(', ') + ' et ' + chosen.at(-1) : (chosen[0] ?? ''),
      writes = Object.hasOwn(draft.parameters, 'prompt');
    if (!writes && !listed) return '';
    return (
      (writes ? 'Il écrit le prompt' + (listed ? ' et choisit ' + listed : '') : 'Il choisit ' + listed) +
      ' ; les réglages plus bas restent les vôtres.'
    );
  }
  function renderEditor() {
    const manifest = familyOf(draft.pipeline);
    $('native-workflow-description').value = draft.description;
    $('native-workflow-enabled').checked = draft.enabled;
    $('native-workflow-hero').dataset.off = String(!draft.enabled);
    $('native-workflow-enabled').onchange = () => {
      $('native-workflow-hero').dataset.off = String(!$('native-workflow-enabled').checked);
    };
    $('native-workflow-offer').textContent = offerText();
    $('native-workflow-chosen').textContent = chosenText();
    $('native-workflow-chosen').hidden = !$('native-workflow-chosen').textContent;
    // « Réglages de Krea 2 », « Réglages d’ACE-Step 1.5 ».
    $('native-workflow-title').textContent =
      'Réglages ' + (/^[aeiouyàâéèêîôûh]/i.test(shownName) ? 'd’' : 'de ') + (shownName || 'ce modèle');
    // What is in its way (a file missing, a card it cannot run on), under the sentence.
    $('native-workflow-capability').textContent = draft.unavailableReason || '';
    $('native-workflow-capability').hidden = !draft.unavailableReason;
    readComponents = [];
    valueLines = [];
    profileWriters = [];
    const componentControls = {};
    $('native-workflow-components').replaceChildren();
    for (const role of [
      ...new Set([
        ...Object.keys(draft.components),
        ...Object.entries(manifest?.components || {})
          .filter(([, spec]) => spec.required)
          .map(([role]) => role),
      ]),
    ]) {
      const policy = draft.components[role],
        control = fileLine(role, policy || { policy: 'fixed', asset: '' }, {
          optional: !manifest?.components[role]?.required,
          present: Boolean(policy),
        });
      readComponents.push([role, control.read]);
      componentControls[role] = control;
      $('native-workflow-components').append(control.line);
    }
    suggestTokenizers(componentControls);
    readParameters = [];
    parameterControls = {};
    rendering = true;
    const list = $('native-workflow-parameters'),
      stages = stagesOf(manifest, draft),
      // What every version the workflow makes replaces: set on the lines of the versions.
      profiled = name =>
        stages.length > 0 && stages.every(stage => Object.hasOwn(draft.profiles[stage]?.parameters ?? {}, name));
    list.replaceChildren();
    const enhanced = renderEnhance(),
      texts = [];
    for (const [name, policy] of Object.entries(draft.parameters)) {
      const spec = manifest?.parameters?.[name] ?? {},
        kept = () => readParameters.push([name, () => policy]);
      // Written at each creation, by Moodix AI or in the Studio: a fixed prompt was refused at each
      // one, and leaves with the first change saved (saveEditor).
      if (name === 'prompt') {
        readParameters.push([name, () => (policy.policy === 'model' ? policy : { policy: 'model', type: 'string' })]);
        continue;
      }
      // The size of each version of a video, where the size of the request is not a line.
      if ((name === 'width' || name === 'height') && profiled(name)) {
        if (name === 'width')
          for (const line of profileLines('width')) {
            valueLines.push(line);
            profileWriters.push(line.write);
            list.append(line.line);
          }
        kept();
        continue;
      }
      // Part of a request, or read by no engine of the family: no line, and kept as written.
      if (!isSetting(name) || spec.unused) {
        kept();
        continue;
      }
      // On its own line, with its instruction (renderEnhance).
      if (name === 'expandPrompt') {
        if (enhanced) list.append(...enhanced);
        else kept();
        continue;
      }
      if (profiled(name)) {
        for (const line of profileLines(name)) {
          valueLines.push(line);
          profileWriters.push(line.write);
          list.append(line.line);
        }
        kept();
        continue;
      }
      const control = settingLine(name, policy);
      parameterControls[name] = control;
      valueLines.push(control);
      readParameters.push([name, control.read]);
      // A text to write (a negative prompt) comes after the figures and the switches.
      if (typeFor(name, policy) === 'string' && !(policy.choices || spec.choices)) texts.push(control.line, control.note);
      else list.append(control.line, control.note);
    }
    // A model that had the setting added since the workflow was written (Krea 2 and its prompt).
    if (enhanced && !Object.hasOwn(draft.parameters, 'expandPrompt')) list.append(...enhanced);
    list.append(...texts);
    $('native-workflow-empty').hidden = list.children.length > 0;
    // What a workflow holds of a request that does what the user would not expect (a denoise a copy
    // of before fixed at 1 ignores the image to modify): no line here, said at the head of the settings.
    const warned = Object.keys(draft.parameters)
      .filter(name => !parameterControls[name])
      .map(name => settingWarning(manifest, draft, name))
      .filter(Boolean);
    $('native-workflow-warning').textContent = warned.join(' ');
    $('native-workflow-warning').hidden = !warned.length;
    renderLoras(draft.loras || []);
    rendering = false;
    refreshInert();
    syncReset();
    error('');
    $('native-workflow-unsaved').hidden = true;
    setBusy(busy);
  }
  /**
   * « Améliorer le prompt » on its line, with its switch. On, the family's text encoder rewrites the
   * prompt before each image with an instruction the user may edit, under the line; the prompt
   * actually used is kept with the image. Returns its elements, or null when the family has none.
   */
  function renderEnhance() {
    const manifest = familyOf(draft.pipeline),
      policy = draft.parameters.expandPrompt,
      config = draft.promptExpansion || manifest?.promptExpansionDefault;
    const supported = Boolean(
      manifest?.features?.includes('promptExpansion') && manifest.parameters?.expandPrompt && config,
    );
    readEnhance = null;
    if (!supported) return null;
    const on = policy?.policy === 'model' ? policy.default === true : policy?.value === true,
      line = node('div', 'set-line set-value'),
      caption = node('label', 'set-name', 'Améliorer le prompt avant chaque image'),
      toggle = valueControl({ id: 'native-enhance-switch', title: 'Améliorer le prompt avant chaque image', type: 'boolean', initial: on }),
      template = element('textarea', 'native-enhance-template'),
      instruction = node('details', 'set-more');
    caption.setAttribute('for', 'native-enhance-switch');
    template.value = config.template;
    template.rows = 6;
    template.spellcheck = false;
    template.setAttribute('aria-label', 'Consigne d’amélioration du prompt');
    instruction.append(
      node('summary', '', 'Consigne d’amélioration'),
      template,
      node('p', 'field-help', 'Le texte {{prompt}} est remplacé par le prompt demandé ; il doit apparaître une seule fois.'),
    );
    line.append(
      caption,
      toggle.side,
      helpMark(
        'L’encodeur de texte réécrit le prompt en une description plus détaillée avant la génération (quelques secondes de plus). Le prompt réellement utilisé est affiché dans les détails de l’image.',
      ),
    );
    const sync = () => {
      instruction.hidden = !toggle.control.checked;
    };
    toggle.control.onchange = sync;
    sync();
    readEnhance = () => {
      // Off in a workflow that never had the setting: nothing is added to it (saved untouched, it
      // stays as it was stored).
      if (!toggle.control.checked)
        return {
          parameter:
            policy?.policy === 'fixed' && policy.value === false
              ? policy
              : policy || draft.promptExpansion
                ? { policy: 'fixed', value: false }
                : undefined,
          expansion: draft.promptExpansion,
        };
      if (template.value.split('{{prompt}}').length !== 2)
        throw Error('La consigne d’amélioration doit contenir {{prompt}} exactement une fois.');
      return {
        parameter: policy?.policy === 'fixed' && policy.value === true ? policy : { policy: 'fixed', value: true },
        expansion: { ...config, template: template.value },
      };
    };
    return [line, instruction];
  }
  function readEditor() {
    const record = {
      ...draft,
      description: $('native-workflow-description').value.trim(),
      enabled: $('native-workflow-enabled').checked,
      components: Object.fromEntries(
        readComponents.map(([name, read]) => [name, read()]).filter(([, value]) => value !== null),
      ),
      parameters: Object.fromEntries(readParameters.map(([name, read]) => [name, read()])),
      loras: readLoras.map(control => control.read()),
    };
    // What the server found in the folders is its answer, not a part of the workflow.
    delete record.automatic;
    if (profileWriters.length) {
      record.profiles = structuredClone(draft.profiles);
      for (const write of profileWriters) write(record.profiles);
    }
    if (readEnhance) {
      const { parameter, expansion } = readEnhance();
      if (parameter) record.parameters.expandPrompt = parameter;
      if (expansion) record.promptExpansion = expansion;
      else delete record.promptExpansion;
    }
    // What the list says of a workflow beside what is written in it.
    for (const name of [
      'digest',
      'ready',
      'unavailableReason',
      'unavailableKind',
      'error',
      'path',
      'builtin',
      'customized',
      'update',
      'base',
    ])
      delete record[name];
    return record;
  }
  function editorDirty() {
    if (!draft) return false;
    try {
      return JSON.stringify(readEditor()) !== baseline;
    } catch {
      return true;
    }
  }
  /**
   * Opens the page of a model: `record`, its workflow as the list has it; `name`, the model as
   * the page « Modèles » calls it (« RIFE », where its workflow is « Interpoler (RIFE 4.26) »).
   */
  async function edit(record, { name = '' } = {}) {
    if (busy || working || !record) return false;
    draft = structuredClone(record);
    shownName = name || record.name || '';
    opened = { parameters: structuredClone(record.parameters), profiles: structuredClone(record.profiles ?? null) };
    returnFocus = document.activeElement || null;
    // The settings scroll inside their tab's area; the page of a model scrolls its own body.
    parentScroll = $('settings-body')?.scrollTop || 0;
    renderEditor();
    baseline = JSON.stringify(readEditor());
    $('settings-form').hidden = true;
    $('workflow-editor').hidden = false;
    $('settings').setAttribute('aria-labelledby', 'native-workflow-title');
    $('settings').scrollTop = 0;
    // Each model opens at its top.
    $('native-workflow-body').scrollTop = 0;
    $('native-workflow-back').focus();
    return true;
  }
  function leaveEditor() {
    draft = null;
    afterBack = undefined;
    $('workflow-editor').hidden = true;
    $('settings-form').hidden = false;
    $('settings').setAttribute('aria-labelledby', 'settings-title');
    $('native-workflow-unsaved').hidden = true;
    $('settings').scrollTop = 0;
    if ($('settings-body')) $('settings-body').scrollTop = parentScroll;
    if (returnFocus?.isConnected !== false) returnFocus?.focus();
  }
  function requestBack(after) {
    if (working || busy) return;
    if (!draft) {
      after?.();
      return;
    }
    if (editorDirty()) {
      afterBack = after;
      $('native-workflow-unsaved').hidden = false;
      $('native-workflow-keep').focus();
      return;
    }
    leaveEditor();
    after?.();
  }
  async function saveEditor() {
    if (pendingFiles.size) await Promise.allSettled([...pendingFiles]);
    if (!draft || working || busy) return false;
    const session = version;
    try {
      const record = readEditor();
      // Saved untouched, a workflow stays as it was stored (the same fingerprint): a fixed prompt of
      // before only leaves with a change of the user's.
      if (draft.parameters.prompt?.policy === 'fixed' && JSON.stringify(record) === baseline)
        record.parameters.prompt = structuredClone(draft.parameters.prompt);
      if (!record.description)
        throw Error('Dites en une phrase pour quoi Moodix AI choisit ce modèle (« Il le choisit pour »).');
      for (const [role, policy] of Object.entries(record.components))
        if (!policy.asset)
          throw Error(
            familyOf(record.pipeline)?.components[role]?.format === 'tokenizer'
              ? 'Choisissez le dossier du tokenizer : il est requis pour enregistrer ces réglages.'
              : 'Choisissez un fichier pour « ' + componentLabel(role) + ' ».',
          );
      if (record.loras.some(lora => !lora.asset))
        throw Error('Choisissez le fichier de chaque LoRA, ou retirez les lignes inutilisées.');
      const result = await run(async signal => (await api('generation/workflows', record, { signal })).json());
      if (session !== version || !result) return false;
      changedWorkflows = true;
      const saved = result.workflow || record,
        index = workflows.findIndex(item => item.id === saved.id);
      if (index < 0) workflows.push(saved);
      else workflows[index] = saved;
      renderList();
      leaveEditor();
      // Readiness and origin (a shipped workflow becomes "modified by you") come from the server.
      void refresh({ settings: false }).catch(() => {});
      return true;
    } catch (failure) {
      if (session === version) error(failure.message);
      return false;
    }
  }
  function cancelSettings() {
    version++;
    controller.abort();
    controller = new AbortController();
    if (draft) leaveEditor();
    importStatus('');
    // A licence left unconfirmed is asked again from the start the next time.
    licenseAsked = '';
  }
  $('generation-test').onclick = async () => {
    try {
      await run(async signal => {
        const result = await (await api('generation/test', values(), { signal })).json();
        runner = result.runner || result;
        runnerStatus();
      });
    } catch (failure) {
      if (!controller.signal.aborted) $('generation-status').textContent = failure.message;
    }
  };
  $('native-workflow-back').onclick = () => requestBack();
  $('native-workflow-close').onclick = () => options.onRequestClose?.();
  $('native-workflow-save').onclick = saveEditor;
  $('native-workflow-keep').onclick = () => {
    $('native-workflow-unsaved').hidden = true;
    afterBack = undefined;
    $('native-workflow-back').focus();
  };
  $('native-workflow-discard').onclick = () => {
    const after = afterBack;
    leaveEditor();
    after?.();
  };
  $('native-workflow-save-back').onclick = async () => {
    const after = afterBack;
    if (await saveEditor()) after?.();
  };
  $('settings').addEventListener(
    'cancel',
    event => {
      if (draft) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!$('native-workflow-unsaved').hidden) $('native-workflow-keep').onclick();
        else requestBack();
      }
    },
    true,
  );
  // Échap is answered at the key itself (16/11): the browser lets a page refuse a close request
  // (`cancel`, above) only once per user activation, and Échap is not one. Pressed again on « Enregistrer
  // les modifications de ce modèle ? », it closed the settings and the changes were lost. A key
  // prevented is never a close request. Heard on the page: after what answers Échap itself in the
  // editor (a list of glass stops it), before the guard of the settings (on the window), and with the
  // focus lost too (the key then goes to the page, not to the settings).
  document.addEventListener?.('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !draft || !$('settings').open) return;
    // Another window open over the settings: the key is its own.
    const within = event.target?.closest?.('dialog[open]');
    if (within && within !== $('settings')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!$('native-workflow-unsaved').hidden) $('native-workflow-keep').onclick();
    else requestBack();
  });
  $('native-workflow-add-lora').onclick = () => {
    if ($('native-workflow-add-lora').dataset.unavailable === 'true') return;
    addLora({
      id: crypto.randomUUID(),
      asset: '',
      description: '',
      // Added to be used: on, until the user says otherwise.
      enabled: { policy: 'fixed', value: true },
      strength: { policy: 'fixed', value: 1 },
    });
  };
  function importStatus(message, failed = false) {
    $('native-import-status').hidden = !message;
    $('native-import-status').textContent = message;
    $('native-import-status').className = failed ? 'config-error' : 'field-help';
    if (failed) {
      $('native-import-status').scrollIntoView?.({ block: 'nearest' });
      $('native-import-status').focus();
    }
  }
  for (const [key, [id, role]] of Object.entries(folderControls)) {
    $(id + '-browse').onclick = async () => {
      try {
        await run(async signal => {
          const path = await browse('directory', $(id).value, signal);
          signal.throwIfAborted();
          if (path) $(id).value = path;
        });
      } catch (failure) {
        if (!controller.signal.aborted) importStatus(failure.message, true);
      }
      showFolder(key);
    };
    // « Détecter »: the folder of the models folder again; kept as no folder apart at « Enregistrer ».
    if ($(id + '-detect'))
      $(id + '-detect').onclick = () => {
        if (!folderDefaults[role]) return;
        $(id).value = folderDefaults[role];
        showFolder(key);
      };
    for (const event of ['input', 'change', 'blur']) $(id).addEventListener?.(event, () => showFolder(key));
    // Measured once the line is in sight (its tab opened, the window resized).
    if (typeof ResizeObserver === 'function' && $(id).nodeType === 1) new ResizeObserver(() => showFolder(key)).observe($(id));
  }
  // « Remettre les valeurs de base »: every line takes the value of Moodix again; nothing is saved
  // before « Enregistrer » (saved so, a model the user changed nothing else of is Moodix's again,
  // and follows its updates: NativeWorkflowCatalog.save).
  $('native-workflow-reset').onclick = () => {
    for (const line of valueLines) line.toBase();
    refreshInert();
    syncReset();
  };

  return {
    ...runtime,
    refresh,
    updateRunner,
    values,
    workflowDescriptions: () => [],
    setBusy,
    cancelSettings,
    saved,
    hasPendingImport: () => false,
    finishImport: async () => true,
    edit,
    saveEditor,
    requestBack,
    isEditing: () => draft !== null,
    editorDirty,
    /** (0.6.102) Whether a workflow was saved, set back, deleted or shown again since the last call. */
    takeChanges: () => {
      const changed = changedWorkflows;
      changedWorkflows = false;
      return changed;
    },
  };
}
