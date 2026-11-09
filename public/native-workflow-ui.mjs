import { setupGenerationRuntime } from './generation-runtime.mjs';

const labels = {
  model: 'Modèle',
  textEncoder: 'Encodeur de texte',
  vae: 'VAE image / vidéo',
  audioVae: 'VAE audio',
  textProjection: 'Projection de texte',
  enhancer: 'Enhancer',
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
  duration: 'Durée (secondes)',
  audio: 'Audio',
  stage: 'Brouillon / finale',
  start_strength: 'Influence de l’image de début',
  end_strength: 'Influence de l’image de fin',
  image_compression: 'Compression des références (CRF)',
  overlap_frames: 'Images de chevauchement',
  msr_frames: 'Durée latente des références MSR',
  msr_strength: 'Influence des références MSR',
};
const ownership = { fixed: 'Fixe', model: 'Assistant', random: 'Aléatoire' };
const roleLabels = {
  img2img: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  msr_image: 'Référence de sujet',
  source_video: 'Vidéo à prolonger',
};
const limits = {
  seed: [0, Number.MAX_SAFE_INTEGER],
  width: [64, 4096],
  height: [64, 4096],
  steps: [1, 1000],
  cfg: [1, 1],
  denoise: [0.01, 1],
  frames: [1, 36000],
  fps: [0.1, 240],
  duration: [0.1, 600],
};
const referenceRoles = { krea2: ['img2img'], ltx25: ['start_image', 'end_image', 'msr_image', 'source_video'] };
export const parameterPolicies = name => (name === 'seed' ? ['fixed', 'model', 'random'] : ['fixed', 'model']);
const typeFor = (name, policy) =>
  policy.type ||
  (typeof policy.value === 'boolean'
    ? 'boolean'
    : typeof policy.value === 'string'
      ? 'string'
      : ['prompt', 'negative_prompt', 'stage'].includes(name)
        ? 'string'
        : ['cfg', 'denoise', 'fps', 'duration', 'start_strength', 'end_strength', 'msr_strength'].includes(name)
          ? 'number'
          : 'integer');

