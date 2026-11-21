"""Time a family of the built-in engine, phase by phase, outside the application.

A family leaves ComfyUI for this engine only once it is measured at least as fast, on the same
files and the same request. This runs the pipeline several times in one process (the worker of
the application outlives its jobs the same way: the first run is the cold one) and prints what
each phase cost, what stayed on the GPU and what was kept in RAM.

    python -s -m runner.bench krea2 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER [--lora FILE:STRENGTH]
    python -s -m runner.bench minimax_h3 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --audio-vae A.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER \\
        [--steps 20: MiniMax's own checkpoints] [--reference-model REF2VA --reference reference_image=FILE]
    python -s -m runner.bench ltx25 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --audio-vae A.safetensors [--upscaler U.safetensors] --out FOLDER
    python -s -m runner.bench moss --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER [--cfg 3] [--negative "..."]
    python -s -m runner.bench wan22 --model HIGH.safetensors --model-low LOW.safetensors \\
        --text-encoder T.safetensors --vae V.safetensors --reference start_image=FILE --out FOLDER \\
        [--step-lora HIGH_LORA --step-lora-low LOW_LORA: four steps] [--frames 81] [--size 768x448]
    python -s -m runner.bench wan_scail2 --model M.safetensors --text-encoder T.safetensors \\
        --clip-vision C.safetensors --vae V.safetensors --lora STEP_LORA:0.8 --lora DPO_LORA:1 \\
        --segmenter SAM.safetensors --segmenter-tokenizer TOKENIZER_FOLDER \\
        --reference driving_video=VIDEO --reference reference_image=IMAGE --out FOLDER \\
        [--mode animate: the character of the image moves as the video does, in its own scene] \\
        [--subject girl] [--reference-subject robot] [--frames 81]

    Common: [--runs 3] [--seed 1] [--size WxH] [--steps 8] [--frames 124] [--prompt "..."]
            [--new-prompts N] [--gpu-gib N] [--ram-reserve-gib N]

Each run has another prompt (the text encoder is part of what is timed) up to --new-prompts,
then the last one again. Nothing is written to the application's data: results go to --out.
"""

import argparse
import json
import sys
import time
import uuid

PROMPT = 'A red fox sitting on a mossy rock in a misty pine forest at dawn, soft light, shallow depth of field'


def _prompt(args, run):
    turn = min(run, args.new_prompts) if args.new_prompts else run
    return args.prompt if turn == 1 else f'{args.prompt}, variation {turn}'


def _size(args, default):
    return tuple(int(side) for side in (args.size or default).lower().split('x'))


def _need(args, *names):
    missing = [name for name in names if not getattr(args, name)]
    if missing:
        raise SystemExit('missing: ' + ', '.join('--' + name.replace('_', '-') for name in missing))


def _loras(args):
    """--lora FILE:STRENGTH, as many times as there are LoRAs."""
    return [
        dict(id=f'lora-{index}', path=path, strength=float(strength))
        for index, (path, _, strength) in enumerate(item.rpartition(':') for item in args.lora)
    ]


def krea2_job(args, run):
    _need(args, 'model', 'text_encoder', 'vae', 'tokenizer')
    width, height = _size(args, '1024x1024')
    return dict(
        id=str(uuid.uuid4()),
        pipeline='krea2',
        mediaType='image',
        parameters=dict(
            prompt=_prompt(args, run),
            seed=args.seed + run - 1,
            width=width,
            height=height,
            steps=args.steps or 8,
            cfg=1,
            denoise=1,
            expandPrompt=False,
        ),
        components=dict(model=args.model, textEncoder=args.text_encoder, vae=args.vae, tokenizer=args.tokenizer),
        loras=_loras(args),
        references=[],
    )


