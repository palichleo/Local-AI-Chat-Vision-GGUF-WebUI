/**
 * The ComfyUI graph (API format) of a job, for each family of models ComfyUI runs for Atelier
 * (the manifests with "engine": "external"). Upscaling and frame interpolation are not here:
 * the built-in engine does them.
 *
 * A family gives: why a job stays on the built-in engine (`unsupported`), the model files it
 * names and where ComfyUI chooses them (`files`), and the graph itself (`graph`), with the node
 * that saves the result. Every graph uses ComfyUI's own nodes; only an LTX 2.5 video with
 * subject references goes through the LongForge LTX2.5 nodes, the only ones that take them.
 */
const problem = (message, status = 502) => Object.assign(new Error(message), { status });
export const leaf = path => String(path).split(/[\\/]/).pop();

const UNET = ['UNETLoader', 'unet_name'],
  CLIP = ['CLIPLoader', 'clip_name'],
  VAE = ['VAELoader', 'vae_name'];
const file = (key, path, [node, input]) => ({ key, path, node, input });
const role = (job, name) => job.references.filter(ref => ref.role === name);
const node = (class_type, inputs) => ({ class_type, inputs });
// Where ComfyUI writes the result of a job, under its own output folder.
const prefix = job => 'atelier/' + job.id.replaceAll('-', '');
const saveVideo = (job, video) =>
  node('SaveVideo', { video, filename_prefix: prefix(job), format: 'mp4', 'format.codec': 'auto', codec: 'auto' });
const createVideo = (images, fps, audio) =>
  node('CreateVideo', {
    images,
    fps,
    ...(audio ? { audio } : {}),
    bit_depth: 8,
    color_space: 'sRGB',
    chroma_subsampling: '420',
    codec: 'none',
  });
/** What a ComfyUI offers of the attention nodes below, when it has not been asked. */
export const ALL_FEATURES = Object.freeze({ kitchen: true, sparse: true });
/**
 * The attention nodes a job asks for, placed after `model`: ComfyUI's INT8 attention from
 * comfy-kitchen (« comfy kitchen attention »), then, for MiniMax-H3 FastH3 checkpoints, Video
 * Sparse Attention (FastVideo's VSA: 4×4×4 video cubes, the model's learned coarse branch,
 * text, audio and reference rows kept exact). What this ComfyUI lacks (`features`) is left
 * out: the model then runs on its default attention. Returns the model to sample with.
 */
function attention(graph, job, model, features, names = {}) {
  const p = job.parameters;
  // The styles picked in the Studio: one LoRA each, on top of the workflow's own.
  (job.styles ?? []).forEach((style, index) => {
    graph['style' + index] = node('LoraLoaderModelOnly', {
      lora_name: names['style' + index] ?? style.name,
      strength_model: style.strength,
      model,
    });
    model = ['style' + index, 0];
  });
  if (p.attention === 'comfy_kitchen' && features.kitchen) {
    graph.attention = node('ModelAttentionBackend', { model, attention: 'comfy kitchen attention' });
    model = ['attention', 0];
  }
  if (p.sparse_attention === 'vsa' && features.sparse) {
    graph.sparse = node('BlockSparseAttention', {
      model,
      selection: 'vsa',
      'selection.keep_percent': p.sparse_keep ?? 10,
      start_percent: p.sparse_start ?? 0.2,
      end_percent: 1,
      dense_blocks: '',
      min_tokens: 12288,
      // Not used by VSA: its weights were trained against their own sparse pattern.
      extra_tokens: 0,
      sink_conditioning: 'exact_kv_and_rows',
      verbose: false,
    });
    model = ['sparse', 0];
  }
  return model;
}

