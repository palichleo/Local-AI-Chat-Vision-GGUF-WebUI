import { FORMATS, formatOf, nearestSize, sizesFor } from './formats.mjs';

/**
 * The Studio: the creation tools used by hand. The user picks Image, Vidéo or Son, writes the
 * prompt and sets everything; « Générer » is the confirmation, no model reads the request.
 * Videos line up in a timeline, where each can be continued.
 */
const MODES = [
  {
    id: 'image',
    verb: 'create_image',
    label: 'Image',
    icon: 'image',
    hint: 'Une image à partir de votre prompt, ou une image à retoucher.',
  },
  {
    id: 'video',
    verb: 'create_video',
    label: 'Vidéo',
    icon: 'video',
    hint: 'Un clip à partir d’un prompt et de vos images, puis sa suite dans la timeline.',
  },
  {
    id: 'audio',
    verb: 'create_audio',
    label: 'Son',
    icon: 'sound',
    hint: 'Une musique, chantée ou instrumentale, ou des bruitages.',
  },
];
const ROLES = {
  source: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  reference: 'Référence',
};
// Under each input tile: one word, the full name in its tooltip.
const SHORT = { source: 'À modifier', start_image: 'Début', end_image: 'Fin', reference: 'Réf.' };
const SETTINGS = { lyrics: 'Paroles', seconds: 'Durée (s)', language: 'Langue' };
const SETTING_HELP = { lyrics: 'Vide pour un morceau instrumental. Balises : [Verse], [Chorus], [Bridge]…' };
const MAX_STYLES = 4;
const leaf = name =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '');
const seconds = value => (Math.round(value * 10) / 10).toString().replace('.', ',') + ' s';
const sizeKey = size => size.width + 'x' + size.height;
// The box the format frame fits in: the widest and the tallest it gets.
const FRAME = { width: 264, height: 176 };

/** The frame of a ratio, as large as its box allows. */
export function frameSize(ratio, box = FRAME) {
  return ratio >= box.width / box.height
    ? { width: box.width, height: Math.round(box.width / ratio) }
    : { width: Math.round(box.height * ratio), height: box.height };
}

const COUNTED = { image: 'image', video: 'clip', audio: 'son' };

/**
 * What each banner shows of its mode: how many were made and, for a picture or a clip, the last
 * one (the runs come newest first). A sound has nothing to show but its number.
 */
export function showcased(runs) {
  return Object.fromEntries(
    MODES.map(item => {
      const mine = runs.filter(record => (record.mediaType || 'image') === item.id);
      return [
        item.id,
        {
          count: mine.length ? `${mine.length} ${COUNTED[item.id]}${mine.length > 1 ? 's' : ''}` : '',
          latest: item.id === 'audio' ? null : (mine[0]?.outputs?.[0]?.originalUrl ?? null),
        },
      ];
    }),
  );
}

/** The prompt sent: what the user wrote, then the style as its last line. */
export function withStyle(prompt, style) {
  const text = String(prompt ?? '').trim(),
    look = String(style ?? '').trim();
  return look ? `${text}\n\nStyle: ${look}` : text;
}

/** The sizes offered for a workflow in a format, and the one closest to `pixels`. */
export function sizeChoices(workflow, formatId, pixels) {
  const format = FORMATS.find(item => item.id === formatId),
    sizes = format ? sizesFor(format, workflow.limits) : [];
  return { sizes, nearest: nearestSize(sizes, pixels) };
}

