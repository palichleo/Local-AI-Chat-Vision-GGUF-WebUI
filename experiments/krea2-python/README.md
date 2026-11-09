# Krea2 Python experiment

One-shot recreation of the supplied `workflow.json`, using **PyTorch, Transformers and Diffusers**. No ComfyUI server, nodes or Python modules are used at runtime. This folder does not change Atelier's existing ComfyUI integration.

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

`--profile` captures one warmed diffusion step with the installed PyTorch CPU/CUDA profiler. Aggregate timings are embedded in the PNG and JSON metadata; a normal run does not enable profiling. See [PROFILE.md](PROFILE.md) for measured costs and attribution limits.

**No automatic downloads or installations.** Hugging Face offline mode is enforced. Local paths, generated outputs and Python caches are ignored by Git. Weights and tokenizer assets are not included; their original licenses still apply.

## Memory and compatibility

The supplied transformer is larger than a 12 GB GPU. Its INT8 matrices are memory-mapped from disk and copied/dequantized one at a time on the GPU. ConvRot metadata selects the matching orthogonal input rotation; LoRAs act on the original, unrotated input. The text encoder is loaded and released before diffusion. The VAE uses tiling.

This avoids loading a full BF16 transformer into RAM or VRAM, at the cost of repeated transfers. A fast local SSD matters. Windows may count memory-mapped checkpoint pages in the process working set; this is not the same as private allocated RAM. Close other GPU models first: the prototype requires at least 9 GiB of free VRAM and never stops other applications.

This is a deliberately narrow experiment: CUDA GPU, Krea2 Turbo, the supplied Qwen text encoder and Wan/Qwen VAE architectures, Euler/simple, CFG=1, the node types used in this graph, one image per run. Architecture dimensions and sampling shift are fixed for this model family. It is not a general Comfy workflow interpreter, a video pipeline or a CPU implementation.

It uses BF16 operations on dequantized INT8/FP8 weights rather than Comfy's optimized quantized kernels. Prompt expansion, random generation and numerical details may differ. Identical seed does **not** promise a pixel-identical Comfy result. Actual timings and checks are recorded in [RESULTS.md](RESULTS.md).

## Checks

```sh
python -m unittest discover -s experiments/krea2-python -v
```

These checks verify the original graph plan, branch selection, disabled refinement, unsupported-node rejection, ConvRot/LoRA algebra, and profile aggregation without loading model checkpoints.

References: [official Krea2 inference code](https://github.com/krea-ai/krea-2), [Diffusers Krea2 documentation](https://github.com/huggingface/diffusers/blob/main/docs/source/en/api/pipelines/krea2.md).
