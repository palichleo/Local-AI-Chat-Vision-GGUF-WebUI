"""MiniMax-H3's own tokens take the ids it was trained with, from a Qwen2.5 or a Qwen3 tokenizer."""

import unittest

from runner.models.minimax_h3_text import EXTRA_TOKENS, align_extra_tokens


class FakeTokenizer:
    """The part of a Hugging Face tokenizer the alignment uses: new tokens take the next ids."""

    def __init__(self, size, known=None):
        self.vocab = {'t' + str(index): index for index in range(size)} | (known or {})
        self.size = max(self.vocab.values()) + 1

    def __len__(self):
        return self.size

    def convert_tokens_to_ids(self, token):
        return self.vocab.get(token)

    def add_special_tokens(self, tokens):
        for token in tokens['additional_special_tokens']:
            if token not in self.vocab:
                self.vocab[token] = self.size
                self.size += 1


class MiniMaxTokens(unittest.TestCase):
    def test_qwen3_and_qwen25_tokenizers_give_the_trained_ids(self):
        # Qwen3 ends at 151668 (</think>), Qwen2.5 at 151664: both end with the same ids.
        for size in (151669, 151665):
            tokenizer = FakeTokenizer(size)
            align_extra_tokens(tokenizer)
            for token, index in EXTRA_TOKENS.items():
                self.assertEqual(tokenizer.convert_tokens_to_ids(token), index, (size, token))

    def test_a_tokenizer_that_has_them_already_is_left_as_it_is(self):
        tokenizer = FakeTokenizer(151669, dict(EXTRA_TOKENS))
        before = dict(tokenizer.vocab)
        align_extra_tokens(tokenizer)
        self.assertEqual(tokenizer.vocab, before)

    def test_a_larger_tokenizer_is_refused_with_what_it_has(self):
        with self.assertRaisesRegex(ValueError, 'expected 151669'):
            align_extra_tokens(FakeTokenizer(151700))


if __name__ == '__main__':
    unittest.main()
