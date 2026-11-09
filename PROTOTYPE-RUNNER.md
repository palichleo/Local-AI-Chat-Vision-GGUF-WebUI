# Prototype runner branch

Experimental branch of Atelier local. Generation runs natively: Node supervises a persistent Python worker (`runner/`) instead of calling the ComfyUI API. The worker is installed automatically in `data/runtime/` and is driven from the application interface through the LLM tools `generate_image` and `generate_video`.

- [Native runner: setup, supported pipelines and measured results](runner/README.md)
- [Design of native workflows](docs/superpowers/specs/2026-11-09-native-workflows-design.md)

`experiments/krea2-python/` keeps the original Krea2 experiment and its profiling reports (`OPTIMIZED.md`, `PROFILE.md`, `LAST-TRY.md`) as references only; the application does not import it. The original experiment is also preserved at commit `0ed79d6` on `experiment/krea2-python`.

The ComfyUI client has been removed from this branch; ComfyUI files are only read by the workflow importer. `main` remains Comfy-based until this branch replaces it.
