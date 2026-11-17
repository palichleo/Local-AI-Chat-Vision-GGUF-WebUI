# Third-party components

Moodix is licensed under PolyForm Noncommercial 1.0.0 (see `LICENSE`). This file lists the components it relies on and their licenses.

## Code included in this repository

No third-party source file is copied into this repository. Some network definitions are written after published architectures, whose licenses are reproduced here:

- `runner/models/rrdbnet.py` follows the RRDBNet architecture of [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) — BSD 3-Clause License, Copyright (c) 2021, Xintao Wang. All rights reserved.
- `runner/models/rife.py` follows the IFNet architecture of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) — MIT License, Copyright (c) 2021 hzwer.
- `runner/models/seedvr2.py`, `runner/models/seedvr2_vae.py` and `runner/pipelines/seedvr2.py` follow the SeedVR2 architecture and one-step sampling of [SeedVR](https://github.com/ByteDance-Seed/SeedVR) — Apache License 2.0, Copyright (c) 2025 Bytedance Ltd. and/or its affiliates — as packaged by [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) — Apache License 2.0, Copyright 2025 seed. `runner/models/seedvr2_color.py` implements the colour corrections described there (CIELAB histogram matching, wavelet, AdaIN).
- `runner/models/moss_sfx.py` and `runner/pipelines/moss_sfx.py` follow the text-to-sound inference of [MOSS-SoundEffect v2](https://github.com/OpenMOSS/MOSS-TTS/tree/main/moss_soundeffect_v2) — Apache License 2.0, Copyright the OpenMOSS Team — itself built on [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio) (Apache License 2.0, Copyright ModelScope) and the Wan transformer blocks of [Wan2.1](https://github.com/Wan-Video/Wan2.1) (Apache License 2.0, Copyright Alibaba). The audio decoder follows the DAC architecture of [descript-audio-codec](https://github.com/descriptinc/descript-audio-codec) — MIT License, Copyright (c) 2023-present, Descript. Changes: only the inference path is kept, the weight-normalised convolutions are folded at load time, the VAE file is read without running pickled code, and the text encoder, transformer and decoder take the GPU one after the other. Neither project ships a `NOTICE` file.
- `runner/pipelines/acestep15.py` calls the `AceStepPipeline` of diffusers (Apache-2.0); no ACE-Step source is copied.
- `runner/models/wan_scail2.py`, `runner/models/wan_clip.py`, `runner/models/wan_text.py` and `runner/video/scail.py` are written after the official implementation of [SCAIL-2](https://github.com/zai-org/SCAIL-2) (`wan/modules/model_scail2.py`, `wan/modules/clip.py`, `wan/modules/t5.py`, `wan/scail.py`, `wan/utils/scail_utils.py`) — Apache License 2.0, Copyright 2024-2025 The Alibaba Wan Team Authors — itself the code of [Wan2.1](https://github.com/Wan-Video/Wan2.1) (Apache License 2.0). The repository ships no `NOTICE` file.
- `runner/models/sparse_attention.py` follows the method and the layout of the video sparse attention of [FastVideo](https://github.com/hao-ai-lab/FastVideo) (`fastvideo/attention/backends/video_sparse_attn_h3.py`) — Apache License 2.0, Copyright the FastVideo authors — written from its description. The repository ships no `NOTICE` file.
- `runner/models/sam3.py` renames the tensors of SAM 3.1 after the table of the conversion script of [transformers](https://github.com/huggingface/transformers) (`models/sam3/convert_sam3_to_hf.py`) — Apache License 2.0, Copyright 2025 The Meta AI Authors and The HuggingFace Inc. team.
- `runner/models/ltx25_block.py`, `runner/models/ltx25_decoder.py`, `runner/models/wan_block.py`, `runner/models/minimax_h3.py`, `runner/models/minimax_h3_vae.py` and `runner/pipelines/minimax_h3.py` compute again, with other kernels or for other file layouts, what the matching classes of [diffusers](https://github.com/huggingface/diffusers) compute — Apache License 2.0, Copyright 2025 The Lightricks team and The HuggingFace Team (LTX-2 transformer), Copyright 2026 Lightricks and The HuggingFace Team (LTX-2 decoder), Copyright 2025 The Wan Team and The HuggingFace Team (Wan), Copyright 2026 The MiniMax Team and The HuggingFace Team (MiniMax-H3).

No line of ComfyUI or of its custom nodes is copied: the Python engine was compared line by line with an installed ComfyUI and its nodes on 17 November 2026 (17 trivial lines alike out of 3,662, never two in a row).

Any future adaptation of MIT, BSD or Apache-2.0 code must be listed here with its copyright line and license, and an Apache-2.0 `NOTICE` file must be reproduced when one exists. GPL and AGPL code (including ComfyUI) cannot be included.

## Fonts included in this repository

The interface uses five fonts served by the application itself (`public/fonts/`), so the page loads nothing from the web. Each is licensed under the [SIL Open Font License 1.1](https://openfontlicense.org), whose full text sits beside it. Michroma, Manrope and JetBrains Mono are the unmodified releases of the [Google Fonts repository](https://github.com/google/fonts); Gloock and Jost (the interface « Salle obscure », 0.6.0) are their latin and latin-ext subsets in WOFF2 as published by [Fontsource](https://fontsource.org) (`@fontsource/gloock`, `@fontsource-variable/jost`), unmodified and renamed.

| Font           | File                                       | Copyright                                                                                      | License                           |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| Michroma       | `public/fonts/Michroma-Regular.ttf`        | Copyright 2011 The Michroma Project Authors (https://github.com/googlefonts/Michroma-font)     | OFL-1.1 (`OFL-Michroma.txt`)      |
| Manrope        | `public/fonts/Manrope-Variable.ttf`        | Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)            | OFL-1.1 (`OFL-Manrope.txt`)       |
| JetBrains Mono | `public/fonts/JetBrainsMono-Variable.ttf`  | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | OFL-1.1 (`OFL-JetBrainsMono.txt`) |
| Gloock         | `public/fonts/Gloock-latin.woff2`, `public/fonts/Gloock-latin-ext.woff2` | Copyright 2022 The Gloock Project Authors (https://github.com/duartp/gloock) | OFL-1.1 (`OFL-Gloock.txt`) |
| Jost           | `public/fonts/Jost-latin.woff2`, `public/fonts/Jost-latin-ext.woff2` | Copyright 2020 The Jost Project Authors (https://github.com/indestructible-type/Jost) | OFL-1.1 (`OFL-Jost.txt`) |

## Components installed separately

These are not distributed with the sources. Node.js is provided by the user. llama.cpp is provided by the user or downloaded by the application from the official releases of its project on GitHub (the build that fits the computer, with the CUDA runtime libraries published beside it for an NVIDIA card). The Python packages are downloaded by uv into `data/runtime/` when generation is enabled, at the versions locked in `runner/uv.lock`.

| Component                        | Version              | License                                                                                                                          |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                          | ≥ 22                 | MIT (plus bundled component licenses)                                                                                            |
| llama.cpp (`llama-server`)       | official build or user-supplied | MIT; the CUDA runtime libraries published beside its CUDA builds are NVIDIA's, under NVIDIA's own license            |
| uv                               | 0.13.7               | MIT or Apache-2.0                                                                                                                |
| Python (python-build-standalone) | 3.13                 | PSF-2.0 (plus bundled component licenses)                                                                                        |
| torch                            | 2.14.0               | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT (as declared by the package) |
| torchvision                      | 0.29.0               | BSD-3-Clause                                                                                                                     |
| diffusers                        | 0.41.0               | Apache-2.0                                                                                                                       |
| transformers                     | 5.17.0               | Apache-2.0                                                                                                                       |
| accelerate                       | 1.15.0               | Apache-2.0                                                                                                                       |
| safetensors                      | 0.8.0                | Apache-2.0                                                                                                                       |
| tokenizers                       | 0.23.2               | Apache-2.0                                                                                                                       |
| huggingface_hub                  | 1.33.0               | Apache-2.0                                                                                                                       |
| comfy-kitchen                    | 0.2.41               | Apache-2.0                                                                                                                       |
| triton / triton-windows          | 3.8.0 / 3.9.0.post30 | MIT                                                                                                                              |
| pillow                           | 12.3.0               | MIT-CMU                                                                                                                          |
| numpy                            | 2.5.3                | BSD-3-Clause (with bundled 0BSD, MIT, Zlib, CC0-1.0 parts)                                                                       |
| av (PyAV)                        | 19.0.0               | BSD-3-Clause; its wheel bundles FFmpeg libraries (built as LGPL v3 or later) with libx264 and libx265, which are GPL-2.0-or-later |
| imageio                          | 2.38.0               | BSD-2-Clause                                                                                                                     |
| imageio-ffmpeg                   | 0.6.0                | BSD-2-Clause; its wheel bundles an FFmpeg executable built with `--enable-gpl --enable-version3` (GPL v3 or later)               |
| sentencepiece                    | 0.2.2                | Apache-2.0                                                                                                                       |
| protobuf                         | 7.36.2               | BSD-3-Clause                                                                                                                     |
| nvidia-\* (CUDA libraries pulled by torch: cuBLAS, cuDNN, cuFFT…) | as locked | NVIDIA proprietary licenses (as declared by the packages)                                                    |

The other packages of `runner/uv.lock` are dependencies of those above. None declares a GPL or AGPL license on PyPI (71 packages checked on 17 November 2026); certifi is under MPL-2.0 and tqdm under MPL-2.0 and MIT.

FFmpeg comes with two of these packages, and neither copy is distributed with Moodix:

- the executable of imageio-ffmpeg is run as a separate program, to write and convert videos;
- the libraries of PyAV, with libx264 and libx265 (GPL), are loaded into the engine's own process, to read videos and sound.

An archive that shipped this Python environment together with Moodix would therefore distribute GPL libraries combined with the engine, which a noncommercial or proprietary license does not fit: the environment must stay a download made on the user's computer, or video reading must first go through the FFmpeg executable. This is the project's own reading, not legal advice.

### npm packages (Claude, optional)

Claude is asked through Anthropic's official library. It is not distributed with the sources: the application installs it with npm into `node_modules/` the first time the user chooses Claude (Paramètres › Moodix AI), at the versions locked in `package-lock.json`, without running any install script.

| Package                 | Version | License    |
| ----------------------- | ------- | ---------- |
| @anthropic-ai/sdk       | 1.4.0   | Apache-2.0 |
| @opentelemetry/api      | 1.10.0  | Apache-2.0 |
| standardwebhooks        | 1.1.1   | MIT        |
| @stablelib/base64       | 1.0.1   | MIT        |
| fast-sha256             | 1.3.0   | Unlicense  |
| json-schema-to-ts       | 3.1.1   | MIT        |
| ts-algebra              | 2.0.0   | MIT        |
| @babel/runtime          | 7.29.14 | MIT        |

None of them is under a GPL or AGPL license (checked on 17 November 2026).

### Remote chat models (optional)

When the user chooses one in Paramètres › Moodix AI, the chat is answered by an online service under that service's own terms, with the user's own account: ChatGPT (the user's ChatGPT Plus or Pro plan, through OpenAI's [ChatGPT plan usage for open-source and locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source); offering it in a paid application requires OpenAI's interest form first), Claude (an API key of the user's Claude Console: Anthropic does not permit third-party applications to sign in with a Claude.ai account or to use Claude subscription plans), OpenRouter (a key of the user's account made by its official OAuth PKCE sign-in), or any server « compatible OpenAI » with its own key. Moodix never reuses the identity of another tool (Codex, Claude Code…).

## Models

Checkpoints, text encoders, VAEs, LoRAs, tokenizers and GGUF files are never distributed with Moodix. For a workflow it ships, Moodix can download the missing files when the user asks for it, from the repositories listed in `runner/downloads.json` (Hugging Face, and GitHub for Real-ESRGAN): the files go from their publisher to the user's computer, and a file behind a license gate needs the user's own Hugging Face account. Each model keeps its own license, which may restrict commercial use, or the countries where the model may be used, independently of Atelier's license. Before a download, the application shows the license of each file (its name, a link to its text and its limits, as written in `runner/downloads.json` after the table below), and asks the user to confirm those with conditions (LTX 2.5, MiniMax H3, Krea 2, SAM 3.1); the choice stays the user's.

The licenses below were read at their source on 17 November 2026. A license can change with a new version of a model: read it again before relying on it. The last column is a summary, not legal advice; the text of each license prevails.

| Model (files of the shipped workflows) | License | Limits to know |
| --- | --- | --- |
| LTX 2.5 — `Lightricks/LTX-2.5` (transformer, Gemma 4 text encoder with its projection, VAEs, latent upscaler) | [LTX-2.x Community License Agreement](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) (as amended on 29 October 2026) | A paid license from US$10 million of annual revenue. Not in a product or service that directly competes with Lightricks' own without their agreement. Outputs published must be disclosed as machine-made; watermarking and provenance features must not be removed. |
| MiniMax H3, FastH3 Omni — `FastVideo/FastH3-Omni-Comfy`, `Comfy-Org/MiniMax-H3` | [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) | Not licensed in the European Union, the United Kingdom, the Republic of Korea and the United States of America, for the model and for its outputs alike. Elsewhere: an authorization from US$20 million of yearly revenue, "MiniMax H3" shown in a commercial product, a `NOTICE` file with any copy. |
| Krea 2 Turbo — `Comfy-Org/Krea-2` | [Krea 2 Community License Agreement v.1](https://huggingface.co/Comfy-Org/Krea-2/blob/main/LICENSE.pdf) | Commercial use of the model and of its outputs only under US$1 million of total annual revenue. Content filters required. Krea may end the license with 30 days' notice. |
| SAM 3.1 — `Comfy-Org/sam3.1` (finds the characters for SCAIL-2) | [SAM License](https://huggingface.co/Comfy-Org/sam3.1/blob/main/LICENSE) (Meta) | Redistribution under the same license, with its copy. No use for military, nuclear or weapons purposes. |
| MOSS Image — `Comfy-Org/MOSS-Image`, from `OpenMOSS-Team/MOSS-Image-SFT`, with its Qwen3.5-9B text encoder | Apache-2.0 | Its VAE is the FLUX.2 VAE of Black Forest Labs, published under Apache-2.0 with FLUX.2 [klein] 4B and the FLUX.2 small decoder; the file used here, repackaged by Comfy-Org, carries no license label of its own. |
| MOSS-SoundEffect v2 — `OpenMOSS-Team/MOSS-SoundEffect-v2.0`, with its Qwen3-1.7B text encoder | Apache-2.0 | |
| ACE-Step 1.5 XL — `ACE-Step/acestep-v15-xl-sft-diffusers` | MIT | |
| Wan 2.1 SCAIL-2 — `Comfy-Org/SCAIL-2`, with the UMT5 and CLIP encoders of `Comfy-Org/Wan-2.1`, the Wan VAE and the lightx2v LoRA of `Kijai/WanVideo_comfy` | MIT on the model page of `zai-org/SCAIL-2`, Apache-2.0 for its code, for Wan 2.1 and for lightx2v | `Kijai/WanVideo_comfy` declares no license of its own; its files are conversions of Apache-2.0 ones. |
| SeedVR2 7B — `Comfy-Org/SeedVR2` | Apache-2.0 | |
| Real-ESRGAN x2plus, x4plus — releases of `xinntao/Real-ESRGAN` | BSD-3-Clause | |
| RIFE 4.26 — `Comfy-Org/Frame-Interpolation` | MIT | |
| Text encoders and VAE used by the models above: Gemma 4 12B (LTX 2.5), Qwen3-VL-4B and the Qwen-Image VAE (Krea 2), Qwen3-VL-32B (MiniMax H3) | Apache-2.0 | They come inside the repositories of their models. |
| Tokenizers — `Qwen/Qwen2.5-7B-Instruct`, `openai/clip-vit-large-patch14` | Apache-2.0; MIT (license of `openai/CLIP`) | The model page of the CLIP tokenizer declares no license. |

The acceptable use policies that the LTX and Krea licenses refer to are part of them and are not summarised here. The chat model is the user's choice and keeps the license of its publisher.

The two sound models chosen for Moodix's own engine allow commercial use without a revenue or usage cap: [ACE-Step 1.5 XL](https://huggingface.co/ACE-Step/acestep-v15-xl-sft-diffusers) (music, MIT) and [MOSS-SoundEffect v2](https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect-v2.0) (sound effects, Apache-2.0, with a Qwen3-1.7B text encoder under Apache-2.0).
