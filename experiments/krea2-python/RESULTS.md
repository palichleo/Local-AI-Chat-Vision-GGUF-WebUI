# Local test results

Hardware: RTX 4070 SUPER (12 GB), 32 GB system RAM, Windows. Existing local checkpoints and Python packages only; no downloads or installations.

The original workflow was copied unchanged (SHA-256 `c10bddbf13428cf291d6793a24a760184d7a7820897c2601428ceee52c74ff3a`). Text-to-image used its seed **261956854443987**, **8 Euler/simple steps**, **CFG=1**, enabled prompt refinement and all three LoRAs with the graph's strengths. Generated images were opened and visually checked, rather than accepting process exit as proof of success.

| Test | Generation time¹ | Peak PyTorch allocated VRAM | Result |
| --- | ---: | ---: | --- |
| Text-to-image, 512 × 512, before transfer optimization | 68.94 s | 7.709 GiB | Coherent scene |
| Text-to-image, original 1448 × 1448, final transfer path | 70.41 s | 7.710 GiB | Coherent scene, original dimensions |
| Image-to-image, 512 × 512, denoise 0.4, refinement disabled | 27.99 s | 7.597 GiB | Coherent variation of the supplied image |

¹ From the start of model loading through decoding; initial Python/package imports are excluded. For the final 1448 × 1448 run, an external monitor measured **81.34 s total process wall time**, **15.107 GiB peak process working set**, and **77.00 CPU-seconds**. Checkpoint memory maps contribute to the working set; it is not a measurement of private heap memory. GPU allocation excludes the driver and other applications.

The first unoptimized native-resolution run took 109.21 s total / 98.80 s after imports, with 1,207.16 CPU-seconds. Moving quantized bytes to CUDA **before** converting to BF16 cut unnecessary CPU conversion and transfer work. These are single local measurements with warm filesystem caches, not a controlled multi-run benchmark.

The INT8 checkpoint's ConvRot flag is essential: plain integer-times-scale dequantization without the matching input rotation produced noise. The corrected implementation rotates the base-model input and keeps LoRA inputs in the original basis. An independent algebra check verifies this relationship.

All completed native runs reported `comfy_imported: false` (the final script checks both `comfy` and `comfy_kitchen`). The standalone script makes no ComfyUI server requests. It exits after saving the PNG and metadata; all experiment processes finished, and GPU usage returned to approximately the pre-test baseline. The existing user-owned ComfyUI process was left running.

Five offline checks passed: original graph plan, image/no-refinement branch, disabled workflow refiner, unsupported-node rejection and ConvRot/LoRA algebra. The workflow, script and documentation are tracked; local paths, checkpoints and generated outputs are not published.

Limits: no pixel-equivalence claim, no Linux or other-GPU execution test, no integration into Atelier's chat, no video generation. Image-to-image was tested with a generated reference and an explicit `--image` path. This establishes that the supplied image pipeline can run without ComfyUI; it does not establish equal speed or quality across arbitrary workflows.

## Speed comparison against the existing ComfyUI installation

Both backends used the same local checkpoints, three LoRA strengths, 1448 × 1448 resolution, eight Euler/simple steps and CFG=1. For the paired runs, the **exact same already-expanded prompt** was supplied to both. Seeds were 261956854443987 and 261956854443988. The third Comfy run used seed +1000 to force actual sampling while retaining cached conditioning; it did not reuse a finished image.

| Run | Request / process wall time | Native model-loading-through-decoding time |
| --- | ---: | ---: |
| Comfy, GPU models unloaded, seed 1 | 27.727 s | — |
| Comfy, GPU models unloaded, seed 2 | 27.870 s | — |
| Comfy, cached nodes and conditioning, new seed | 24.215 s | — |
| Standalone Python, new process, seed 1 | 82.361 s | 70.240 s |
| Standalone Python, new process, seed 2 | 77.145 s | 65.970 s |

Mean time for the paired runs: **27.799 s Comfy versus 79.753 s standalone Python**, a factor of **2.87**. Excluding the native process's startup/import overhead, its measured generation interval averaged 68.105 s, or **2.45 times** the Comfy request time. The latter still includes Comfy's request handling and PNG saving, so it is not a kernel-only comparison. Native peak process working set was 14.842–14.843 GiB; CPU use was 72.672–77.453 CPU-seconds.

A separate Comfy run with the workflow's **prompt expansion enabled** took **30.854 s**, with no cached nodes. The earlier complete native run with expansion took 81.340 s including process startup. This is one complete-workflow measurement per backend, taken at different times; the paired measurements above provide the stronger comparison.

Method: a temporary local harness read model names and strengths from the existing plan, resolved the selected graph branches into the core loader/LoRA/conditioning/sampler/VAE/save nodes, and submitted them to the already-running local Comfy server. The complete-workflow run also included the graph's TextGenerate settings and prompt suffix concatenation. For the standalone runs, a temporary copy of the original graph replaced the text-encoding inputs with the exact expanded prompt. Assertions checked matching prompt, model filenames, LoRAs, dimensions, steps, CFG and denoise before execution.

Before each unloaded Comfy run, the harness waited for an empty queue, requested model unloading/freeing, and verified PyTorch GPU memory below 256 MiB. Both unloaded runs reported an empty `execution_cached` list; the warm run cached loader/conditioning/latent nodes only, while sampling, decoding and saving executed again. The second unloaded run explicitly supplied the CLIP loader's normal `device=default` option to invalidate its prior conditioning cache without changing its behavior. Comfy's existing server configuration was retained, including `--fast fp16_accumulation cublas_ops` and latent previews.

These are **warm filesystem-cache** measurements. The Comfy server was already running, so its initial Python imports/server boot are excluded; native process wall times include imports and shutdown. No other generation was queued during the test. Comfy GPU models were unloaded again at the end; the existing server was not stopped. Temporary graphs, logs, raw histories and outputs remain local under the ignored `outputs/` directory.

Conclusion: the current standalone prototype is substantially slower on this machine. Its repeated per-matrix transfers and BF16 execution of dequantized weights are optimization candidates; the timing comparison alone does not quantify each cause. It does not yet match the speed of the installed Comfy implementation. Linux was deliberately left untested, and image quality was not re-evaluated in this speed check.
