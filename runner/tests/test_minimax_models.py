"""MiniMax-H3: which file a job reads, and in how many steps (0.6.108)."""

import unittest

from runner.pipelines import minimax_h3 as pipeline
from runner.registry import family


def _header(heads=1, gates=False):
    """What tells the checkpoints apart, as their files say it."""
    found = {
        'final_layer.video_out.weight': {'shape': [96 * heads, 5376]},
        'final_layer.audio_out.weight': {'shape': [32 * heads, 5376]},
    }
    if gates:
        found['blocks.0.attn.to_gate_compress.weight'] = {'shape': [5376, 5376]}
    return found


def _job(roles=(), steps=None, **components):
    parameters = {} if steps is None else {'steps': steps}
    return dict(
        parameters=parameters,
        components=dict(model='fl2va.safetensors', **components),
        references=[dict(role=role, path=role + '.png') for role in roles],
    )


class MiniMaxModels(unittest.TestCase):
    def test_a_checkpoint_says_whether_it_is_distilled(self):
        # FastH3 Omni: 32 output heads. FastH3 v2: one head, and the gates of its sparse attention.
        self.assertEqual(pipeline.steps_of(_header(heads=32, gates=True)), 8)
        self.assertEqual(pipeline.steps_of(_header(gates=True)), 8)
        # MiniMax's own FL2VA and Ref2VA: neither.
        self.assertEqual(pipeline.steps_of(_header()), 20)

    def test_the_steps_of_another_kind_of_checkpoint_are_refused_with_the_reason(self):
        self.assertEqual(pipeline.check_steps(_job(steps=20), _header()), 20)
        self.assertEqual(pipeline.check_steps(_job(steps=8), _header(heads=32, gates=True)), 8)
        # A job that does not say (an older record): the checkpoint's own.
        self.assertEqual(pipeline.check_steps(_job(), _header()), 20)
        with self.assertRaisesRegex(ValueError, 'de base.*20 étapes, pas en 8'):
            pipeline.check_steps(_job(steps=8), _header())
        with self.assertRaisesRegex(ValueError, 'distillé.*8 étapes, pas en 20'):
            pipeline.check_steps(_job(steps=20), _header(gates=True))

    def test_reference_images_are_read_by_the_file_the_workflow_names_for_them(self):
        both = dict(referenceModel='ref2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image'], **both)), 'ref2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image', 'reference_image'], **both)), 'ref2va.safetensors')
        # A text alone, start and end images, a video to continue: the model's own file.
        self.assertEqual(pipeline.model_path(_job([], **both)), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['start_image', 'end_image'], **both)), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['source_video'], **both)), 'fl2va.safetensors')
        # A workflow with one file (FastH3 Omni reads everything): that file.
        self.assertEqual(pipeline.model_path(_job(['reference_image'])), 'fl2va.safetensors')
        self.assertEqual(pipeline.model_path(_job(['reference_image'], referenceModel='')), 'fl2va.safetensors')

    def test_the_family_takes_both_step_counts_and_an_optional_second_file(self):
        manifest = family('minimax_h3')
        self.assertEqual(manifest['parameters']['steps']['choices'], [8, 20])
        second = manifest['components']['referenceModel']
        self.assertFalse(second['required'])
        self.assertEqual(second['folder'], 'diffusion_models')
        self.assertEqual(second['signature'], manifest['components']['model']['signature'])


if __name__ == '__main__':
    unittest.main()
