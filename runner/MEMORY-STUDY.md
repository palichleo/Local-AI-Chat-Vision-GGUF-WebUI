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

### After the corrections of 0.6.77 (17 November 2026)

One answer to a shortage for every family (`models/ladder.py`): the same work tried in ways that hold less and less, or cut in pieces halved where one does not fit. The decoders of LTX 2.5 and of MiniMax H3 give their frames off the card a stretch at a time instead of joining the whole video there. Same cases and seeds as the sweep:

| Case | Before | After |
| --- | --- | --- |
| LTX 2.5, 1088 × 1920, 10 s, start image | out of memory after 452 s | made in 341 s |
| LTX 2.5, 1536 × 1536, 10 s | out of memory after 294 s | made in 387 s |
| SeedVR2, 1536² to 3072² | out of memory after 3 s | made in 35 s |
| MiniMax H3, 1920 × 1088, 5 s | out of memory after 87 s | refused in 4 s: 11.2 GiB asked free, 10.8 free |
| MiniMax H3, 1344 × 768, 10 s, three references | out of memory after 31 s | refused in 4 s: 10.9 GiB asked, 10.8 free |
| MiniMax H3, 1344 × 768, 14 s | out of memory after 27 s | refused in 6 s: 14.3 GiB asked (the card has 12) |
| LTX 2.5, 896 × 1600, 5 s (control) | 105 s | 105 s, the same 121 frames |
| MiniMax H3, 1344 × 768, 5 s (control) | 179 s | 175 s, the same 124 frames |
| MiniMax H3, 768 × 448, 5 s (control) | 77 s | 76 s, the same 124 frames |
| MiniMax H3, 768 × 448, 14 s (control) | 170 s, peak 8.5 GiB | 165 s, peak 7.5 GiB |
| LTX 2.5, 896 × 1600, 10 s, start image (control) | 218 s | 202 s; larger tiles, hence another grain (38 dB) |

What it shows:

- **No creation is lost on the way any more**: it is made, or refused at once with what to reduce.
- **The decoders by stretches of frames give the very frames of the library's** (tests: to the bit; controls: every frame identical).
- **MiniMax H3 has a limit on this card that the fallbacks do not lift**: its steps hold 1.2 GiB plus 0.112 for each thousand tokens with none of its weights on the card (measured at 12 900, 34 800, 37 800 and 76 000 tokens), about 72 000 tokens on a 12 GiB card with 1.2 GiB taken by other programs. At 1920 × 1088 the sampling went to its end one time of two. Its blocks hold six widths of 7 168 channels of the sequence at once: lowering that is a work of its own.
- **What a refusal costs**: it is said from what is free when the generation starts. With the other programs closed (11.6 GiB free) the two cases at the limit would be tried.

### The card under constraint (17 November 2026, engine 0.6.78)

Another process holds 4 GiB of the card for the whole run and writes in them, as a game, a browser or another generation program would: 7.1 GiB are free, a card of 8 GiB.

**What the first run found.** On Windows, PyTorch (`torch.cuda.mem_get_info`) says what this process may still take of its own budget, the card less a fixed share, whatever the other programs hold: 10.8 GiB free of 12 with 0.25 GiB taken elsewhere, with 1.2, and with 4. The engine sized the share of the weights on that figure. It filled the card all the same, the driver put the overflow in the shared memory, and an image of Krea 2 took **474 s instead of 30**, without an error. The driver's own count (NVML) includes every program: `hardware.free_bytes` now takes the least of the two, and every pipeline asks there. The same image: **26 s**.

| Creation | Whole card (10.8 GiB free) | 7.1 GiB free |
| --- | --- | --- |
| Krea 2, 1024 × 1024 | 32 s | 27 s |
| Krea 2, 1536 × 1536 | 46 s | 40 s |
| SeedVR2, 1024² to 2048² | 15 s | 18 s |
| LTX 2.5, 288 × 512, 5 s | not measured | 42 s |
| LTX 2.5, 896 × 1600, 5 s | 105 s | 93 s |
| LTX 2.5, 768 × 448, 10 s | 58 s | 58 s |
| LTX 2.5, 896 × 1600, 10 s, start image | 202 s | 198 s |
| MiniMax H3, 768 × 448, 5 s | 76 s | 74 s |
| MiniMax H3, 768 × 448, 14 s | 165 s | 165 s |
| MiniMax H3, 1344 × 768, 5 s | 175 s | 178 s |

