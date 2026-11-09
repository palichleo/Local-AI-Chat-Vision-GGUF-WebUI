# Native pipeline profile

Measured on the same RTX 4070 SUPER / Windows setup as [the speed comparison](RESULTS.md). Resolution 1448 × 1448, eight Euler/simple steps, CFG=1, the same prepared prompt, seed and three LoRAs. No packages or models were downloaded.

The optional `--profile` flag uses the installed PyTorch CPU/CUDA profiler to capture **step 2 of 8**, after the first step has warmed up the kernels. It saves an aggregate report in the output PNG's metadata and adjacent JSON; it does not export a large full trace. This is a representative single-step sample, not an average over all steps.

## Measured cost

Sample elapsed time: **6.450884 s**. Attributed CUDA work: **6.118108 s**.

| Category | CUDA seconds per sampled step | Share of CUDA work |
| --- | ---: | ---: |
| Base-model linear operations | 1.621213 | 26.50% |
| LoRA linear operations, scaling and accumulation | 1.507702 | 24.64% |
| Other operations outside the ranges below | 1.018757 | 16.65% |
| Base-weight upload | 0.826715 | 13.51% |
| Attention | 0.780962 | 12.76% |
| Weight conversion and dequantization | 0.204681 | 3.35% |
| ConvRot input rotation | 0.136190 | 2.23% |
| LoRA upload/casting | 0.021888 | 0.36% |

The sample contains 264 base linear calls, **768 LoRA applications** and 32 attention calls. Each adapter application performs two extra matrix products plus output scaling/addition. The three adapters' combined runtime is nearly as large as the base linear calculations.

The largest individual operators, summed across their call sites, were `aten::mm` (2.186278 s), `aten::copy_` (1.183569 s), `aten::mul` (0.928300 s), `aten::add` (0.788424 s) and efficient attention (0.780896 s). These operator totals overlap the categories above; they must not be added to the table. The residual “other” category includes work outside the annotated linear/transfer ranges, such as normalizations, modulation and residual operations; it is not a direct measurement of one specific kernel family.

## Avoiding a misleading transfer diagnosis

The CPU ranges around base-weight upload lasted 3.135297 s and those around LoRA upload/casting lasted 2.741338 s. **These are not pure transfer times:** synchronous copy calls also wait for preceding GPU work. The attributed CUDA upload work totals only **0.848603 s**, approximately **13.87%** of CUDA work. Host read/metadata ranges total 0.231170 s; this is not a direct disk-I/O throughput measurement, because memory-mapped page faults can occur later during copying.

CPU and CUDA totals overlap and must not be added. The summarizer selects CPU annotation ranges with attributed CUDA operations and rejects duplicate synthetic CUDA annotations, which the installed profiler also emits. It verifies that the disjoint categories do not exceed the enclosing step's CUDA total. Attention is attributed from `aten::scaled_dot_product_attention`; the remaining CUDA work is reported explicitly as “other”.

## Priorities suggested by this sample

1. Prepare/fuse the LoRA contribution rather than applying three separate adapters during every linear call. This targets the measured adapter overhead. Merging and especially requantizing must be checked for numerical/image changes; the sample does not promise that all 24.64% can be removed.
2. Reuse a Python worker to avoid the previously measured 11–12 s of process startup/imports for each image. Model unloading for VRAM handoff can remain independent of worker lifetime.
3. Evaluate direct optimized INT8 execution and fused elementwise/normalization operations instead of repeatedly running dequantized BF16 matrices and separate pointwise kernels.
4. Cache/prefetch selected weights within the VRAM budget. Upload contributes about 14% in this sample, so reducing copies alone will not close the full measured speed gap.

These are optimization candidates, not implemented speedups or guaranteed additive savings. No Comfy kernel profile was captured, so this sample cannot attribute the entire cross-backend difference to a particular optimization.

## Validation and limits

The instrumented generation completed all eight steps, saved a 1448 × 1448 PNG, reported `comfy_imported: false` and peaked at 7.611 GiB of PyTorch allocated VRAM. Its decoded pixels are **exactly identical** to the corresponding pre-instrumentation native benchmark image: SHA-256 `93d086db0d091b14491334a55710d7cf52978e95c33061d0a5b79858e8aabc9d`. PNG bytes differ because metadata now includes the profile.

The instrumented run took 71.08 s from model loading through decoding. Starting/stopping the profiler and building its event summary add overhead outside the sampled interval; this run should not replace the uninstrumented speed measurements. Normal execution leaves profiling disabled. Six offline checks passed, including duplicate-CUDA-annotation rejection in the summarizer. The embedded Python import path was corrected so it can load the local profiling helper.

All experiment processes exited and released their GPU allocations. The pre-existing Comfy server was not stopped. Linux and image-to-image profiling were left out; the image quality comparison above only verifies that instrumentation preserved this exact native output.

To repeat with existing local configuration:

```sh
python experiments/krea2-python/try_krea.py --profile
```

For an exact comparison, supply `--workflow` with the same local fixed-prompt benchmark graph used previously. Without that override, the normal graph's prompt expansion still runs before the sampled diffusion step.