def moss_job(args, run):
    _need(args, 'model', 'text_encoder', 'vae', 'tokenizer')
    width, height = _size(args, '1024x1024')
    return dict(
        id=str(uuid.uuid4()),
        pipeline='moss',
        mediaType='image',
        parameters=dict(
            prompt=_prompt(args, run),
            negative_prompt=args.negative,
            seed=args.seed + run - 1,
            width=width,
            height=height,
            steps=args.steps or 50,
            cfg=args.cfg,
        ),
        components=dict(model=args.model, textEncoder=args.text_encoder, vae=args.vae, tokenizer=args.tokenizer),
        loras=[],
        references=[],
    )


def minimax_h3_job(args, run):
    _need(args, 'model', 'text_encoder', 'vae', 'audio_vae', 'tokenizer')
    width, height = _size(args, '768x448')
    return dict(
        id=str(uuid.uuid4()),
        pipeline='minimax_h3',
        mediaType='video',
        parameters=dict(
            prompt=_prompt(args, run),
            seed=args.seed + run - 1,
            width=width,
            height=height,
            steps=args.steps or 8,
            stage='draft',
            frames=args.frames,
            fps=24,
            audio=True,
            overlap_frames=22,
            attention='comfy_kitchen',
            sparse_attention='vsa' if args.sparse_keep else 'off',
            sparse_keep=args.sparse_keep or 10,
            sparse_start=args.sparse_start,
        ),
        components=dict(
            model=args.model,
            textEncoder=args.text_encoder,
            tokenizer=args.tokenizer,
            vae=args.vae,
            audioVae=args.audio_vae,
            # MiniMax's own checkpoints: the file that reads reference images (Ref2VA).
            **({'referenceModel': args.reference_model} if args.reference_model else {}),
        ),
        loras=[],
        references=[
            dict(input=role, role=role, path=path) for role, _, path in (item.partition('=') for item in args.reference)
        ],
    )


def ltx25_job(args, run):
    _need(args, 'model', 'text_encoder', 'vae', 'audio_vae')
    width, height = _size(args, '288x512')
    components = dict(model=args.model, textEncoder=args.text_encoder, vae=args.vae, audioVae=args.audio_vae)
    # With the latent upscaler, a large video is sampled in two passes, as the workflow does.
    if args.upscaler:
        components['upscaler'] = args.upscaler
    return dict(
        id=str(uuid.uuid4()),
        pipeline='ltx25',
        mediaType='video',
        parameters=dict(
            prompt=_prompt(args, run),
            seed=args.seed + run - 1,
            width=width,
            height=height,
            steps=args.steps or 8,
            stage='draft',
            frames=args.frames,
            fps=24,
            audio=True,
            start_strength=0.7,
            end_strength=0.7,
            image_compression=18,
            msr_strength=1,
            msr_frames=33,
            overlap_frames=9,
        ),
        components=components,
        loras=_loras(args),
        references=[],
    )


def wan_scail2_job(args, run):
    _need(args, 'model', 'text_encoder', 'vae', 'clip_vision')
    from runner.video.stream import probe

    references = [
        dict(input=role, role=role, path=path) for role, _, path in (item.partition('=') for item in args.reference)
    ]
    driving = next((ref['path'] for ref in references if ref['role'] == 'driving_video'), None)
    if not driving:
        raise SystemExit('missing: --reference driving_video=FILE')
    width, height = _size(args, '896x512')
    parameters = dict(
        prompt=_prompt(args, run),
        seed=args.seed + run - 1,
        width=width,
        height=height,
        steps=args.steps or 6,
        shift=5,
        frames=args.frames,
        fps=float(probe(driving)['fps']),
        audio=True,
        mode=args.mode,
    )
    if args.segment_frames:
        parameters['segment_frames'] = args.segment_frames
    components = dict(model=args.model, textEncoder=args.text_encoder, clipVision=args.clip_vision, vae=args.vae)
    # Without masks among the references, SAM 3.1 finds the subjects from these words.
    for name in ('subject', 'reference_subject'):
        if getattr(args, name):
            parameters[name] = getattr(args, name)
    if args.segmenter:
        components.update(segmenter=args.segmenter, segmenterTokenizer=args.segmenter_tokenizer)
    return dict(
        id=str(uuid.uuid4()),
        pipeline='wan_scail2',
        mediaType='video',
        parameters=parameters,
        components=components,
        loras=_loras(args),
        references=references,
    )


