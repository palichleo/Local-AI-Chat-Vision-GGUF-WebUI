"""Time a family of the built-in engine, phase by phase, outside the application.

A family leaves ComfyUI for this engine only once it is measured at least as fast, on the same
files and the same picture. This runs the pipeline several times in one process (the worker of
the application outlives its jobs the same way: the first run is the cold one) and prints what
each phase cost, what stayed on the GPU and what was kept in RAM.

    python -s -m runner.bench krea2 --model M.safetensors --text-encoder T.safetensors \\
        --vae V.safetensors --tokenizer TOKENIZER_FOLDER --out FOLDER [--runs 3] [--seed 1]
        [--size 1024x1024] [--steps 8] [--prompt "..."] [--same-prompt] [--lora FILE:STRENGTH]
        [--gpu-gib N] [--ram-reserve-gib N]

Nothing is written to the application's data: the pictures go to --out.
"""

import argparse
import json
import sys
import time
import uuid

PROMPT = 'A red fox sitting on a mossy rock in a misty pine forest at dawn, soft light, shallow depth of field'


def krea2_job(args, run):
    width, height = (int(side) for side in args.size.lower().split('x'))
    # Another prompt each run unless asked otherwise: the text encoder is part of what is timed.
    prompt = args.prompt if args.same_prompt or run == 1 else f'{args.prompt}, variation {run}'
    return dict(
        id=str(uuid.uuid4()),
        pipeline='krea2',
        mediaType='image',
        parameters=dict(
            prompt=prompt,
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


FAMILIES = {'krea2': ('runner.pipelines.krea2', krea2_job)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('family', choices=sorted(FAMILIES))
    parser.add_argument('--model', required=True)
    parser.add_argument('--text-encoder', required=True)
    parser.add_argument('--vae', required=True)
    parser.add_argument('--tokenizer', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--size', default='1024x1024')
    parser.add_argument('--steps', type=int, default=8)
    parser.add_argument('--prompt', default=PROMPT)
    parser.add_argument('--same-prompt', action='store_true')
    parser.add_argument('--lora', action='append', default=[], metavar='FILE:STRENGTH')
    parser.add_argument('--gpu-gib', type=float, help='ceiling on the weights kept on the GPU')
    parser.add_argument('--ram-reserve-gib', type=float, help='RAM the resident files must leave free')
    args = parser.parse_args(argv)

    import importlib

    import torch

    from runner import engine as worker
    from runner.models import residency

    if args.ram_reserve_gib is not None:
        residency.RESERVE = int(args.ram_reserve_gib * 1024**3)
    module_name, build = FAMILIES[args.family]
    module = importlib.import_module(module_name)
    config = dict(cacheRoot=args.out, outputRoot=args.out, engine='int8', tuned=True)
    if args.gpu_gib is not None:
        config['cacheGiB'] = args.gpu_gib
    free, total = torch.cuda.mem_get_info()
    card = torch.cuda.get_device_name(0)
    print(f'{card} · torch {torch.__version__} · {free / 1024**3:.2f} GiB free of {total / 1024**3:.2f}')

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
        print(f'\nrun {run}: {seconds:.1f} s  (seed {job["parameters"]["seed"]})')
        previous = 0.0
        for at, stage, step, free_gib in marks:
            label = f'{stage} {step}' if step else stage
            print(f'  {at:7.2f} s  +{at - previous:5.2f}  {label:<34} free {free_gib} GiB')
            previous = at
        metadata = result.get('metadata', {})
        steps = [mark for mark in metadata.get('timeline', []) if mark.get('stage') == 'denoising']
        print('  weights:', json.dumps(metadata.get('weights')))
        if steps:
            print(
                '  during the steps: allocated',
                max(mark['allocated_gib'] for mark in steps),
                'reserved',
                max(mark['reserved_gib'] for mark in steps),
                'lowest free',
                min(mark['free_gib'] for mark in steps),
                'GiB',
            )
        print('  RAM:', json.dumps(residency.RESIDENCY.summary(), ensure_ascii=False))
        print('  file:', result['outputs'][0]['filename'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