What it shows:

- **With a third less memory the engine does not slow down.** It keeps fewer weights on the card (3.7 GiB of Krea 2 instead of 7.3, none of MiniMax H3) and passes the others through at each step: sending weights ahead costs almost nothing here. This is the measured ground for letting the weights give way to the computation.
- **Two more corrections came from this run**: the attention of LTX 2.5 in pieces of its queries when it does not fit whole (the refining pass of 10 s failed there), and the refusal of MiniMax H3 from what was measured in place of an estimate that asked 7.8 GiB for a video that holds 5.1.
- **The spill into the shared memory is slow without failing**: 57 s a step instead of 0.8. Nothing in PyTorch says it. The driver's count is what tells it before it happens.

Not covered: a real card of 8 GiB (the pinned RAM and the driver may differ), less than 7 GiB free, a memory taken while a generation runs.

### Against ComfyUI (17 and 18 November 2026, engine 0.6.78 then 0.6.79)

ComfyUI 0.45.2 with its own environment (PyTorch 2.12.1, comfy-aimdo 0.6.0, « Dynamic VRAM » enabled), started alone on the same machine; our engine through `runner.bench`, the model left on the card between two creations as the Studio does. Each engine is given the same job (same files, sizes, seeds, prompts), ComfyUI through the graph the application sends it. Four creations in a row for each case: the first after the engine gave everything back (files already read once), two with a new prompt, one with the same prompt and another seed. The other engine is stopped meanwhile. Our prompts encoded earlier are kept on the disk: every case started from an empty folder, or the comparison flattered us.

How steady it is: two series of ComfyUI agree within 0.5 s, three of ours within 1 s once warm.

| Creation | Cold: ours / ComfyUI | New prompt (third in a row) | Same prompt |
| --- | --- | --- | --- |
| Krea 2, 1024 × 1024 | 21.7 / 12.5 s | 9.8 / 8.7 s | 8.8 / 8.1 s |
| Krea 2, 1536 × 1536 | 35.5 / 22.7 s | 23.4 / 22.2 s | 22.5 / 21.6 s |
| LTX 2.5, 288 × 512, 5 s | 35.7 / 26.0 s | 19.1 / 18.1 s | 8.1 / 10.5 s |
| LTX 2.5, 896 × 1600, 5 s | 95.6 / 92.4 s | 84.1 / 85.1 s | 72.2 / 78.4 s |
| MiniMax H3, 768 × 448, 5 s | 72.3 / 52.8 s | 59.2 / 49.2 s | 49.5 / 43.8 s |
| MiniMax H3, 1344 × 768, 5 s | 174.0 / 148.4 s | 159.1 / 146.7 s | 150.9 / 141.7 s |

(Engine 0.6.79. With 0.6.78: Krea 2 cold 27.5 and 39.8 s, LTX 2.5 draft with a new prompt 23.3 to 24.1 s.)

At the sizes where the sweep had found our failures, one creation each (ours: 0.6.77 and 0.6.78, a new process for each; ComfyUI: its models given back before each):

| Creation | Ours | ComfyUI |
| --- | --- | --- |
| Krea 2, 1920 × 1088 | 39 s | 21 s |
| LTX 2.5, 768 × 448, 10 s | 58 s | 56 s |
| MiniMax H3, 768 × 448, 14 s | 165 s | 140 s |
| LTX 2.5, 896 × 1600, 10 s | 203 s | 198 s |
| LTX 2.5, 1536 × 1536, 10 s | 387 s | 389 s |
| LTX 2.5, 1088 × 1920, 5 s, start image | 144 s | 260 s |
| LTX 2.5, 896 × 1600, 10 s, start image | 202 s | 508 s |
| LTX 2.5, 1088 × 1920, 10 s, start image | 341 s | 1 309 s |
| MiniMax H3, 1344 × 768, 14 s | refused in 6 s | not finished after 25 minutes |

(MiniMax H3 at 1920 × 1088 was queued behind that last one and never started: not measured on ComfyUI.)

What it shows:

