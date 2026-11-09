# Prototype runner

Preserved experimental Python runner, on the `prototype-runner` branch. It recreates the supplied Krea2 workflow with prepared LoRA weights, standalone INT8 kernels, a bounded GPU cache and a persistent Python worker.

- [Usage and configuration](experiments/krea2-python/README.md)
- [Optimized implementation and test results](experiments/krea2-python/OPTIMIZED.md)
- [Original CPU/CUDA profile](experiments/krea2-python/PROFILE.md)

Local configuration, prepared weight caches and generated images remain under `experiments/krea2-python/` and are ignored by Git. The normal application is maintained separately on `main`; this prototype is not integrated into its interface.

From this checkout, with the existing local Python environment:

```sh
python experiments/krea2-python/try_krea.py --engine int8 --worker
```

The original experiment is also preserved at commit `0ed79d6` on `experiment/krea2-python`.
