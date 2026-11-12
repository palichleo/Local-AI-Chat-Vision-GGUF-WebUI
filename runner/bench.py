"""Time a family of the built-in engine, phase by phase, outside the application.

A family leaves ComfyUI for this engine only once it is measured at least as fast, on the same
files and the same request. This runs the pipeline several times in one process (the worker of
the application outlives its jobs the same way: the first run is the cold one) and prints what
each phase cost, what stayed on the GPU and what was kept in RAM.

    python -s -m runner.bench krea2 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER [--lora FILE:STRENGTH]
    python -s -m runner.bench minimax_h3 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --audio-vae A.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER

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
            steps=args.steps,
            cfg=1,
            denoise=1,
            expandPrompt=False,
        ),
        components=dict(model=args.model, textEncoder=args.text_encoder, vae=args.vae, tokenizer=args.tokenizer),
        loras=[
            dict(id=f'lora-{index}', path=path, strength=float(strength))
            for index, (path, _, strength) in enumerate(item.rpartition(':') for item in args.lora)
        ],
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
            steps=args.steps,
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
        ),
        loras=[],
        references=[],
    )


FAMILIES = {
    'krea2': ('runner.pipelines.krea2', krea2_job),
    'minimax_h3': ('runner.pipelines.minimax_h3', minimax_h3_job),
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('family', choices=sorted(FAMILIES))
    for name in ('model', 'text-encoder', 'vae', 'audio-vae', 'tokenizer'):
        parser.add_argument('--' + name)
    parser.add_argument('--out', required=True)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--size')
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--frames', type=int, default=124)
    parser.add_argument('--prompt', default=PROMPT)
    parser.add_argument('--new-prompts', type=int, default=0, help='prompts that differ; later runs repeat the last')
    parser.add_argument('--same-prompt', action='store_true', help='one prompt for every run')
    parser.add_argument('--lora', action='append', default=[], metavar='FILE:STRENGTH')
    parser.add_argument('--gpu-gib', type=float, help='ceiling on the weights kept on the GPU')
    parser.add_argument('--ram-reserve-gib', type=float, help='RAM the resident files must leave free')
    parser.add_argument('--sparse-keep', type=float, help='MiniMax-H3: video sparse attention, percent of cubes kept')
    parser.add_argument('--sparse-start', type=float, default=0.2, help='MiniMax-H3: share of the steps kept dense')
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
            marks.append((time.perf_counter() - started, data.get('stage'), data.get('step'), data.get('free_gib')))

        # As the worker does: PyTorch kept inside the video memory that is free now.
        ceiling = worker._vram_ceiling(torch)
        try:
            result = module.generate(job, config, progress)
        finally:
            if ceiling:
                torch.cuda.set_per_process_memory_fraction(1.0)
        seconds = time.perf_counter() - started
        worker.release()
        print(f'\nrun {run}: {seconds:.1f} s  (seed {job["parameters"]["seed"]})', flush=True)
        previous = 0.0
        for at, stage, step, free_gib in marks:
            label = f'{stage} {step}' if step else stage
            room = '' if free_gib is None else f' free {free_gib} GiB'
            print(f'  {at:7.2f} s  +{at - previous:6.2f}  {label:<34}{room}')
            previous = at
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