const krea2 = {
  unsupported: () => '',
  files: job => [
    file('model', job.components.model, UNET),
    file('textEncoder', job.components.textEncoder, CLIP),
    file('vae', job.components.vae, VAE),
    ...job.loras.map((lora, index) => file('lora' + index, lora.path, ['LoraLoaderModelOnly', 'lora_name'])),
  ],
  graph(job, inputs, names, features) {
    const p = job.parameters,
      graph = {
        model: node('UNETLoader', { unet_name: names.model, weight_dtype: 'default' }),
        clip: node('CLIPLoader', { clip_name: names.textEncoder, type: 'krea2', device: 'default' }),
        vae: node('VAELoader', { vae_name: names.vae }),
      };
    let model = ['model', 0];
    job.loras.forEach((lora, index) => {
      graph['lora' + index] = node('LoraLoaderModelOnly', {
        lora_name: names['lora' + index],
        strength_model: lora.strength,
        model,
      });
      model = ['lora' + index, 0];
    });
    model = attention(graph, job, model, features, names);
    let text = p.prompt,
      expanded;
    if (p.expandPrompt) {
      // The text encoder rewrites the prompt first, as the built-in engine does.
      const options = job.promptExpansion;
      graph.expand = node('TextGenerate', {
        clip: ['clip', 0],
        prompt: options.template.replace('{{prompt}}', p.prompt),
        max_length: options.maxTokens,
        sampling_mode: 'on',
        'sampling_mode.temperature': Math.min(options.temperature, 2),
        'sampling_mode.top_k': options.topK,
        'sampling_mode.top_p': options.topP,
        'sampling_mode.min_p': options.minP,
        'sampling_mode.repetition_penalty': Math.min(options.repetitionPenalty, 5),
        'sampling_mode.seed': options.seed,
        'sampling_mode.presence_penalty': 0,
        thinking: false,
        use_default_template: true,
        mtp: 'auto',
      });
      graph.prompt = node('StringConcatenate', {
        string_a: ['expand', 0],
        string_b: options.suffix,
        delimiter: '',
      });
      // Read back with the result: the prompt the image was really made from.
      graph.promptText = node('PreviewAny', { source: ['prompt', 0] });
      text = ['prompt', 0];
      expanded = 'promptText';
    }
    graph.positive = node('CLIPTextEncode', { text, clip: ['clip', 0] });
    graph.negative = node('ConditioningZeroOut', { conditioning: ['positive', 0] });
    const [source] = role(job, 'img2img');
    if (source) {
      graph.source = node('LoadImage', { image: inputs[source.input] });
      graph.fitted = node('ImageScale', {
        image: ['source', 0],
        upscale_method: 'lanczos',
        width: p.width,
        height: p.height,
        crop: 'center',
      });
      graph.latent = node('VAEEncode', { pixels: ['fitted', 0], vae: ['vae', 0] });
    } else graph.latent = node('EmptyLatentImage', { width: p.width, height: p.height, batch_size: 1 });
    graph.sampler = node('KSampler', {
      seed: p.seed,
      steps: p.steps,
      cfg: p.cfg ?? 1,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: p.denoise ?? 1,
      model,
      positive: ['positive', 0],
      negative: ['negative', 0],
      latent_image: ['latent', 0],
    });
    graph.decode = node('VAEDecode', { samples: ['sampler', 0], vae: ['vae', 0] });
    graph.save = node('SaveImage', { images: ['decode', 0], filename_prefix: prefix(job) });
    return { graph, output: 'save', steps: ['sampler'], ...(expanded ? { text: expanded } : {}) };
  },
};

