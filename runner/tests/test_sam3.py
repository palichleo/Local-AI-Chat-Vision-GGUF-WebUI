import unittest
from types import SimpleNamespace
from unittest.mock import patch

import torch

from runner.models import sam3
from runner.video import identity


TRUNK = 'backbone.vision_backbone.trunk.'


class NameTests(unittest.TestCase):
    def test_the_files_names_become_transformers_names(self):
        for key, wanted in (
            ('backbone.vision_backbone.trunk.pos_embed', sam3.POSITIONS),
            (TRUNK + 'blocks.3.norm2.weight', 'vision_encoder.backbone.layers.3.layer_norm2.weight'),
            (TRUNK + 'blocks.3.attn.proj.bias', 'vision_encoder.backbone.layers.3.attention.o_proj.bias'),
            ('backbone.vision_backbone.convs.1.conv_3x3.weight', 'vision_encoder.neck.fpn_layers.1.proj2.weight'),
            (
                'backbone.vision_backbone.convs.0.dconv_2x2_1.bias',
                'vision_encoder.neck.fpn_layers.0.scale_layers.2.bias',
            ),
            ('backbone.language_backbone.encoder.ln_final.bias', 'text_encoder.text_model.final_layer_norm.bias'),
            ('backbone.language_backbone.resizer.weight', 'text_projection.weight'),
            (
                'transformer.decoder.layers.2.ca_text.out_proj.weight',
                'detr_decoder.layers.2.text_cross_attn.o_proj.weight',
            ),
            ('transformer.decoder.layers.2.norm1.bias', 'detr_decoder.layers.2.vision_cross_attn_layer_norm.bias'),
            ('transformer.decoder.presence_token_head.layers.2.weight', 'detr_decoder.presence_head.layer3.weight'),
            ('transformer.decoder.boxRPB_embed_y.layers.0.bias', 'detr_decoder.box_rpb_embed_y.layer1.bias'),
            ('dot_prod_scoring.prompt_mlp.layers.1.weight', 'dot_product_scoring.text_mlp.layer2.weight'),
            ('segmentation_head.mask_predictor.mask_embed.layers.0.bias', 'mask_decoder.mask_embedder.layers.0.bias'),
            ('segmentation_head.cross_attend_prompt.out_proj.bias', 'mask_decoder.prompt_cross_attn.o_proj.bias'),
        ):
            self.assertEqual(sam3.renamed(key), wanted)

    def test_queries_keys_and_values_stored_as_one_matrix_are_three_names(self):
        self.assertEqual(
            sam3.renamed('backbone.vision_backbone.trunk.blocks.0.attn.qkv.weight'),
            tuple(f'vision_encoder.backbone.layers.0.attention.{part}_proj.weight' for part in 'qkv'),
        )
        self.assertEqual(
            sam3.renamed('backbone.language_backbone.encoder.transformer.resblocks.5.attn.in_proj_bias'),
            tuple(f'text_encoder.text_model.encoder.layers.5.self_attn.{part}_proj.bias' for part in 'qkv'),
        )
        self.assertEqual(
            sam3.renamed('transformer.encoder.layers.1.cross_attn_image.in_proj_weight'),
            tuple(f'detr_encoder.layers.1.cross_attn.{part}_proj.weight' for part in 'qkv'),
        )

    def test_what_the_tracker_alone_reads_is_left_out(self):
        self.assertIsNone(sam3.renamed('backbone.vision_backbone.propagation_convs.0.conv_1x1.weight'))
        self.assertIsNone(sam3.renamed('backbone.vision_backbone.interactive_convs.2.conv_3x3.bias'))
        self.assertIsNone(sam3.renamed('geometry_encoder.points_direct_project.weight'))
        header = {
            '__metadata__': {},
            'tracker.model.maskmem_tpos_enc': {'shape': [7, 1, 1, 64]},
            'detector.backbone.vision_backbone.interactive_convs.0.conv_1x1.bias': {'shape': [256]},
            'detector.transformer.decoder.query_embed.weight': {'shape': [200, 256]},
            'detector.transformer.decoder.layers.0.self_attn.in_proj_weight': {'shape': [768, 256]},
        }
        self.assertEqual(
            sam3.names(header),
            {
                'detr_decoder.query_embed.weight': ('detector.transformer.decoder.query_embed.weight', None),
                **{
                    f'detr_decoder.layers.0.self_attn.{part}_proj.weight': (
                        'detector.transformer.decoder.layers.0.self_attn.in_proj_weight',
                        third,
                    )
                    for third, part in enumerate('qkv')
                },
            },
        )

    def test_a_file_of_another_model_is_refused(self):
        header = {
            'detector.transformer.decoder.query_embed.weight': {'shape': [200, 256]},
            'detector.transformer.decoder.layers.0.self_attn.in_proj_weight': {'shape': [768, 256]},
            'detector.backbone.vision_backbone.trunk.pos_embed': {'shape': [1, 577, 1024]},
        }
        wanted = {
            'detr_decoder.query_embed.weight': (200, 256),
            **{f'detr_decoder.layers.0.self_attn.{part}_proj.weight': (256, 256) for part in 'qkv'},
            # Stored with one position more, for a class token the model does not have.
            sam3.POSITIONS: (1, 576, 1024),
            # Absent from a SAM 3.1 file: the level of features it has no use for.
            'vision_encoder.neck.fpn_layers.3.proj1.weight': (256, 1024, 1, 1),
        }
        self.assertEqual(len(sam3.validate_layout(header, wanted)), 5)
        with self.assertRaisesRegex(ValueError, 'missing'):
            sam3.validate_layout(header, dict(wanted, **{'detr_decoder.reference_points.weight': (200, 4)}))
        with self.assertRaisesRegex(ValueError, 'size'):
            sam3.validate_layout(header, dict(wanted, **{'detr_decoder.query_embed.weight': (100, 256)}))
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            sam3.validate_layout(dict(header, **{'detector.new.weight': {'shape': [1]}}), wanted)


