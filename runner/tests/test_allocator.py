"""The engine sets PyTorch's allocator before torch is imported, and leaves the user's choice alone."""

import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def allocator(value=None):
    env = {key: item for key, item in os.environ.items() if key != 'PYTORCH_CUDA_ALLOC_CONF'}
    if value is not None:
        env['PYTORCH_CUDA_ALLOC_CONF'] = value
    script = 'import runner, os; print(os.environ.get("PYTORCH_CUDA_ALLOC_CONF"))'
    found = subprocess.run([sys.executable, '-s', '-c', script], cwd=ROOT, env=env, capture_output=True, text=True)
    return found.stdout.strip()


class AllocatorTest(unittest.TestCase):
    def test_segments_that_grow_unless_the_user_chose(self):
        self.assertEqual(allocator(), 'expandable_segments:True')
        self.assertEqual(allocator('backend:native'), 'backend:native')


if __name__ == '__main__':
    unittest.main()
