import re
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import torch
import torch.nn.functional as F

from runner.models import attention8

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).parent / 'fixtures' / 'int8-attention-rows.json'


def kernel_ready():
    try:
        import comfy_kitchen

        return torch.cuda.is_available() and bool(comfy_kitchen.int8_attention_is_available(torch.device('cuda')))
    except Exception:
        return False


def drawn(batch=2, heads=3, queries=10, keys=12, size=8, key_heads=None, seed=0):
    torch.manual_seed(seed)
    query = torch.randn(batch, heads, queries, size)
    key = torch.randn(batch, key_heads or heads, keys, size)
    value = torch.randn(batch, key_heads or heads, keys, size)
    return query, key, value


class Kernel:
    """A kernel that answers a little off the exact attention everywhere (what it answered is told
    from what was computed again), and not a number for the rows it is told to fail on."""

    OFF = 0.25

    def __init__(self, failed=(), value=float('nan'), partial=False):
        self.failed, self.value, self.partial, self.calls = failed, value, partial, []

    def __call__(self, query, key, value, **named):
        self.calls.append(named)
        mask = named.get('attn_mask')
        spread = query.shape[1] // key.shape[1]
        keys, values = key.repeat_interleave(spread, 1), value.repeat_interleave(spread, 1)
        answer = F.scaled_dot_product_attention(query.float(), keys.float(), values.float(), attn_mask=mask) + self.OFF
        for batch, head, row in self.failed:
            if self.partial:
                answer[batch, head, row, -1] = self.value
            else:
                answer[batch, head, row] = self.value
        return answer.to(query.dtype)


def exact(query, key, value, mask=None):
    spread = query.shape[1] // key.shape[1]
    keys, values = key.repeat_interleave(spread, 1), value.repeat_interleave(spread, 1)
    return F.scaled_dot_product_attention(query.float(), keys.float(), values.float(), attn_mask=mask)


class RepairTests(unittest.TestCase):
    """(0.6.140) The first clip of Wan 2.2 made with its step LoRAs, on 20/11: five frames of the
    picture, then 76 black ones. One row of an attention, one head of one token of the 1.1 million
    of a pass, came back from comfy-kitchen's INT8 kernel « not a number »."""

    def check(self, answer, truth, failed, off=Kernel.OFF):
        self.assertTrue(bool(torch.isfinite(answer).all()))
        rows = torch.zeros(answer.shape[:3], dtype=torch.bool)
        for place in failed:
            rows[place] = True
        # The rows that failed are the exact attention; the others are the kernel's, as it gave them.
        self.assertTrue(torch.allclose(answer[rows].float(), truth[rows], atol=1e-5))
        self.assertTrue(torch.allclose(answer[~rows].float(), truth[~rows] + off, atol=1e-5))

    def test_an_answer_that_is_all_numbers_is_left_as_it_is(self):
        query, key, value = drawn()
        held, calls = torch.randn(2, 3, 10, 8), []

        def kernel(*given, **named):
            calls.append((given, named))
            return held

        exact_one = 'torch.nn.functional.scaled_dot_product_attention'
        with mock.patch(exact_one, side_effect=AssertionError('nothing to compute again')):
            answer = attention8.attend(query, key, value, kernel=kernel)
            self.assertIs(answer, held)
            # Asked as before: the three tensors, no mask when none is given; comfy-kitchen's own
            # kernel unless another is named.
            self.assertEqual(len(calls), 1)
            self.assertTrue(all(given is sent for given, sent in zip(calls[0][0], (query, key, value))))
            self.assertEqual(calls[0][1], {})
            with mock.patch.dict(sys.modules, {'comfy_kitchen': types.SimpleNamespace(int8_attention=kernel)}):
                self.assertIs(attention8.attend(query, key, value), held)
            self.assertEqual(len(calls), 2)

    def test_the_rows_that_failed_are_computed_again_and_the_others_kept(self):
        query, key, value = drawn()
        failed = [(0, 1, 2), (0, 1, 7), (1, 0, 0), (1, 2, 9)]
        answer = attention8.attend(query, key, value, kernel=Kernel(failed))
        self.check(answer, exact(query, key, value), failed)
        # Infinite, or a single value of the row: failed all the same.
        for kernel in (Kernel(failed, float('inf')), Kernel(failed, float('-inf')), Kernel(failed, partial=True)):
            self.check(attention8.attend(query, key, value, kernel=kernel), exact(query, key, value), failed)

    def test_every_row_of_a_head_may_fail_and_is_computed_a_few_at_a_time(self):
        query, key, value = drawn(batch=1, heads=2, queries=11)
        failed = [(0, 1, row) for row in range(11)]
        seen = []
        real = F.scaled_dot_product_attention

        def counted(queries, *more, **named):
            seen.append(queries.shape[0])
            return real(queries, *more, **named)

        with mock.patch.object(attention8, 'ROWS', 4):
            kernel = Kernel(failed)
            raw = kernel(query, key, value)
            with mock.patch('torch.nn.functional.scaled_dot_product_attention', counted):
                answer = attention8.repaired(raw, query, key, value)
        self.assertEqual(seen, [4, 4, 3])
        self.check(answer, exact(query, key, value), failed)

    def test_a_mask_is_read_for_the_rows_computed_again(self):
        query, key, value = drawn()
        failed = [(0, 0, 3), (1, 2, 5)]
        torch.manual_seed(1)
        # Keys left out for everyone (padding), then a mask of its own for every query.
        padding = torch.ones(2, 1, 1, 12, dtype=torch.bool)
        padding[0, :, :, 8:] = False
        padding[1, :, :, :3] = False
        each = torch.rand(2, 3, 10, 12) > 0.3
        each[..., 0] = True
        added = torch.where(each, 0.0, float('-inf'))
        for mask in (padding, each, added):
            kernel = Kernel(failed)
            answer = attention8.attend(query, key, value, attn_mask=mask, kernel=kernel)
            self.assertIs(kernel.calls[0]['attn_mask'], mask)
            self.check(answer, exact(query, key, value, mask), failed)
        # (Without it, the rows computed again would read the keys left out.)
        unmasked = exact(query, key, value)
        self.assertFalse(torch.allclose(exact(query, key, value, padding)[0, 0, 3], unmasked[0, 0, 3], atol=1e-3))

    def test_several_heads_of_queries_may_read_the_same_head_of_keys(self):
        query, key, value = drawn(heads=4, key_heads=2)
        failed = [(0, 3, 1), (1, 1, 4), (1, 2, 0)]
        answer = attention8.attend(query, key, value, kernel=Kernel(failed))
        self.check(answer, exact(query, key, value), failed)

    def test_the_answer_keeps_the_precision_of_the_kernel(self):
        query, key, value = (item.to(torch.bfloat16) for item in drawn())
        failed = [(1, 1, 6)]
        answer = attention8.attend(query, key, value, kernel=Kernel(failed))
        self.assertEqual(answer.dtype, torch.bfloat16)
        truth = exact(query, key, value)
        self.assertTrue(torch.equal(answer[1, 1, 6], truth[1, 1, 6].to(torch.bfloat16)))

    def test_every_model_asks_the_kernel_through_here(self):
        # A call written beside this module would bring the black clips back for its model.
        direct = []
        for path in sorted(ROOT.rglob('*.py')):
            if path.name == 'attention8.py' or 'tests' in path.parts:
                continue
            for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                if re.search(r'\bint8_attention(_masked)?\(', line):
                    direct.append(f'{path.relative_to(ROOT)}:{number}')
        self.assertEqual(direct, [])
        models = sorted((ROOT / 'models').glob('*.py'))
        users = [path.name for path in models if 'attention8.attend(' in path.read_text(encoding='utf-8')]
        self.assertEqual(users, ['minimax_h3.py', 'moss_image.py', 'wan_block.py', 'wan_scail2.py'])


