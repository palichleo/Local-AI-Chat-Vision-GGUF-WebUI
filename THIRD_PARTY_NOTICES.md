# Third-party components

Atelier local is licensed under PolyForm Noncommercial 1.0.0 (see `LICENSE`). This file lists the components it relies on and their licenses.

## Code included in this repository

No third-party source file is copied into this repository. Some network definitions are written after published architectures, whose licenses are reproduced here:

- `runner/models/rrdbnet.py` follows the RRDBNet architecture of [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) — BSD 3-Clause License, Copyright (c) 2021, Xintao Wang. All rights reserved.
- `runner/models/rife.py` follows the IFNet architecture of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) — MIT License, Copyright (c) 2021 hzwer.
- `runner/models/seedvr2.py`, `runner/models/seedvr2_vae.py` and `runner/pipelines/seedvr2.py` follow the SeedVR2 architecture and one-step sampling of [SeedVR](https://github.com/ByteDance-Seed/SeedVR) — Apache License 2.0, Copyright (c) 2025 Bytedance Ltd. and/or its affiliates — as packaged by [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) — Apache License 2.0, Copyright 2025 seed. `runner/models/seedvr2_color.py` implements the colour corrections described there (CIELAB histogram matching, wavelet, AdaIN).
- `runner/models/moss_sfx.py` and `runner/pipelines/moss_sfx.py` follow the text-to-sound inference of [MOSS-SoundEffect v2](https://github.com/OpenMOSS/MOSS-TTS/tree/main/moss_soundeffect_v2) — Apache License 2.0, Copyright the OpenMOSS Team — itself built on [DiffSynth-Studio](https://github.com/modelscope/DiffSynth-Studio) (Apache License 2.0, Copyright ModelScope) and the Wan transformer blocks of [Wan2.1](https://github.com/Wan-Video/Wan2.1) (Apache License 2.0, Copyright Alibaba). The audio decoder follows the DAC architecture of [descript-audio-codec](https://github.com/descriptinc/descript-audio-codec) — MIT License, Copyright (c) 2023-present, Descript. Changes: only the inference path is kept, the weight-normalised convolutions are folded at load time, the VAE file is read without running pickled code, and the text encoder, transformer and decoder take the GPU one after the other. Neither project ships a `NOTICE` file.
- `runner/pipelines/acestep15.py` calls the `AceStepPipeline` of diffusers (Apache-2.0); no ACE-Step source is copied.

Any future adaptation of MIT, BSD or Apache-2.0 code must be listed here with its copyright line and license, and an Apache-2.0 `NOTICE` file must be reproduced when one exists. GPL and AGPL code (including ComfyUI) cannot be included.

## Fonts included in this repository

The interface uses four fonts served by the application itself (`public/fonts/` and `public/assets/fonts/`), so the page loads nothing from the web. Each is licensed under the [SIL Open Font License 1.1](https://openfontlicense.org), whose full text sits beside it. Michroma, Manrope and JetBrains Mono are the unmodified releases of the [Google Fonts repository](https://github.com/google/fonts); Archivo is the unmodified variable font of [its own repository](https://github.com/Omnibus-Type/Archivo) (`fonts/variable/Archivo[wdth,wght].ttf`, renamed).

| Font           | File                                       | Copyright                                                                                      | License                           |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| Michroma       | `public/fonts/Michroma-Regular.ttf`        | Copyright 2011 The Michroma Project Authors (https://github.com/googlefonts/Michroma-font)     | OFL-1.1 (`OFL-Michroma.txt`)      |
| Manrope        | `public/fonts/Manrope-Variable.ttf`        | Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope)            | OFL-1.1 (`OFL-Manrope.txt`)       |
| JetBrains Mono | `public/fonts/JetBrainsMono-Variable.ttf`  | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) | OFL-1.1 (`OFL-JetBrainsMono.txt`) |
| Archivo        | `public/assets/fonts/Archivo-Variable.ttf` | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)           | OFL-1.1 (`Archivo-OFL.txt`)       |

## Components installed separately

These are not distributed with the sources. Node.js and llama.cpp are provided by the user; the Python packages are downloaded by uv into `data/runtime/` when generation is enabled, at the versions locked in `runner/uv.lock`.

| Component                        | Version              | License                                                                                                                          |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                          | ≥ 22                 | MIT (plus bundled component licenses)                                                                                            |
| llama.cpp (`llama-server`)       | user-supplied        | MIT                                                                                                                              |
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
| av (PyAV)                        | 19.0.0               | BSD-3-Clause; bundles FFmpeg libraries under LGPL                                                                                |
| imageio                          | 2.38.0               | BSD-2-Clause                                                                                                                     |
| imageio-ffmpeg                   | 0.6.0                | BSD-2-Clause; its wheel bundles an FFmpeg binary under GPL/LGPL                                                                  |
| sentencepiece                    | 0.2.2                | Apache-2.0                                                                                                                       |
| protobuf                         | 7.36.2               | BSD-3-Clause                                                                                                                     |

FFmpeg is used as a separate program or dynamic library, not linked into Atelier's sources.

## Models

Checkpoints, text encoders, VAEs, LoRAs, tokenizers and GGUF files are never distributed with Atelier. Each keeps its own license, which may restrict commercial use independently of Atelier's license (for example the LTX-2 Community License).

The two sound models chosen for Atelier's own engine allow commercial use without a revenue or usage cap: [ACE-Step 1.5 XL](https://huggingface.co/ACE-Step/acestep-v15-xl-sft-diffusers) (music, MIT) and [MOSS-SoundEffect v2](https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect-v2.0) (sound effects, Apache-2.0, with a Qwen3-1.7B text encoder under Apache-2.0).