class CacheTests(unittest.TestCase):
    def test_a_cache_is_found_under_the_decorators_that_wrap_it(self):
        from functools import wraps

        from transformers.pytorch_utils import compile_compatible_method_lru_cache

        def outer(function):
            @wraps(function)
            def wrapper(*args):
                return function(*args)

            return wrapper

        calls = []

        @outer
        @compile_compatible_method_lru_cache(maxsize=2)
        def table(size):
            calls.append(size)
            return size

        table(3), table(3)
        self.assertEqual(calls, [3])
        found = list(sam3._caches(table))
        self.assertTrue(found)
        for cache in found:
            cache.cache_clear()
        table(3)
        self.assertEqual(calls, [3, 3])
        self.assertEqual(list(sam3._caches(len)), [])


class PromptTests(unittest.TestCase):
    def test_a_prompt_is_phrases_apart_by_commas_each_naming_one_object_unless_said(self):
        self.assertEqual(sam3.phrases('girl, handkerchief'), [('girl', 1), ('handkerchief', 1)])
        self.assertEqual(sam3.phrases(' dancer : 3 ,, (red apple) '), [('dancer', 3), ('red apple', 1)])
        self.assertEqual(sam3.phrases('person:0'), [('person', 1)])
        self.assertEqual(sam3.phrases(' , '), [])

    def test_a_phrase_is_start_tokens_end_then_padding_the_model_does_not_read(self):
        def pieces(text, add_special_tokens):
            return {'input_ids': list(range(100, 100 + len(text.split())))}

        pieces.bos_token_id, pieces.eos_token_id = 49406, 49407
        ids, mask = sam3.token_ids('a b c', pieces)
        self.assertEqual(tuple(ids.shape), (1, sam3.TOKENS))
        self.assertEqual(ids[0, :6].tolist(), [49406, 100, 101, 102, 49407, 0])
        self.assertEqual(mask[0].tolist(), [1] * 5 + [0] * 27)
        ids, mask = sam3.token_ids(' '.join('x' * 60), pieces)
        self.assertEqual(ids[0, -1].item(), 49407)
        self.assertEqual(mask.sum().item(), sam3.TOKENS)


