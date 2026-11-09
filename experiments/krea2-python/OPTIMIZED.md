# Prepared LoRA + INT8 experiment

This extends the standalone experiment with the execution strategy suggested by the [profile](PROFILE.md): prepare adapter contributions into the weights, run optimized INT8 kernels, retain selected weights on the GPU, and keep Python imports alive between jobs. No ComfyUI server or `comfy` Python package is used. The **independent `comfy-kitchen` 0.2.41 CUDA kernel library** already installed locally is used through its registered Torch operator. No downloads, package installations or source-checkpoint modifications were made.

## Implementation

- Each layer is prepared separately on the GPU in FP32. For rotated INT8 storage, adapter `A` is rotated into the checkpoint's basis before adding `strength × alpha/rank × B @ A`. The resulting INT8 layer is requantized per output row; floating layers are stored as BF16. Full BF16 copies of the whole transformer are not allocated.
- Prepared layers are written atomically into a private, ignored disk cache. The cache key contains source paths, sizes, modification times, adapter order, strengths and a format version. Unchanged layers are reused after restarting Python. Files with the same path, size and preserved modification timestamp are assumed unchanged; this is not a content-hash cache.
- At most 6 GiB of weights are kept resident, reduced automatically if free memory minus a 3.5 GiB activation reserve is smaller. The cache keeps selected layers rather than cycling an undersized LRU through the whole model. Source mmap tensors remain alive during asynchronous transfers, then are released after synchronization. Keeping the mappings avoids repeated mapping/page-fault overhead.
- The text encoder is released before diffusion. GPU weights are released before VAE decoding. The stdin worker processes jobs sequentially, keeps Python/library state alive, and releases model allocations between jobs. EOF closes the worker; it creates no listening port.

No checkpoint or adapter filenames are hardcoded. Model architecture dimensions remain specific to the supplied Krea2/Qwen family, as in the original experiment. Default `--engine stream` is preserved; the new path is selected with `--engine int8`.

## Speed and resource measurements

Same RTX 4070 SUPER 12 GB, 32 GB RAM, Windows, 1448 × 1448, eight Euler/simple steps, CFG=1 and three LoRAs. Prepared-prompt measurements use the exact same prompt and seeds as [the earlier comparison](RESULTS.md).

| Measurement | Elapsed time |
| --- | ---: |
| Previous reference script, new Python process, prepared prompt | 77.145–82.361 s |
| Optimized worker, first job with prepared weights already on disk, includes imports | 54.879 s |
| Optimized worker, second job, new seed, models unloaded between jobs | **43.748 s** |
| Earlier Comfy measurement, GPU models unloaded, prepared prompt | 27.727–27.870 s |
| Optimized image-to-image, 512 × 512, denoise 0.4, GPU cache disabled, after imports | 24.470 s |

The two worker jobs took **99.769 s total process wall time** and peaked at **14.640 GiB process working set**. Their PyTorch allocated VRAM peak was **7.611 GiB**. Retained weight cache size was 5.996 GiB, with 945 hits and 1,167 misses across eight steps. Total uploaded weight data was 58.525 GiB. Reported idle PyTorch allocation after each job was **0.007935 GiB**, approximately 8 MiB, from persistent library buffers; the driver/context is additional. All test workers exited after EOF.

The worker's first-job total includes its Python/library imports, while its second-job total does not. Model loading, inference and PNG saving remain included in both; models are unloaded between jobs. The Comfy numbers are earlier measurements on the already-running server, not simultaneous paired measurements with this implementation. These results show a substantial improvement, **not parity with Comfy**.

### First preparation cost and disk usage

With a fresh cache, the original workflow including prompt expansion completed in **76.730 s after imports**, peaking at 7.710 GiB PyTorch allocated VRAM. Preparing the transformer and its cache took about **30.23 s** in that run, versus roughly one second when the prepared files already exist. First use therefore has a significant one-time cost for each model/adapter/strength combination.

The persistent prepared cache contains 264 layer files totaling **13,489,035,328 bytes**, about 13.49 GB / 12.56 GiB. Different combinations get separate caches; there is no automatic disk-cache eviction in this experiment. Cache files are disposable, but source model files are never replaced.

A second disposable cache was built under `outputs/weights-cache-cold-test/` to measure first use. Automatic command review rejected its cleanup (`blocked by policy`), so this additional approximately 13.49 GB test folder remains local. It is ignored by Git and unused by the normal cache.

## Profile of the final optimized path

Second warmed diffusion step: **3.500446 s elapsed**, **3.442267 s attributed CUDA work**, compared with 6.450884 s / 6.118108 s in the reference profile.

| Category | CUDA seconds |
| --- | ---: |
| Prepared base linear operations, including 224 INT8 operations | 1.134596 |
| Attention | 0.803905 |
| Weight upload | 0.461256 |
| Other normalization/modulation/residual operations | 1.042510 |

There are no separate adapter-forward calls in this path. The installed kernel library's registered Torch operator is used so the profiler correctly attributes the external CUDA kernels. An intermediate test using the direct Python kernel entry point missed part of that attribution; its partial profile is not used in this table. The final registered-op output was pixel-identical to the direct-entry-point optimized output.

## Quality and correctness checks

The maximum additional per-layer weight reconstruction relative RMSE after merging/requantizing was **0.00630746**, approximately **0.63%**. This is a weight error metric, not a perceptual image-quality score. INT8 activation quantization and requantizing merged weights change output pixels relative to the BF16 reference.

Generated 512 × 512 and 1448 × 1448 outputs were opened and checked. The tested scene remains coherent, detailed and faithful to the prompt. Two different seeds completed in the same worker. Image-to-image also completed with the GPU cache disabled, validating the streaming fallback. This small visual sample does not establish equivalent quality for all prompts or LoRAs.

The fresh-cache complete-workflow run and the corresponding warm-cache prepared-prompt run produced the exact same prompt and decoded pixels. This also verifies repeatability across cache construction/reuse and the prompt-expansion/fixed-prompt paths for this input.

Ten checks passed with `KREA_TEST_CUDA=1`: workflow/branch selection, ConvRot algebra, independent fused-weight reconstruction, cache-key invalidation, worker input validation, profiler aggregation, and a real CUDA prepared layer compared against an independent FP32 reference. The GPU test also checks disk-cache reuse, disabled/enabled GPU caching, repeatability and cache bounds. A subprocess smoke test verified that an invalid worker request is followed by a successful valid request, and that EOF ends the process.

Linux, arbitrary model families, concurrent workers, video generation and Atelier UI integration remain out of scope. Very large resolutions can require lowering `--cache-gib`; the automatic headroom is calibrated for this tested resolution. Recoverable input/file errors are reported per job; a fatal CUDA device error may require restarting the worker.