def wan22_job(args, run):
    _need(args, 'model', 'model_low', 'text_encoder', 'vae')
    references = [
        dict(input=role, role=role, path=path) for role, _, path in (item.partition('=') for item in args.reference)
    ]
    if not any(ref['role'] == 'start_image' for ref in references):
        raise SystemExit('missing: --reference start_image=FILE')
    width, height = _size(args, '768x448')
    components = dict(model=args.model, modelLow=args.model_low, textEncoder=args.text_encoder, vae=args.vae)
    # With its two step LoRAs, as the application ships the model: 4 steps and no guidance.
    lightning = bool(args.step_lora and args.step_lora_low)
    if lightning:
        components.update(stepLora=args.step_lora, stepLoraLow=args.step_lora_low)
    return dict(
        id=str(uuid.uuid4()),
        pipeline='wan22',
        mediaType='video',
        parameters=dict(
            prompt=_prompt(args, run),
            seed=args.seed + run - 1,
            width=width,
            height=height,
            steps=args.steps or (4 if lightning else 20),
            cfg=1 if lightning else 3.5,
            shift=5,
            # (4n + 1 frames: 81, five seconds, unless such a length is asked.)
            frames=args.frames if args.frames % 4 == 1 else 81,
            fps=16,
        ),
        components=components,
        loras=[],
        references=references,
    )