- **The steps themselves are level.** MiniMax H3: 31.3 s of steps for a draft against 31.6, 105.7 against 105.8 at 1344 × 768. Krea 2: 0.84 s a step against 0.81, 2.43 against 2.26 at 1536². LTX 2.5: ahead. Sending the weights ahead from page-locked RAM is worth ComfyUI's weights faulted onto the card; with almost none of MiniMax H3 on the card (0.5 GiB instead of 4.2) a step takes 3.8 s instead of 3.7.
- **What we lose is around the steps**, and it is counted:
  - *cold*, 5 s of libraries imported at the first creation of a session (diffusers, transformers: ComfyUI imports its own when it starts), then every file read into page-locked RAM before anything runs (9.4 s for the 12.6 GiB of Krea 2, 4.2 s since 0.6.79), where ComfyUI maps the file and starts;
  - *a new prompt on LTX 2.5* made the share of the model leave the card whole and come back from the disk (4.5 s): since 0.6.79 it lends what the encoder lacks (0.9 GiB) — see the commit;
  - *MiniMax H3, every creation*: the video decoder (4.6 GiB) is loaded again (3.6 to 4.7 s), the audio VAE (1 s), and the share of the model (2 s), where ComfyUI leaves all three on the card (9.9 GiB held between two creations). Reading the decoder's file ahead during the last step changes nothing (tried, removed): with 17 to 19 GiB of the model page-locked on a 32 GiB machine the copy itself is slow, the processor's own memory work takes four times longer than alone. The answer is the model's share and the decoders left on the card when the video leaves them room, as LTX 2.5 does: not done.
- **At the limits ComfyUI does not fail, it slows down beyond use**: with a start image the large LTX 2.5 videos take two to four times longer than ours (the tiles and the grouped timesteps of 0.6.74 and 0.6.77), and a MiniMax H3 video too large for the card was still running after 25 minutes where we say so in 6 s. Without a start image the two engines are within 3 %.
- **Method**: the first video of a run empties the card before its decode (a choice of 0.5.51, kept), so a new prompt only benefits from the lent share from the third video on; a cold run of ours in a new process pays the imports, which a worker pays once.

Not covered: the application's own path (the chat model coming and going between two creations), SCAIL-2, sounds, upscaling; ComfyUI on the card under constraint; a second machine.

### MiniMax H3 after 0.6.80 (18 November 2026)

The model is left on the card between two videos, as LTX 2.5's: its file open, its layers built, its share of the card kept through the decode (which runs beside it), taken back for the same files, the same shape of video and the same attention. Measured by alternating the code of 0.6.79 and of 0.6.80 on the same machine, in use that day (a browser, 0.6 GiB of the card held elsewhere), then against ComfyUI the same day; later videos of a run, same prompt:

| Video | 0.6.79 | 0.6.80 | ComfyUI |
| --- | --- | --- | --- |
| 768 × 448, 5 s | 53.0 s | 49.9 s | 47.0 s |
| 1344 × 768, 5 s | 161.0 s | 155.6 s | 146.0 s |

With a new prompt each time: 58.2 s against 52.5 at 768 × 448, 165.6 against 150.7 at 1344 × 768.

What was tried for the rest of the gap, and what it showed:

- **A model taken back must not ask for its page-locked RAM again.** Asked again, the weights to copy were named from the share as the steps had left it, a few layers more than first foreseen; at 1344 × 768, where RAM locks a part of them only, 19 GiB were read anew beside the rest and the next videos took ten minutes instead of two and a half. Found by the alternation at that size, fixed before the commit: a size not measured would have shipped it.
- **The decoders read into RAM for the next video make everything slower on 32 GiB**: 53.4 s a draft instead of 46.2, the steps at 4.1 s instead of 3.7. With 17 to 19 GiB of the model page-locked, 5 GiB more leave the system nothing. The decoder's file read ahead through the system's cache changes nothing either (0.6.79).
- **A larger share of the model at draft size changes nothing measurable** (5.5 GiB instead of 4.2: 47.2 to 48.9 s against 46.7 to 49.9).
- **The decoders left on the card, ComfyUI's arrangement, would gain little here**: with 5.2 GiB of the card taken the model keeps no share, a step takes 4.0 to 4.1 s instead of 3.75 to 3.9 (2 to 3.5 s a video) for 5.7 s of loading saved, nothing at 1344 × 768 where they do not fit beside the steps, and 20 GiB of RAM locked. Not done.