class DetectTests(unittest.TestCase):
    def detect(self, logits, present, **options):
        masks = torch.arange(3.0).view(1, 3, 1, 1).expand(1, 3, 2, 2)

        def model(vision_embeds, text_embeds, attention_mask):
            self.assertEqual(tuple(text_embeds.pooler_output.shape), (1, 32, 8))
            return SimpleNamespace(
                pred_logits=torch.tensor([logits]), presence_logits=torch.tensor([[present]]), pred_masks=masks
            )

        features = SimpleNamespace(fpn_hidden_states=[torch.zeros(1, 4, 2, 2)])
        text = SimpleNamespace(pooler_output=torch.zeros(1, 32, 8))
        return sam3.detect(model, features, text, torch.ones(1, 32), **options)[0]

    def test_objects_come_best_first_above_the_score_asked(self):
        scores, masks = self.detect([0.0, 3.0, -3.0], -2.0, threshold=0.4, most=3)
        self.assertEqual([round(value, 2) for value in scores.tolist()], [0.95, 0.5])
        # The second query's mask first, then the first one's; probabilities.
        self.assertTrue(torch.allclose(masks[:, 0, 0], torch.tensor([1.0, 0.0]).sigmoid()))
        scores, _masks = self.detect([0.0, 3.0, -3.0], -2.0, threshold=0.4, most=1)
        self.assertEqual(len(scores), 1)

    def test_the_estimate_that_the_phrase_names_anything_counts_only_when_asked(self):
        scores, _masks = self.detect([0.0, 3.0, -3.0], -2.0, threshold=0.4, most=3, presence=True)
        self.assertEqual(len(scores), 0)


def mask(*rows, size=8):
    """A square mask of probabilities, lit on the rows given."""
    picture = torch.zeros(size, size)
    for row in rows:
        picture[row] = 1.0
    return picture


