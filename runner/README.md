# Native generation runner — experimental branch

This runner uses local PyTorch/Diffusers pipelines. It never imports the ComfyUI runtime. The separate `comfy-kitchen` package supplies CUDA INT8 kernels.

Since 0.4.14 it is Atelier's _internal_ engine: it upscales (Real-ESRGAN, SeedVR2), interpolates (RIFE) and continues LTX 2.5 and MiniMax H3 videos. New images and videos are made by ComfyUI, the _external_ engine, which the Node server calls over HTTP (`lib/comfy-engine.mjs`, `lib/comfy-graphs.mjs`); a family whose manifest says `"native": false` (Krea 2, MOSS Image) has no pipeline here. The Krea 2 pipeline this runner had is kept out of the repository in `experiment_keep_engine/`; what this page says of Krea 2 below describes that pipeline.

The Node server owns one CPU-idle Python worker. Before generation it validates the resolved job, unloads llama.cpp and its vision projector, runs the pipeline, verifies GPU release, then reloads the LLM. Cancellation terminates and reaps the owned worker. A worker failure does not close the chat server.

## Setup

On Windows and Linux x64, enabling native generation automatically prepares a private Python 3.13 environment and its libraries in `data/runtime/`. No system Python is required or modified. Python is not registered with Windows and the system PATH is not changed. The initial setup downloads several GB; later launches reuse the environment. Chat remains available during setup and Configuration shows its progress. Closing Atelier cancels preparation; the next attempt can resume from cached downloads.