const minimax_h3 = {
  unsupported(job) {
    if (role(job, 'source_video').length) return 'continuations stay on the built-in engine';
    // What the built-in engine refuses is left to it, so the user reads its reason.
    if (role(job, 'reference_image').length > 9) return 'more than nine reference images';
    if (role(job, 'reference_image').length && (role(job, 'start_image').length || role(job, 'end_image').length))
      return 'reference images and start or end images do not combine';
    return '';
  },
  files: job => [
    file('model', job.components.model, UNET),
    file('textEncoder', job.components.textEncoder, CLIP),
    file('vae', job.components.vae, VAE),
    file('audioVae', job.components.audioVae, VAE),
  ],
  graph(job, inputs, names, features) {
    const p = job.parameters,
      graph = {
        model: node('UNETLoader', { unet_name: names.model, weight_dtype: 'default' }),
        shifted: node('MiniMaxH3SigmaShift', { model: ['model', 0], shift_video: 12, shift_audio: 3 }),
        clip: node('CLIPLoader', { clip_name: names.textEncoder, type: 'minimax', device: 'default' }),
        vae: node('VAELoader', { vae_name: names.vae }),
        audioVae: node('VAELoader', { vae_name: names.audioVae }),
      };
    const size = { prompt: p.prompt, width: p.width, height: p.height, length: p.frames, clip: ['clip', 0] };
    const load = (name, ref) => {
      graph[name] = node('LoadImage', { image: inputs[ref.input] });
      return [name, 0];
    };
    const [start] = role(job, 'start_image'),
      [end] = role(job, 'end_image');
    if (start || end)
      graph.conditions = node('MiniMaxH3ImageToVideo', {
        ...size,
        vae: ['vae', 0],
        ...(start ? { first_frame: load('start', start) } : {}),
        ...(end ? { last_frame: load('end', end) } : {}),
      });
    // Text alone goes the same way as references: the model reads no image then.
    else
      graph.conditions = node('MiniMaxH3ReferenceToVideo', {
        ...size,
        ref_image_size: 'max',
        vae: ['vae', 0],
        audio_vae: ['audioVae', 0],
        ...Object.fromEntries(
          role(job, 'reference_image').map((ref, index) => [
            'ref_images.ref_image_' + index,
            load('reference' + (index + 1), ref),
          ]),
        ),
      });
    const model = attention(graph, job, ['shifted', 0], features, names);
    Object.assign(graph, {
      noise: node('RandomNoise', { noise_seed: p.seed }),
      guider: node('BasicGuider', { model, conditioning: ['conditions', 0] }),
      method: node('KSamplerSelect', { sampler_name: 'euler' }),
      sigmas: node('BasicScheduler', { model, scheduler: 'simple', steps: p.steps, denoise: 1 }),
      sampler: node('SamplerCustomAdvanced', {
        noise: ['noise', 0],
        guider: ['guider', 0],
        sampler: ['method', 0],
        sigmas: ['sigmas', 0],
        latent_image: ['conditions', 1],
      }),
      decode: node('VAEDecode', { samples: ['sampler', 0], vae: ['vae', 0] }),
    });
    if (p.audio !== false) graph.sound = node('VAEDecodeAudio', { samples: ['sampler', 0], vae: ['audioVae', 0] });
    graph.video = createVideo(['decode', 0], p.fps, p.audio !== false && ['sound', 0]);
    graph.save = saveVideo(job, ['video', 0]);
    return { graph, output: 'save', steps: ['sampler'], decodes: true };
  },
};

// MOSS Image as the user's own workflow runs it: Euler on the normal schedule, with the guidance
// of one late layer skipped during the first half of the steps.
const moss = {
  unsupported: () => '',
  files: job => [
    file('model', job.components.model, UNET),
    file('textEncoder', job.components.textEncoder, CLIP),
    file('vae', job.components.vae, VAE),
  ],
  graph(job, inputs, names, features) {
    const p = job.parameters;
    const graph = {
      loaded: node('UNETLoader', { unet_name: names.model, weight_dtype: 'default' }),
      model: node('SkipLayerGuidanceDiTSimple', {
        model: ['loaded', 0],
        double_layers: '',
        single_layers: '22',
        start_percent: 0,
        end_percent: 0.5,
      }),
      clip: node('CLIPLoader', { clip_name: names.textEncoder, type: 'moss_image', device: 'default' }),
      vae: node('VAELoader', { vae_name: names.vae }),
      positive: node('CLIPTextEncode', { text: p.prompt, clip: ['clip', 0] }),
      negative: node('CLIPTextEncode', { text: p.negative_prompt ?? '', clip: ['clip', 0] }),
      latent: node('EmptyFlux2LatentImage', { width: p.width, height: p.height, batch_size: 1 }),
      sampler: node('KSampler', {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['model', 0],
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
      }),
      decode: node('VAEDecode', { samples: ['sampler', 0], vae: ['vae', 0] }),
    };
    graph.sampler.inputs.model = attention(graph, job, ['model', 0], features, names);
    graph.save = node('SaveImage', { images: ['decode', 0], filename_prefix: prefix(job) });
    return { graph, output: 'save', steps: ['sampler'] };
  },
};