export function setupStudio({ api, node, icon, notice, assets, viewOutput, waitForModel, blocked, onChange }) {
  const $ = id => document.getElementById(id);
  let info = null,
    mode = null,
    runs = [],
    working = null, // { label, fraction, requestId, controller } while a generation runs
    releasing = null, // the chat model leaving the GPU, asked when a mode is opened
    styling = false,
    extending = null, // the clip being continued
    failure = '',
    drawn = null, // the size the frame was last drawn at, to ease from
    watching = null; // follows the size of the stage
  const drafts = Object.fromEntries(
    MODES.map(item => [
      item.id,
      {
        workflow: null,
        prompt: '',
        style: '',
        styles: [],
        format: null,
        size: null,
        seed: '',
        length: null,
        inputs: {},
        settings: {},
      },
    ]),
  );
  const picker = node('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp';
  picker.hidden = true;
  $('studio-view').append(picker);

  const verbOf = () => (mode === 'video' && extending ? 'extend_video' : MODES.find(item => item.id === mode).verb);
  const offered = () => info?.tools?.[verbOf()] ?? [];
  function current() {
    const draft = drafts[mode],
      list = offered();
    // A continuation stays with the workflow that made the clip when it can.
    if (mode === 'video' && extending) return list.find(item => item.id === extending.workflowId) ?? list[0] ?? null;
    return list.find(item => item.id === draft.workflow) ?? list[0] ?? null;
  }
  const button = (className, text, onclick, glyph) => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = onclick;
    return control;
  };
  function field(label, control, { help, wide = false } = {}) {
    const wrapper = node('label', 'studio-field' + (wide ? ' is-wide' : ''));
    wrapper.append(node('span', 'studio-label', label), control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  function select(choices, value, onchange) {
    const control = node('select');
    for (const [key, text] of choices) control.add(new Option(text, String(key)));
    control.value = String(value);
    control.onchange = () => onchange(control.value);
    return control;
  }
  function textarea(value, rows, placeholder, oninput) {
    const control = node('textarea');
    control.rows = rows;
    control.value = value;
    control.placeholder = placeholder;
    control.oninput = () => oninput(control.value);
    return control;
  }

  // ------------------------------------------------------------------ inputs (images)
  function exclusiveWith(workflow, role) {
    // The other inputs this one cannot be combined with, when one of them is filled.
    const groups = workflow.exclusive ?? [],
      own = groups.find(group => group.includes(role));
    if (!own) return [];
    return groups
      .filter(group => group !== own)
      .flat()
      .filter(other => drafts[mode].inputs[other]?.some(Boolean));
  }
  async function fill(role, index, file) {
    if (!file) return;
    const imported = await assets.importFiles([file], { reveal: false });
    if (!imported.length)
      return notice('Image non importée : la bibliothèque est occupée ou le fichier est illisible.');
    const [resource] = imported;
    (drafts[mode].inputs[role] ??= [])[index] = {
      source: { resource: resource.id },
      preview: resource.previewUrl || resource.originalUrl,
      name: `${resource.label} · ${resource.name}`,
      width: resource.width,
      height: resource.height,
    };
    followFormat(role);
    render();
  }
  /** A video takes the format of the image it starts from, unless the user chose one. */
  function followFormat(role) {
    const draft = drafts[mode],
      image = draft.inputs[role]?.[0];
    if (mode !== 'video' || role !== 'start_image' || !image?.width || draft.formatChosen) return;
    const format = formatOf(image.width, image.height);
    if (format) Object.assign(draft, { format: format.id, size: null });
  }
  function slot(workflow, role, index, label, short = label) {
    const draft = drafts[mode],
      value = draft.inputs[role]?.[index],
      clash = exclusiveWith(workflow, role),
      tile = node('div', 'studio-slot' + (value ? ' is-filled' : ''));
    const choose = button('studio-slot-pick', '', () => {
      picker.onchange = () => {
        const [file] = picker.files;
        picker.value = '';
        void fill(role, index, file);
      };
      picker.click();
    });
    choose.title = clash.length ? `Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}` : label;
    choose.disabled = Boolean(clash.length) || Boolean(working);
    if (value) {
      const preview = node('img');
      preview.src = value.preview;
      preview.alt = value.name;
      choose.append(preview);
    } else choose.append(icon('plus'));
    choose.ondragover = event => event.preventDefault();
    choose.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      if (!choose.disabled) void fill(role, index, event.dataTransfer.files[0]);
    };
    tile.append(choose, node('span', 'studio-slot-label', short));
    if (value) {
      const remove = button(
        'studio-slot-remove',
        '',
        () => {
          draft.inputs[role][index] = null;
          render();
        },
        'close',
      );
      remove.setAttribute('aria-label', 'Retirer ' + label);
      tile.append(remove);
    }
    return tile;
  }
  function inputs(workflow) {
    const row = node('div', 'studio-slots');
    for (const [role, spec] of Object.entries(workflow.roles)) {
      if (!spec.count || !spec.media.includes('image')) continue;
      for (let index = 0; index < spec.count; index++)
        row.append(
          slot(
            workflow,
            role,
            index,
            ROLES[role] + (spec.count > 1 ? ' ' + (index + 1) : ''),
            SHORT[role] + (spec.count > 1 ? ' ' + (index + 1) : ''),
          ),
        );
    }
    return row.children.length ? row : null;
  }

  // ------------------------------------------------------------------ size, length
  /** The formats and sizes a workflow offers, with the draft settled on one of each. */
  function sizing(workflow) {
    const draft = drafts[mode],
      formats = FORMATS.filter(format => sizesFor(format, workflow.limits).length),
      base = workflow.size ?? { width: 1024, height: 1024 };
    if (!formats.some(format => format.id === draft.format))
      draft.format = (formatOf(base.width, base.height) ?? formats[0])?.id ?? null;
    const { sizes, nearest } = sizeChoices(workflow, draft.format, base.width * base.height);
    if (!sizes.some(size => sizeKey(size) === draft.size)) draft.size = nearest ? sizeKey(nearest) : null;
    return { formats, sizes, final: workflow.final && sizeKey(workflow.final) };
  }
  /** Fills the resolution list for the draft's format. */
  function listSizes(control, workflow) {
    const { sizes, final } = sizing(workflow);
    control.replaceChildren();
    for (const size of sizes)
      control.add(
        new Option(`${size.width} × ${size.height}` + (sizeKey(size) === final ? ' · finale' : ''), sizeKey(size)),
      );
    control.value = drafts[mode].size ?? '';
  }

  // ------------------------------------------------------------------ the stage
  /** The shape of what will be made: a ratio and the few words written in the frame. */
  function shapeOf(workflow) {
    if (mode === 'audio') return { ratio: 3.4, label: '' };
    if (extending) {
      const { width, height } = extending.parameters ?? {},
        format = formatOf(width, height);
      return { ratio: width > 0 && height > 0 ? width / height : 16 / 9, label: format?.id ?? 'Suite' };
    }
    const format = FORMATS.find(item => item.id === drafts[mode].format);
    return { ratio: format?.ratio ?? 1, label: format?.id ?? '' };
  }
  /** The room the frame has: its stage, less a margin; a default before the stage is laid out. */
  function room(frame) {
    const box = frame.parentElement,
      chips = box?.querySelector('.studio-formats'),
      // The stage has a padding of its own when the middle column dissolves (narrow windows).
      style = box && typeof getComputedStyle === 'function' ? getComputedStyle(box) : null,
      pad = side => parseFloat(style?.[side]) || 0,
      width = (box?.clientWidth ?? 0) - pad('paddingLeft') - pad('paddingRight'),
      // The formats sit under the frame, in the same stage.
      height =
        (box?.clientHeight ?? 0) - pad('paddingTop') - pad('paddingBottom') - (chips ? chips.offsetHeight + 12 : 0) - 4;
    return width > 40 && height > 40 ? { width: Math.min(width - 20, 560), height: Math.min(height, 440) } : FRAME;
  }
  function reshape(frame, { ratio, label }) {
    const size = frameSize(ratio, room(frame));
    frame.style.width = size.width + 'px';
    frame.style.height = size.height + 'px';
    frame.querySelector('.studio-frame-label').textContent = label;
    drawn = size;
  }
  /**
   * An empty frame in the format of the image or the video to come (its shape only, not its
   * size), as large as the stage allows. It eases from the shape it had to the new one, across
   * formats and across modes, and follows the window when it is resized.
   */
  function stage(workflow) {
    const box = node('div', 'studio-stage'),
      frame = node('div', 'studio-frame' + (mode === 'audio' ? ' is-audio' : '') + (working ? ' is-busy' : '')),
      next = shapeOf(workflow);
    frame.setAttribute('aria-hidden', 'true');
    frame.append(node('span', 'studio-frame-fill'), node('span', 'studio-frame-label', next.label));
    // Drawn at the previous shape first, so the browser has something to ease from.
    const from = drawn ?? frameSize(next.ratio);
    frame.style.width = from.width + 'px';
    frame.style.height = from.height + 'px';
    box.append(frame);
    watching?.disconnect();
    if (typeof ResizeObserver === 'function') {
      // Called once the stage is laid out, then at every change of its size.
      watching = new ResizeObserver(() => reshape(frame, shapeOf(workflow)));
      watching.observe(box);
    }
    return { box, frame };
  }
  /** The formats as a row of chips under the frame: choosing one reshapes it in place. */
  function formatChips(workflow, frame, resolution) {
    const draft = drafts[mode],
      row = node('div', 'studio-formats');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Format');
    for (const format of sizing(workflow).formats) {
      const chip = button('studio-format', format.id, () => {
        Object.assign(draft, { format: format.id, size: null, formatChosen: true });
        for (const other of row.children) other.setAttribute('aria-checked', String(other === chip));
        listSizes(resolution, workflow);
        reshape(frame, shapeOf(workflow));
      });
      chip.title = format.label;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(format.id === draft.format));
      chip.disabled = Boolean(working);
      row.append(chip);
    }
    return row;
  }
  function lengthField(workflow, grid) {
    const lengths = workflow.lengths;
    if (!lengths?.seconds.length) return;
    const draft = drafts[mode],
      key = extending ? 'extension' : 'length',
      nearest = wanted =>
        lengths.seconds.reduce((best, value) => (Math.abs(value - wanted) < Math.abs(best - wanted) ? value : best));
    if (!lengths.seconds.includes(draft[key])) draft[key] = nearest(draft[key] ?? lengths.standard ?? 5);
    grid.append(
      field(
        extending ? 'Durée ajoutée' : 'Durée',
        select(
          lengths.seconds.map(value => [value, seconds(value)]),
          draft[key],
          value => {
            draft[key] = Number(value);
          },
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ style
  function styleSection(workflow, media) {
    const draft = drafts[mode],
      section = node('section', 'studio-style');
    section.append(node('h3', '', 'Style'));
    if (workflow.external) {
      const list = node('div', 'studio-loras');
      draft.styles.forEach((style, index) => {
        const row = node('div', 'studio-lora');
        const strength = node('input');
        strength.type = 'number';
        strength.step = '0.05';
        strength.min = '-4';
        strength.max = '4';
        strength.value = String(style.strength);
        strength.title = 'Force du LoRA';
        strength.setAttribute('aria-label', 'Force du LoRA');
        strength.oninput = () => {
          style.strength = Number(strength.value);
        };
        const remove = button(
          'icon-button',
          '',
          () => {
            draft.styles.splice(index, 1);
            render();
          },
          'close',
        );
        remove.setAttribute('aria-label', 'Retirer ce LoRA');
        row.append(
          select(
            info.styles.map(name => [name, leaf(name)]),
            style.name,
            value => {
              style.name = value;
            },
          ),
          strength,
          remove,
        );
        list.append(row);
      });
      if (info.styles.length) {
        if (draft.styles.length < MAX_STYLES)
          list.append(
            button(
              'studio-link',
              draft.styles.length ? 'Ajouter un LoRA' : 'Ajouter un LoRA de style',
              () => {
                draft.styles.push({ name: info.styles[0], strength: 1 });
                render();
              },
              'plus',
            ),
          );
      } else
        list.append(
          node('small', 'field-help', 'Aucun LoRA listé : ComfyUI est arrêté ou son dossier loras est vide.'),
        );
      section.append(list);
    }
    const box = textarea(draft.style, 2, 'Décrivez un style, ou laissez vide pour un style au hasard…', value => {
      draft.style = value;
    });
    box.maxLength = 2000;
    box.setAttribute('aria-label', 'Style ajouté au prompt');
    const make = button(
      'secondary studio-make-style',
      styling ? 'Écriture du style…' : 'Générer un style à partir de la description',
      async () => {
        if (styling || working) return;
        const reason = blocked();
        if (reason) return notice(reason);
        styling = true;
        render();
        const controller = new AbortController();
        try {
          // The chat model is started when it is not running, once it has finished leaving.
          await releasing;
          await waitForModel(api, controller.signal, () => {});
          const result = await (await api('studio/style', { description: draft.style, media })).json();
          draft.style = result.style;
          notice('');
        } catch (error) {
          notice('Style non généré : ' + error.message);
        } finally {
          styling = false;
          onChange();
          render();
        }
      },
      'spark',
    );
    make.disabled = styling || Boolean(working);
    box.title = 'Le style est ajouté à la fin du prompt.';
    section.append(box, make);
    return section;
  }

  // ------------------------------------------------------------------ generation
  function request() {
    const draft = drafts[mode],
      workflow = current(),
      verb = verbOf(),
      prompt = draft.prompt.trim();
    if (!workflow) throw Error('Aucun workflow prêt pour cette création.');
    if (!prompt) throw Error('Écrivez un prompt.');
    const args = { prompt: mode === 'audio' ? prompt : withStyle(prompt, draft.style) },
      edits = {};
    if (offered().length > 1 && !extending) args.workflow = workflow.id;
    if (mode === 'video')
      args.intention = extending ? 'Suite demandée dans le Studio.' : 'Création demandée dans le Studio.';
    if (extending) args.source = { output: extending.id };
    else
      for (const [role, spec] of Object.entries(workflow.roles)) {
        const chosen = (draft.inputs[role] ?? []).filter(Boolean).map(item => item.source);
        if (!chosen.length || !spec.count) continue;
        args[role] = role === 'reference' ? chosen : chosen[0];
      }
    if (workflow.lengths?.seconds.length) args.duration = draft[extending ? 'extension' : 'length'];
    if (workflow.limits && draft.size && !extending) {
      const [width, height] = draft.size.split('x').map(Number);
      if (workflow.direct) Object.assign(args, { width, height });
      else Object.assign(edits, { width, height });
      // A large picture is a final, a small one a draft: the profile only names it here.
      if (workflow.stages) {
        const small = workflow.size ? workflow.size.width * workflow.size.height : 0;
        args.stage = width * height > small * 1.5 ? 'final' : 'draft';
      }
    }
    if (draft.seed.trim() && workflow.seeded) {
      const seed = Number(draft.seed);
      if (!Number.isSafeInteger(seed) || seed < 0) throw Error('Seed : un entier positif, ou vide pour un tirage.');
      args.seed = seed;
    }
    for (const setting of workflow.settings) {
      const value = draft.settings[workflow.id]?.[setting.key];
      if (value === undefined || value === '') continue;
      args[setting.key] = setting.type === 'string' ? value : Number(value);
    }
    const styles = workflow.external && mode !== 'audio' && !extending ? draft.styles.filter(style => style.name) : [];
    return { verb, args, edits, styles };
  }
  // A mode is opened to generate: the chat model leaves the GPU now, not at the first « Générer ».
  // Asked in the background, never under an answer or a message waiting for the model; a refusal
  // changes nothing, the generation unloads the model itself anyway.
  function release() {
    if (releasing || working || styling || blocked()) return;
    releasing = api('studio/release', {})
      .then(() => onChange())
      .catch(() => {})
      .finally(() => {
        releasing = null;
      });
  }
  async function generate() {
    if (working) return;
    const reason = blocked();
    if (reason) return notice(reason);
    let wanted;
    try {
      wanted = request();
    } catch (error) {
      failure = error.message;
      return render();
    }
    failure = '';
    const controller = new AbortController();
    working = { label: 'Préparation…', fraction: null, controller };
    render();
    onChange();
    const pause = () => new Promise(resolve => setTimeout(resolve, 700));
    try {
      await releasing;
      let proposal = await (
        await api('tools/action', {
          conversationId: info.conversationId,
          name: wanted.verb,
          arguments: wanted.args,
          ...(wanted.styles.length ? { styles: wanted.styles } : {}),
        })
      ).json();
      working.requestId = proposal.requestId;
      // The size chosen here, where the workflow sets its own.
      const shown = proposal.plan?.parameters ?? {},
        edits = Object.fromEntries(Object.entries(wanted.edits).filter(([key, value]) => shown[key] !== value));
      if (Object.keys(edits).length) {
        proposal = await (
          await api('tools/revise', { requestId: proposal.requestId, approvalToken: proposal.approvalToken, edits })
        ).json();
        working.requestId = proposal.requestId;
      }
      controller.signal.throwIfAborted();
      let job = await (
        await api('tools/execute', {
          requestId: proposal.requestId,
          permission: 'once',
          ...(proposal.mediaType ? { approvalToken: proposal.approvalToken } : {}),
        })
      ).json();
      const jobId = job.id;
      let listed = false;
      while (!['done', 'error', 'cancelled'].includes(job.state)) {
        Object.assign(working, { label: job.progress || 'Génération…', fraction: job.fraction ?? null });
        // The result is shown as soon as it exists, while the chat model reloads.
        if (job.record && !listed) {
          listed = true;
          await refresh().catch(() => {});
          render();
        }
        progress();
        await pause();
        job = await (await api('tools/job')).json();
        if (job?.id !== jobId) throw Error('La génération suivie a été remplacée par une autre tâche.');
      }
      if (!job.record)
        throw Error(controller.signal.aborted ? 'Génération arrêtée.' : job.error || 'La génération a échoué.');
      if (extending) extending = null;
    } catch (error) {
      failure = controller.signal.aborted ? 'Génération arrêtée.' : error.message;
    } finally {
      working = null;
      await refresh().catch(() => {});
      onChange();
      render();
    }
  }
  function stop() {
    if (!working) return;
    working.controller.abort();
    if (working.requestId) api('tools/cancel', { requestId: working.requestId }).catch(() => {});
  }
  /** Updates the progress line alone: the form keeps its focus while a generation runs. */
  function progress() {
    const line = $('studio-progress');
    if (!line || !working) return;
    line.querySelector('.studio-progress-label').textContent = working.label;
    const bar = line.querySelector('progress');
    if (working.fraction === null) bar.removeAttribute('value');
    else bar.value = working.fraction;
    // The frame fills as the generation advances.
    document.querySelector('.studio-frame')?.style.setProperty('--progress', String(working.fraction ?? 0));
  }

  // ------------------------------------------------------------------ results
  const mediaOf = record => record.mediaType || 'image';
  /** Whether some ready workflow of this verb takes an input in this role. */
  const takes = (verb, role) => (info?.tools?.[verb] ?? []).some(item => item.roles[role]?.count);
  const sourceOf = record => record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id;
  function length(record) {
    const p = record.parameters ?? {};
    if (mediaOf(record) === 'audio') return p.seconds ? seconds(p.seconds) : '';
    return p.frames && p.fps ? seconds(p.frames / p.fps) : '';
  }
  async function remove(record) {
    try {
      await api('studio/delete', { id: record.id });
      if (extending?.id === record.id) extending = null;
      await refresh();
    } catch (error) {
      notice(error.message);
    }
    render();
  }
  function actions(record, extra = []) {
    const row = node('div', 'studio-actions');
    for (const [label, glyph, onclick, title] of [
      ...extra,
      ['Détails', 'info', () => viewOutput(record, 0), 'Voir l’original et ses paramètres'],
      ['', 'trash', () => remove(record), 'Retirer du Studio (le fichier reste dans le dossier output)'],
    ]) {
      const control = button('output-action', label, onclick, glyph);
      control.title = title;
      if (!label) control.setAttribute('aria-label', title);
      control.disabled = Boolean(working);
      row.append(control);
    }
    return row;
  }
  // The size of each image shown, read from the picture itself: a record does not keep it.
  const measured = new Map();
  function useImage(record, target, role) {
    const output = { ...record.outputs[0], ...measured.get(record.id) };
    mode = target;
    extending = null;
    (drafts[target].inputs[role] ??= [])[0] = {
      source: { output: record.id },
      preview: output.originalUrl,
      name: record.prompt,
      width: output.width,
      height: output.height,
    };
    followFormat(role);
    render();
    $('studio-view').scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  function results() {
    const mine = runs.filter(record => mediaOf(record) === mode),
      section = node('section', 'studio-results');
    if (mode === 'video') {
      // Oldest first: the timeline reads from left to right.
      const clips = [...mine].reverse(),
        numbers = new Map(clips.map((record, index) => [record.id, index + 1]));
      section.append(node('h3', '', 'Timeline'));
      if (!clips.length)
        section.append(node('p', 'asset-empty', 'Vos vidéos s’aligneront ici, dans l’ordre de création.'));
      const strip = node('div', 'studio-timeline');
      for (const record of clips) {
        const clip = node('article', 'studio-clip' + (extending?.id === record.id ? ' is-selected' : '')),
          player = node('video'),
          from = numbers.get(sourceOf(record));
        player.controls = true;
        player.preload = 'metadata';
        player.playsInline = true;
        player.src = record.outputs[0].originalUrl || '';
        const caption = node(
          'p',
          'studio-caption',
          `#${numbers.get(record.id)} · ${[length(record), record.workflowName].filter(Boolean).join(' · ')}`,
        );
        const text = node('p', 'studio-prompt', (from ? `↳ Suite de #${from} · ` : '') + record.prompt);
        text.title = record.prompt;
        clip.append(
          player,
          caption,
          text,
          actions(record, [
            [
              'Prolonger',
              'forward',
              () => {
                extending = record;
                failure = '';
                render();
                $('studio-view').scrollTo?.({ top: 0, behavior: 'smooth' });
              },
              'Écrire la suite de ce clip',
            ],
          ]),
        );
        strip.append(clip);
      }
      if (clips.length) section.append(strip);
      return section;
    }
    section.append(node('h3', '', mode === 'image' ? 'Images' : 'Sons'));
    if (!mine.length)
      section.append(
        node('p', 'asset-empty', mode === 'image' ? 'Vos images apparaîtront ici.' : 'Vos sons apparaîtront ici.'),
      );
    const grid = node('div', 'studio-timeline ' + (mode === 'image' ? 'is-images' : 'is-sounds'));
    for (const record of mine) {
      const card = node('article', 'studio-card');
      if (mode === 'image') {
        const picture = node('img');
        picture.src = record.outputs[0].originalUrl || '';
        picture.alt = record.prompt;
        picture.loading = 'lazy';
        picture.onclick = () => viewOutput(record, 0);
        picture.onload = () => measured.set(record.id, { width: picture.naturalWidth, height: picture.naturalHeight });
        card.append(picture);
      } else {
        const player = node('audio');
        player.controls = true;
        player.preload = 'metadata';
        player.src = record.outputs[0].originalUrl || '';
        card.append(
          player,
          node('p', 'studio-caption', [length(record), record.workflowName].filter(Boolean).join(' · ')),
        );
      }
      const text = node('p', 'studio-prompt', record.prompt);
      text.title = record.prompt;
      card.append(
        text,
        actions(
          record,
          mode === 'image'
            ? [
                ...(takes('create_image', 'source')
                  ? [['Modifier', 'edit', () => useImage(record, 'image', 'source'), 'Repartir de cette image']]
                  : []),
                ...(takes('create_video', 'start_image')
                  ? [
                      [
                        'Animer',
                        'video',
                        () => useImage(record, 'video', 'start_image'),
                        'En faire l’image de début d’une vidéo',
                      ],
                    ]
                  : []),
              ]
            : [],
        ),
      );
      grid.append(card);
    }
    if (mine.length) section.append(grid);
    return section;
  }

  // ------------------------------------------------------------------ the page
  function message(text) {
    const panel = node('section', 'studio-desk is-empty');
    panel.append(node('p', 'asset-empty', text));
    return panel;
  }
  /**
   * The desk: what is written on the left, the frame and « Générer » in the middle, the
   * settings on the right. Wide rather than tall: everything stays in view.
   */
  function form() {
    const draft = drafts[mode],
      list = offered(),
      workflow = current();
    if (!info.enabled) return message('La génération locale est désactivée : activez-la dans Configuration.');
    if (!workflow)
      return message(
        mode === 'audio'
          ? 'Aucun workflow de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.'
          : 'Aucun workflow prêt pour cette création : vérifiez Configuration, Workflows.',
      );
    const desk = node('section', 'studio-desk'),
      write = node('div', 'studio-col studio-write'),
      center = node('div', 'studio-col studio-center'),
      settings = node('div', 'studio-col studio-settings'),
      grid = node('div', 'studio-grid-fields');

    // Left: what the user writes and hands over.
    if (mode === 'video' && extending) {
      const banner = node('div', 'studio-extending');
      banner.append(
        icon('forward'),
        node('span', '', 'Suite du clip : ' + extending.prompt.slice(0, 90)),
        button('studio-link', 'Annuler', () => {
          extending = null;
          render();
        }),
      );
      write.append(banner);
    }
    if (mode === 'audio' && list.length > 1) {
      // The kind of sound is the first choice: music, or sound effects.
      const kinds = node('div', 'studio-kinds');
      kinds.setAttribute('role', 'radiogroup');
      kinds.setAttribute('aria-label', 'Type de son');
      for (const item of list) {
        const kind = button('studio-kind', '', () => {
          draft.workflow = item.id;
          render();
        });
        kind.title = item.description;
        kind.setAttribute('role', 'radio');
        kind.setAttribute('aria-checked', String(item.id === workflow.id));
        kind.append(node('strong', '', item.name), node('span', '', item.description));
        kinds.append(kind);
      }
      write.append(kinds);
    }
    const prompt = textarea(
      draft.prompt,
      4,
      extending
        ? 'Ce qui se passe ensuite…'
        : mode === 'image'
          ? 'Décrivez l’image…'
          : mode === 'video'
            ? 'Décrivez le clip : ce qu’on voit, ce qui se passe, la caméra, le son…'
            : 'Décrivez le son : genre, instruments, ambiance…',
      value => {
        draft.prompt = value;
      },
    );
    prompt.maxLength = 4000;
    prompt.title = 'Ctrl + Entrée pour générer';
    prompt.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void generate();
      }
    };
    write.append(field('Prompt', prompt, { wide: true }));
    if (!extending) {
      const row = inputs(workflow);
      if (row) write.append(row);
    }

    // Right: the settings, two to a row.
    if (list.length > 1 && !extending && mode !== 'audio') {
      const model = field(
        'Modèle',
        select(
          list.map(item => [item.id, item.name]),
          workflow.id,
          value => {
            draft.workflow = value;
            render();
          },
        ),
      );
      model.title = workflow.description;
      grid.append(model);
    }
    const resolution = node('select');
    if (workflow.limits && !extending) {
      listSizes(resolution, workflow);
      resolution.onchange = () => {
        draft.size = resolution.value;
      };
      const sized = field('Résolution', resolution);
      if (mode === 'video') sized.title = 'Plus grand : plus long à générer.';
      grid.append(sized);
    }
    lengthField(workflow, grid);
    const texts = [];
    for (const setting of workflow.settings) {
      // Kept per workflow: a song's length is not a sound effect's.
      const store = (draft.settings[workflow.id] ??= {}),
        value = store[setting.key] ?? setting.default ?? '',
        label = SETTINGS[setting.key] || setting.key,
        set = next => {
          store[setting.key] = next;
        };
      if (setting.type === 'string' && !setting.choices) {
        const box = textarea(String(value), 4, SETTING_HELP[setting.key] ?? '', set);
        if (setting.maxLength) box.maxLength = setting.maxLength;
        texts.push(field(label, box, { wide: true }));
      } else if (setting.choices)
        grid.append(
          field(
            label,
            select(
              setting.choices.map(choice => [choice, String(choice)]),
              value,
              set,
            ),
          ),
        );
      else {
        const input = node('input');
        input.type = 'number';
        input.value = String(value);
        if (setting.min !== undefined) input.min = String(setting.min);
        if (setting.max !== undefined) input.max = String(setting.max);
        input.oninput = () => set(input.value);
        const wrapper = field(label, input);
        if (setting.max !== undefined) wrapper.title = `De ${setting.min ?? 0} à ${setting.max}.`;
        grid.append(wrapper);
      }
    }
    if (workflow.seeded) {
      const seed = node('input');
      seed.type = 'number';
      seed.min = '0';
      seed.placeholder = 'au hasard';
      seed.value = draft.seed;
      seed.oninput = () => {
        draft.seed = seed.value;
      };
      grid.append(field('Seed', seed));
    }
    if (grid.children.length) settings.append(grid);
    settings.append(...texts);
    if (mode !== 'audio' && !extending) settings.append(styleSection(workflow, mode));

    // Middle: the frame in the format to come, its formats, and the button.
    const { box, frame } = stage(workflow);
    center.append(box);
    if (workflow.limits && !extending) box.append(formatChips(workflow, frame, resolution));
    const footer = node('div', 'studio-footer');
    if (working) {
      const line = node('div', 'studio-progress');
      line.id = 'studio-progress';
      const bar = node('progress');
      bar.max = 1;
      line.append(
        node('span', 'studio-progress-label', working.label),
        bar,
        button('secondary', 'Arrêter', stop, 'stop'),
      );
      footer.append(line);
    } else {
      const go = button('primary studio-go', extending ? 'Générer la suite' : 'Générer', generate, 'spark');
      go.disabled = styling;
      footer.append(go);
    }
    if (failure) {
      const alert = node('p', 'studio-error', failure);
      alert.setAttribute('role', 'alert');
      footer.append(alert);
    }
    center.append(footer);

    desk.append(write, center, ...(settings.children.length ? [settings] : []));
    if (!settings.children.length) desk.classList.add('is-two');
    if (working) for (const control of desk.querySelectorAll('textarea, select, input')) control.disabled = true;
    return desk;
  }
  function render() {
    const chosen = MODES.find(item => item.id === mode);
    // One mode at a time: the three choices leave once one is taken, « Retour » brings them back.
    $('studio-modes').hidden = Boolean(chosen);
    $('studio-back').hidden = !chosen;
    $('studio-back').disabled = Boolean(working) || styling;
    $('studio-title').textContent = chosen ? chosen.label : 'Studio';
    $('studio-summary').textContent = chosen ? 'Studio' : 'Créez directement, avec vos propres prompts.';
    $('studio-view').classList.toggle('is-open', Boolean(chosen));
    const body = $('studio-body');
    body.dataset.mode = mode ?? '';
    // The stage leaves with the form it is in, and nothing follows its size any longer: still
    // watched, it was reported once more as it went, with no mode left to read a format from.
    watching?.disconnect();
    watching = null;
    // Nothing under the banners: they keep the whole height, also while the tools load.
    if (!mode) return body.replaceChildren();
    if (!info) return body.replaceChildren(node('p', 'asset-empty', 'Chargement…'));
    body.replaceChildren(form(), results());
    progress();
  }
  /** Each banner shows the last creation of its mode in its outline, and how many there are. */
  function showcase() {
    for (const [id, { count, latest }] of Object.entries(showcased(runs))) {
      const banner = banners[id];
      banner.count.textContent = count;
      banner.count.hidden = !count;
      banner.shape.replaceChildren();
      banner.shape.classList.toggle('is-filled', Boolean(latest));
      if (!latest) continue;
      const media = node(id === 'video' ? 'video' : 'img');
      if (id === 'video') {
        // Its first picture only: nothing plays on the banner.
        Object.assign(media, { muted: true, preload: 'metadata', playsInline: true, src: latest + '#t=0.1' });
      } else Object.assign(media, { alt: '', loading: 'lazy', decoding: 'async', src: latest });
      // A file that cannot be shown leaves the empty outline.
      media.onerror = () => {
        banner.shape.replaceChildren();
        banner.shape.classList.toggle('is-filled', false);
      };
      banner.shape.append(media);
    }
  }
  async function refresh() {
    if (!info) return;
    runs = (await (await api(`gallery/${info.conversationId}`)).json()).runs;
    showcase();
  }
  async function open() {
    render();
    try {
      info = await (await api('studio')).json();
      await refresh();
    } catch (error) {
      notice('Studio indisponible : ' + error.message);
    }
    render();
  }

  // The three choices: wide banners, each with the outline of what it makes.
  const banners = {};
  for (const item of MODES) {
    const banner = button(
      'studio-mode',
      '',
      () => {
        mode = item.id;
        failure = '';
        render();
        release();
      },
      item.icon,
    );
    banner.dataset.mode = item.id;
    const words = node('span', 'studio-mode-words'),
      count = node('span', 'studio-mode-count');
    count.hidden = true;
    words.append(node('strong', '', item.label), node('span', '', item.hint), count);
    const shape = node('span', 'studio-mode-shape');
    shape.setAttribute('aria-hidden', 'true');
    banners[item.id] = { shape, count };
    banner.append(words, shape, icon('chevron'));
    $('studio-modes').append(banner);
  }
  $('studio-back').onclick = () => {
    if (working || styling) return;
    mode = null;
    extending = null;
    failure = '';
    render();
  };
  return { open, render, busy: () => Boolean(working) || styling };
}
