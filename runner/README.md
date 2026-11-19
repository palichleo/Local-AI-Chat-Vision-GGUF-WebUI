# Moodix's generation engine

This folder is Moodix's own generation engine: local PyTorch/Diffusers pipelines, started by the Node server. It never imports the ComfyUI runtime; the separate `comfy-kitchen` package only supplies CUDA INT8 kernels.

The Node server owns one Python worker (`python -m runner --config …`), idle on the processor between two jobs. Before a generation the server validates the resolved job, unloads a local chat model and its vision projector, runs the pipeline, checks that video memory was released, then reloads the chat model. Cancelling terminates and reaps the worker. A worker failure does not close the chat server.

## What runs here

A family (`runner/families/*.json`) describes a model: its components, its settings, the tasks it takes and the hardware it needs. Its pipeline is in `runner/pipelines/`, its model code in `runner/models/`, and what videos share (frames, continuation, export, sound) in `runner/video/`.

| Family | Tasks | Needs an NVIDIA card |
| --- | --- | --- |
| Krea 2 | images, edits of an image | yes |
| LTX 2.5 | videos with sound, continuations | yes |
| MiniMax H3 | videos with sound, continuations | yes |
| Wan 2.1 SCAIL-2 | a character replaced in a video | yes |
| SeedVR2 | image upscaling and restoration | yes |
| Real-ESRGAN (image, video) | upscaling | no |
| RIFE | frame interpolation | no |
| ACE-Step 1.5 | music | no |
| MOSS-SoundEffect v2 | sound effects | no |

**MOSS Image** is the one family with no pipeline here (`"engine": "external"`): the Node server asks a ComfyUI running on the same computer for it, over its local HTTP API (`lib/comfy-engine.mjs`, `lib/comfy-graphs.mjs`).

The workflows shipped with Moodix are the JSON files of `runner/workflows/`, replaced by updates; `runner/workflow-history.json` lists the fingerprints of their earlier versions, so that a copy the user never edited follows the new one. The user's own workflows and edits live in `workflow/` at the root (`npm run ship-workflows` publishes them into `runner/workflows/`). `runner/downloads.json` says where each file of a shipped workflow can be downloaded from, with its size, its SHA-256 and its license.

## Setup

On Windows and Linux x64, Moodix prepares a private Python 3.13 environment and its libraries in `data/runtime/` the first time generation needs it. No system Python is required or modified: Python is not registered with Windows and the system PATH is not changed. The first setup downloads several GB; later launches reuse the environment. The chat stays available meanwhile.

