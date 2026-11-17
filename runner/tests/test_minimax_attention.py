import unittest

import torch

from runner.models import minimax_h3

CUDA = torch.cuda.is_available()


@unittest.skipUnless(CUDA and minimax_h3.int8_attention_ready(), 'the INT8 attention kernel runs on the GPU')
class AttentionInPiecesTests(unittest.TestCase):
    """The dense attention computed a piece of its queries at a time, when its buffers do not fit
    beside the sequence (17/11: 1920 x 1088, and 1344 x 768 with three references, failed there)."""

    def rows(self, count):
        torch.manual_seed(3)
        return [torch.randn(1, count, 4, 128, device='cuda', dtype=torch.bfloat16) for _ in range(3)]

    def whole(self, query, key, value):
        import comfy_kitchen

        answer = comfy_kitchen.int8_attention(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2))
        return answer.transpose(1, 2).flatten(2, 3)

    def test_the_pieces_give_the_answer_of_the_whole_call(self):
        original = minimax_h3.PIECE
        try:
            for count, piece in ((1024, 256), (1000, 256), (700, 128)):
                with self.subTest(rows=count, piece=piece), torch.no_grad():
                    minimax_h3.PIECE = piece
                    query, key, value = self.rows(count)
                    expected = self.whole(query, key, value)
                    got = minimax_h3.Int8Attention.in_pieces(query, key, value)
                    self.assertEqual(got.shape, expected.shape)
                    self.assertTrue(torch.equal(got, expected))
        finally:
            minimax_h3.PIECE = original

    def test_a_call_that_lacks_memory_is_answered_in_pieces(self):
        import comfy_kitchen

        query, key, value = self.rows(1024)
        with torch.no_grad():
            expected = self.whole(query, key, value)
        kernel, calls = comfy_kitchen.int8_attention, []

        def lacking(q, k, v, attn_mask=None):
            calls.append(q.shape[2])
            # The whole sequence does not fit; a piece of its queries does.
            if q.shape[2] == 1024:
                raise torch.OutOfMemoryError('too large')
            return kernel(q, k, v, attn_mask=attn_mask)

        seen = {}

        def project(attn, hidden, rotary):
            return query, key, value

        attn = type('Attn', (), {'to_out': [lambda rows: seen.setdefault('rows', rows), lambda rows: rows]})()
        original, piece = minimax_h3.project, minimax_h3.PIECE
        comfy_kitchen.int8_attention, minimax_h3.project, minimax_h3.PIECE = lacking, project, 256
        try:
            with torch.no_grad():
                minimax_h3.Int8Attention()(attn, torch.zeros(1, 1024, 512, device='cuda', dtype=torch.bfloat16))
        finally:
            comfy_kitchen.int8_attention, minimax_h3.project, minimax_h3.PIECE = kernel, original, piece
        self.assertEqual(calls, [1024, 512, 512])
        self.assertTrue(torch.equal(seen['rows'], expected))


if __name__ == '__main__':
    unittest.main()