FAMILIES = {
    'krea2': ('runner.pipelines.krea2', krea2_job),
    'ltx25': ('runner.pipelines.ltx25', ltx25_job),
    'minimax_h3': ('runner.pipelines.minimax_h3', minimax_h3_job),
    'moss': ('runner.pipelines.moss', moss_job),
    'wan22': ('runner.pipelines.wan22', wan22_job),
    'wan_scail2': ('runner.pipelines.wan_scail2', wan_scail2_job),
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('family', choices=sorted(FAMILIES))
    names = ('model', 'reference-model', 'text-encoder', 'vae', 'audio-vae', 'tokenizer', 'upscaler', 'clip-vision')
    # Wan 2.2: its second model (« low noise »), and the step LoRA of each.
    names += ('model-low', 'step-lora', 'step-lora-low')
    for name in (*names, 'segmenter'):
        parser.add_argument('--' + name)
    parser.add_argument('--out', required=True)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--size')
    parser.add_argument('--steps', type=int, help='8 unless the family has its own (SCAIL-2: 6, MOSS Image: 50)')
    parser.add_argument('--frames', type=int, default=124)
    parser.add_argument('--prompt', default=PROMPT)
    parser.add_argument('--new-prompts', type=int, default=0, help='prompts that differ; later runs repeat the last')
    parser.add_argument('--same-prompt', action='store_true', help='one prompt for every run')
    parser.add_argument('--lora', action='append', default=[], metavar='FILE:STRENGTH')
    parser.add_argument('--reference', action='append', default=[], metavar='ROLE=FILE')
    parser.add_argument('--segmenter-tokenizer', help='SCAIL-2: folder of the CLIP tokenizer SAM 3.1 reads')
    parser.add_argument('--subject', help='SCAIL-2: who to follow in the video ("girl, handkerchief")')
    parser.add_argument('--reference-subject', help='SCAIL-2: who to draw from the reference image')
    parser.add_argument('--segment-frames', type=int, help='SCAIL-2: frames of a segment, 81 unless the card is small')
    parser.add_argument(
        '--mode',
        choices=('replace', 'animate'),
        default='replace',
        help='SCAIL-2: replace the person of the video, or animate the character of the image',
    )
    parser.add_argument('--keep', action='store_true', help='leave the model on the GPU between runs, as the Studio')
    parser.add_argument('--gpu-gib', type=float, help='ceiling on the weights kept on the GPU')
    parser.add_argument('--ram-reserve-gib', type=float, help='RAM the resident files must leave free')
    parser.add_argument('--sparse-keep', type=float, help='MiniMax-H3: video sparse attention, percent of cubes kept')
    parser.add_argument('--sparse-start', type=float, default=0.2, help='MiniMax-H3: share of the steps kept dense')
    parser.add_argument('--cfg', type=float, default=3.0, help='MOSS Image: guidance (1 follows the prompt alone)')
    parser.add_argument('--negative', default='', help='MOSS Image: negative prompt')
    args = parser.parse_args(argv)
    if args.same_prompt:
        args.new_prompts = 1

    import importlib

    import torch

    from runner import engine as worker
    from runner.models import residency

    if args.ram_reserve_gib is not None:
        residency.RESERVE = int(args.ram_reserve_gib * 1024**3)
    module_name, build = FAMILIES[args.family]
    module = importlib.import_module(module_name)
    # A family that sets its own reserve is given the one asked for here.
    if args.ram_reserve_gib is not None and hasattr(module, 'RAM_RESERVE_GIB'):
        module.RAM_RESERVE_GIB = args.ram_reserve_gib
    config = dict(cacheRoot=args.out, outputRoot=args.out, engine='int8', tuned=True)
    if args.gpu_gib is not None:
        config['cacheGiB'] = args.gpu_gib
    free, total = torch.cuda.mem_get_info()
    card = torch.cuda.get_device_name(0)
    print(f'{card} · torch {torch.__version__} · {free / 1024**3:.2f} GiB free of {total / 1024**3:.2f}', flush=True)

    for run in range(1, args.runs + 1):
        job = build(args, run)
        marks = []
        started = time.perf_counter()

        def progress(**data):
            # A picture of the step (the preview the application shows) is not a phase.
            if not data.get('stage') and not data.get('step'):
                return
            memory = torch.cuda.memory_allocated() / 1024**3, torch.cuda.memory_reserved() / 1024**3
            marks.append((time.perf_counter() - started, data.get('stage'), data.get('step'), memory))

        def timeline():
            previous = 0.0
            for at, stage, step, (allocated, reserved) in marks:
                label = f'{stage} {step}' if step else stage
                print(f'  {at:7.2f} s  +{at - previous:6.2f}  {label:<34} {allocated:5.2f} / {reserved:5.2f} GiB')
                previous = at

        # As the worker does: PyTorch kept inside the video memory that is free now.
        ceiling = worker._vram_ceiling(torch)
        try:
            result = module.generate(job, config, progress)
        except BaseException:
            # What the run held, allocated / reserved, up to the failure.
            print(f'\nrun {run} failed after {time.perf_counter() - started:.1f} s', flush=True)
            timeline()
            raise
        finally:
            if ceiling:
                torch.cuda.set_per_process_memory_fraction(1.0)
        seconds = time.perf_counter() - started
        # As the Studio does between two creations, or as the chat does after one.
        worker.release(between=args.keep)
        print(f'\nrun {run}: {seconds:.1f} s  (seed {job["parameters"]["seed"]})', flush=True)
        timeline()
        metadata = result.get('metadata', {})
        timeline = metadata.get('timeline', [])
        steps = [mark for mark in timeline if mark.get('step')]
        kept = metadata.get('weights') or metadata.get('weight_cache')
        print('  weights:', json.dumps(kept, ensure_ascii=False)[:600])
        print('  peak video memory:', metadata.get('peak_vram_gib'), 'GiB')
        if steps:
            last = steps[-1].get('weights')
            if last:
                print('  copied to the GPU:', json.dumps(last))
            measures = [
                (key, [mark[key] for mark in steps if key in mark]) for key in ('allocated_gib', 'reserved_gib')
            ]
            print(
                '  during the steps:',
                ', '.join(f'{key} {max(values)}' for key, values in measures if values),
                '· lowest free',
                min(mark['free_gib'] for mark in steps if 'free_gib' in mark),
                'GiB',
            )
        print('  RAM:', json.dumps(residency.RESIDENCY.summary(), ensure_ascii=False))
        print('  file:', result['outputs'][0]['filename'], flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
