# How the engine should manage memory: a study

A working note, kept aside: it is no part of the documentation of the engine, and the README says nothing of it. 17 November 2026. Written before changing anything, after a video that the card could hold failed for want of memory (LTX 2.5, 896 × 1600, 8 s, fixed in 0.6.74). It records what a proven engine does, what is published, where Moodix's engine stands, and the experiments that follow. Results are added below as they are measured.

Two requirements guide it:

1. **At least as fast as ComfyUI** on the same files.
2. **Never fail for want of memory when the job could have run by adapting**: slower is acceptable, failing is not. On every kind of machine, in time: a card of 8 GB, a Mac, a processor alone.

How far each part can be trusted:

- **ComfyUI** was read in the user's own installation (0.45.2). The key points were checked again in its code by the author of this page. ComfyUI is GPL-3.0: its mechanisms are described here in our own words, and nothing of its code is copied into Moodix.
- **The published state of the art** was gathered by a web search on the same day. Its sources are listed with their dates, but they have not all been read again: a claim here is a lead to verify, not a fact established by us. Most projects publish charts or claims rather than tables.
- **Moodix's engine** was read in this repository, and its journal (`data/generation-journal.jsonl`) on the development machine (RTX 4070 SUPER 12 GB, 32 GB of RAM, Windows 11).

## 1. What ComfyUI does

### It no longer guesses how many weights to keep on the card

The installation runs « Dynamic VRAM » (the library `comfy-aimdo`, GPL-3.0, enabled by default on NVIDIA and recent AMD cards since February 2026). No budget in bytes is chosen for the weights. Each model reserves a range of virtual addresses on the card; a weight is given physical memory when its layer is about to run, and loses it as soon as anything else needs the room, an ordinary allocation of the computation included. A weight that could not be placed is copied to a temporary buffer for the call and freed after it: slower, never an error. The computation always comes before the weights.

It watches the real occupation of the card, other programs included (NVML), and on Windows it reads the budget the system grants the card (WDDM), which is how it sees the spill into shared memory. PyTorch cannot see that spill: `torch.cuda.set_per_process_memory_fraction` only knows the card's own memory.

Before this mode, and still without it, ComfyUI estimated the memory of a sampling run with one constant per family of models (`memory_usage_factor`: 3.1 for Flux, 0.077 for LTX 2.x on its packed latent, 0.114 for MiniMax H3, 2.2 for Krea 2…), set by hand and several of them marked « TODO » in its own code. The share of the weights followed from that estimate.

### Other mechanisms worth knowing

- **Per-token timesteps are never kept per token.** For LTX 2.x, one embedding per frame, expanded to the tokens for the time of one operation; for MiniMax H3, one per different value. This is what Moodix lacked on 17 November.
- **Weights not on the card are sent ahead**: while a block computes, the weights of the next are copied on a second CUDA stream, from page-locked RAM (40 % of the RAM at most on Windows).
- **Layers are ranked by what streaming them costs** (their size, plus the cast, plus the computation of a LoRA): the costliest to stream stay on the card first.
- **A LoRA is applied once on the card** and written back in place while the weight stays there.
- **The video decoder splits itself**: after each stage, an activation larger than a limit that follows the card (32 MiB at 6 GB, 128 MiB at 24 GB) is cut along time and each piece goes through the remaining stages alone; finished frames are written straight to RAM.
- **VAE**: an estimate first; where the estimate is trusted and too large, tiles at once; else a try, then tiles on failure. For a video, the temporal tile is halved until it fits.
- **Windows**: 600 MB kept free on the card (400 MB elsewhere), « because of the shared vram issue ».

### What it does not solve

- **Running out of memory while sampling is a hard failure**: every model is unloaded and the prompt fails. There is no retry, and the default attention has no fallback.
- **Its estimates are hand-tuned constants**, blind to the length of the prompt, the number of LoRAs, the kind of attention.
- **The dynamic mode exists for NVIDIA and recent AMD only.** On a Mac (MPS), with DirectML or on a processor alone, none of it applies.
- The audio VAE of LTX is decoded in one piece; the Wan VAE keeps the whole decoded video on the card.

## 2. What is published

