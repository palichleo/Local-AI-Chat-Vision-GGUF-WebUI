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

All completed runs reported `comfy_imported: false` (the final script checks both `comfy` and `comfy_kitchen`). No ComfyUI server requests were made. The process exits after saving the PNG and metadata; all experiment processes finished, and GPU usage returned to approximately the pre-test baseline. The existing user-owned ComfyUI process was left untouched.

Five offline checks passed: original graph plan, image/no-refinement branch, disabled workflow refiner, unsupported-node rejection and ConvRot/LoRA algebra. The workflow, script and documentation are tracked; local paths, checkpoints and generated outputs are not published.

Limits: no paired generation against ComfyUI, no pixel-equivalence claim, no Linux or other-GPU execution test, no integration into Atelier's chat, no video generation. Image-to-image was tested with a generated reference and an explicit `--image` path. This establishes that the supplied image pipeline can run without ComfyUI; it does not establish equal speed or quality across arbitrary workflows.