// Subject references only exist in the LongForge LTX2.5 nodes: with one, the video goes through them.
const ltxSubjects = {
  // LongForge looks for the images of a scene in this folder of ComfyUI's input directory.
  folder: 'longforge_ltx25',
  unsupported(job) {
    const p = job.parameters;
    if (role(job, 'msr_image').length > 2) return 'more than two subject references';
    if (p.audio === false) return 'LongForge always renders the sound';
    if (p.fps !== 24) return 'LongForge renders at 24 frames per second';
    if (p.frames < 25 || (p.frames - 1) % 8) return 'clips shorter than one second';
    return '';
  },
  files: job => [
    file('model', job.components.model, UNET),
    file('textEncoder', job.components.textEncoder, CLIP),
    file('vae', job.components.vae, VAE),
    file('audioVae', job.components.audioVae, VAE),
    ...(job.loras[0] ? [file('lora', job.loras[0].path, ['LongForgeLTXMSRReferences', 'lora_name'])] : []),
  ],
  graph(job, inputs, names, features) {
    const p = job.parameters,
      media = {};
    for (const [key, name] of [
      ['start', 'start_image'],
      ['end', 'end_image'],
    ])
      for (const ref of role(job, name).slice(0, 1))
        Object.assign(media, { [key + '_file']: inputs[ref.input], [key + '_enabled']: true });
    const graph = {
      project: node('LongForgeLTXProject', {
        // One project per generation: LongForge appends scenes to a project, Atelier wants one clip.
        project_name: 'atelier_' + job.id.replaceAll('-', ''),
        action: 'GENERATE NEXT',
        run_mode: 'ONE SCENE',
        scene_data: JSON.stringify([
          { name: 'Scene 1', prompt: p.prompt, ...(Object.keys(media).length ? { ltx: media } : {}) },
        ]),
        selected_scene: 1,
        run_stamp: Math.floor(Math.random() * 2 ** 31),
        export_when_done: true,
      }),
      video: node('LongForgeLTXVideoSettings', {
        width: p.width,
        height: p.height,
        new_seconds: (p.frames - 1) / p.fps,
        overlap_frames: '9',
        audio_continuity: false,
      }),
      sampling: node('LongForgeLTXSampling', {
        seed: p.seed,
        increment_seed: false,
        prompt_enhance: false,
        negative: 'blurry, low quality, distorted, flickering, artifacts',
        sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0',
        video_cfg: 1,
        audio_cfg: 1,
        start_strength: p.start_strength ?? 0.7,
        end_strength: p.end_strength ?? 0.7,
        image_compression: p.image_compression ?? 18,
        eta: 0,
        s_noise: 1,
      }),
      model: node('UNETLoader', { unet_name: names.model, weight_dtype: 'default' }),
      clip: node('CLIPLoader', { clip_name: names.textEncoder, type: 'ltxv', device: 'default' }),
      videoVae: node('VAELoader', { vae_name: names.vae }),
      audioVae: node('VAELoader', { vae_name: names.audioVae }),
      export: node('LongForgeLTXExportSettings', {
        container: 'MP4',
        codec: 'H264',
        encoder: 'CPU',
        bit_depth: '8',
        interpolation_factor: 1,
        browser_preview: true,
        loop_mode: 'OFF',
        loop_seconds: 1,
        loop_audio: 'CROSSFADE',
        color_drift: 'OFF',
        color_strength: 0.5,
        color_reference_scene: 1,
      }),
      render: node('LongForgeLTXRender', {
        job: ['project', 0],
        video_settings: ['video', 0],
        sampling: ['sampling', 0],
        model: ['model', 0],
        clip: ['clip', 0],
        video_vae: ['videoVae', 0],
        audio_vae: ['audioVae', 0],
        export_settings: ['export', 0],
        // The exported film is the result: no second decode for LongForge's own preview panel.
        preview_new_scene: false,
        export_crf: 18,
        repair_audio_seams: true,
        repair_video_seams: false,
        fade_film_edges: true,
        encoding_speed: 'medium',
        metadata_mode: 'NONE',
        diagnostic_wavs: false,
        seam_request: '{}',
      }),
    };
    graph.render.inputs.model = attention(graph, job, ['model', 0], features, names);
    const subjects = role(job, 'msr_image');
    if (subjects.length) {
      const [lora] = job.loras;
      if (!lora) throw problem('Les références de sujet demandent leur LoRA.');
      subjects.forEach((ref, index) => {
        graph['subject' + (index + 1)] = node('LongForgeLTXOptionalImage', { image: inputs[ref.input] });
      });
      graph.subjects = node('LongForgeLTXMSRReferences', {
        lora_name: names.lora,
        strength_model: lora.strength,
        strength: p.msr_strength ?? 1,
        reference_frames: String(p.msr_frames ?? 33),
        ...Object.fromEntries(subjects.map((_, index) => ['reference' + (index + 1), ['subject' + (index + 1), 0]])),
      });
      graph.render.inputs.media = ['subjects', 0];
    }
    return { graph, output: 'render', steps: ['render'], decodes: true };
  },
};