class FollowTests(unittest.TestCase):
    def test_a_candidate_that_a_better_one_covers_is_not_another_object(self):
        whole, part, apart = mask(0, 1, 2, 3) > 0.5, mask(1) > 0.5, mask(6) > 0.5
        kept = identity.distinct([(0.8, 1, part), (0.9, 0, whole), (0.7, 1, apart)])
        self.assertEqual([(score, phrase) for score, phrase, _solid in kept], [(0.9, 0), (0.7, 1)])
        self.assertEqual(identity.overlap(whole, part), 1.0)
        self.assertEqual(identity.overlap(whole, apart), 0.0)

    def test_a_mask_takes_the_place_of_the_object_it_covers_best(self):
        left, right = mask(0, 1) > 0.5, mask(6, 7) > 0.5
        before = {0: left, 1: right}
        # Found in the other order: each keeps its place.
        self.assertEqual(identity.assigned([mask(5, 6, 7) > 0.5, mask(0) > 0.5], before, 2), {1: 0, 0: 1})
        # A new object takes a free place, never one more than the phrase may name.
        self.assertEqual(identity.assigned([left, mask(4) > 0.5], {0: left}, 2), {0: 0, 1: 1})
        self.assertEqual(identity.assigned([left, mask(4) > 0.5], {0: left}, 1), {0: 0})
        self.assertEqual(identity.assigned([], before, 2), {})

    def follow(self, script, texts):
        """A Follower fed one frame after the other; script[frame][phrase] = [(score, mask)]."""
        calls = {'frame': 0}

        def image_features(model, pictures):
            calls['frame'] += pictures.shape[0]
            return SimpleNamespace(first=calls['frame'] - pictures.shape[0], count=pictures.shape[0])

        def detect(model, features, text, _mask, threshold, most):
            found = []
            for frame in range(features.first, features.first + features.count):
                items = [item for item in script[frame].get(text, []) if item[0] > threshold][:most]
                scores = torch.tensor([score for score, _mask in items])
                masks = torch.stack([item for _score, item in items]) if items else torch.zeros(0, 8, 8)
                found.append((scores, masks))
            return found

        follower = identity.Follower(None, [(text, None, most) for text, most in texts])
        with patch.object(sam3, 'image_features', image_features), patch.object(sam3, 'detect', detect):
            follower.feed(torch.zeros(2, 3, 4, 4))
            follower.feed(torch.zeros(len(script) - 2, 3, 4, 4))
        return follower

    def test_objects_are_followed_frame_after_frame(self):
        girl, scarf, cloth = mask(0, 1, 2, 3), mask(0), mask(6)
        follower = self.follow(
            [
                # The scarf on her head fits "cloth" too: it is hers, not another object.
                {'girl': [(0.97, girl)], 'cloth': [(0.87, scarf)]},
                {'girl': [(0.97, girl)], 'cloth': [(0.91, cloth), (0.6, scarf)]},
                # Fitting the phrase less well for a frame, an object already followed stays.
                {'girl': [(0.97, girl)], 'cloth': [(0.3, cloth)]},
                {'girl': [(0.3, girl)]},
            ],
            [('girl', 1), ('cloth', 1)],
        )
        self.assertEqual([sorted(frame) for frame in follower.frames], [[0], [0, 1], [0, 1], [0]])
        self.assertEqual(follower.scores[2], {0: 0.97, 1: 0.3})
        self.assertTrue(torch.equal(follower.frames[1][1].float(), cloth))
        self.assertEqual(identity.order(follower.frames, follower.count), [0, 1])

    def test_an_object_not_seen_yet_needs_the_full_score(self):
        follower = self.follow([{'girl': [(0.4, mask(1))]}, {'girl': [(0.45, mask(1))]}, {}], [('girl', 1)])
        self.assertEqual(follower.frames, [{}, {}, {}])
        self.assertEqual(identity.order(follower.frames, follower.count), [])

    def test_two_objects_of_one_phrase_keep_their_places(self):
        one, two = mask(0, 1), mask(5, 6)
        follower = self.follow(
            [{'dancer': [(0.9, one), (0.8, two)]}, {'dancer': [(0.9, two), (0.8, one)]}, {'dancer': [(0.9, two)]}],
            [('dancer', 2)],
        )
        self.assertTrue(torch.equal(follower.frames[1][0].float(), one))
        self.assertTrue(torch.equal(follower.frames[1][1].float(), two))
        self.assertEqual(sorted(follower.frames[2]), [1])


class ColourTests(unittest.TestCase):
    def column(self, *columns, size=8):
        picture = torch.zeros(size, size)
        for column in columns:
            picture[:, column] = 1.0
        return picture

    def test_colours_go_to_the_objects_first_seen_then_from_left_to_right(self):
        frames = [{2: self.column(6)}, {0: self.column(5), 1: self.column(1), 2: self.column(6)}, {}]
        self.assertEqual(identity.order(frames, 4), [2, 1, 0])
        self.assertEqual(identity.order([{0: torch.zeros(8, 8)}], 1), [])

    def test_a_frame_is_painted_in_the_palette_the_first_object_over_the_others(self):
        frame = {0: self.column(0, 1, 2, 3), 1: self.column(3, 4)}
        picture = identity.coloured(frame, [0, 1], 16, 16)
        self.assertEqual(tuple(picture.shape), (3, 16, 16))
        blue, red = identity.PALETTE[0], identity.PALETTE[1]
        self.assertEqual(tuple(picture[:, 8, 2].tolist()), blue)
        # Where both are, the first shows.
        self.assertEqual(tuple(picture[:, 8, 6].tolist()), blue)
        self.assertEqual(tuple(picture[:, 8, 9].tolist()), red)
        self.assertEqual(tuple(picture[:, 8, 14].tolist()), (1.0, 1.0, 1.0))
        dark = identity.coloured({}, [0, 1], 4, 4, identity.BLACK)
        self.assertTrue((dark == -1).all())
        # An object of the video that this frame does not show leaves the others their colours.
        only = identity.coloured({1: self.column(3, 4)}, [0, 1], 16, 16)
        self.assertEqual(tuple(only[:, 8, 7].tolist()), red)


if __name__ == '__main__':
    unittest.main()
