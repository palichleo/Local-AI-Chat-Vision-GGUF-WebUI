import unittest

import torch

from runner.models import minimax_h3_vae

CUDA = torch.cuda.is_available()


class LayoutTests(unittest.TestCase):
    def test_a_feed_forward_swaps_its_halves_and_a_projection_is_read_per_head(self):
        value = torch.arange(24.0).reshape(12, 2)
        swapped = minimax_h3_vae.transform(value, ('swap_halves',))
        self.assertEqual(swapped.tolist(), torch.cat([value[6:], value[:6]]).tolist())
        # Two heads of [q k v], two rows each: the keys are rows 2-3 and 8-9.
        keys = minimax_h3_vae.transform(value, ('head_qkv', 2, 1))
        self.assertEqual(keys.tolist(), value[[2, 3, 8, 9]].tolist())
        self.assertIs(minimax_h3_vae.transform(value, None), value)

    @unittest.skipUnless(CUDA, 'the models are filled on the GPU')
    def test_a_model_is_filled_on_the_gpu_in_the_precision_asked(self):
        from accelerate import init_empty_weights

        with init_empty_weights():
            model = torch.nn.ModuleDict({'up': torch.nn.Linear(2, 4, bias=False), 'plain': torch.nn.Linear(2, 2)})
        tensors = {'up.weight': torch.arange(8.0).reshape(4, 2), 'plain.weight': torch.ones(2, 2)}
        tensors['plain.bias'] = torch.tensor([3.0, 4.0])
        minimax_h3_vae._fill(model, tensors, torch.bfloat16)
        self.assertEqual(model['up'].weight.device.type, 'cuda')
        self.assertEqual(model['up'].weight.dtype, torch.bfloat16)
        self.assertEqual(model['up'].weight.tolist(), tensors['up.weight'].tolist())
        self.assertEqual(model['plain'].bias.tolist(), [3.0, 4.0])

    @unittest.skipUnless(CUDA, 'the models are filled on the GPU')
    def test_a_tensor_the_file_lacks_is_named(self):
        from accelerate import init_empty_weights

        with init_empty_weights():
            model = torch.nn.ModuleDict({'up': torch.nn.Linear(2, 4, bias=False)})
        with self.assertRaisesRegex(ValueError, 'up.weight'):
            minimax_h3_vae._fill(model, {}, torch.bfloat16)


if __name__ == '__main__':
    unittest.main()