@unittest.skipUnless(kernel_ready(), 'the INT8 attention kernel runs on the GPU')
class KernelTests(unittest.TestCase):
    def test_the_rows_the_kernel_itself_fails_on_are_answered(self):
        # Eight queries of the pass that failed (head 36, tokens 3887 to 3894 of block 33 of the low
        # noise model) and one key in 108 of theirs: enough for comfy-kitchen 0.2.41 to fail on seven.
        # (Kept as text: an update refuses an archive that holds a file of weights, whatever is in it.)
        import base64
        import json

        import comfy_kitchen
        import numpy

        kept = json.loads(FIXTURE.read_text(encoding='utf-8'))

        def tensor(name):
            numbers = numpy.frombuffer(base64.b64decode(kept[name]), dtype='<f2').reshape(kept['shapes'][name])
            return torch.from_numpy(numbers.copy()).to('cuda', torch.bfloat16)

        query, key = tensor('queries'), tensor('keys')
        torch.manual_seed(0)
        value = torch.randn(key.shape, device='cuda').to(torch.bfloat16)
        with torch.inference_mode():
            raw = comfy_kitchen.int8_attention(query, key, value)
            failed = ~torch.isfinite(raw.float().sum(-1))
            if not bool(failed.any()):
                self.skipTest('this comfy-kitchen answers these rows: the repair may have had its day')
            answer = attention8.attend(query, key, value)
            truth = F.scaled_dot_product_attention(query.float(), key.float(), value.float())
        self.assertTrue(bool(torch.isfinite(answer).all()))
        self.assertTrue(torch.allclose(answer[failed].float(), truth[failed], atol=0.02))
        self.assertTrue(torch.equal(answer[~failed], raw[~failed]))
        # What the rows that fail have in common: every score of theirs far below zero (-107 for
        # the best score of the best of them here). The exact attention answers such rows.
        best = (query[0, 0].float() @ key[0, 0].float().T / 128**0.5).max(-1).values
        self.assertLess(best[failed[0, 0]].max().item(), -50)


if __name__ == '__main__':
    unittest.main()