// The distilled model's own schedule: eight steps, or three to refine an enlarged first pass.
const LTX_SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0',
  LTX_REFINE_SIGMAS = '0.909375, 0.725, 0.421875, 0.0';
/**
 * A large LTX video is sampled at half its size, doubled in latent space, then refined at full
 * size. Measured on a 12 GB card: a step costs 2.4 to 3.1 s at half size whatever the size, and
 * 3.4 s at 576 × 1024 against 10.3 s at 896 × 1600 at full size. Two passes (8 small steps, the
 * enlargement, 3 full steps) only win above about 0.8 megapixel. Needs the latent upscaler, and
 * a size whose half is still one the model takes.
 */
const LTX_TWO_PASS_PIXELS = 800_000;
const ltxHalf = job => {
  const { width, height } = job.parameters;
  return job.components.upscaler && width * height >= LTX_TWO_PASS_PIXELS && width % 64 === 0 && height % 64 === 0
    ? { width: width / 2, height: height / 2 }
    : null;
};
const ltxVideo = {
  unsupported: () => '',
  files: job => [
    file('model', job.components.model, UNET),
    file('textEncoder', job.components.textEncoder, CLIP),
    file('vae', job.components.vae, VAE),
    file('audioVae', job.components.audioVae, VAE),
    ...(ltxHalf(job) ? [file('upscaler', job.components.upscaler, ['LatentUpscaleModelLoader', 'model_name'])] : []),
    ...job.loras.map((lora, index) => file('lora' + index, lora.path, ['LoraLoaderModelOnly', 'lora_name'])),
  ],
  graph(job, inputs, names, features) {
    const p = job.parameters,
      half = ltxHalf(job),
      [start] = role(job, 'start_image'),
      [end] = role(job, 'end_image');
    const graph = {
      model: node('UNETLoader', { unet_name: names.model, weight_dtype: 'default' }),
      clip: node('CLIPLoader', { clip_name: names.textEncoder, type: 'ltxv', device: 'default' }),
      videoVae: node('VAELoader', { vae_name: names.vae }),
      audioVae: node('VAELoader', { vae_name: names.audioVae }),
      positive: node('CLIPTextEncode', { text: p.prompt, clip: ['clip', 0] }),
      negative: node('CLIPTextEncode', { text: '', clip: ['clip', 0] }),
      conditions: node('LTXVConditioning', {
        positive: ['positive', 0],
        negative: ['negative', 0],
        frame_rate: p.fps,
      }),
      method: node('KSamplerSelect', { sampler_name: 'euler_ancestral' }),
      empty: node('EmptyLTXVLatentVideo', {
        width: half?.width ?? p.width,
        height: half?.height ?? p.height,
        length: p.frames,
        batch_size: 1,
      }),
      silence: node('LTXVEmptyLatentAudio', {
        frames_number: p.frames,
        frame_rate: p.fps,
        batch_size: 1,
        audio_vae: ['audioVae', 0],
      }),
    };
    let model = ['model', 0];
    job.loras.forEach((lora, index) => {
      graph['lora' + index] = node('LoraLoaderModelOnly', {
        lora_name: names['lora' + index],
        strength_model: lora.strength,
        model,
      });
      model = ['lora' + index, 0];
    });
    model = attention(graph, job, model, features, names);
    // An image is cut to the video's format once; each pass takes it at its own size.
    for (const [name, ref] of [
      ['start', start],
      ['end', end],
    ]) {
      if (!ref) continue;
      graph[name + 'Source'] = node('LoadImage', { image: inputs[ref.input] });
      graph[name + 'Fitted'] = node('ResizeImageMaskNode', {
        input: [name + 'Source', 0],
        resize_type: 'scale dimensions',
        'resize_type.width': p.width,
        'resize_type.height': p.height,
        'resize_type.crop': 'center',
        scale_method: 'lanczos',
      });
      graph[name + 'Image'] = node('LTXVPreprocess', {
        image: [name + 'Fitted', 0],
        img_compression: p.image_compression ?? 18,
      });
    }
    const pass = (number, { latent, audio, sigmas, seed, startStrength }) => {
      const id = name => name + number;
      let positive = ['conditions', 0],
        negative = ['conditions', 1];
      const guide = (name, image, frame, strength) => {
        graph[id(name)] = node('LTXVAddGuide', {
          positive,
          negative,
          vae: ['videoVae', 0],
          latent,
          image: [image, 0],
          frame_idx: frame,
          strength,
        });
        [positive, negative, latent] = [0, 1, 2].map(output => [id(name), output]);
      };
      // With an end image both ends are guides; a start image alone is written into the first frame.
      if (end) {
        if (start) guide('startGuide', 'startImage', 0, startStrength);
        guide('endGuide', 'endImage', -1, p.end_strength ?? 0.7);
      } else if (start) {
        graph[id('started')] = node('LTXVImgToVideoInplace', {
          vae: ['videoVae', 0],
          image: ['startImage', 0],
          latent,
          strength: startStrength,
          bypass: false,
        });
        latent = [id('started'), 0];
      }
      graph[id('joined')] = node('LTXVConcatAVLatent', { video_latent: latent, audio_latent: audio });
      graph[id('noise')] = node('RandomNoise', { noise_seed: seed });
      graph[id('sigmas')] = node('ManualSigmas', { sigmas });
      graph[id('guider')] = node('LTXVDualCFGGuider', { model, positive, negative, video_cfg: 1, audio_cfg: 1 });
      graph[id('sampler')] = node('SamplerCustomAdvanced', {
        noise: [id('noise'), 0],
        guider: [id('guider'), 0],
        sampler: ['method', 0],
        sigmas: [id('sigmas'), 0],
        latent_image: [id('joined'), 0],
      });
      graph[id('parts')] = node('LTXVSeparateAVLatent', { av_latent: [id('sampler'), 0] });
      if (!end) return { video: [id('parts'), 0], audio: [id('parts'), 1] };
      // The guides were added to the latent as extra frames: they leave it before what follows.
      graph[id('cropped')] = node('LTXVCropGuides', { positive, negative, latent: [id('parts'), 0] });
      return { video: [id('cropped'), 2], audio: [id('parts'), 1] };
    };
    let made = pass(1, {
      latent: ['empty', 0],
      audio: ['silence', 0],
      sigmas: LTX_SIGMAS,
      seed: p.seed,
      startStrength: p.start_strength ?? 0.7,
    });
    if (half) {
      graph.upscaler = node('LatentUpscaleModelLoader', { model_name: names.upscaler });
      graph.enlarged = node('LTXVLatentUpsampler', {
        samples: made.video,
        upscale_model: ['upscaler', 0],
        vae: ['videoVae', 0],
      });
      // The first pass only followed the start image; the refining pass holds it exactly.
      made = pass(2, {
        latent: ['enlarged', 0],
        audio: made.audio,
        sigmas: LTX_REFINE_SIGMAS,
        seed: p.seed + 1,
        startStrength: 1,
      });
    }
    graph.decode = node('VAEDecodeTiled', {
      samples: made.video,
      vae: ['videoVae', 0],
      tile_size: 512,
      overlap: 64,
      temporal_size: 64,
      temporal_overlap: 16,
    });
    if (p.audio !== false)
      graph.sound = node('LTXVAudioVAEDecode', { samples: made.audio, audio_vae: ['audioVae', 0] });
    graph.video = createVideo(['decode', 0], p.fps, p.audio !== false && ['sound', 0]);
    graph.save = saveVideo(job, ['video', 0]);
    return {
      graph,
      output: 'save',
      steps: half
        ? [
            ['sampler1', 8],
            ['sampler2', 3],
          ]
        : ['sampler1'],
      decodes: true,
    };
  },
};