export function setupNativeWorkflows(options) {
  const { api, state, node, notice, onSettingsBusyChange = () => {} } = options,
    $ = id => document.getElementById(id);
  const runtime = setupGenerationRuntime(options);
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
    readProfiles = [];
  const element = (tag, id, text = '') => {
    const value = node(tag, '', text);
    if (id) value.id = id;
    return value;
  };
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
            'generation-iterations',
            'generation-minus',
            'generation-plus',
            'generation-unlimited',
            'generation-python',
            'generation-tokenizer',
            'generation-python-browse',
            'generation-tokenizer-browse',
            'generation-test',
            'workflow-add',
            'native-workflow-import',
            'native-workflow-file',
            'native-convert-root',
            'native-convert-root-browse',
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
  function values() {
    const maxIterations = unlimited ? 10000 : Number($('generation-iterations').value);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > (unlimited ? 10000 : 9999))
      throw Error('Choisissez entre 1 et 9 999 générations, ou ∞.');
    const modelRoot = $('native-convert-root').value.trim();
    return {
      enabled: $('generation-enabled').checked,
      autoAllow: $('generation-auto').checked,
      maxIterations,
      pythonPath: $('generation-python').value.trim(),
      tokenizerPath: $('generation-tokenizer').value.trim(),
      modelRoot: modelRoot === folders.model && !state.generation?.modelRoot ? '' : modelRoot,
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
  function renderList() {
    $('workflow-list').replaceChildren();
    if (!workflows.length) $('workflow-list').append(node('p', 'native-empty', 'Aucun workflow.'));
    for (const record of workflows) {
      const card = node('article', 'workflow-card'),
        heading = node('div', 'workflow-card-header'),
        title = node('div', 'workflow-card-title');
      title.append(
        node('strong', '', record.name),
        node(
          'small',
          'field-help',
          record.pipeline === 'ltx25'
            ? 'Vidéo · LTX2.5'
            : record.pipeline === 'krea2'
              ? 'Image · Krea2'
              : 'Moteur à choisir',
        ),
      );
      const status = node(
        'span',
        'native-status',
        record.importDraft ? 'Brouillon' : record.enabled ? 'Actif' : 'Désactivé',
      );
      status.dataset.active = String(record.enabled);
      heading.append(title, status);
      const editButton = button('Modifier', () => edit(record));
      editButton.dataset.nativeControl = 'true';
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
      const actions = node('div', 'native-card-actions');
      actions.append(remove, cancel, editButton);
      card.append(
        heading,
        node('p', 'field-help', record.description),
        ...(record.unavailableReason ? [node('p', 'field-help', record.unavailableReason)] : []),
        actions,
      );
      $('workflow-list').append(card);
    }
    setBusy(busy);
  }
  function apply(result, { settings = true } = {}) {
    workflows = result.workflows || [];
    assets = result.assets || assets;
    folders = result.folders || folders;
    runner = result.runner || runner;
    const config = result.config;
    if (config) {
      state.generation = config;
      if (settings) {
        $('generation-enabled').checked = config.enabled;
        $('generation-auto').checked = config.autoAllow;
        unlimited = config.maxIterations === 10000;
        if (!unlimited) lastLimited = config.maxIterations || 5;
        $('generation-iterations').value = lastLimited;
        $('generation-python').value = config.pythonPath || '';
        $('generation-tokenizer').value = config.tokenizerPath || '';
        $('native-convert-root').value = config.modelRoot || folders.model || '';
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
  function assetPicker(role, id, value) {
    const container = node('div', 'native-asset-picker'),
      compatible = assets.filter(
        asset =>
          asset.kind === role &&
          (!(asset.family || asset.pipeline) || (asset.family || asset.pipeline) === draft.pipeline),
      );
    const choices = [
      ['', 'Choisir un fichier…'],
      ...compatible.map(asset => [asset.id, asset.name || asset.path.split(/[\\/]/).pop()]),
    ];
    if (value && !compatible.some(asset => asset.id === value))
      choices.push([value, draft.importDraft?.files[value] || 'Fichier à retrouver']);
    const control = select(id, choices, value),
      path = input(id + '-path', '');
    control.setAttribute('aria-label', 'Fichier · ' + (labels[role] || role));
    path.placeholder = 'Coller un chemin de fichier';
    path.spellcheck = false;
    path.setAttribute('aria-label', 'Chemin · ' + (labels[role] || role));
    async function register(chosen, signal) {
      if (!chosen) return;
      const result = await (
        await api('generation/assets', { path: chosen, kind: role, family: draft.pipeline }, { signal })
      ).json();
      signal.throwIfAborted();
      const asset = result.asset || result;
      if (!asset.id) throw Error('Le fichier n’a pas pu être enregistré.');
      assets = assets.filter(item => item.id !== asset.id).concat(asset);
      if (![...control.children].some(option => option.value === asset.id)) {
        const option = element('option', null, asset.name || asset.path?.split(/[\\/]/).pop() || asset.id);
        option.value = asset.id;
        control.append(option);
      }
      control.value = asset.id;
      control.onchange?.();
      path.value = '';
      manual.open = false;
      error('');
    }
    const choose = button('Parcourir…', async () => {
      try {
        await run(async signal =>
          register(
            await browse(
              'generation',
              path.value ||
                assets.find(asset => asset.id === control.value)?.path ||
                (role === 'model' ? $('native-convert-root').value : folders[role]) ||
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
    const add = button('Utiliser', async () => {
        try {
          await run(signal => register(path.value.trim(), signal));
        } catch (failure) {
          if (!controller.signal.aborted) error(failure.message);
        }
      }),
      row = node('div', 'path-input'),
      manual = node('details', 'native-manual-path'),
      manualRow = node('div', 'path-input');
    row.append(control, choose);
    manualRow.append(path, add);
    manual.append(node('summary', '', 'Saisir un chemin'), manualRow);
    container.append(row, manual);
    return {
      container,
      control,
      selected() {
        if (path.value.trim()) throw Error('Validez le chemin avec « Utiliser » pour ' + (labels[role] || role) + '.');
        return control.value;
      },
      get compatible() {
        return assets.filter(
          asset =>
            asset.kind === role &&
            (!(asset.family || asset.pipeline) || (asset.family || asset.pipeline) === draft.pipeline),
        );
      },
    };
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
    card.append(field(labels[role] || role, ownershipSelect), picker.container, allowed);
    const active = input(id + '-enabled', present, 'checkbox');
    if (optional) {
      const label = node('label', 'history-toggle');
      label.append(active, node('span', '', 'Utiliser ' + (labels[role] || role)));
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
      read() {
        if (optional && !active.checked) return null;
        if (ownershipSelect.value === 'fixed') return { policy: 'fixed', asset: picker.selected() };
        const choices = checks.filter(([, check]) => check.checked).map(([id]) => id);
        if (picker.selected() && !choices.includes(picker.selected()))
          throw Error(
            'Choisissez une valeur par défaut parmi les fichiers autorisés pour ' + (labels[role] || role) + '.',
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
    const boundsFor =
      prefix === 'native-lora-strength'
        ? draft.pipeline === 'krea2'
          ? [-4, 4]
          : [0, 2]
        : draft.pipeline === 'ltx25'
          ? {
              cfg: [1, 1],
              frames: [9, 481],
              fps: [1, 60],
              overlap_frames: [1, 33],
              msr_frames: [25, 33],
              msr_strength: [0, 1],
              start_strength: [0, 1],
              end_strength: [0, 1],
              image_compression: [0, 51],
            }[name] ||
            limits[name] || [0, 100]
          : limits[name] || [0, 100];
    const enumChoices = policy.choices || (name === 'stage' ? ['draft', 'final'] : null);
    const value =
      type === 'boolean'
        ? input(prefix + '-value-' + name, initial ?? false, 'checkbox')
        : enumChoices
          ? select(
              prefix + '-value-' + name,
              enumChoices.map(choice => [
                String(choice),
                choice === 'draft' ? 'Brouillon' : choice === 'final' ? 'Vidéo finale' : String(choice),
              ]),
              initial ?? enumChoices[0],
            )
          : type === 'string'
            ? element('textarea', prefix + '-value-' + name)
            : input(prefix + '-value-' + name, initial ?? (name === 'seed' ? 0 : 1), 'number');
    if (type === 'string' && !enumChoices) {
      value.value = initial ?? '';
      value.rows = 3;
      value.maxLength = policy.maxLength || 8000;
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
        if (type === 'string') result.maxLength = policy.maxLength || 8000;
        if (['number', 'integer'].includes(type)) {
          result.min = number(min, 'Minimum');
          result.max = number(max, 'Maximum');
          if (result.min > result.max || (useDefault.checked && (concrete < result.min || concrete > result.max)))
            throw Error((labels[name] || name) + ' : la valeur par défaut doit être dans les limites choisies.');
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
      readReferences.length >= (draft.importDraft ? 256 : draft.pipeline === 'krea2' ? 1 : 5),
    );
    $('native-workflow-add-reference').disabled =
      busy || working || $('native-workflow-add-reference').dataset.unavailable === 'true';
  }
  function addReference(reference) {
    const roles = [...new Set([...(referenceRoles[draft.pipeline] || Object.keys(roleLabels)), reference.role])];
    const card = node('div', 'native-reference'),
      role = select(
        'native-reference-role-' + reference.id,
        roles.map(role => [role, roleLabels[role] || 'Usage à définir']),
        reference.role,
      ),
      name = input('native-reference-name-' + reference.id, reference.name || roleLabels[reference.role]),
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
    $('native-workflow-video').hidden = draft.pipeline !== 'ltx25';
    $('native-workflow-title').textContent = isNew ? 'Créer un workflow' : 'Modifier le workflow';
    $('native-workflow-capability').textContent = draft.importDraft
      ? draft.importDraft.blockers.length
        ? 'Brouillon prérempli · exécution non prise en charge pour ce graphe.'
        : 'Brouillon prérempli · activation après vérification des fichiers et des réglages.'
      : draft.unavailableReason || '';
    $('native-workflow-enabled').dataset.unavailable = String(Boolean(draft.importDraft?.blockers.length));
    readComponents = [];
    $('native-workflow-components').replaceChildren();
    for (const role of [
      ...new Set([...Object.keys(draft.components), ...(draft.pipeline === 'ltx25' ? ['audioVae'] : [])]),
    ]) {
      const policy = draft.components[role],
        control = componentControl(
          role,
          policy || { policy: 'fixed', asset: draft.importDraft ? 'missing-' + role : '' },
          { optional: ['textProjection', 'enhancer'].includes(role), present: Boolean(policy) },
        );
      readComponents.push([role, control.read]);
      $('native-workflow-components').append(control.card);
    }
    readParameters = [];
    $('native-workflow-parameters').replaceChildren();
    for (const [name, policy] of Object.entries(draft.parameters)) {
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
    if (readProfiles.length) record.profiles = Object.fromEntries(readProfiles.map(([stage, read]) => [stage, read()]));
    for (const name of ['digest', 'ready', 'unavailableReason', 'error', 'path']) delete record[name];
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
        record = await run(signal => template('krea2', signal));
        if (!record || session !== version) return false;
        record = { ...record, id: crypto.randomUUID(), name: '', description: '' };
        clearTemplateAssets(record);
        fresh = true;
      }
      isNew = fresh;
      draft = structuredClone(record);
      returnFocus = document.activeElement || $('workflow-add');
      parentScroll = $('settings').scrollTop || 0;
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
    $('settings').scrollTop = parentScroll;
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
    if (!draft || working || busy) return false;
    const session = version;
    try {
      const record = readEditor();
      if (!record.name || (!record.importDraft && !record.description))
        throw Error('Ajoutez un nom et une description indiquant quand utiliser ce workflow.');
      if (!record.importDraft || record.enabled) {
        for (const [role, policy] of Object.entries(record.components))
          if ((policy.policy === 'fixed' && !policy.asset) || (policy.policy === 'model' && !policy.choices.length))
            throw Error('Choisissez un fichier pour « ' + (labels[role] || role) + ' ».');
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
  for (const [id, kind] of [
    ['generation-python', 'python'],
    ['generation-tokenizer', 'tokenizer'],
  ])
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
      role: referenceRoles[draft.pipeline]?.[0] || 'reference',
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
  $('native-convert-root-browse').onclick = async () => {
    try {
      await run(async signal => {
        const path = await browse('directory', $('native-convert-root').value, signal);
        signal.throwIfAborted();
        if (path) $('native-convert-root').value = path;
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
    const modelRoot = $('native-convert-root').value.trim(),
      session = version;
    importStatus('Lecture du workflow…');
    try {
      const result = await run(async signal => {
        if (file.size > 2 * 1024 * 1024) throw Error('Workflow limité à 2 Mo.');
        const sourceText = await file.text();
        signal.throwIfAborted();
        return (await api('generation/import', { sourceText, modelRoot, name: file.name || '' }, { signal })).json();
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