Two schools. **Estimate, then reserve** (Moodix today, InvokeAI, DiffSynth-Studio, ComfyUI before 2026): DiffSynth's own documentation admits its limit is exceeded « so inference can keep running ». **React or measure** (ComfyUI since 2026; Ollama, which measures the exact memory of a model before running it). The search found **no engine that learns its estimates from its own measurements**.

| Subject | What is proven or claimed | Source (date, license) |
| --- | --- | --- |
| Weights placed on use, temporary copy when they do not fit | The mechanism of section 1. One measurement by its author (Flux 2 with a LoRA: 39.6 s to 34.8 s), charts otherwise | [ComfyUI PR 11845](https://github.com/Comfy-Org/ComfyUI/pull/11845) (Feb 2026), [Comfy blog](https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local) (Mar 2026), [comfy-aimdo](https://github.com/Comfy-Org/comfy-aimdo); GPL-3.0 |
| Weights sent ahead on a side stream | 10 to 50 % faster sampling when a model does not fit (charts) | [Comfy blog](https://blog.comfy.org/p/new-comfyui-optimizations-for-nvidia) (Jan 2026) |
| Offloading by groups of layers, with prefetch | The best published table: LTX 36.7 s without offload, 38.5 s with 2.8 GiB on the card; Flux 16.8 s against 52.5 s. The cost depends on the model. Without a side stream, 40 to 100 % slower | [diffusers PR 10503](https://github.com/huggingface/diffusers/pull/10503) (Feb 2025), Apache-2.0 |
| Weights left on the disk | Flux: 47.7 s with 36.4 GB of RAM, 55.5 s with 2.8 GB | [diffusers PR 11682](https://github.com/huggingface/diffusers/pull/11682) (June 2025), Apache-2.0 |
| One state per layer: device, type and storage (card, RAM, disk) | A clean separation of the policy from the model | [DiffSynth-Studio](https://diffsynth-studio-doc.readthedocs.io/en/latest/Pipeline_Usage/VRAM_management.html), Apache-2.0 |
| Device × storage of the weights × execution by segments | CPU, Vulkan, Metal, CUDA; retries a decode with smaller tiles on a real failure | [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp), MIT |
| Measure instead of estimating | One more layer of a language model fits the card: 52 to 85 tokens a second | [Ollama](https://ollama.com/blog/new-model-scheduling) (Sep 2025) |
| Shared memory on Windows | The driver spills instead of failing; PyTorch cannot see nor cap it | [PyTorch forum](https://discuss.pytorch.org/t/torch-cuda-set-per-process-memory-fraction-doesn-t-see-shared-memory/223336) (Sep 2025) |
| Fragmentation of PyTorch's allocator | The order of the allocations can double what is reserved | [PyTorch devlog](https://docs.pytorch.org/devlogs/eager/2026-06-01-cuda-caching-allocator/) (June 2026) |
| Quantised formats | Flux on an H100: bf16 12 s, INT8 15 s, GGUF Q8 15 s, 4-bit integers 109 s; formats without their own kernels are slow | [Hugging Face](https://huggingface.co/blog/diffusers-quantization) (May 2025) |
| Kernels for quantised weights, with a registry of backends | INT8, FP8, NVFP4; falls back from CUDA to plain PyTorch. Already used by Moodix | [comfy-kitchen](https://github.com/Comfy-Org/comfy-kitchen), Apache-2.0 |
| 4-bit weights and activations with a low-rank branch | 3.5 times less memory than 4-bit floats; needs its own kernels and a calibration per model; no video model | [SVDQuant](https://arxiv.org/abs/2411.05007) (ICLR 2025), Apache-2.0 |
| Small approximate video VAEs | Wan 2.2: 50 ms a frame and 12.8 GB, against under 2 ms and 0.8 GB; lower quality. Weights exist for LTX 2.5 and MiniMax H3 | [TAEHV](https://github.com/madebyollin/taehv), MIT |
| Apple Silicon | PyTorch on MPS: no tensor over 2³² elements, no 8-bit floats. The engines that count are written for it (Draw Things, MLX) | [diffusers on MPS](https://huggingface.co/docs/diffusers/main/en/optimization/mps), [Draw Things](https://engineering.drawthings.ai/p/optimizing-qwen-image-for-edge-devices) (Sep 2025) |
| Caches of steps (TeaCache, MagCache…) | Faster at a cost in quality, and they use more memory: an option shown to the user, never a silent fallback | [diffusers](https://huggingface.co/docs/diffusers/main/en/optimization/cache) |

Not found: a credible measurement of a 14 to 30 billion parameter video model on a processor alone; an equivalent of « weights placed on use » for Apple Silicon. Licenses to keep away from: `mmgp` and Wan2GP forbid commercial use; Forge is AGPL.

## 3. Where Moodix's engine stands

Three layers are shared by every family:

- **RAM** (`models/residency.py`): each large file read once into page-locked RAM, kept between jobs within a budget that leaves the system a reserve.
- **Weights on the card** (`models/pool.py`): a share of a model stays on the card, the rest is sent ahead for each call, in the format of the file (INT8 through comfy-kitchen's kernels).
- **The card as a whole** (`engine.py`, `models/kept.py`): PyTorch kept under what is free less 1 GiB, and one model left on the card for the next generation of the Studio.

The fourth is not shared, and that is where the failure of 17 November was. **How much memory a computation takes, and what to do when it lacks**, is written apart in each pipeline:

| Family | Working memory | When it lacks |
| --- | --- | --- |
| LTX 2.5 | A formula of the number of tokens, measured at three sizes (up to 22 400 tokens) | Halves its share of the weights, then none, then fails |
| Wan 2.1 SCAIL-2 | Its own formula; shortens its segments | Reduces its share in a loop |
| MiniMax H3 | A fixed reserve, whatever the size | One retry |
| Krea 2 | A fixed reserve | Nothing |
| SeedVR2 | What is free less 4 GiB | Nothing |

The video that failed had 35 000 tokens: outside what the formula was measured on. Above all of them, `engine.generate` answers any shortage by running the whole job again without the ceiling, which on Windows spills into shared memory: two to three times slower, or « device not ready ».

What the journal of the last three days says (48 generations): LTX 2.5 went under 0.3 GiB of free memory in 5 jobs of 18 and failed twice; Krea 2 in 1 of 23, without failing; MiniMax H3 never under 2.4 GiB.

And the engine is written for NVIDIA cards: `cuda` appears in 24 of its files.

| A proven idea | ComfyUI | Moodix |
| --- | --- | --- |
| The weights give way to the computation | Automatically | A share set at the start, reduced only after a failure |
| Weights sent ahead | Two streams | Yes; to be measured against theirs |
| Timesteps kept once per group of tokens | Yes | Yes since 0.6.74 |
| A retry after a shortage while sampling | No | LTX 2.5 and SCAIL-2 only |
| The shared memory of Windows seen | Yes | No |
| Estimates fed by measurements | No | No; the measurements exist |
| A video decoder that splits itself | Yes | Fixed tiles |

## 4. The experiments

One change at a time, each proven by measurements that alternate the old and the new code (the machine drifts by about 10 % in an hour).

1. **A table of measurements**: for each generation, the working memory really used, by family, size and inputs.
2. **A sweep of the limits**: every size and length the interface offers, with and without input images. It fills the table and compares each formula with what is measured.
3. **The card under constraint**: memory taken away on purpose (a card of 8 GB, other programs open). The engine must slow down, never fail.
4. **Against ComfyUI** in its dynamic mode: same files, same seed, alternating the two engines, cold and warm.
5. **The changes**, where a measurement justifies them: one estimate for every family, read from the table; one ladder of fallbacks, and the end of the retry without a ceiling; a share of the weights that shrinks while sampling; the shared memory of Windows detected.
6. **Every kind of machine**, afterwards: the choice of the device taken out of the 24 files that write it. The published evidence for Macs and for a processor alone is thin: no result is promised there.

## 5. Results

### The sweep of the limits (17 November 2026, engine 0.6.76)

21 creations at the largest sizes and lengths the interface offers, each in a process of its own, outside the application, on the development machine (10.8 GiB of the card free at the start of each: other programs held 1.2). The pipeline was called under the ceiling of the engine, without the general retry « without the ceiling ». Recorded at every mark of the pipeline: the most memory allocated since the last, what was reserved, what was free.

| Case | Result | Time | Peak allocated | Weights kept on the card |
| --- | --- | --- | --- | --- |
| Krea 2, 1024 × 1024 | made | 32 s | 8.8 GiB | 7.3 GiB |
| Krea 2, 1536 × 1536 | made | 46 s | 8.8 | 6.7 |
| Krea 2, 1920 × 1088 | made | 39 s | 8.8 | 6.8 |
| Krea 2, 1536 × 1536, image to modify | made | 43 s | 8.8 | 6.7 |
| SeedVR2, 1024² to 2048² | made | 15 s | 7.8 | |
| SeedVR2, 1536² to 3072² | **out of memory** after 3 s, encoding the image (`seedvr2_vae.py`) | | 9.7 | |
| LTX 2.5, 896 × 1600, 5 s | made | 105 s | 8.6 | 5.3 |
| LTX 2.5, 896 × 1600, 10 s | made | 203 s | 9.0 | 3.3 |
| LTX 2.5, 896 × 1600, 10 s, start image | made | 218 s | 9.1 | 2.7 |
| LTX 2.5, 896 × 1600, 10 s, start and end images | made | 223 s | 9.1 | 2.7 |
| LTX 2.5, 1088 × 1920, 5 s, start image | made | 144 s | 8.8 | 3.7 |
| LTX 2.5, 1088 × 1920, 10 s, start image | **out of memory** after 452 s, decoding the video | | 9.6 | 0.7 |
| LTX 2.5, 1536 × 1536, 10 s | **out of memory** after 294 s, decoding the video (4.57 GiB asked at once) | | 8.5 | 0.5 |
| LTX 2.5, 896 × 1600, continuation of 5 s | made | 99 s | 8.8 | 4.8 |
| LTX 2.5, 768 × 448, 10 s (one pass) | made | 58 s | 9.1 | 6.6 |
| MiniMax H3, 768 × 448, 5 s | made | 77 s | 6.8 | 4.2 |
| MiniMax H3, 768 × 448, 14 s | made | 170 s | 8.5 | 2.4 |
| MiniMax H3, 1344 × 768, 5 s | made | 179 s | 8.7 | 2.2 |
| MiniMax H3, 1344 × 768, 14 s | **out of memory** after 27 s, in the attention, before the first step | | 9.5 | |
| MiniMax H3, 1920 × 1088, 5 s | **out of memory** after 87 s, in the attention, at the first step | | 9.7 | |
| MiniMax H3, 1344 × 768, 10 s, three references | **out of memory** after 31 s, in the attention, before the first step | | 8.7 | |

What it shows:

- **Six failures of 21, from three causes**, none of them in the weights:
  - **the video decoder of LTX 2.5** puts the whole decoded video together on the card. The sampling of a video of 63 000 and of 71 000 tokens went to its end, and the creation was lost after five to seven minutes;
  - **the attention of MiniMax H3** (the INT8 kernel over the whole sequence) has no fallback, and the room left for it is a fixed reserve that does not follow the size;
  - **the VAE of SeedVR2** encodes the image in one piece.
- **The share of the weights does follow the size**: for LTX 2.5 it goes from 6.6 GiB at 10 000 tokens to 0.5 at 71 000, and the peak stays between 8.2 and 8.9 GiB. Sampling never failed.
- **The formula of LTX 2.5 reserves more than is used**: at the peak of the refining pass, 0.7 to 2 GiB of what it set aside were not allocated. (The peak counts the weights passing through as well as the computation: the true need of the computation is lower still.)
- **The refining pass dominates a large video**: at 896 × 1600 for 10 s, 3.3 s for each of the eight steps at half size, 30 s for each of the three at full size; 60 s a step at 1088 × 1920, 70 s at 1536 × 1536.
- **The card's own memory was never full**: Windows counted 11.1 GiB of 12 at most. The ceiling keeps PyTorch out of the shared memory.
- **A counter that cannot be used as it is**: Windows' « shared usage » of the card rose by 12 to 14 GiB during every large job. It counts the page-locked RAM the engine keeps the files in, not a spill.

Not covered: SCAIL-2, the sounds, Real-ESRGAN, RIFE, the subject references of LTX 2.5, any card other than this one.