What separates the two engines now, at every video: the video decoder loaded again (4.6 GiB: 3.6 to 7.3 s), the audio VAE (1 s), and a new prompt (8 to 12 s for us, 5 for ComfyUI: the 15.7 GiB conditioner read from the disk). One cause under the three: the RAM held by the model's page-locked weights on a 32 GiB machine. ComfyUI locks 13 GiB at most and reads the rest through the system's cache; its steps are 6 % slower than ours and everything around them faster. On a machine of 64 GiB the question would not arise the same way: not measured.

### The first creation of a session (19 November 2026, engine 0.6.105)

What a worker that has just started pays before its first picture, Krea 2 at 1024 × 1024 in 8 steps, its files in the system's cache, driven through the worker's own protocol (one process per measure):

| Stage | Seconds |
| --- | --- |
| libraries imported (PyTorch 1.5 s, then diffusers and transformers) | 6.9 |
| the job checked | 0.25 |
| text encoder read and loaded (1.8 s), prompt encoded (0.4 s), VAE loaded (0.3 s) | 2.45 |
| the model read into page-locked RAM (12.6 GiB), its layers built | 4.1 |
| its share copied to the card | 0.9 |
| eight steps (the first 1.8 s, the others 0.82 s each) | 7.55 |
| decode | 1.0 |
| **in all** | **23.2** |

The libraries alone, by family, in a process that does nothing else: 5.8 s for Krea 2, 6.6 s for LTX 2.5, 3.2 s for MiniMax H3, 6.2 s for all of them together; 0.70 GiB of RAM once imported, nothing on the card. The first time of an evening, their files not yet in the system's cache: 18.6 s (one measure).

**Importing them as the worker starts** (`runner/warm.py`, a setting of the application, on unless the user turns it off). The same first picture, three rounds or more, alternated:

| The picture is asked for | Seconds | |
| --- | --- | --- |
| no import ahead | 23.0 to 23.4 | 6 measures |
| once the import has ended (20 s after the start) | 16.0 to 16.6 | 6 measures |
| 3 s after the start | 19.6 to 20.3 | 10 measures, and one at 30.5 |
| at once | 22.9 to 23.2 | 3 measures |

- **6.9 s gained on the first picture of a session, nothing lost when it is asked for at once.** The idle worker holds 0.70 GiB instead of 0.03, and no memory of the card.
- **On Windows the import stood still until a request came.** A library that opens looks at the standard handles of the process, and that look waits for a read in progress on a pipe: with the worker waiting for its request by reading its input, numpy was imported 12.06 s after the start (when the line arrived) instead of 0.12 s, and the first picture gained nothing (23.1 and 23.3 s). The worker now asks the pipe whether something is there, and reads only then, for as long as it imports.
- **One thread imports at a time.** A request that needs the libraries takes over once the module being imported is imported (0.3 s lost at most, measured at 0 s) and imports the rest itself; the background goes on after it. Waiting for the whole list instead made a picture asked for at once wait for what the other families import.
- **A module being imported is in `sys.modules` half made**: the worker closing during the import failed on `torch.cuda` (seen once, before the correction). What looks at PyTorch without importing it now asks whether it is entirely imported.
- **One measure in ten at 3 s took 30.5 s**: 10 s more before the first stage, the import already late when the request came (0.41 GiB held at 3 s instead of 0.54). Not seen again in eight more with a stack recorded at 9.5 s; the machine doing something else is the likeliest, and nothing shows the contrary.

Not measured: LTX 2.5 (its imports are of the same size, its first creation much longer); a disk slower than this one.

#### In the application itself (19 November 2026, engine 0.6.106)

A copy of the application (its own data folder and Python environment, the user's settings without the keys, no chat model), the same picture asked for from the Studio as the first creation after each start, the setting off then on, twice:

| First picture of a session | In all | Before the engine | The engine |
| --- | --- | --- | --- |
| nothing imported ahead | 22.0 s and 21.1 s | 4.8 s and 5.1 s | 17.1 s and 16.1 s |
| libraries imported as the worker starts | 16.1 s and 16.3 s | 0.2 s and 0.2 s | 15.9 s and 16.1 s |

- **5.3 s gained (25 %), all of it before the engine**: the application asks the worker to check the job first (`preflight`), and it is that check which imports the libraries, not the creation that follows. The worker has them 12 s after the application starts (0.70 GiB held, the card untouched).
- **The list was kept from the creation alone, and held 128 modules of the 3042** (0.6.105): importing them brought nearly everything with them, by chance. What the check imports is kept too since 0.6.106.
- **Other families beside it**: a MiniMax H3 video made in the same session (66.8 s, its own libraries not yet known), then, after a restart with both families imported ahead (0.70 GiB again), a Krea 2 picture (17.2 s) and a MiniMax H3 video (58.4 s). Nothing failed, nothing was written to the worker's error log.
- **The first time of an evening is not the 18.6 s above**: at every start the application checks its Python environment by importing the same libraries in a process of its own, before the worker starts. Their files are in the system's cache by then, and the worker imports them in about 5 s whatever came before. (That check and the worker's import now do the same work twice at each start, one after the other: about 5 s of one core, not looked into.)
- **In the copy the very first creation took 25.0 s, its first step 4.4 s**: the application keeps Python's compiled code under a folder named after the path of the sources, and a copy starts without it. Not a cost of a session.