const ltxFor = job => (role(job, 'msr_image').length ? ltxSubjects : ltxVideo);
const ltx25 = {
  folder: job => ltxFor(job).folder,
  unsupported: job =>
    role(job, 'source_video').length ? 'continuations stay on the built-in engine' : ltxFor(job).unsupported(job),
  files: job => ltxFor(job).files(job),
  graph: (job, inputs, names, features) => ltxFor(job).graph(job, inputs, names, features),
};

export const COMFY_FAMILIES = { krea2, ltx25, minimax_h3, moss };

/**
 * The graph of a job: `inputs` maps each reference input to its name in ComfyUI's input
 * folder, `names` each model file (see `files`) to the name ComfyUI lists it under.
 * `features` says which attention nodes this ComfyUI has (see `comfyFeatures`).
 * Returns `{ graph, output, steps, text?, decodes?, attention }`: the node that saves the result,
 * the nodes whose steps are worth showing in order (a name, or a name with its number of steps),
 * the node whose text is the prompt really used, and the attention it runs with.
 */
export function comfyGraph(job, inputs = {}, names = {}, features = ALL_FEATURES) {
  const family = COMFY_FAMILIES[job.pipeline];
  if (!family) throw problem(`ComfyUI ne prend pas la famille ${job.pipeline}.`);
  for (const ref of job.references)
    if (!inputs[ref.input]) throw problem(`Fichier ${ref.input} non transmis à ComfyUI.`);
  const known = Object.fromEntries(family.files(job).map(item => [item.key, names[item.key] ?? leaf(item.path)]));
  (job.styles ?? []).forEach((style, index) => {
    known['style' + index] = names['style' + index] ?? style.name;
  });
  const plan = family.graph(job, inputs, known, features);
  const p = job.parameters;
  plan.attention = [
    plan.graph.attention ? 'comfy kitchen attention' : 'default attention',
    ...(plan.graph.sparse ? [`vsa ${p.sparse_keep ?? 10} % from ${Math.round((p.sparse_start ?? 0.2) * 100)} %`] : []),
  ];
  return plan;
}