The [uv-managed Python installation](https://docs.astral.sh/uv/guides/install-python/) and the versions of the libraries are pinned: `pyproject.toml` declares the supported packages, and `uv.lock` locks their transitive dependencies and wheel hashes. PyTorch comes from the official CUDA 13.0 wheel index. Python, uv, libraries, temporary files and caches stay in `data/`, which Git ignores and updates preserve.

After an application update, the libraries are checked by the new version, once its sources (including `pyproject.toml` and `uv.lock`) are in place. Synchronization keeps the same `data/runtime/venv`, installs only the missing or changed locked packages and reuses the others. If it is interrupted, the chat stays available, generation stays unavailable until it succeeds, and a later launch tries again.

For a release that changes the libraries, update `pyproject.toml`, regenerate `uv.lock` with `uv lock --project runner`, test and publish both files together. Startup uses `uv sync --locked`: a stale or missing lockfile produces a visible environment error instead of resolving untested versions on the user's computer.

The worker starts offline (`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`) and with `-s`, apart from the user's own Python packages. It downloads nothing: model files are downloaded by the Node server, and only when the user asks.

## Diagnosis

Each stage of a generation (time, video memory, what failed) is appended to `data/generation-journal.jsonl` as it happens, so a generation that hangs, fails or is cancelled can be read afterwards; the file keeps the recent ones. `data/runner-errors.log` keeps the tracebacks.

## Measurements

`python -s -m runner.bench <family> …` runs a pipeline alone, outside the application, to measure it (see the top of `bench.py`).

Measured in November 2026 on the development RTX 4070 Super (12 GB), with INT8 ConvRot model files. These are local measurements, not guarantees:

| Pipeline | Case | Pipeline time | Peak torch VRAM |
| --- | --- | --- | --- |
| Krea 2 | 512², 8 steps, three LoRAs | 16.68 s | 7.597 GiB |
| Krea 2 | 1448², 8 steps, three LoRAs | 36.45 s | 8.199 GiB |
| LTX 2.5 distilled | 384×256, 25 frames, 24 fps, 8 steps | 65.99 s | 6.634 GiB |
| LTX 2.5 distilled | Same size, start and end images | 65.14 s | 7.308 GiB |
| LTX 2.5 distilled | Video with 48 kHz stereo sound, 384×256 | 68.14 s | 6.634 GiB |
| LTX 2.5 distilled | 768×512, 25 frames | 108.22 s | 6.779 GiB |
| LTX 2.5 distilled | 896×1600, 121 frames with sound, start image, two passes | 192 s | under the 12 GB of the card |
| LTX 2.5 distilled | 896×1600, 193 frames (8 s) with sound, start image, two passes (17 Nov, 0.6.74) | 184 s | 8.76 GiB |
| LTX 2.5 distilled | 896×1600, 121 frames with sound, from text, two passes (17 Nov, 0.6.74) | 96 s | 8.67 GiB |

Startup, the state of the disk cache and the first compilation of the kernels change the total time.

The two lines of 17 November were measured once the embedding of a timestep was kept once per different timestep instead of once per token (`runner/models/ltx25_block.py`): before it, the copies of these embeddings took 7.5 GiB for the 35 000 tokens of the 8-second video, whose refining pass ran out of the memory of the card.

**Large LTX 2.5 videos run in two passes**, as the model's own recipe does, when the optional `upscaler` component (the ×2 latent spatial upscaler) is set and the shorter side is at least 512 px: eight steps at half the size, the latents doubled by the upscaler, then three steps at the full size with the start image held exactly. On the 12 GB card at 896×1600, 121 frames: 48 s for the first pass, 65 s for the three full-size steps, 60 s to decode. Without the upscaler the eight steps run at the full size: several times slower, and beyond what 12 GB holds at this size.

The distilled LTX 2.5 pipeline takes 8 steps, CFG 1, dimensions divisible by 32 and frame counts of 8n+1. Its audio VAE is required even when no sound is exported.

## Formats of a model file

The engine reads safetensors files, in the precision they store: INT8 ConvRot (the note `.comfy_quant` beside each layer), 8-bit floats (« fp8 scaled » or not), 16 and 32-bit floats. On an RTX 4070 Super the INT8 files are the fast ones: a layer computes three times faster from 8-bit integers than from floats, whatever the floats were stored as (LTX 2.5: 1.25 s a step against 2.74 s from an « fp8 scaled » file), and INT8 ConvRot rounds less than 8-bit floats do. The measures are in `MEMORY-STUDY.md`.

`python -s -m runner.convert SOURCE TARGET.safetensors` writes any 8-bit file again as INT8 ConvRot: an « fp8 scaled » safetensors file, or a GGUF file (Q8_0, Q4_0, Q4_1, Q5_0, Q5_1, Q4_K, Q5_K, Q6_K; `runner/models/gguf.py` reads them without llama.cpp). 20 GiB of LTX 2.5 take 40 s. GGUF files are not read in place: they are converted first.

## Checks

From the root of the repository, with the interpreter of the private environment (`data/runtime/venv/Scripts/python.exe` on Windows, `data/runtime/venv/bin/python` on Linux):

```sh
python -s -m unittest discover -s runner/tests
```

The tests need no graphics card and no model file. Code style: `ruff format --config runner/pyproject.toml` on the files you touch (lines of 120 characters at most).

Generation on Linux has not been tried on a real card yet.
