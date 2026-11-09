# Last bounded speed trial

The `--tuned` experiment brings this runner close to ComfyUI for prepared prompts on the tested Windows / RTX 4070 SUPER setup. The full workflow with local prompt expansion remains measurably slower. Nothing from this experiment has been merged into Atelier's `main` branch.

## Final comparison

Same GPU, same installed packages and local checkpoints, same three LoRAs and strengths, **1448 × 1448**, **eight Euler/simple steps**, **CFG=1**, seeds **261956854443987** and **261956854443988**. Both servers/workers were already started for the measured pairs, with one warm-up generation per backend. Native model allocations and Comfy GPU models were released between every job. Prepared weights and operating-system filesystem caches were warm.

| Case | Comfy run 1 | Comfy run 2 | Runner run 1 | Runner run 2 | Mean difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Exact same already-expanded prompt | 29.740 s | 29.265 s | 30.587 s | 30.733 s | Runner +3.92% |
| Workflow including prompt expansion | 31.063 s | 30.910 s | 35.492 s | 35.499 s | Runner +14.55% |

Prepared-prompt means: **29.5025 s Comfy**, **30.6600 s runner**. Full-workflow means: **30.9865 s Comfy**, **35.4955 s runner**. The report uses approximately 10% as a practical similarity threshold: the prepared-prompt case meets it, the complete workflow does not. Two seeds are enough for this bounded decision, not a broad statistical benchmark.

Each native time is measured externally from sending a stdin job through receiving `job complete`. The worker's own timer now also includes its final synchronization and memory release. Comfy times run from request submission through successful history availability, with polling at 150 ms. Every measured Comfy job reported **no cached graph nodes**; only filesystem/library caches were warm. Equivalent constant-string concatenation chains invalidated text/refinement node cache ancestry without altering their input strings. Comfy's existing startup settings were retained.

The native warm-up job took **44.743 s including initial imports**. Comfy warm-up took 29.250 s on an already-running server. Neither warm-up is counted in the averages. No claim of matching fresh-process or newly built weight-cache latency is made.

Raw graphs, status histories, outputs and timings remain local under ignored `outputs/final-comparison-1794189513287739400/`. The prepared-prompt graphs were checked for identical model files, LoRAs, dimensions, prompt, steps, CFG and denoise before running. Full-workflow graphs also use the same prompt expansion input and sampling settings, though the implementations differ numerically and their expanded output is not guaranteed identical.

## What changed

1. **Fused RMS normalization/modulation and gated residual kernels.** Small Triton kernels avoid separate float32 intermediate tensors and launches. They preserve intermediate BF16 rounding where the reference performs it. Per-head Q/K norms use the same fused normalization.
2. **cuDNN attention with native GQA.** The installed Windows PyTorch build has no FlashAttention support. A local probe instead found cuDNN attention about twice as fast as the previous memory-efficient kernel at the relevant sequence/head shape. cuDNN handles grouped-query heads directly, avoiding the explicit fourfold key/value head repetition. The tuned path selects it only for long, unmasked attention; shorter/masked attention retains PyTorch's normal dispatcher.
3. **Bounded CPU prefetch.** While the text encoder uses the GPU, a single background thread touches pages of existing prepared-weight mappings. It keeps at most 8 GiB and leaves an 8 GiB available-RAM reserve according to the starting measurement. It does not copy or pin the entire model. Missing optional `psutil` disables this prefetch. Executor shutdown is registered for both success and early errors.
4. **A calibrated 7 GiB GPU weight-cache ceiling**, reduced when free GPU memory minus a 3 GiB activation reserve is smaller. `--cache-gib` can lower the limit. This tuned limit is calibrated for this model and resolution; other workloads may need less retention.

These changes are opt-in with `--engine int8 --tuned`. Baseline and earlier INT8 paths remain available. No packages or checkpoints were downloaded or installed, and the prepared-weight format was not changed or rebuilt.

## Validation and resource limits

- All five native jobs (warm-up, two prepared-prompt, two full-workflow) completed and reported `comfy_imported: false`.
- Peak PyTorch allocated VRAM was **8.208 GiB**, with **6.996 GiB** of retained prepared weights. Total device use during the run was higher, approximately 11.4 GiB including other applications/driver allocations; this is a tight fit for a 12 GB card.
- After every job, PyTorch allocated VRAM returned to **0.007935 GiB**, approximately 8 MiB. Process working set after jobs was 1.97–2.26 GiB. CPU mapped weights are released after each job. A preliminary two-job run with the earlier 6 GiB GPU limit peaked at 14.698 GiB process working set; the final five-job comparison did not sample peak process RAM, so no final peak-RAM claim is made.
- Prepared-prompt and full-workflow output images were opened and visually checked. They remain coherent and detailed. Pixel identity with the previous path is not expected because reduction order and attention backend changed.
- The CUDA checks compare fused operations against independent eager references at widths 128, 2560 and 6144, including batch size two. Gated residual output matched exactly; fused norm/modulation relative RMSE in the local probe was at most approximately 0.000019. An attention module comparison checks cuDNN GQA against the original processor with a 1% relative-RMSE bound. These are numerical bounds, not perceptual quality guarantees.
- The execution cleanup check simulates a model-load failure and verifies registered prefetch cleanup runs. The worker still validates job types and can report recoverable errors without accepting arbitrary job fields.
- All **13 Python/CUDA tests passed** on the final implementation, including the cleanup regression check. A separate code review compared the patched block and kernels with the installed Diffusers implementation and found no remaining blocking defect in this tested scope.
- The application suite also passed: **400 passed, 0 failed, 1 Linux-only test skipped** under Windows. Main's files and branch were not changed.

Linux, other GPU families, videos, very large contexts/resolutions, and exhaustive quality checks are not covered. The kernels are inference-only. cuDNN and Triton support must be present; tuned mode fails explicitly on an unsupported installation rather than silently claiming the same performance. The prefetch budget is not a hard process-RAM cap. Initial JIT/driver compilation and cold filesystem I/O can increase first use.

All test worker processes exited after EOF. The user's pre-existing Comfy server was left running and its GPU models were unloaded. Main remains separate and unchanged.

## Run this version

With the existing ignored local configuration and prepared weights:

```sh
python experiments/krea2-python/try_krea.py --engine int8 --tuned --worker
```

To preserve the measured low startup overhead, reuse the worker for successive jobs. Releasing its GPU models is separate from ending the Python process.
