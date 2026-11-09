# Native generation runner — experimental branch

This runner uses local PyTorch/Diffusers pipelines. It never imports the ComfyUI runtime or submits native jobs to a Comfy server. The separate `comfy-kitchen` package supplies CUDA INT8 kernels.

The Node server owns one CPU-idle Python worker. Before generation it validates the resolved job, unloads llama.cpp and its vision projector, runs the pipeline, verifies GPU release, then reloads the LLM. Cancellation terminates and reaps the owned worker. A worker failure does not close the chat server.

## Setup

On Windows and Linux x64, enabling native generation automatically prepares a private Python 3.13 environment and its libraries in `data/runtime/`. No system Python is required or modified. Python is not registered with Windows and the system PATH is not changed. The initial setup downloads several GB; later launches reuse the environment. Chat remains available during setup and Configuration shows its progress. Closing Atelier cancels preparation; the next attempt can resume from cached downloads.

The [uv-managed Python installation](https://docs.astral.sh/uv/guides/install-python/) and dependency versions are pinned: `pyproject.toml` declares the supported packages, and `uv.lock` locks their transitive dependencies and wheel hashes. PyTorch uses the official CUDA 13.0 wheel index. Python, uv, libraries, temporary files and compiler/model caches stay in the app's private data directory, which Git ignores and app updates preserve. No model, LoRA or tokenizer is downloaded automatically. This implementation currently requires a compatible NVIDIA driver/GPU for generation; chat remains available separately.

In **Configuration → Workflows → Environnement de génération**, leave **Python personnalisé** empty for automatic setup. An explicitly selected external interpreter remains an advanced override: Atelier does not install packages into it. Select the local Qwen tokenizer folder when using Krea2 (selecting its `tokenizer.json` also works). Python is started with `-s` to isolate it from user-site packages. LTX2.5 uses the tokenizer embedded in its Gemma checkpoint instead.

**Ajouter un workflow** opens the editor in the existing settings dialog. Select local component files, describe when the LLM should use the workflow, and save. Component names are taken from your files. A fixed parameter is locked; a model parameter exposes only the chosen bounds/options; random seeds are resolved once before approval. LoRA activation and strength have separate policies. Disabled or incompatible workflows are not advertised as tools.

Native JSON definitions live in `workflow/`. Local asset paths and worker preferences live in `data/`. Originals and resolved-job manifests live in `output/`. These user files, model weights and caches are ignored by Git and preserved by updates. Deleting conversation history removes analysis copies and links, not original outputs.

After image generation, the LLM receives the result metadata, without automatic image pixels or a critique request. It normally finishes there. The `local_read_output` tool can inspect one saved compressed output when the user asks for a check or the model finds a specific reason relevant to the task. This is guidance, not a keyword filter or a prohibition. Inspected pixels are temporary for the current turn; gallery copies and originals remain available independently.

## Verified behavior

Measured on the development RTX 4070 Super, using existing local INT8 ConvRot checkpoints:

| Pipeline | Case | Pipeline time | Peak torch VRAM |
| --- | --- | --- | --- |
| Krea2 | 512², 8 steps, three LoRAs | 16.68 s | 7.597 GiB |
| Krea2 | 1448², 8 steps, three LoRAs | 36.45 s | 8.199 GiB |
| LTX2.5 distilled | 384×256, 25 frames, 24 fps, 8 steps | 65.99 s | 6.634 GiB |
| LTX2.5 distilled | Same size, start + end image conditions | 65.14 s | 7.308 GiB |
| LTX2.5 distilled | Two learned MSR image slots and LoRA, 384×256 | 68.93 s | 7.597 GiB |
| LTX2.5 distilled | Silent continuation, 9 context + 16 new frames | 64.56 s | 7.288 GiB |
| LTX2.5 distilled | Video with 48 kHz stereo audio, 384×256 | 68.14 s | 6.634 GiB |
| LTX2.5 distilled | Final profile, 768×512, 25 frames | 108.22 s | 6.779 GiB |

Startup/imports, disk cache state and first kernel compilation affect total latency. These are local measurements, not guarantees or a video comparison against ComfyUI. All successful smoke runs acknowledged zero remaining torch GPU allocation after cleanup.

Krea2 supports text-to-image and one img2img reference. The converter accepts only the supported Krea API graph, backs up its bytes, preserves explicit prompt-expansion settings and never guesses how an unknown node works.

LTX2.5 supports text-to-video, start/end images, two learned MSR image slots, optional stereo audio, and silent continuation. It uses the 22B distilled transformer, Gemma4 Unified encoder with projections, diffusion video VAE, and audio VAE/vocoder. Start/end strengths default to 0.7 and image recompression to CRF 18. MSR additionally requires its compatible learned-slot LoRA; its strength and 25/33-frame guide window can be declared in JSON. Arbitrary video LoRAs are rejected until their layout is supported.

The distilled pipeline requires 8 steps, CFG=1, dimensions divisible by 32 and frame counts of 8n+1. The audio VAE is required by the coupled sampler even when audio is not exported. Every video needs its own approval, including its concrete draft/final stage, seed and dimensions. Draft/final profiles set explicit dimensions and duration. `reuse_output` promotes a draft from the current conversation while retaining its prompt, seed, component choices, references and LoRA settings. The final render is a new generation, not a guarantee of pixel-identical composition at another resolution.

`source_video` uses an active video resource or a previous native video `output_id`. The original is staged on disk; sampled preview frames never stand in for it. A bounded tail of 1/9/17/25/33 frames conditions the next window. Export appends only the newly generated frames, keeps a constant frame rate and never overwrites the source. Continuation currently requires a **silent source at the selected output resolution and fps**; incompatible audio, dimensions or cadence fail explicitly. The output metadata records its source and overlap. Successive separately approved continuations can form a sequence.

Use **Convertir LongForge avec sauvegarde** to extract the supported settings/assets from the supplied editor graph. It creates a disabled native workflow, backs up source bytes and reports omitted optional enhancement and private scene/media data. Duplicate asset matches require disambiguation; files already registered for the same role take precedence. No graph interpreter is run.

**Remaining LongForge differences:** continuous audio across scenes, automatic whole-film planning, interpolation/upscaling and optional enhancement are not implemented. The original 896×1600 five-second preset has not been validated on 12 GB; conversion preserves it in the final profile for review. Real smoke tests establish working execution, not quality/speed parity with every Comfy workflow. Legacy Comfy code remains for existing records and compatibility tests.

## Checks

Node: `npm test`. Python from a normal environment: `python -s -m unittest discover -s runner/tests -v`.

For an embedded interpreter whose isolated path excludes the current directory:

```powershell
python -s -c "import sys,unittest;sys.path.insert(0,'.');r=unittest.TextTestRunner().run(unittest.defaultTestLoader.discover('runner/tests'));sys.exit(not r.wasSuccessful())"
```

Real GPU smoke artifacts stay local and are not distributed. Linux GPU inference has not been tested yet.
