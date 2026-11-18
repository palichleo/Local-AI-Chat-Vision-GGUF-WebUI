import unittest
from types import SimpleNamespace
from unittest import mock


class KeptModelTests(unittest.TestCase):
    """MiniMax H3 leaves its model on the card for the next video, as LTX 2.5 does (0.6.80)."""

    def job(self, width=768, references=(), **parameters):
        parameters = dict(width=width, height=448, frames=124, **parameters)
        return dict(components={'model': 'model'}, loras=[], references=list(references), parameters=parameters)

    def test_the_model_left_is_taken_back_for_the_same_video_only_and_dropped_when_it_is_no_use(self):
        try:
            import torch  # noqa: F401
        except ImportError:
            self.skipTest('torch is required')
        from runner.models import kept
        from runner.pipelines import minimax_h3 as pipeline

        given, dropped = [], []

        def run(_job, _config, _progress, key, holder):
            given.append(holder[0])
            if holder[0] is None:
                width = key[1][0]
                holder[0] = SimpleNamespace(
                    key=key,
                    # RAM was short for the one of 1344: its steps copied from the file's mapping.
                    locked=width != 1344,
                    # The decode of the one of 1920 did not fit beside the share: it left whole.
                    pool=SimpleNamespace(gpu={} if width == 1920 else {'layer': 1}),
                    allocated=0,
                    drop=lambda: dropped.append(width),
                )
            return 'video'

        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: [path, 1, 1]),
            mock.patch.object(pipeline, '_generate', run),
        ):
            try:
                self.assertEqual(pipeline.generate(self.job(), {}, None), 'video')
                first = kept._kept['minimax_h3']
                self.assertEqual(pipeline.generate(self.job(), {}, None), 'video')
                self.assertEqual((given, dropped), ([None, first], []))
                # Another size, an image to start from, another attention: the model is built for
                # them, so the one left is not taken back.
                pipeline.generate(self.job(width=832), {}, None)
                pipeline.generate(self.job(width=832, references=[{'role': 'start_image'}]), {}, None)
                sparse = self.job(width=832, references=[{'role': 'start_image'}], sparse_attention='vsa')
                pipeline.generate(sparse, {}, None)
                self.assertEqual((given[2:], dropped), ([None, None, None], [768, 832, 832]))
                # A failure leaves nothing for the next video.
                with mock.patch.object(pipeline, '_generate', side_effect=RuntimeError('out of memory')):
                    with self.assertRaises(RuntimeError):
                        job = self.job(width=832, references=[{'role': 'start_image'}], sparse_attention='vsa')
                        pipeline.generate(job, {}, None)
                self.assertEqual((dropped[3:], kept._kept), ([832], {}))
                # Not kept: a model whose steps copied from unlocked memory, nor one whose share left.
                pipeline.generate(self.job(width=1344), {}, None)
                pipeline.generate(self.job(width=1920), {}, None)
                self.assertEqual((dropped[4:], kept._kept), ([1344, 1920], {}))
            finally:
                kept._kept.clear()

    def test_what_is_left_closes_its_file_whatever_the_card_answers(self):
        from runner.pipelines import minimax_h3 as pipeline

        loaded, closed = pipeline.Loaded('key'), []
        loaded.stack.callback(lambda: closed.append(True))

        def clear():
            raise RuntimeError('CUDA error')

        loaded.pool, loaded.dit = SimpleNamespace(clear=clear), object()
        with self.assertRaises(RuntimeError):
            loaded.drop()
        self.assertEqual((closed, loaded.pool, loaded.dit), ([True], None, None))

    def test_the_decode_asks_for_its_decoder_and_more_for_a_larger_picture(self):
        from runner.pipelines.minimax_h3 import decode_gib

        small, large = decode_gib(dict(width=768, height=448)), decode_gib(dict(width=1344, height=768))
        # Measured with the audio VAE beside the decoder: 5.4 and 6.0 GiB (17/11).
        self.assertTrue(5.3 < small < 5.7 and 5.9 < large < 6.3, (small, large))


if __name__ == '__main__':
    unittest.main()
