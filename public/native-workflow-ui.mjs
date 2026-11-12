import { setupGenerationRuntime } from './generation-runtime.mjs';

// Interface wording for parameters; component, role and family labels come from the family manifests.
const labels = {
  prompt: 'Prompt',
  negative_prompt: 'Prompt négatif',
  seed: 'Seed',
  width: 'Largeur',
  height: 'Hauteur',
  steps: 'Étapes',
  cfg: 'Guidage',
  denoise: 'Débruitage',
  expandPrompt: 'Expansion du prompt',
  frames: 'Images vidéo',
  fps: 'Images par seconde',
  audio: 'Audio',
  stage: 'Brouillon / finale',
  start_strength: 'Influence de l’image de début',
  end_strength: 'Influence de l’image de fin',
  image_compression: 'Compression des références (CRF)',
  overlap_frames: 'Images de chevauchement',
  msr_frames: 'Durée latente des références MSR',
  msr_strength: 'Influence des références MSR',
  tile: 'Taille des tuiles (px, 0 = entière)',
  max_side: 'Plus grand côté de sortie (px, 0 = libre)',
  multiplier: 'Multiplicateur d’images',
  mode: 'Mode',
};
const choiceLabels = { draft: 'Brouillon', final: 'Vidéo finale', smooth: 'Fluide', slow_motion: 'Ralenti' };
const ownership = { fixed: 'Fixe', model: 'Assistant', random: 'Aléatoire' };
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
// What an optional component that is used, but left to the folders of the settings, holds in
// place of a file: an id no file is registered under, so the server looks in the folders.
const AUTOMATIC = 'automatic';
export const parameterPolicies = name => (name === 'seed' ? ['fixed', 'model', 'random'] : ['fixed', 'model']);
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
  const roleLabel = role =>
    ownFirst()
      .map(item => item.roles[role]?.label)
      .find(Boolean) || 'Usage à définir';
  const parameterSpec = name => familyOf(draft?.pipeline)?.parameters[name] || {};
  const typeFor = (name, policy) =>
    parameterSpec(name).type ||
    policy.type ||
    (typeof policy.value === 'boolean' ? 'boolean' : typeof policy.value === 'string' ? 'string' : 'number');
  const familyLabel = name => {
    const item = familyOf(name);
    return item
      ? `${{ image: 'Image', video: 'Vidéo', audio: 'Son' }[item.mediaType] || item.mediaType} · ${item.label}`
      : 'Moteur à choisir';
  };
  let workflows = [],
    assets = [],
    folders = {},
    runner = {},
    busy = false,
    working = false,
    unlimited = false,
    lastLimited = 5,
    version = 0,
    refreshVersion = 0,
    controller = new AbortController(),
    pendingPipeline = '';
  let draft = null,
    baseline = '',
    isNew = false,
    returnFocus = null,
    parentScroll = 0,
    afterBack,
    readComponents = [],
    readParameters = [],
    readLoras = [],
    readReferences = [],
    readProfiles = [],
    readEnhance = null,
    // Shipped workflows the user deleted (hidden until an update changes them).
    hiddenWorkflows = 0,
    // What the shipped workflows can download, the download in progress, whether a token is kept.
    downloads = { offers: {}, job: { state: 'idle' }, hasToken: false },
    following = false,
    // Where ComfyUI, the external engine, is and whether it answers.
    comfy = { enabled: false, baseUrl: '', reachable: false, version: '' };
  // Paths being registered from a file field: Save waits for them.
  const pendingFiles = new Set();
  const element = (tag, id, text = '') => {
    const value = node(tag, '', text);
    if (id) value.id = id;
    return value;
  };
  const icon = name => {
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
  const segmented = (id, items, initial) => {
    const control = element('div', id);
    control.className = 'native-policy-switch';
    control.setAttribute('role', 'group');
    let selected = initial;
    const buttons = items.map(([key, label]) => {
      const choice = button(label, () => {
        control.value = key;
        control.onchange?.();
      });
      choice.setAttribute('aria-pressed', String(key === selected));
      control.append(choice);
      return [key, choice];
    });
    Object.defineProperty(control, 'value', {
      get: () => selected,
      set: value => {
        selected = value;
        for (const [key, choice] of buttons) choice.setAttribute('aria-pressed', String(key === value));
      },
    });
    return control;
  };
  const field = (label, control) => {
    const group = node('div', 'field-group'),
      caption = node('label', '', label);
    if (control.getAttribute('role') === 'group') control.setAttribute('aria-label', label);
    else if (control.id) caption.setAttribute('for', control.id);
    group.append(caption, control);
    return group;
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
            'generation-review',
            'generation-iterations',
            'generation-minus',
            'generation-plus',
            'generation-unlimited',
            'generation-python',
            'generation-python-browse',
            'generation-test',
            'workflow-add',
            'native-workflow-import',
            'native-workflow-file',
            'native-convert-root',
            'native-convert-root-browse',
            'generation-vae-root',
            'generation-vae-root-browse',
            'generation-lora-root',
            'generation-lora-root-browse',
          ].includes(control.id) &&
          !control.dataset.nativeControl
        )
          continue;
        control.disabled = disabled || control.dataset.unavailable === 'true';
      }
    $('generation-iterations').disabled = disabled || unlimited;
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
  function syncLimit() {
    const control = $('generation-iterations');
    control.hidden = unlimited;
    control.required = !unlimited;
    control.disabled = busy || working || unlimited;
    $('generation-unlimited').setAttribute('aria-pressed', String(unlimited));
    $('generation-infinity-value').hidden = !unlimited;
    $('generation-limit-label').textContent = unlimited ? 'Sans limite' : `${control.value} essai(s)`;
  }
  function folderValues() {
    return Object.fromEntries(
      Object.entries(folderControls).map(([key, [id, role]]) => {
        const path = $(id).value.trim();
        return [key, path === folders[role] && !state.generation?.[key] ? '' : path];
      }),
    );
  }
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
    const maxIterations = unlimited ? 10000 : Number($('generation-iterations').value);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > (unlimited ? 10000 : 9999))
      throw Error('Choisissez entre 1 et 9 999 générations, ou ∞.');
    return {
      enabled: $('generation-enabled').checked,
      autoAllow: $('generation-auto').checked,
      maxIterations,
      reviewVideos: $('generation-review').checked,
      pythonPath: $('generation-python').value.trim(),
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
  /** Internal: Atelier's own engine runs the family. External: ComfyUI does. */
  const engineOf = record => families.find(item => item.family === record.pipeline)?.engine || 'internal';
  const ENGINES = [
    ['internal', 'Moteur interne'],
    ['external', 'Moteur externe · ComfyUI'],
  ];
  /** The address of ComfyUI and whether it answers, at the top of the external section. */
  function comfyPanel() {
    const panel = node('div', 'comfy-panel'),
      status = node(
        'span',
        'native-status',
        !comfy.enabled
          ? 'Désactivé'
          : comfy.reachable
            ? 'Connecté' + (comfy.version ? ' · ComfyUI ' + comfy.version : '')
            : 'Ne répond pas',
      );
    status.dataset.active = String(comfy.enabled && comfy.reachable);
    const use = input('comfy-enabled', comfy.enabled, 'checkbox'),
      toggle = node('label', 'history-toggle'),
      address = input('comfy-url', comfy.baseUrl);
    toggle.append(use, node('span', '', 'Utiliser ComfyUI'));
    // The families that also run on Atelier's own engine: ticked, they stay there with ComfyUI on.
    const kept = (comfy.choices ?? []).map(choice => {
      const check = input('comfy-own-' + choice.family, (comfy.own ?? []).includes(choice.family), 'checkbox'),
        label = node('label', 'history-toggle');
      label.append(check, node('span', '', choice.label + ' : créer avec le moteur d’Atelier'));
      label.title = 'Sans ComfyUI, cette famille passe de toute façon par le moteur d’Atelier.';
      check.dataset.nativeControl = 'true';
      return { family: choice.family, check, label };
    });
    address.spellcheck = false;
    address.placeholder = 'http://127.0.0.1:8188';
    address.setAttribute('aria-label', 'Adresse de ComfyUI');
    const save = button('Enregistrer', async () => {
      try {
        const result = await run(async signal =>
          (
            await api(
              'generation/comfy',
              {
                enabled: use.checked,
                baseUrl: address.value.trim(),
                own: kept.filter(item => item.check.checked).map(item => item.family),
              },
              { signal },
            )
          ).json(),
        );
        if (result) apply(result, { settings: false });
      } catch (failure) {
        importStatus(failure.message, true);
      }
    });
    for (const control of [use, address, save]) control.dataset.nativeControl = 'true';
    const row = node('div', 'path-input');
    row.append(address, save);
    panel.append(toggle, status, row, ...kept.map(item => item.label));
    return panel;
  }
  /** What a workflow is, at a glance: a colour, and under the pointer what it means. */
  function workflowState(record) {
    const offer = downloads.offers[record.id],
      job = downloads.job;
    if (job.state === 'running' && job.workflowId === record.id) {
      const share = job.total ? Math.floor((job.received / job.total) * 100) : 0;
      return [
        'downloading',
        `Téléchargement : ${share} % (${formatSize(job.received)} sur ${formatSize(job.total)})` +
          (job.current ? ` · ${job.current}` : '') +
          '.',
      ];
    }
    if (record.importDraft) return ['off', 'Brouillon importé : à vérifier avant de l’activer.'];
    if (!record.enabled) return ['off', 'Désactivé : l’assistant ne s’en sert pas.'];
    if (record.ready !== false) return ['ready', 'Prêt : l’assistant peut s’en servir.'];
    if (offer) {
      const names = offer.files.map(file => file.file).join(', '),
        several = offer.files.length > 1,
        them = several ? 'les' : 'le';
      const what = `Il manque ${several ? offer.files.length + ' fichiers' : 'un fichier'} : ${names}.`;
      return [
        'missing',
        what +
          (offer.complete
            ? offer.needsToken
              ? ` ${several ? 'Ils demandent' : 'Il demande'} un compte Hugging Face : enregistrez votre jeton dans l’onglet Mise à jour, puis téléchargez-${them}.`
              : ` Le bouton de téléchargement ${them} place au bon endroit (${formatSize(offer.bytes)}).`
            : ` Placez-${them} dans le dossier de ${several ? 'leur' : 'son'} type (onglet Génération, Dossier des modèles).`),
      ];
    }
    const reason = record.unavailableReason || 'Indisponible.';
    // Not the workflow's fault: its engine is stopped, starting, or ComfyUI does not answer.
    if (!/^Fichier|^Aucun fichier|Choisissez/.test(reason)) return ['waiting', reason];
    return [/^Fichier introuvable|^Aucun fichier/.test(reason) ? 'missing' : 'problem', reason];
  }
  /** Shipped with Atelier, or the user's own (created or imported): the latter wear another colour. */
  const originOf = record =>
    record.update
      ? 'Fourni avec Atelier · nouvelle version.'
      : record.customized
        ? 'Fourni avec Atelier, modifié par vous.'
        : record.builtin
          ? 'Fourni avec Atelier.'
          : 'Créé ou importé par vous.';
  function downloadButton(record, offer) {
    const job = downloads.job,
      mine = job.state === 'running' && job.workflowId === record.id;
    if (mine) {
      const stop = button('Arrêter', async () => {
        try {
          downloads.job = await (await api('downloads/cancel', {})).json();
        } catch (failure) {
          importStatus(failure.message, true);
        }
      });
      stop.title = 'Arrêter le téléchargement ; il reprendra où il en était.';
      return stop;
    }
    const start = button('', async () => {
      if (offer.needsToken) {
        askToken(
          `${record.name} demande un compte Hugging Face : acceptez la licence sur ${offer.page} avec ce compte, puis collez ici un jeton de lecture et relancez le téléchargement.`,
        );
        return;
      }
      try {
        importStatus('');
        downloads.job = await (await api('downloads/start', { id: record.id })).json();
        renderList();
        followDownload();
      } catch (failure) {
        importStatus(failure.message, true);
      }
    });
    start.className = 'secondary workflow-download';
    start.append(icon('download'), node('span', '', formatSize(offer.bytes)));
    const label = `Télécharger les fichiers manquants (${formatSize(offer.bytes)})`;
    start.setAttribute('aria-label', label);
    start.title = label;
    start.dataset.nativeControl = 'true';
    if (job.state === 'running') {
      start.disabled = true;
      start.dataset.unavailable = 'true';
      start.title = 'Un autre téléchargement est en cours.';
    }
    return start;
  }
  function workflowCard(record) {
    const card = node('article', 'workflow-card'),
      [stateName, stateText] = workflowState(record),
      offer = downloads.offers[record.id];
    card.dataset.state = stateName;
    card.dataset.origin = record.builtin ? 'atelier' : 'user';
    const dot = node('span', 'workflow-state');
    dot.tabIndex = 0;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'État : ' + stateText);
    dot.dataset.help = stateText;
    dot.dataset.helpAlign = 'start';
    const name = node('strong', 'workflow-name', record.name);
    const details = [record.description, originOf(record)].filter(Boolean).join('\n');
    // The name says the details too, for a pointer that passes over it.
    name.dataset.help = details;
    name.dataset.helpAlign = 'start';
    const tip = node('span', 'help-tip workflow-help', '?');
    tip.tabIndex = 0;
    tip.setAttribute('role', 'img');
    tip.setAttribute('aria-label', 'Détails : ' + details);
    tip.dataset.help = details;
    const actions = node('div', 'native-card-actions');
    if (offer?.complete) actions.append(downloadButton(record, offer));
    if (record.customized) {
      const reset = button(
        'Rétablir',
        async () => {
          try {
            const result = await run(async signal =>
              (await api('generation/reset', { id: record.id }, { signal })).json(),
            );
            if (result) apply(result, { settings: false });
          } catch (failure) {
            importStatus(failure.message, true);
          }
        },
        'text-button',
      );
      reset.title = 'Revenir à la version fournie avec Atelier';
      reset.dataset.nativeControl = 'true';
      actions.append(reset);
    }
    // Only the user's own workflows can be deleted; the shipped ones stay (an edit is restored).
    if (!record.builtin) {
      let confirming = false;
      const cancel = button('Annuler', () => {
        confirming = false;
        remove.textContent = 'Supprimer';
        cancel.hidden = true;
      });
      cancel.hidden = true;
      cancel.dataset.nativeControl = 'true';
      const remove = button(
        'Supprimer',
        async () => {
          if (!confirming) {
            confirming = true;
            remove.textContent = 'Confirmer';
            cancel.hidden = false;
            return;
          }
          try {
            await run(async signal => {
              await api('generation/remove', { id: record.id }, { signal });
              workflows = workflows.filter(item => item.id !== record.id);
              renderList();
            });
          } catch (failure) {
            importStatus(failure.message, true);
          }
        },
        'text-button native-remove',
      );
      remove.dataset.nativeControl = 'true';
      actions.append(remove, cancel);
    }
    const editButton = button('Modifier', () => edit(record));
    editButton.dataset.nativeControl = 'true';
    actions.append(editButton);
    card.append(dot, name, tip, actions);
    if (stateName === 'downloading') {
      const bar = node('span', 'workflow-progress'),
        fill = node('span');
      fill.style.width = (downloads.job.total ? (downloads.job.received / downloads.job.total) * 100 : 0) + '%';
      bar.append(fill);
      card.append(bar);
    }
    return card;
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
  /** The card of the download in progress, without drawing the list again (the bubble stays open). */
  function updateProgress() {
    const job = downloads.job;
    for (const card of $('workflow-list').querySelectorAll('.workflow-card[data-state="downloading"]')) {
      const fill = card.querySelector('.workflow-progress > span');
      if (fill) fill.style.width = (job.total ? (job.received / job.total) * 100 : 0) + '%';
      const dot = card.querySelector('.workflow-state'),
        record = workflows.find(item => item.id === job.workflowId);
      if (dot && record) {
        const [, text] = workflowState(record);
        dot.dataset.help = text;
        dot.setAttribute('aria-label', 'État : ' + text);
        onHelpChange(dot);
      }
    }
  }
  function renderList() {
    $('workflow-list').replaceChildren();
    for (const [engine, title] of ENGINES) {
      const heading = node('div', 'workflow-section');
      heading.append(node('h4', '', title));
      if (engine === 'external') heading.append(comfyPanel());
      $('workflow-list').append(heading);
      const own = workflows.filter(record => engineOf(record) === engine);
      if (!own.length) $('workflow-list').append(node('p', 'native-empty', 'Aucun workflow.'));
      for (const record of own) $('workflow-list').append(workflowCard(record));
    }
    if (hiddenWorkflows > 0) {
      const restore = button(
        `Réafficher les workflows fournis supprimés (${hiddenWorkflows})`,
        async () => {
          try {
            const result = await run(async signal => (await api('generation/unhide', {}, { signal })).json());
            if (result) apply(result, { settings: false });
          } catch (failure) {
            importStatus(failure.message, true);
          }
        },
        'text-button native-unhide',
      );
      restore.dataset.nativeControl = 'true';
      $('workflow-list').append(restore);
    }
    setBusy(busy);
  }
  function apply(result, { settings = true } = {}) {
    workflows = result.workflows || [];
    comfy = result.comfy || comfy;
    hiddenWorkflows = result.hiddenWorkflows ?? hiddenWorkflows;
    downloads = result.downloads || downloads;
    if (downloads.job?.state === 'running') followDownload();
    assets = result.assets || assets;
    folders = result.folders || folders;
    if (result.families) {
      families = result.families;
      const option = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
      $('native-workflow-pipeline').replaceChildren(
        option('', 'Choisir un moteur…'),
        ...families.map(item => option(item.family, familyLabel(item.family))),
      );
    }
    runner = result.runner || runner;
    const config = result.config;
    if (config) {
      state.generation = config;
      if (settings) {
        $('generation-enabled').checked = config.enabled;
        $('generation-auto').checked = config.autoAllow;
        $('generation-review').checked = config.reviewVideos === true;
        unlimited = config.maxIterations === 10000;
        if (!unlimited) lastLimited = config.maxIterations || 5;
        $('generation-iterations').value = lastLimited;
        $('generation-python').value = config.pythonPath || '';
        for (const [key, [id, role]] of Object.entries(folderControls))
          $(id).value = config[key] || folders[role] || '';
        syncLimit();
      }
    }
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
  /**
   * One field per file: pick a registered file from its suggestions, paste a path, or browse.
   * The chosen asset id is kept in a hidden control (`control`, whose onchange other parts of
   * the editor listen to); the visible field shows the file's name.
   */
  function assetPicker(role, id, value) {
    const spec = familyOf(draft.pipeline)?.components[role] || {},
      container = node('div', 'native-asset-picker'),
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
      automatic = spec.format === 'tokenizer' || Boolean(spec.signature?.length),
      found = draft.automatic?.[role] || '',
      replaced = node('p', 'field-help', ''),
      hint = folder ? 'Choisir un dossier ou coller son chemin…' : 'Choisir un fichier ou coller son chemin…',
      unset = automatic ? 'Automatique' + (found ? ' : ' + found : '') + ' · ou ' + hint.toLowerCase() : hint;
    const fileName = path => path?.split(/[\\/]/).pop() || '';
    // Two files of the same name (in different folders) are told apart by their folder.
    function display(assetId) {
      const asset = assets.find(item => item.id === assetId);
      if (!asset) return assetId ? draft.importDraft?.files[assetId] || 'Fichier à retrouver' : '';
      const name = asset.name || fileName(asset.path),
        twins = compatibleAssets().filter(item => item.id !== asset.id && (item.name || fileName(item.path)) === name);
      return twins.length ? `${name} (${fileName(asset.path?.replace(/[\\/][^\\/]*$/, ''))})` : name;
    }
    let shown = '';
    const placeholder = () => (control.value ? hint : unset);
    function show() {
      shown = display(control.value);
      field.value = shown;
      field.placeholder = placeholder();
      field.dataset.automatic = String(automatic && !control.value);
      back.hidden = !automatic || !control.value;
      // The file chosen is not here any more: the one that stands in for it is named.
      replaced.textContent =
        control.value && found && control.value === value
          ? `Ce fichier n’est plus à sa place : ${found} le remplace, pris dans le dossier des réglages.`
          : '';
      replaced.hidden = !replaced.textContent;
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
    field.setAttribute('aria-label', 'Fichier · ' + componentLabel(role));
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
        `Aucun fichier « ${text} » : choisissez-le dans la liste, collez son chemin complet ou utilisez Parcourir…`,
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
      if (!field.value.trim()) {
        field.value = shown;
        field.placeholder = placeholder();
      }
    };
    field.oninput = () => resolveTyped({ final: false });
    field.onchange = () => resolveTyped({ final: true });
    field.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      resolveTyped({ final: true });
    };
    const browseButton = button('Parcourir…', async () => {
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
    });
    // Back to the file of the settings' folder, for a component that had one chosen here.
    const back = button('Automatique', () => choose(''));
    back.title = 'Ne plus fixer ce fichier : prendre celui qui convient dans le dossier des réglages';
    const row = node('div', 'path-input');
    row.append(field, browseButton, back, control, list);
    container.append(row, replaced);
    show();
    return {
      container,
      control,
      adopt,
      // Whether the folders of the settings can answer for this component (see `unset`).
      automatic,
      selected() {
        const text = field.value.trim();
        if (text && text !== shown)
          throw Error(
            `Fichier non reconnu pour « ${componentLabel(role)} » : choisissez-le dans la liste, collez son chemin complet ou utilisez Parcourir…`,
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
  function componentControl(role, policy, { optional = false, present = true } = {}) {
    const card = node('div', 'native-component'),
      id = 'native-component-' + role,
      ownershipSelect = segmented(
        id + '-policy',
        [
          ['fixed', ownership.fixed],
          ['model', ownership.model],
        ],
        policy.policy,
      ),
      picker = assetPicker(role, id, policy.asset || policy.default),
      allowed = node('div', 'native-asset-choices');
    let checks = [];
    function renderChoices() {
      const selected = new Set(
        checks.length ? checks.filter(([, check]) => check.checked).map(([id]) => id) : policy.choices || [],
      );
      checks = [];
      allowed.replaceChildren();
      for (const asset of picker.compatible) {
        const check = input(
            id + '-' + asset.id,
            selected.has(asset.id) || asset.id === picker.control.value,
            'checkbox',
          ),
          label = node('label', 'history-toggle');
        label.append(check, node('span', '', asset.name || asset.path.split(/[\\/]/).pop()));
        allowed.append(label);
        checks.push([asset.id, check]);
      }
      if (!checks.length) allowed.append(node('p', 'field-help', 'Enregistrez les fichiers locaux à autoriser.'));
    }
    picker.control.onchange = renderChoices;
    renderChoices();
    ownershipSelect.onchange = () => {
      allowed.hidden = ownershipSelect.value !== 'model';
    };
    ownershipSelect.onchange();
    const spec = familyOf(draft.pipeline)?.components[role] || {};
    // A component the assistant may not choose (a tokenizer must match its encoder) shows no ownership switch.
    if (spec.policies && !spec.policies.includes('model')) ownershipSelect.hidden = true;
    card.append(field(componentLabel(role), ownershipSelect), picker.container, allowed);
    if (spec.help) card.append(node('p', 'field-help', spec.help));
    const active = input(id + '-enabled', present, 'checkbox');
    if (optional) {
      const label = node('label', 'history-toggle');
      label.append(active, node('span', '', 'Utiliser ' + componentLabel(role)));
      card.append(label);
      const sync = () => {
        ownershipSelect.hidden = !active.checked;
        picker.container.hidden = !active.checked;
        allowed.hidden = !active.checked || ownershipSelect.value !== 'model';
      };
      active.onchange = sync;
      ownershipSelect.onchange = sync;
      sync();
    }
    return {
      card,
      picker,
      read() {
        if (optional && !active.checked) return null;
        // Left without a file, where the folders of the settings can answer: a required
        // component is not sent at all, an optional one that is used says so; the server takes
        // the file from the folders. A model folder cannot be told from another: it is asked for.
        if (ownershipSelect.value === 'fixed')
          return picker.selected() || !picker.automatic
            ? { policy: 'fixed', asset: picker.selected() }
            : optional
              ? { policy: 'fixed', asset: AUTOMATIC }
              : null;
        const choices = checks.filter(([, check]) => check.checked).map(([id]) => id);
        if (picker.selected() && !choices.includes(picker.selected()))
          throw Error(
            'Choisissez une valeur par défaut parmi les fichiers autorisés pour ' + componentLabel(role) + '.',
          );
        return {
          policy: 'model',
          choices,
          ...(picker.selected() ? { default: picker.selected() } : {}),
          ...(policy.description ? { description: policy.description } : {}),
        };
      },
    };
  }
  function primitive(name, policy, prefix = 'native', allowed = parameterPolicies(name)) {
    const title = prefix === 'native-lora-strength' ? 'Intensité' : labels[name] || name;
    const type = typeFor(name, policy),
      card = node('div', 'native-parameter'),
      owner = segmented(
        prefix + '-policy-' + name,
        allowed.map(key => [key, ownership[key]]),
        policy.policy,
      );
    const initial = policy.policy === 'fixed' ? policy.value : policy.default;
    const spec =
      prefix === 'native-lora-strength' ? familyOf(draft.pipeline)?.loras?.strength || {} : parameterSpec(name);
    const boundsFor = [spec.min ?? spec.choices?.[0] ?? 0, spec.max ?? spec.choices?.at(-1) ?? 100];
    const enumChoices = policy.choices || (spec.type === 'string' ? spec.choices : null) || null;
    const value =
      type === 'boolean'
        ? input(prefix + '-value-' + name, initial ?? false, 'checkbox')
        : enumChoices
          ? select(
              prefix + '-value-' + name,
              enumChoices.map(choice => [String(choice), choiceLabels[choice] || String(choice)]),
              initial ?? enumChoices[0],
            )
          : type === 'string'
            ? element('textarea', prefix + '-value-' + name)
            : input(prefix + '-value-' + name, initial ?? (name === 'seed' ? 0 : 1), 'number');
    if (type === 'string' && !enumChoices) {
      value.value = initial ?? '';
      value.rows = 3;
      value.maxLength = policy.maxLength || spec.maxLength || 8000;
    }
    if (type === 'integer') value.step = '1';
    else if (type === 'number') value.step = 'any';
    const bounds = node('div', 'native-policy-bounds'),
      min = input(prefix + '-min-' + name, policy.min ?? boundsFor[0], 'number'),
      max = input(prefix + '-max-' + name, policy.max ?? boundsFor[1], 'number');
    min.step = max.step = type === 'integer' ? '1' : 'any';
    if (['integer', 'number'].includes(type)) bounds.append(field('Minimum', min), field('Maximum', max));
    const description = input(prefix + '-description-' + name, policy.description || '');
    description.maxLength = 1000;
    description.placeholder = 'Consigne pour l’assistant (facultatif)';
    description.setAttribute('aria-label', 'Indication · ' + (labels[name] || name));
    const useDefault = input(
        prefix + '-use-default-' + name,
        policy.policy === 'fixed' || Object.hasOwn(policy, 'default'),
        'checkbox',
      ),
      defaultLabel = node('label', 'history-toggle');
    defaultLabel.append(useDefault, node('span', '', 'Préférer une valeur par défaut'));
    const valueField = field(type === 'boolean' ? 'Activé' : title, value),
      heading = field(title, owner);
    heading.className += ' native-parameter-heading';
    card.append(heading, defaultLabel, valueField, bounds, description);
    value.setAttribute('aria-label', title);
    valueField.children[0].className = 'sr-only';
    owner.onchange = () => {
      defaultLabel.hidden = owner.value !== 'model';
      valueField.hidden = owner.value === 'random' || (owner.value === 'model' && !useDefault.checked);
      bounds.hidden = owner.value !== 'model' || !['integer', 'number'].includes(type);
      description.hidden = owner.value !== 'model';
    };
    useDefault.onchange = owner.onchange;
    owner.onchange();
    const number = (control, label) => {
      if (control.value === '') throw Error(label + ' : ajoutez une valeur.');
      const value = Number(control.value);
      if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))
        throw Error(label + ' : valeur numérique invalide.');
      return value;
    };
    return {
      card,
      owner,
      value,
      min,
      max,
      read() {
        const selected = owner.value;
        if (selected === 'random') return { policy: 'random', type: 'integer' };
        const concrete =
          selected === 'model' && !useDefault.checked
            ? undefined
            : type === 'boolean'
              ? value.checked
              : type === 'string'
                ? value.value
                : number(value, labels[name] || name);
        if (selected === 'fixed') return { policy: 'fixed', value: concrete };
        const result = { policy: 'model', type };
        if (useDefault.checked) result.default = concrete;
        if (enumChoices) result.choices = enumChoices;
        // Only what the workflow narrows is written: the family's own limits stay the family's,
        // so a workflow follows them when an update widens them.
        if (type === 'string' && !enumChoices && policy.maxLength) result.maxLength = policy.maxLength;
        if (['number', 'integer'].includes(type)) {
          const low = number(min, 'Minimum'),
            high = number(max, 'Maximum');
          if (low > high || (useDefault.checked && (concrete < low || concrete > high)))
            throw Error((labels[name] || name) + ' : la valeur par défaut doit être dans les limites choisies.');
          if (policy.min !== undefined || (!enumChoices && low !== spec.min)) result.min = low;
          if (policy.max !== undefined || (!enumChoices && high !== spec.max)) result.max = high;
        }
        if (description.value.trim()) result.description = description.value.trim();
        return result;
      },
    };
  }
  function renderLoras(loras) {
    readLoras = [];
    $('native-workflow-loras').replaceChildren();
    const count = () => {
      $('native-lora-count').textContent = String(readLoras.length);
    };
    for (const lora of loras) addLora(lora);
    count();
  }
  function addLora(lora) {
    const card = node('div', 'native-lora'),
      picker = assetPicker('lora', 'native-lora-asset-' + lora.id, lora.asset),
      description = input('native-lora-description-' + lora.id, lora.description || ''),
      enabled = segmented(
        'native-lora-enabled-' + lora.id,
        [
          ['off', 'Désactivé'],
          ['fixed', 'Activé'],
          ['model', 'Assistant'],
        ],
        lora.enabled.policy === 'off' || (lora.enabled.policy === 'fixed' && !lora.enabled.value)
          ? 'off'
          : lora.enabled.policy,
      ),
      defaultEnabled = input('native-lora-default-' + lora.id, lora.enabled.default ?? true, 'checkbox');
    description.placeholder = 'Style ou effet apporté';
    description.maxLength = 1000;
    const defaultLabel = node('label', 'history-toggle');
    defaultLabel.append(defaultEnabled, node('span', '', 'Actif par défaut'));
    enabled.onchange = () => {
      defaultLabel.hidden = enabled.value !== 'model';
    };
    enabled.onchange();
    const strength = primitive(lora.id, { ...lora.strength, type: 'number' }, 'native-lora-strength', [
      'fixed',
      'model',
    ]);
    const item = {
      read: () => ({
        id: lora.id,
        asset: picker.selected(),
        description: description.value.trim(),
        enabled:
          enabled.value === 'off'
            ? { policy: 'off' }
            : enabled.value === 'fixed'
              ? { policy: 'fixed', value: true }
              : { policy: 'model', default: defaultEnabled.checked },
        strength: strength.read(),
      }),
    };
    card.append(
      field('Fichier LoRA', picker.container),
      field('Effet / usage', description),
      field('Activation', enabled),
      defaultLabel,
      strength.card,
      button(
        'Retirer',
        () => {
          readLoras = readLoras.filter(value => value !== item);
          card.remove();
          $('native-lora-count').textContent = String(readLoras.length);
        },
        'text-button native-remove',
      ),
    );
    readLoras.push(item);
    $('native-workflow-loras').append(card);
    $('native-lora-count').textContent = String(readLoras.length);
  }
  function renderReferences(references) {
    readReferences = [];
    $('native-workflow-references').replaceChildren();
    for (const reference of references) addReference(reference);
    referenceCount();
  }
  function referenceCount() {
    $('native-reference-count').textContent = String(readReferences.length);
    $('native-workflow-add-reference').dataset.unavailable = String(
      readReferences.length >=
        (draft.importDraft
          ? 256
          : Object.values(familyOf(draft.pipeline)?.roles || {}).reduce((sum, role) => sum + (role.max ?? 1), 0)),
    );
    $('native-workflow-add-reference').disabled =
      busy || working || $('native-workflow-add-reference').dataset.unavailable === 'true';
  }
  function addReference(reference) {
    const known = Object.keys(familyOf(draft.pipeline)?.roles || {});
    const roles = [
      ...new Set([...(known.length ? known : families.flatMap(item => Object.keys(item.roles))), reference.role]),
    ];
    const card = node('div', 'native-reference'),
      role = select(
        'native-reference-role-' + reference.id,
        roles.map(role => [role, roleLabel(role)]),
        reference.role,
      ),
      name = input('native-reference-name-' + reference.id, reference.name || roleLabel(reference.role)),
      description = input('native-reference-description-' + reference.id, reference.description || ''),
      required = input('native-reference-required-' + reference.id, reference.required, 'checkbox'),
      label = node('label', 'history-toggle');
    name.maxLength = 120;
    description.maxLength = 1000;
    description.placeholder = 'Ce que cette référence doit apporter';
    label.append(required, node('span', '', 'Référence obligatoire'));
    const item = {
      read: () => ({
        id: reference.id,
        role: role.value,
        name: name.value.trim(),
        description: description.value.trim(),
        required: required.checked,
      }),
    };
    card.append(
      field('Usage', role),
      field('Nom', name),
      field('Description', description),
      label,
      button(
        'Retirer',
        () => {
          readReferences = readReferences.filter(value => value !== item);
          card.remove();
          referenceCount();
        },
        'text-button native-remove',
      ),
    );
    readReferences.push(item);
    $('native-workflow-references').append(card);
    referenceCount();
  }
  function renderProfiles(profiles) {
    readProfiles = [];
    $('native-workflow-profiles').replaceChildren();
    for (const [stage, profile] of Object.entries(profiles || {})) {
      const group = node('div', 'native-profile');
      group.append(node('h4', '', stage === 'draft' ? 'Brouillon' : 'Vidéo finale'));
      const controls = [];
      for (const [name, value] of Object.entries(profile.parameters || {})) {
        const control = input('native-profile-' + stage + '-' + name, value, 'number');
        control.step = 'any';
        group.append(field(labels[name] || name, control));
        controls.push([name, control]);
      }
      readProfiles.push([
        stage,
        () => ({
          parameters: Object.fromEntries(
            controls.map(([name, control]) => {
              const value = Number(control.value);
              if (control.value === '' || !Number.isFinite(value))
                throw Error('Profil vidéo : valeur numérique invalide.');
              return [name, value];
            }),
          ),
        }),
      ]);
      $('native-workflow-profiles').append(group);
    }
  }
  function renderSource() {
    $('native-source-settings').replaceChildren();
    $('native-import-notes').replaceChildren();
    const meta = draft.importDraft,
      section = $('native-source-section');
    section.hidden = !meta;
    section.open = false;
    let rendered = false;
    if (!meta) {
      section.ontoggle = null;
      return;
    }
    for (const warning of [...meta.blockers, ...meta.warnings]) $('native-import-notes').append(node('p', '', warning));
    section.ontoggle = () => {
      if (!section.open || rendered) return;
      rendered = true;
      for (const setting of meta.extras)
        $('native-source-settings').append(
          field(
            setting.label,
            node(
              'pre',
              'native-source-value',
              typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value, null, 2),
            ),
          ),
        );
    };
  }
  function renderEditor() {
    $('native-workflow-name').value = draft.name;
    $('native-workflow-description').value = draft.description;
    $('native-workflow-enabled').checked = draft.enabled;
    $('native-workflow-pipeline').value = draft.pipeline;
    $('native-workflow-video').hidden = !familyOf(draft.pipeline)?.profiles;
    $('native-workflow-title').textContent = isNew ? 'Créer un workflow' : 'Modifier le workflow';
    $('native-workflow-capability').textContent = draft.importDraft
      ? draft.importDraft.blockers.length
        ? 'Brouillon prérempli · exécution non prise en charge pour ce graphe.'
        : 'Brouillon prérempli · activation après vérification des fichiers et des réglages.'
      : draft.unavailableReason || '';
    $('native-workflow-enabled').dataset.unavailable = String(Boolean(draft.importDraft?.blockers.length));
    readComponents = [];
    const componentControls = {};
    $('native-workflow-components').replaceChildren();
    for (const role of [
      ...new Set([
        ...Object.keys(draft.components),
        ...Object.entries(familyOf(draft.pipeline)?.components || {})
          .filter(([, spec]) => spec.required)
          .map(([role]) => role),
      ]),
    ]) {
      const policy = draft.components[role],
        control = componentControl(
          role,
          policy || { policy: 'fixed', asset: draft.importDraft ? 'missing-' + role : '' },
          { optional: !familyOf(draft.pipeline)?.components[role]?.required, present: Boolean(policy) },
        );
      readComponents.push([role, control.read]);
      componentControls[role] = control;
      $('native-workflow-components').append(control.card);
    }
    suggestTokenizers(componentControls);
    readParameters = [];
    $('native-workflow-parameters').replaceChildren();
    const enhanced = renderEnhance();
    for (const [name, policy] of Object.entries(draft.parameters)) {
      // Shown as its own on/off section (renderEnhance) rather than as one more number or checkbox.
      if (name === 'expandPrompt' && enhanced) continue;
      if (name === 'expandPrompt' && !draft.promptExpansion && policy.policy === 'fixed' && !policy.value) {
        readParameters.push([name, () => policy]);
        continue;
      }
      const control = primitive(name, policy);
      readParameters.push([name, control.read]);
      $('native-workflow-parameters').append(control.card);
    }
    renderLoras(draft.loras || []);
    renderReferences(draft.references || []);
    renderProfiles(draft.profiles);
    renderSource();
    error('');
    $('native-workflow-unsaved').hidden = true;
    $('native-workflow-switch').hidden = true;
    setBusy(busy);
  }
  /**
   * Prompt enhancement as one visible Off/On switch. When on, the family's text encoder rewrites the
   * prompt before each image with an editable instruction; the prompt actually used is kept with the image.
   * Returns whether the family offers it.
   */
  function renderEnhance() {
    const manifest = familyOf(draft.pipeline),
      policy = draft.parameters.expandPrompt,
      config = draft.promptExpansion || manifest?.promptExpansionDefault;
    const supported = Boolean(
      manifest?.features?.includes('promptExpansion') && manifest.parameters?.expandPrompt && config,
    );
    $('native-workflow-enhance').hidden = !supported;
    $('native-workflow-enhance-body').replaceChildren();
    readEnhance = null;
    if (!supported) return false;
    const current = policy?.policy === 'model' ? 'model' : policy?.value === true ? 'on' : 'off';
    const toggle = segmented(
      'native-enhance-switch',
      [['off', 'Off'], ['on', 'On'], ...(current === 'model' ? [['model', 'Assistant']] : [])],
      current,
    );
    const template = element('textarea', 'native-enhance-template');
    template.value = config.template;
    template.rows = 6;
    template.spellcheck = false;
    template.setAttribute('aria-label', 'Consigne d’amélioration du prompt');
    const instruction = node('details', 'native-manual-path');
    instruction.append(
      node('summary', '', 'Consigne d’amélioration'),
      template,
      node(
        'p',
        'field-help',
        'Le texte {{prompt}} est remplacé par le prompt demandé ; il doit apparaître une seule fois.',
      ),
    );
    const sync = () => {
      instruction.hidden = toggle.value === 'off';
    };
    toggle.onchange = sync;
    sync();
    $('native-workflow-enhance-body').append(
      field('Améliorer le prompt avant chaque image', toggle),
      node(
        'p',
        'field-help',
        'L’encodeur de texte réécrit le prompt en une description plus détaillée avant la génération (quelques secondes de plus). Le prompt réellement utilisé est affiché dans les détails de l’image.',
      ),
      instruction,
    );
    readEnhance = () => {
      const value = toggle.value;
      if (value === 'off') return { parameter: { policy: 'fixed', value: false }, expansion: draft.promptExpansion };
      if (template.value.split('{{prompt}}').length !== 2)
        throw Error('La consigne d’amélioration doit contenir {{prompt}} exactement une fois.');
      return {
        parameter: value === 'model' ? policy : { policy: 'fixed', value: true },
        expansion: { ...config, template: template.value },
      };
    };
    return true;
  }
  function readEditor() {
    const record = {
      ...draft,
      name: $('native-workflow-name').value.trim(),
      description: $('native-workflow-description').value.trim(),
      enabled: $('native-workflow-enabled').checked,
      components: Object.fromEntries(
        readComponents.map(([name, read]) => [name, read()]).filter(([, value]) => value !== null),
      ),
      parameters: Object.fromEntries(readParameters.map(([name, read]) => [name, read()])),
      loras: readLoras.map(control => control.read()),
      references: readReferences.map(control => control.read()),
    };
    // What the server found in the folders is its answer, not a part of the workflow.
    delete record.automatic;
    if (readProfiles.length) record.profiles = Object.fromEntries(readProfiles.map(([stage, read]) => [stage, read()]));
    if (readEnhance) {
      const { parameter, expansion } = readEnhance();
      record.parameters.expandPrompt = parameter;
      if (expansion) record.promptExpansion = expansion;
      else delete record.promptExpansion;
    }
    for (const name of ['digest', 'ready', 'unavailableReason', 'error', 'path', 'builtin', 'customized', 'update'])
      delete record[name];
    return record;
  }
  function editorDirty(includeNew = true) {
    if (!draft) return false;
    try {
      return (includeNew && isNew) || JSON.stringify(readEditor()) !== baseline;
    } catch {
      return true;
    }
  }
  async function template(pipeline, signal) {
    return (
      await (await api('generation/templates?pipeline=' + encodeURIComponent(pipeline), undefined, { signal })).json()
    ).template;
  }
  function clearTemplateAssets(record) {
    for (const policy of Object.values(record.components)) if (policy.policy === 'fixed') policy.asset = '';
  }
  async function edit(record, { fresh = false } = {}) {
    if (busy || working) return false;
    const session = version;
    try {
      if (record?.importSummary) {
        record = await run(async signal =>
          (await api('generation/workflows/' + encodeURIComponent(record.id), undefined, { signal })).json(),
        );
        if (!record || session !== version) return false;
      }
      if (!record) {
        record = await run(signal => template(families[0]?.family, signal));
        if (!record || session !== version) return false;
        record = { ...record, id: crypto.randomUUID(), name: '', description: '' };
        clearTemplateAssets(record);
        fresh = true;
      }
      isNew = fresh;
      draft = structuredClone(record);
      returnFocus = document.activeElement || $('workflow-add');
      // The settings scroll inside their tab's area; the editor scrolls the whole dialog.
      parentScroll = $('settings-body')?.scrollTop || 0;
      renderEditor();
      baseline = JSON.stringify(readEditor());
      $('settings-form').hidden = true;
      $('workflow-editor').hidden = false;
      $('settings').setAttribute('aria-labelledby', 'native-workflow-title');
      $('settings').scrollTop = 0;
      $('native-workflow-name').focus();
      return true;
    } catch (failure) {
      if (session === version) {
        draft = null;
        importStatus(failure.message, true);
      }
      return false;
    }
  }
  function leaveEditor() {
    draft = null;
    afterBack = undefined;
    pendingPipeline = '';
    $('workflow-editor').hidden = true;
    $('settings-form').hidden = false;
    $('settings').setAttribute('aria-labelledby', 'settings-title');
    $('native-workflow-unsaved').hidden = true;
    $('settings').scrollTop = 0;
    if ($('settings-body')) $('settings-body').scrollTop = parentScroll;
    (returnFocus?.isConnected === false ? $('workflow-add') : returnFocus)?.focus();
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
      if (!record.name || (!record.importDraft && !record.description))
        throw Error('Ajoutez un nom et une description indiquant quand utiliser ce workflow.');
      if (!record.importDraft || record.enabled) {
        for (const [role, policy] of Object.entries(record.components))
          if ((policy.policy === 'fixed' && !policy.asset) || (policy.policy === 'model' && !policy.choices.length))
            throw Error(
              familyOf(record.pipeline)?.components[role]?.format === 'tokenizer'
                ? 'Choisissez le dossier du tokenizer : il est requis pour enregistrer ce workflow.'
                : 'Choisissez un fichier pour « ' + componentLabel(role) + ' ».',
            );
        if (record.loras.some(lora => !lora.asset)) {
          const section = $('native-workflow-loras').closest?.('details');
          if (section) section.open = true;
          throw Error('Choisissez le fichier de chaque LoRA, ou retirez les lignes inutilisées.');
        }
      }
      const result = await run(async signal => (await api('generation/workflows', record, { signal })).json());
      if (session !== version || !result) return false;
      const saved = result.workflow || record,
        index = workflows.findIndex(item => item.id === saved.id);
      let view = saved;
      if (saved.importDraft) {
        const { source, extras, ...summary } = saved.importDraft;
        view = { ...saved, importDraft: summary, importSummary: true };
      }
      if (index < 0) workflows.push(view);
      else workflows[index] = view;
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
  }
  $('generation-iterations').oninput = () => {
    lastLimited = Number($('generation-iterations').value) || 5;
    syncLimit();
  };
  $('generation-minus').onclick = () => {
    if (unlimited) {
      unlimited = false;
      lastLimited = 9999;
    } else lastLimited = Math.max(1, Number($('generation-iterations').value) - 1);
    $('generation-iterations').value = lastLimited;
    syncLimit();
  };
  $('generation-plus').onclick = () => {
    if (unlimited) return;
    lastLimited = Number($('generation-iterations').value) + 1;
    if (lastLimited >= 10000) unlimited = true;
    else $('generation-iterations').value = lastLimited;
    syncLimit();
  };
  $('generation-unlimited').onclick = () => {
    if (!unlimited) lastLimited = Math.min(9999, Math.max(1, Number($('generation-iterations').value) || 5));
    unlimited = !unlimited;
    $('generation-iterations').value = lastLimited;
    syncLimit();
  };
  for (const [id, kind] of [['generation-python', 'python']])
    $(id + '-browse').onclick = async () => {
      try {
        await run(async signal => {
          const path = await browse(kind, $(id).value, signal);
          if (path) $(id).value = path;
        });
      } catch (failure) {
        if (!controller.signal.aborted) $('generation-status').textContent = failure.message;
      }
    };
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
  $('generation-recover').onclick = async () => {
    try {
      await api('tools/recover', {});
      options.onChange?.();
      $('generation-status').textContent = 'GPU libéré.';
    } catch (failure) {
      $('generation-status').textContent = failure.message;
    }
  };
  $('workflow-add').onclick = () => edit();
  $('native-workflow-back').onclick = () => requestBack();
  $('native-workflow-close').onclick = () => options.onRequestClose?.();
  $('native-workflow-save').onclick = saveEditor;
  $('native-workflow-keep').onclick = () => {
    $('native-workflow-unsaved').hidden = true;
    afterBack = undefined;
    $('native-workflow-name').focus();
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
  $('native-workflow-add-lora').onclick = () => {
    addLora({
      id: crypto.randomUUID(),
      asset: '',
      description: '',
      enabled: { policy: 'off' },
      strength: { policy: 'fixed', value: 1 },
    });
  };
  $('native-workflow-add-reference').onclick = () => {
    if ($('native-workflow-add-reference').disabled) return;
    addReference({
      id: crypto.randomUUID(),
      role: Object.keys(familyOf(draft.pipeline)?.roles || {})[0] || 'reference',
      required: false,
    });
  };
  async function changePipeline(pipeline) {
    const session = version;
    try {
      const identity = {
          id: draft.id,
          name: $('native-workflow-name').value,
          description: $('native-workflow-description').value,
        },
        next = await run(signal => template(pipeline, signal));
      if (!next || session !== version) return;
      draft = { ...next, ...identity, enabled: false };
      clearTemplateAssets(draft);
      renderEditor();
    } catch (failure) {
      if (session === version) error(failure.message);
    }
  }
  $('native-workflow-pipeline').onchange = async () => {
    const pipeline = $('native-workflow-pipeline').value;
    $('native-workflow-pipeline').value = draft.pipeline;
    if (pipeline === draft.pipeline) return;
    if (!isNew || editorDirty(false)) {
      pendingPipeline = pipeline;
      $('native-workflow-switch').hidden = false;
      $('native-workflow-switch-cancel').focus();
      return;
    }
    await changePipeline(pipeline);
  };
  $('native-workflow-switch-cancel').onclick = () => {
    pendingPipeline = '';
    $('native-workflow-switch').hidden = true;
    $('native-workflow-pipeline').focus();
  };
  $('native-workflow-switch-confirm').onclick = async () => {
    const pipeline = pendingPipeline;
    pendingPipeline = '';
    $('native-workflow-switch').hidden = true;
    if (pipeline) await changePipeline(pipeline);
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
  for (const [id] of Object.values(folderControls))
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
    };
  $('native-workflow-import').onclick = () => $('native-workflow-file').click();
  $('native-workflow-file').onchange = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy || working) return;
    const paths = Object.fromEntries(Object.entries(folderControls).map(([key, [id]]) => [key, $(id).value.trim()])),
      session = version;
    importStatus('Lecture du workflow…');
    try {
      const result = await run(async signal => {
        if (file.size > 2 * 1024 * 1024) throw Error('Workflow limité à 2 Mo.');
        const sourceText = await file.text();
        signal.throwIfAborted();
        return (await api('generation/import', { sourceText, ...paths, name: file.name || '' }, { signal })).json();
      });
      if (!result || session !== version) return;
      assets = result.assets || assets;
      if (await edit(result.workflow, { fresh: true })) importStatus('');
    } catch (failure) {
      if (session === version) importStatus(failure.message, true);
    }
  };
  $('native-workflow-export').onclick = () => {
    try {
      const record = readEditor(),
        url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2) + '\n'], { type: 'application/json' })),
        link = element('a');
      link.href = url;
      link.download = record.id + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (failure) {
      error(failure.message);
    }
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
  };
}
