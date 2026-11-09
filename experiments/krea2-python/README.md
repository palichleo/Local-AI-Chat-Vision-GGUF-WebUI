# Krea2 Python experiment

Experimental recreation of the supplied `workflow.json`, using **PyTorch, Transformers and Diffusers**. No ComfyUI server, nodes or `comfy` Python package are used at runtime. The optional optimized engine uses the independent `comfy-kitchen` kernel library. This folder does not change Atelier's existing ComfyUI integration.

It reads the selected model filenames, three enabled LoRAs and strengths, prompt refinement settings, prompt concatenation, seed, dimensions and sampler settings from the graph. Model filenames are not hardcoded in the Python script.

## Run locally

Use a Python environment that already has PyTorch with CUDA, Diffusers with `Krea2Transformer2DModel`, Transformers, Accelerate, Safetensors, NumPy and Pillow. Tested versions: Python 3.13.14, PyTorch 2.14.0+cu130, Diffusers 0.41.0, Transformers 5.17.0, Accelerate 1.15.0, Safetensors 0.8.0, Pillow 12.3.0.

All checkpoints referenced by the graph must already exist below your model directory. Provide a local Qwen-compatible tokenizer directory containing its vocabulary, merges and tokenizer configuration. The test reused an installed Python environment and tokenizer assets; neither ComfyUI code nor `comfy_kitchen` is imported. Those assets can be supplied separately.

From the repository root (PowerShell or a Linux terminal):

```sh
python experiments/krea2-python/try_krea.py --models-root "PATH_TO_MODELS" --tokenizer "PATH_TO_TOKENIZER" --inspect
python experiments/krea2-python/try_krea.py --models-root "PATH_TO_MODELS" --tokenizer "PATH_TO_TOKENIZER" --width 512 --height 512
```

Remove `--width` and `--height` for the graph's original **1448 × 1448** resolution. Despite the prompt mentioning a vertical composition, the graph's resolution selector is square; the script preserves that setting.

Alternatively, save this private configuration as `local.json` next to the script:

```json
{
  "models_root": "PATH_TO_MODELS",
  "tokenizer": "PATH_TO_TOKENIZER"
}
```

Optional: `--no-refine` skips the prompt expansion; `--image "reference.png"` selects the graph's image-to-image branch with its configured denoise value. Generated PNGs and JSON metadata go into `outputs/`; `--output` can change the destination. Each PNG also embeds its generation metadata.

## Optimized engine and persistent worker

```sh
python experiments/krea2-python/try_krea.py --engine int8
python experiments/krea2-python/try_krea.py --engine int8 --worker
```

These commands reuse `local.json`; otherwise provide `--models-root` and `--tokenizer` as above. Optimized mode additionally requires an installed `comfy-kitchen` with its CUDA backend (tested: 0.2.41). It does not install it, start ComfyUI, or call a Comfy server. See [OPTIMIZED.md](OPTIMIZED.md) for measured speed, memory and quality limits.

With `--engine int8`, LoRAs are merged per layer in FP32, with the correct ConvRot basis. INT8 layers are requantized once and floating layers stored as BF16. Prepared weights live under `outputs/weights-cache/`; the first use prepares them, subsequent runs reuse them. This cache takes about **13.49 GB per checkpoint/LoRA combination** for the supplied graph. Its identity includes source paths, sizes, modification times, adapter order and strengths. It does not overwrite source models. `--cache-root` changes the folder; caches are disposable and can be deleted while no job is running.

The GPU weight cache automatically uses at most 6 GiB and reserves 3.5 GiB of currently free memory for activations. `--cache-gib` can lower that maximum; `--cache-gib 0` disables GPU retention. CPU source mappings stay alive until GPU work completes, and transfers are queued asynchronously. All model weights and mappings are released between worker jobs; Python imports, the CUDA context and small library buffers remain alive. This permits VRAM handoff to a separate LLM.

Worker mode reads one JSON object per stdin line, processes jobs sequentially, and exits on EOF. Examples:

```json
{"workflow":"PATH_TO_WORKFLOW.json","width":512,"height":512,"no_refine":true}
{"workflow":"PATH_TO_ANOTHER_WORKFLOW.json","engine":"int8"}
```

Progress and `job complete` / `job error` records are JSON on stdout; library warnings may appear on stderr. A failed job reports its error; valid subsequent jobs can still run. Supported job fields are `workflow`, `width`, `height`, `no_refine`, `image`, `output`, `engine`, `profile` and `cache_gib`. The worker is a local script protocol, not yet wired into Atelier's UI. The original `--engine stream` remains the default and preserves the reference path for comparisons.

`--profile` captures one warmed diffusion step with the installed PyTorch CPU/CUDA profiler. Aggregate timings are embedded in the PNG and JSON metadata; a normal run does not enable profiling. See [PROFILE.md](PROFILE.md) for measured costs and attribution limits.

**No automatic downloads or installations.** Hugging Face offline mode is enforced. Local paths, generated outputs and Python caches are ignored by Git. Weights and tokenizer assets are not included; their original licenses still apply.

## Memory and compatibility

The supplied transformer is larger than a 12 GB GPU. In the reference `stream` engine, its INT8 matrices are memory-mapped from disk and copied/dequantized one at a time on the GPU. ConvRot metadata selects the matching orthogonal input rotation; LoRAs act on the original, unrotated input. In both engines, the text encoder is loaded and released before diffusion. The VAE uses tiling.

This avoids loading a full BF16 transformer into RAM or VRAM, at the cost of repeated transfers. A fast local SSD matters. Windows may count memory-mapped checkpoint pages in the process working set; this is not the same as private allocated RAM. Close other GPU models first: the prototype requires at least 9 GiB of free VRAM and never stops other applications.

This is a deliberately narrow experiment: CUDA GPU, Krea2 Turbo, the supplied Qwen text encoder and Wan/Qwen VAE architectures, Euler/simple, CFG=1, the node types used in this graph, one image per run. Architecture dimensions and sampling shift are fixed for this model family. It is not a general Comfy workflow interpreter, a video pipeline or a CPU implementation.

The reference engine uses BF16 operations on dequantized INT8/FP8 weights. The optimized engine directly executes INT8 kernels on prepared diffusion layers. Prompt expansion, random generation and numerical details may differ. Identical seed does **not** promise a pixel-identical Comfy result. Requantizing merged weights also changes the output relative to the reference engine. Actual timings and checks are recorded in [RESULTS.md](RESULTS.md) and [OPTIMIZED.md](OPTIMIZED.md).

## Checks

```sh
python -m unittest discover -s experiments/krea2-python -v
```

These checks verify the original graph plan, branch selection, disabled refinement, unsupported-node rejection, ConvRot/LoRA algebra, and profile aggregation without loading model checkpoints.

The optional real CUDA kernel/cache check additionally compares a prepared layer against an independent float32 reference. Enable it with `KREA_TEST_CUDA=1` (PowerShell: `$env:KREA_TEST_CUDA='1'`) before running the same command. Leave it disabled when the GPU is busy.

References: [official Krea2 inference code](https://github.com/krea-ai/krea-2), [Diffusers Krea2 documentation](https://github.com/huggingface/diffusers/blob/main/docs/source/en/api/pipelines/krea2.md).