#### What was tried for the rest, and why nothing of it was kept

With the libraries imported, the first picture takes 15.2 to 16.4 s, the third of the same worker with a new prompt 11.1 to 11.3 s: what is left of a cold start is the model read into page-locked RAM (3.2 to 4.1 s). Each of these was tried from outside, the engine's code untouched (a file run in the worker before it starts), alternated with the engine as it is:

| What | First picture | Kept |
| --- | --- | --- |
| the engine as it is | 14.9 to 16.4 s | |
| the model's files out of the system's cache (read from the disk) | 15.4 and 15.5 s | nothing to do |
| the text encoder read through its mapping, never copied into RAM | 18.0 and 18.3 s | no |
| the model read into RAM by a thread while the text encoder works | 16.3 and 16.4 s | no |

- **The disk is not what a cold start waits for, on this one.** A Samsung 980 PRO gives 3.2 GiB/s to one reader, the system's cache 7; four readers fill the 12.6 GiB arena as fast from one as from the other (2.0 to 3.2 s), bound by the pages of the new buffer. Reading the files ahead (at the start of the application, or when a creation is announced) would gain nothing here; on a slower disk it would, and that was not measured.
- **Reading the model while the text encoder works loses 0.5 to 1 s.** Both want the same memory: the encoder's load went from 1.5 to 5.6 s beside the four readers, and it cannot keep its own copy in RAM meanwhile on 32 GiB (2.4 GiB would be left available, under the 4 kept for the system), so it is read through its mapping.
- **The text encoder copied into RAM is worth its 0.8 s even when it cannot stay**: read through its mapping it takes 3.3 to 3.5 s instead of 1.4 to 1.7. This is also what the second picture of a session pays (text encoder 3.4 s: its copy left for the model, its file gone from the system's cache); the third finds the file in the cache again (1.7 s).
- **Locking the pages costs nothing after the read, 1.5 s before it**: `cudaHostRegister` on 12.6 GiB takes 0.04 s once the buffer is filled, 1.5 s on an untouched one (the read is then no faster: 2.1 to 2.3 s). The order of `Residency.arena` is the right one. Eight readers instead of four: 2.1 to 2.3 s against 2.0 to 2.8, no gain.
- **The first step of a worker takes 1.4 to 1.7 s, the first of a later picture 1.1 s (2.3 s once), the others 0.83 s; the first decode 1.0 s, the later ones 0.75 to 0.85 s.** About 0.6 s of things done once in a process, not looked into further.

Not tried: the application's own path (the chat model leaving the card before a creation and coming back after it), where the arena of the model may have to leave RAM between two creations.

### The 8-bit formats of a model: INT8 ConvRot, « fp8 scaled », GGUF (19 November 2026, engine 0.6.107)

The question: on an RTX 40 card, was INT8 the right file to take, against an « fp8 scaled » one or a GGUF one? LTX 2.5, 121 frames, 8 steps (11 at 1344 × 768, in two passes), the published INT8 ConvRot file and an « fp8 scaled » file of a close derivative of the same model (its layers correlate at 0.99 with the published ones), alternated, two videos a process:

| | INT8 ConvRot | fp8 scaled | the fp8 file converted to INT8 ConvRot |
| --- | --- | --- | --- |
| a step, 768 × 448 | 1.25 s | 2.74 s | 1.25 s |
| a video, 768 × 448, model kept | 20.5 s | 32.4 s | 20.5 s |
| the first video of a process | 43.8 and 44.5 s | 55.5 and 55.6 s | 44.6 s |
| a step, 1344 × 768 | 0.92 s | 2.17 s | |
| a video, 1344 × 768, model kept | 50.0 s | 71.6 s | |
| video memory at the most | 8.6 GiB | 8.9 GiB | 8.6 GiB |

- **The engine did not read the « fp8 scaled » file at all** (« Unsupported LTX2.5 connectors tensor »): it names its tensors without ComfyUI's prefix. Read since 0.6.107; nothing else in the engine assumed the prefix.
- **It is the product that differs, not the conversion.** One layer on the card, 5376 rows: 0.80 ms from INT8 weights through comfy-kitchen's kernel (a product of 8-bit integers, the rows quantised on the way), 2.5 ms for the same layer as 16-bit floats, whatever they were stored as; turning 8-bit floats back into 16-bit ones takes 0.09 ms of it. A feed-forward of 16384 × 4096: 2.7 ms against 10 ms. No file that computes in floats can catch up on this card: « fp8 scaled », GGUF and plain weights all end in the same product.
- **INT8 ConvRot is also the more faithful of the two.** 25 layers of the published file turned back into floats, rounded again in each format, the layer's output against the exact one: 2.7 % for « fp8 scaled » (three bits of mantissa), 1.3 % for INT8 ConvRot (weights and rows both rounded), 1.7 % for INT8 without the rotation, 0.7 % for GGUF Q8_0 (a scale every 32 weights, and a float product), 0.3 % for 16-bit floats.
- **Any 8-bit file can be written again as INT8 ConvRot** (`python -m runner.convert`): each quantised matrix turned back into floats, rotated, rounded with one scale a row. The 20 GiB « fp8 scaled » file in 40 s; it then runs as the published INT8 file does (1.25 s a step). Its video against the source's, same seed: the same scene and the same motion, details apart (PSNR 26.7 and 28.2 dB; two runs of the source are identical to the bit). The rotation is ConvRot's regular Hadamard matrix; with another Hadamard matrix the kernel's product is noise.
- **GGUF**: read for the conversion only (F32, F16, BF16, Q8_0, Q4_0, Q4_1, Q5_0, Q5_1, Q4_K, Q5_K, Q6_K), checked to the last bit against gguf-py on two published files (a Q8_0 one, a Q3_K_M one whose Q4_K, Q5_K and Q6_K tensors were compared). Q2_K, Q3_K and the IQ types are refused by name.

Not measured: a GGUF file of LTX 2.5 itself (none on this disk, and none was downloaded); what ComfyUI makes of the same « fp8 scaled » file; another card (the ratio of the two products is the card's); fidelity on the model's own activations rather than on random rows; a non-distilled LTX 2.5 (the family runs 8 steps without guidance only).

### MiniMax H3's own checkpoints, in 20 steps (19 November 2026, engine 0.6.108)

MiniMax publishes its model in two files, FL2VA (a text, start and end images) and Ref2VA (reference images); they are guidance-distilled (one pass a step, no negative prompt) and not step-distilled: 20 steps where FastH3 takes 8. Their layers are those of FastH3 v2 without the gates of its sparse attention, one output head: the engine built them already, and sampled them in 8 steps whatever they were. A checkpoint now says its steps by what distillation left in it (several output heads, or those gates), a workflow that asks for the other count is refused with the reason, and a workflow may name a second file for the jobs that have reference images.

768 × 448, 124 frames, INT8 ConvRot files, dense attention, the first video of a process:

| Checkpoint | Steps | A step | The video |
| --- | --- | --- | --- |
| FastH3 Omni | 8 | 3.9 s | 71 s |
| FL2VA, from a text | 20 | 3.9 s | 118 s |
| Ref2VA, one reference image | 20 | 4.8 s | 138 s |

- **A step costs the same; there are two and a half times as many.** 8.4 to 8.5 GiB of the card at the most, as FastH3.
- **Both videos are sound** (a fox in a pine forest; the fox of a picture folding its newspaper and looking up): nothing in them points at the INT8 files. No file of these checkpoints in another precision is on this disk to compare with.
- **The Ref2VA file on this disk ends with 73 bytes that are not its own** (a line of text added after its last tensor by whatever downloaded it). safetensors itself refuses such a file, and so does the engine; the measure above was made on a copy without them.

Not measured: these checkpoints with FastH3's sparse attention (they were not trained with it), a larger size, a continuation.

### The interface while the card works (19 November 2026, 0.6.109)

Not the engine, but what its work could take from the page: the same card draws the interface. Measured in a real browser window of 1440 × 900 on the 180 Hz screen of the development machine (`npm run check:fluidity` for the steps of the interface check; a script of the same kind beside a copy of the application for the generations), the wait between two frames read from the page itself:

| | Frames a second | Longest wait between two frames |
| --- | --- | --- |
| at rest, any page | 184 to 186 | 6 to 9 ms |
| the 60 steps of the interface check | 184 (median) | 6 ms (median); over 100 ms in 5 steps, the first time only |
| while a Krea 2 picture is made | 176 to 186 | 6 to 33 ms, 77 ms once as it starts |
| while a MiniMax H3 video is made (68 s) | 181 (median), 168 at the least | 9 ms (median), 54 ms once as the video arrives |

- **The page's own work is small**: one task over 50 ms in the 60 steps (87 ms, the check's own script), 212 ms of script, style and layout in 49 s.
- **The only waits a user could feel are the first appearance of a blurred surface** (the settings: 144 to 249 ms; the Agent's panel: 121 ms): the graphics driver compiles the blur, and the browser keeps it. With the same browser profile at the next launches: 11 and 17 ms. A new profile pays it once.
- **Changing page, opening a menu or leaving the Studio while a video is made**: 6 to 44 ms.

Not measured: a card smaller or slower than this one, a 60 Hz screen (the numbers above are bound by 180 Hz), the chat while a model writes, LTX 2.5 and the upscalers.

### The check of the libraries at every start (19 November 2026, 0.6.110)

Every start of the engine made sure of its environment in three steps: `uv python install` (0.04 s), `uv sync --locked` (0.03 s: « Resolved 72 packages », « Checked 52 packages »), then a process of its own importing every library the families ask for, with the classes of LTX 2.5: 6.7 s. The engine started after it, and imported its own again. Passed once, that third step is now skipped while nothing changed: the same lock and the same Python, uv saying those two lines and no other, and an engine that imports its libraries as it starts (the setting of 0.6.105, on unless turned off; off, the check stays what reads them before the first creation).

Measured with the application's own classes (`PythonEnvironment`, `GenerationWorker`) on a copy of the development machine's environment, in seconds from the start, alternated, after one start left out (a copy has no compiled Python for its path):

| | Environment made sure of | Engine answering | PyTorch imported in the engine |
| --- | --- | --- | --- |
| check made, as every start before (3 starts) | 6.7 to 7.1 | 6.8 to 7.3 | 8.6 to 9.0 |
| check skipped (3 starts) | 0.08 | 0.22 to 0.23 | 1.9 to 2.1 |

- **The check alone on the machine's own environment, only read: 6.7 and 6.9 s** (8.8 s the first time), as on the copy (6.6 to 7.0 s).
- **A first series gave 12 s for the check, and is left out**: the terminal it was run from tells Python not to keep its compiled code (`PYTHONDONTWRITEBYTECODE`), which the application's environment inherits; every import was compiled again. The application itself is not started from such a terminal.
- **What is left of the check.** uv still makes sure, at every start, that every locked package is installed. What it does not see, a file of a library damaged or removed where it stands, is said by the engine: a library every family computes with that it cannot import as it starts, or a request stopped by a library that would not import (a module gone, or one whose own lines fail: a DLL PyTorch cannot load). The application then withdraws the mark of the check, stops the engine and starts it again; that start makes the check, and says what it finds as a failed start always did.
- **Tried with the application's own service on the copy, a DLL of PyTorch (`c10.dll`) taken away**: the engine answers at 0.4 s, says at 0.6 s that it cannot import PyTorch, and at 1.0 s the service says « unavailable » with the check's own words (« … loading c10_cuda.dll or one of its dependencies »). The DLL put back, the next start makes the whole check again (it passes), and the one after skips it.
- **Each line of the change undone in turn makes a test fail**: 23 changes of one line (the check never skipped, skipped whatever uv says or whatever the lock is, a failed check leaving the mark, the engine not heard, every failure taken for the libraries, a start still on its way not waited for…).

Not measured: just after the computer started (the libraries then come from the disk: the check was what read them first, the engine now does, in the background); a start of the whole application, where the chat model loads at the same time; a first creation asked within the first seconds of a start.
