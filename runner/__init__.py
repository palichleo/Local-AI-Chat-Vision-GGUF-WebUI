"""Atelier's offline native generation worker."""

import os

# PyTorch's allocator grows its memory segments instead of keeping blocks of fixed sizes, set
# before torch is first imported. Measured on a 12 GiB card: a 1344 x 768 MiniMax-H3 video ran out
# of memory at its second step with 2.7 GiB reserved but unusable, and passes with it. ComfyUI's
# choice, cudaMallocAsync, ignores the memory ceiling the engine sets (runner.engine): the card
# then spills into shared memory, 351 s a step instead of 21. A value set by the user stays.
ALLOCATOR = 'expandable_segments:True'
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', ALLOCATOR)
