# Third-party components

Atelier local is licensed under PolyForm Noncommercial 1.0.0 (see `LICENSE`). This file lists the components it relies on and their licenses.

## Code included in this repository

No third-party source file is copied into this repository. Some network definitions are written after published architectures, whose licenses are reproduced here:

- `runner/models/rrdbnet.py` follows the RRDBNet architecture of [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) — BSD 3-Clause License, Copyright (c) 2021, Xintao Wang. All rights reserved.
- `runner/models/rife.py` follows the IFNet architecture of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) — MIT License, Copyright (c) 2021 hzwer.
- `runner/models/seedvr2.py`, `runner/models/seedvr2_vae.py` and `runner/pipelines/seedvr2.py` follow the SeedVR2 architecture and one-step sampling of [SeedVR](https://github.com/ByteDance-Seed/SeedVR) — Apache License 2.0, Copyright (c) 2025 Bytedance Ltd. and/or its affiliates — as packaged by [ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) — Apache License 2.0, Copyright 2025 seed. `runner/models/seedvr2_color.py` implements the colour corrections described there (CIELAB histogram matching, wavelet, AdaIN).

Any future adaptation of MIT, BSD or Apache-2.0 code must be listed here with its copyright line and license, and an Apache-2.0 `NOTICE` file must be reproduced when one exists. GPL and AGPL code (including ComfyUI) cannot be included.

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