The [uv-managed Python installation](https://docs.astral.sh/uv/guides/install-python/) and dependency versions are pinned: `pyproject.toml` declares the supported packages, and `uv.lock` locks their transitive dependencies and wheel hashes. PyTorch uses the official CUDA 13.0 wheel index. Python, uv, libraries, temporary files and compiler/model caches stay in the app's private data directory, which Git ignores and app updates preserve. No model, LoRA or tokenizer is downloaded automatically. This implementation currently requires a compatible NVIDIA driver/GPU for generation; chat remains available separately.

After an application update, dependency checks run in the replacement process, after all new sources (including `pyproject.toml` and `uv.lock`) are installed. Each launch also checks an existing private environment when generation is disabled. Synchronization keeps the same `data/runtime/venv`, installs only missing or changed locked packages and reuses satisfied packages. Chat remains available if synchronization is interrupted; generation stays unavailable until it succeeds, and a later launch retries. An external Python override is never modified.

For a release that changes dependencies, update `pyproject.toml`, regenerate `uv.lock` with `uv lock --project runner`, test and publish both files together. Startup uses `uv sync --locked`: a stale or missing lockfile produces a visible environment error instead of silently using old requirements or resolving untested versions on the user's machine.

In **Configuration → Génération → Environnement de génération**, leave **Python personnalisé** empty for automatic setup. An explicitly selected external interpreter remains an advanced override: Atelier does not install packages into it. Select the local Qwen tokenizer folder when using Krea2 (selecting its `tokenizer.json` also works). Python is started with `-s` to isolate it from user-site packages. LTX2.5 uses the tokenizer embedded in its Gemma checkpoint instead.

The separate **Workflows** settings block lists workflows and their activation state. **Créer un workflow** opens the editor in the existing dialog. Select image or video generation, name the workflow and describe when the assistant should use it. Select local files, expand the sections you need and save. **Fixe** locks your value; **Assistant** lets the model choose within your limits; **Aléatoire** draws the seed once before approval. LoRA activation and strength have separate policies. The LTX runner requires an audio VAE even for silent output. Changing generation engines asks before replacing component choices and settings. Disabled or incompatible workflows are not advertised as tools.

In **Dossier des modèles de génération**, one path names the models directory: empty, it is `models/` of this installation; it can be the `models` folder of a ComfyUI, sorted the same way (`diffusion_models`, `text_encoders`, `vae`, `loras`, `upscale_models`, `latent_upscale_models`…). Under **Détails**, a folder apart can be set for one kind of file (diffusion models, VAE, LoRA, text encoders, tokenizers, upscalers, latent upscalers); each can be edited or chosen with **Parcourir…** and saved with the main Configuration button. Edited folders are used immediately for workflow import and selecting new component files; saving keeps them after restart. Clearing a folder restores its default. A component a workflow does not fix takes, in the folder of its kind, the file whose layout is the one its model expects. Existing registered model files stay at their current paths. Text encoders and other component folders keep their existing settings. Manual file paths remain available under **Saisir un chemin**. Selecting the same file again reuses its registry identity. Conversion searches the selected component folders, rejecting ambiguous matches.

**Importer un workflow**, to the left of **Créer un workflow**, accepts Atelier JSON, ComfyUI API exports and ComfyUI editor files through one file chooser. It opens the same creation editor with the recognized parameters, component filenames, LoRAs and reference slots filled in. Import does not save a workflow or generate media. Click **Enregistrer le workflow** to keep the draft; it receives a new identity and cannot overwrite the source workflow.

Prefilling is independent of execution compatibility. Four source images, three LoRAs, an unsupported CFG or unknown custom nodes no longer prevent opening an import. Fields that cannot be mapped confidently, conflicting values and unnamed custom-node widgets remain available in the collapsible, read-only **Réglages source** section. The original JSON is kept in the draft. Unknown engine families are left unassigned rather than guessed. Known editor-widget layouts are decoded explicitly; the importer does not invent labels for arbitrary positional custom widgets.

Drafts persist in the user's `workflow/` folder, can be reopened/exported and remain excluded from LLM tools and job execution. Activation still validates the native engine contract and local assets; an unsupported source graph stays a draft. Source JSON and extra fields are loaded only when editing a draft, not embedded into every workflow list or LLM tool description. Source controls render on demand. Existing local component files are reused when matched unambiguously; unresolved filenames remain visible for selection with Browse. No weights are downloaded.

Shipped native JSON definitions live in `runner/workflows/` (replaced by updates; `runner/workflow-history.json` lists the fingerprints of their earlier versions). The user's own definitions and edits of shipped ones live in `workflow/` (`npm run ship-workflows` publishes them into `runner/workflows/`). Local asset paths and worker preferences live in `data/`. Originals and resolved-job manifests live in `output/`. These user files, model weights and caches are ignored by Git and preserved by updates. Deleting conversation history removes analysis copies and links, not original outputs.

After image generation, the LLM receives the result metadata, without automatic image pixels or a critique request. It normally finishes there. The `local_read_output` tool can inspect one saved compressed output when the user asks for a check or the model finds a specific reason relevant to the task. This is guidance, not a keyword filter or a prohibition. Inspected pixels are temporary for the current turn; gallery copies and originals remain available independently.

## Verified behavior

Measured on the development RTX 4070 Super, using existing local INT8 ConvRot checkpoints:

| Pipeline         | Case                                                                   | Pipeline time | Peak torch VRAM      |
| ---------------- | ---------------------------------------------------------------------- | ------------- | -------------------- |
| Krea2            | 512², 8 steps, three LoRAs                                             | 16.68 s       | 7.597 GiB            |
| Krea2            | 1448², 8 steps, three LoRAs                                            | 36.45 s       | 8.199 GiB            |
| LTX2.5 distilled | 384×256, 25 frames, 24 fps, 8 steps                                    | 65.99 s       | 6.634 GiB            |
| LTX2.5 distilled | Same size, start + end image conditions                                | 65.14 s       | 7.308 GiB            |
| LTX2.5 distilled | Two learned MSR image slots and LoRA, 384×256                          | 68.93 s       | 7.597 GiB            |
| LTX2.5 distilled | Silent continuation, 9 context + 16 new frames                         | 64.56 s       | 7.288 GiB            |
| LTX2.5 distilled | Video with 48 kHz stereo audio, 384×256                                | 68.14 s       | 6.634 GiB            |
| LTX2.5 distilled | Final profile, 768×512, 25 frames                                      | 108.22 s      | 6.779 GiB            |
| LTX2.5 distilled | 896×1600, 121 frames with audio, start image, two passes (10 Nov 2026) | 192 s         | under the 12 GB card |

Startup/imports, disk cache state and first kernel compilation affect total latency. These are local measurements, not guarantees or a video comparison against ComfyUI. All successful smoke runs acknowledged zero remaining torch GPU allocation after cleanup.

Krea2 supports text-to-image and one img2img reference. The converter accepts only the supported Krea API graph, backs up its bytes, preserves explicit prompt-expansion settings and never guesses how an unknown node works.

LTX2.5 supports text-to-video, start/end images, two learned MSR image slots, optional stereo audio, and silent continuation. It uses the 22B distilled transformer, Gemma4 Unified encoder with projections, diffusion video VAE, and audio VAE/vocoder. Start/end strengths default to 0.7 and image recompression to CRF 18. MSR additionally requires its compatible learned-slot LoRA; its strength and 25/33-frame guide window can be declared in JSON. Arbitrary video LoRAs are rejected until their layout is supported.

**Large videos run in two passes**, as the model's own recipe does, when the optional `upscaler` component (the ×2 latent spatial upscaler, e.g. `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`) is set and the shorter side is at least 512 px: eight steps at half the size, the latents doubled by the upscaler, then three steps at the full size (sigmas 0.909375, 0.725, 0.421875) with the start image held exactly. Measured on the 12 GB card at 896×1600, 121 frames: 48 s for the first pass (about 4 s per step after the model is read), 65 s for the three full-size steps, 60 s to decode. Without the upscaler the eight steps run at the full size: several times slower, and beyond what 12 GB holds at this size. The share of the model kept on the GPU is recomputed for the second pass, feed-forwards run in slices of 8192 tokens, and a pass that still runs out of memory is tried again with no weights kept, instead of starting the whole generation over.

The video is decoded in equal tiles (256 px, 64 frames, 32 px and 8 frames shared), which the decoder compiles once per shape. Wider tiles were measured to cost as much per pixel; wider overlaps only decode more.

Every stage of every generation (time, video memory, what failed) is appended to `data/generation-journal.jsonl` as it happens, so a generation that hangs, fails or is cancelled can be diagnosed; `data/runner-errors.log` keeps the tracebacks.

The distilled pipeline requires 8 steps, CFG=1, dimensions divisible by 32 and frame counts of 8n+1. The audio VAE is required by the coupled sampler even when audio is not exported. Every video needs its own approval, including its concrete draft/final stage, seed and dimensions. Draft/final profiles set explicit dimensions and duration. `reuse_output` promotes a draft from the current conversation while retaining its prompt, seed, component choices, references and LoRA settings. The final render is a new generation, not a guarantee of pixel-identical composition at another resolution.

`source_video` uses an active video resource or a previous native video `output_id`. The original is staged on disk; sampled preview frames never stand in for it. A bounded tail of 1/9/17/25/33 frames conditions the next window. Export appends only the newly generated frames, keeps a constant frame rate and never overwrites the source. Continuation currently requires a **silent source at the selected output resolution and fps**; incompatible audio, dimensions or cadence fail explicitly. The output metadata records its source and overlap. Successive separately approved continuations can form a sequence.

Select the supplied LongForge editor graph with **Importer un workflow** to prefill its known settings and component files. Its original graph, including additional scene settings, stays in the saved draft. Values outside the tested execution contract can be reviewed without running them. This imports settings; it does not implement arbitrary Comfy graph execution.

**Remaining LongForge differences:** continuous audio across scenes, automatic whole-film planning, interpolation/upscaling and optional enhancement are not implemented. The 896×1600 five-second preset runs on 12 GB with the two passes described above. Real smoke tests establish working execution, not quality/speed parity with every Comfy workflow.

## Checks

Node: `npm test`. Python from a normal environment: `python -s -m unittest discover -s runner/tests -v`.

For an embedded interpreter whose isolated path excludes the current directory:

```powershell
python -s -c "import sys,unittest;sys.path.insert(0,'.');r=unittest.TextTestRunner().run(unittest.defaultTestLoader.discover('runner/tests'));sys.exit(not r.wasSuccessful())"
```

Real GPU smoke artifacts stay local and are not distributed. Linux GPU inference has not been tested yet.
