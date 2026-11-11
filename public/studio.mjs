import { FORMATS, formatOf, nearestSize, sizesFor } from './formats.mjs';

/**
 * The Studio: the creation tools used by hand. The user picks Image, Vidéo or Son, writes the
 * prompt and sets everything; « Générer » is the confirmation, no model reads the request.
 * Videos line up in a timeline, where each can be continued.
 */
const MODES = [
  { id: 'image', verb: 'create_image', label: 'Image', icon: 'image', hint: 'Créer ou modifier une image.' },
  {
    id: 'video',
    verb: 'create_video',
    label: 'Vidéo',
    icon: 'video',
    hint: 'Un clip, puis sa suite dans la timeline.',
  },
  { id: 'audio', verb: 'create_audio', label: 'Son', icon: 'sound', hint: 'Musique ou bruitages.' },
];
const ROLES = {
  source: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  reference: 'Référence',
};
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
    styling = false,
    extending = null, // the clip being continued
    failure = '';
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
  function slot(workflow, role, index, label) {
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
    tile.append(choose, node('span', 'studio-slot-label', label));
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
        row.append(slot(workflow, role, index, ROLES[role] + (spec.count > 1 ? ' ' + (index + 1) : '')));
    }
    return row.children.length ? row : null;
  }

  // ------------------------------------------------------------------ size, length
  function sizeFields(workflow, grid) {
    if (!workflow.limits) return;
    const draft = drafts[mode],
      formats = FORMATS.filter(format => sizesFor(format, workflow.limits).length),
      base = workflow.size ?? { width: 1024, height: 1024 };
    if (!formats.some(format => format.id === draft.format))
      draft.format = (formatOf(base.width, base.height) ?? formats[0])?.id ?? null;
    const { sizes, nearest } = sizeChoices(workflow, draft.format, base.width * base.height);
    if (!sizes.some(size => sizeKey(size) === draft.size)) draft.size = nearest ? sizeKey(nearest) : null;
    const final = workflow.final && sizeKey(workflow.final);
    grid.append(
      field(
        'Format',
        select(
          formats.map(format => [format.id, format.label]),
          draft.format,
          value => {
            Object.assign(draft, { format: value, size: null, formatChosen: true });
            render();
          },
        ),
      ),
      field(
        'Résolution',
        select(
          sizes.map(size => [
            sizeKey(size),
            `${size.width} × ${size.height}` + (sizeKey(size) === final ? ' · finale' : ''),
          ]),
          draft.size,
          value => {
            draft.size = value;
          },
        ),
        mode === 'video' ? { help: 'Plus grand : plus long à générer.' } : undefined,
      ),
    );
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
          // The chat model is started when it is not running.
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
    section.append(box, make, node('small', 'field-help', 'Le style est ajouté à la fin du prompt.'));
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
    const grid = node('div', mode === 'image' ? 'studio-grid' : 'studio-sounds');
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
  function form() {
    const draft = drafts[mode],
      panel = node('section', 'studio-form'),
      list = offered(),
      workflow = current();
    if (!info.enabled) {
      panel.append(node('p', 'asset-empty', 'La génération locale est désactivée : activez-la dans Configuration.'));
      return panel;
    }
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
      panel.append(banner);
    }
    if (!workflow) {
      panel.append(
        node(
          'p',
          'asset-empty',
          mode === 'audio'
            ? 'Aucun workflow de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.'
            : 'Aucun workflow prêt pour cette création : vérifiez Configuration, Workflows.',
        ),
      );
      return panel;
    }
    if (list.length > 1 && !extending) {
      if (mode === 'audio') {
        // The kind of sound is the first choice: music, or sound effects.
        const kinds = node('div', 'studio-kinds');
        kinds.setAttribute('role', 'radiogroup');
        kinds.setAttribute('aria-label', 'Type de son');
        for (const item of list) {
          const kind = button('studio-kind', '', () => {
            draft.workflow = item.id;
            render();
          });
          kind.setAttribute('role', 'radio');
          kind.setAttribute('aria-checked', String(item.id === workflow.id));
          kind.append(node('strong', '', item.name), node('span', '', item.description));
          kinds.append(kind);
        }
        panel.append(kinds);
      } else
        panel.append(
          field(
            'Modèle',
            select(
              list.map(item => [item.id, item.name]),
              workflow.id,
              value => {
                draft.workflow = value;
                render();
              },
            ),
            { help: workflow.description, wide: true },
          ),
        );
    }
    const prompt = textarea(
      draft.prompt,
      mode === 'audio' ? 3 : 5,
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
    panel.append(field('Prompt', prompt, { wide: true }));
    if (!extending) {
      const row = inputs(workflow);
      if (row) panel.append(row);
    }
    const grid = node('div', 'studio-grid-fields');
    if (!extending) sizeFields(workflow, grid);
    lengthField(workflow, grid);
    for (const setting of workflow.settings) {
      // Kept per workflow: a song's length is not a sound effect's.
      const store = (draft.settings[workflow.id] ??= {}),
        value = store[setting.key] ?? setting.default ?? '',
        label = SETTINGS[setting.key] || setting.key,
        set = next => {
          store[setting.key] = next;
        };
      if (setting.type === 'string' && !setting.choices) {
        const box = textarea(String(value), 5, '', set);
        if (setting.maxLength) box.maxLength = setting.maxLength;
        panel.append(field(label, box, { wide: true, help: SETTING_HELP[setting.key] }));
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
        grid.append(
          field(label, input, {
            help: setting.max !== undefined ? `De ${setting.min ?? 0} à ${setting.max}.` : undefined,
          }),
        );
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
    if (grid.children.length) panel.append(grid);
    if (mode !== 'audio' && !extending) panel.append(styleSection(workflow, mode));

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
    panel.append(footer);
    if (working) for (const control of panel.querySelectorAll('textarea, select, input')) control.disabled = true;
    return panel;
  }
  function render() {
    for (const tab of $('studio-modes').children) {
      tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
      tab.disabled = Boolean(working);
    }
    const body = $('studio-body');
    body.dataset.mode = mode ?? '';
    if (!info) return body.replaceChildren(node('p', 'asset-empty', 'Chargement…'));
    if (!mode)
      return body.replaceChildren(
        node('p', 'studio-choose', 'Choisissez ce que vous voulez créer : une image, une vidéo ou un son.'),
      );
    body.replaceChildren(form(), results());
    progress();
  }
  async function refresh() {
    if (!info) return;
    runs = (await (await api(`gallery/${info.conversationId}`)).json()).runs;
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

  for (const item of MODES) {
    const tab = button(
      'studio-mode',
      '',
      () => {
        mode = item.id;
        failure = '';
        render();
      },
      item.icon,
    );
    tab.dataset.mode = item.id;
    tab.setAttribute('role', 'tab');
    tab.append(node('strong', '', item.label), node('span', '', item.hint));
    $('studio-modes').append(tab);
  }
  return { open, render, busy: () => Boolean(working) || styling };
}
