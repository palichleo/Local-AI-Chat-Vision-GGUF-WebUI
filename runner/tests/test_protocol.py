import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner.protocol import serve


class ProtocolTests(unittest.TestCase):
    def test_release_clears_pytorch_blas_workspace_before_ack(self):
        from runner.engine import release

        calls = []
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: calls.append('sync'),
            empty_cache=lambda: calls.append('empty'),
            memory_allocated=lambda: 0 if 'blas' in calls else 8519680,
        )
        torch = SimpleNamespace(cuda=cuda, _C=SimpleNamespace(_cuda_clearCublasWorkspaces=lambda: calls.append('blas')))
        with patch.dict(sys.modules, torch=torch):
            self.assertEqual(release(), dict(released=True, allocatedGiB=0))
        self.assertLess(calls.index('sync'), calls.index('blas'))

    def _engine_torch(self, free_gib=10):
        fractions = []
        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda: (free_gib * 1024**3, 12 * 1024**3),
            memory_reserved=lambda: 0,
            set_per_process_memory_fraction=fractions.append,
            empty_cache=lambda: fractions.append('empty'),
        )
        return SimpleNamespace(cuda=cuda, OutOfMemoryError=type('OutOfMemoryError', (RuntimeError,), {})), fractions

    def _generate(self, torch, attempt):
        from runner import engine

        module = SimpleNamespace(generate=attempt)
        with (
            patch.dict(sys.modules, torch=torch),
            patch.object(engine, 'preflight', lambda job, config: None),
            patch.object(engine, 'validate_config', lambda config: config),
            patch.object(engine, 'pipeline', lambda name: module),
        ):
            return engine.generate({'pipeline': 'any'}, {}, lambda **_: None)

    def test_generation_keeps_pytorch_inside_the_free_video_memory(self):
        torch, fractions = self._engine_torch()
        seen = []
        self.assertEqual(self._generate(torch, lambda *_: seen.append(list(fractions)) or 'video'), 'video')
        self.assertEqual(seen, [[9 / 12]])  # what is free less 1 GiB, while the pipeline runs
        self.assertEqual(fractions, [9 / 12, 1.0])

    def test_generation_that_needs_more_runs_again_without_the_ceiling(self):
        torch, fractions = self._engine_torch()
        attempts = []

        def attempt(*_):
            attempts.append(fractions[-1])
            if len(attempts) == 1:
                raise torch.OutOfMemoryError('CUDA out of memory')
            return 'video'

        self.assertEqual(self._generate(torch, attempt), 'video')
        self.assertEqual(attempts, [9 / 12, 'empty'])
        self.assertEqual(fractions, [9 / 12, 1.0, 'empty'])

    def test_other_failures_lift_the_ceiling_and_are_not_retried(self):
        torch, fractions = self._engine_torch()
        attempts = []

        def attempt(*_):
            attempts.append(1)
            raise ValueError('bad prompt')

        with self.assertRaises(ValueError):
            self._generate(torch, attempt)
        self.assertEqual((len(attempts), fractions), (1, [9 / 12, 1.0]))

    def test_no_ceiling_when_little_video_memory_is_free(self):
        torch, fractions = self._engine_torch(free_gib=3)
        self.assertEqual(self._generate(torch, lambda *_: 'image'), 'image')
        self.assertEqual(fractions, [])

    def test_ready_errors_recovery_and_shutdown_without_heavy_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(
                json.dumps({k: str(Path(directory) / k) for k in ('tokenizerPath', 'cacheRoot', 'outputRoot')})
            )
            code = 'import sys;sys.path.insert(0,sys.argv.pop(1));from runner.__main__ import main;main()'
            result = subprocess.run(
                [sys.executable, '-c', code, str(Path.cwd()), '--config', str(config)],
                input='bad json\n{"id":"a","method":"diagnostics","params":{}}\n'
                '{"id":"b","method":"release","params":{}}\n'
                '{"id":"c","method":"shutdown","params":{}}\n',
                text=True,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(rows[0]['event'], 'ready')
            self.assertEqual(rows[0]['protocol'], 1)
            self.assertIsInstance(rows[0]['capabilities']['ltx25']['ready'], bool)
            self.assertEqual(rows[0]['capabilities']['ltx25']['mediaType'], 'video')
            self.assertIn('error', rows[1])
            self.assertFalse(rows[2]['result']['cudaInitialized'])
            self.assertFalse(rows[2]['result']['torchImported'])
            self.assertEqual(rows[3]['result'], dict(released=True, allocatedGiB=0))

    def test_generate_releases_before_ack_and_dependency_logs_go_to_stderr(self):
        source = io.StringIO('{"id":1,"method":"generate","params":{}}\n')
        destination = io.StringIO()
        calls = []

        def generate(job, config, progress):
            print('dependency output')
            progress(stage='denoising', step=1, total=1)
            calls.append('generated')
            return {'jobId': 'j', 'outputs': [], 'metadata': {}}

        def release(between=False):
            # The worker's own release: what the generation left for the next one stays.
            calls.append('released between' if between else 'released')
            return dict(released=True, allocatedGiB=0)

        with (
            patch('runner.protocol.generate', generate),
            patch('runner.protocol.release', release),
            patch('sys.stderr', io.StringIO()),
        ):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(calls, ['generated', 'released between', 'released'])
        self.assertEqual(rows[1], {'event': 'progress', 'id': 1, 'data': {'stage': 'denoising', 'step': 1, 'total': 1}})
        self.assertEqual(rows[2]['result']['jobId'], 'j')

    def test_what_a_generation_leaves_on_the_card_stays_until_a_release_is_asked(self):
        from runner import engine
        from runner.models import kept

        dropped = []
        held = {'bytes': 3 * 1024**3}
        cuda = SimpleNamespace(
            is_initialized=lambda: True,
            synchronize=lambda: None,
            empty_cache=lambda: None,
            memory_allocated=lambda: held['bytes'],
        )

        def model(name, key):
            def drop():
                dropped.append(name)
                held['bytes'] = 0

            return SimpleNamespace(key=key, allocated=3 * 1024**3, drop=drop)

        with patch.dict(sys.modules, torch=SimpleNamespace(cuda=cuda, _C=SimpleNamespace())):
            kept.put('ltx25', model('ltx25', 'a'))
            try:
                # After a generation: the model stays, and its memory is not a failed cleanup.
                self.assertEqual(engine.release(between=True), dict(released=True, allocatedGiB=0))
                self.assertEqual(dropped, [])
                # The same model is taken back for the same files; anything else makes it leave.
                found = kept.take('ltx25', 'a')
                self.assertEqual((found.key, dropped), ('a', []))
                kept.put('ltx25', found)
                self.assertIsNone(kept.take('ltx25', 'other files'))
                self.assertEqual(dropped, ['ltx25'])
                held['bytes'] = 3 * 1024**3
                kept.put('ltx25', model('ltx25', 'a'))
                self.assertFalse(kept.only('ltx25'))
                self.assertTrue(kept.only('krea2'))
                self.assertEqual(dropped, ['ltx25', 'ltx25'])
                self.assertFalse(kept.only('krea2'))
                # The application asks (chat model back, stop, close): everything leaves.
                held['bytes'] = 3 * 1024**3
                kept.put('ltx25', model('ltx25', 'a'))
                self.assertEqual(engine.release(), dict(released=True, allocatedGiB=0))
                self.assertEqual(dropped, ['ltx25'] * 3)
                # More than what was left is still a failed cleanup.
                held['bytes'] = 4 * 1024**3
                kept.put('ltx25', SimpleNamespace(key='a', allocated=3 * 1024**3, drop=lambda: None))
                with self.assertRaisesRegex(RuntimeError, 'GPU cleanup incomplete: 1.0'):
                    engine.release(between=True)
            finally:
                kept._kept.clear()

    def test_the_ceiling_counts_what_the_process_already_holds(self):
        from runner import engine

        torch, fractions = self._engine_torch(free_gib=3)
        # 3 GiB free and 7 held by the model left on the card: the ceiling is on the ten, less the margin.
        torch.cuda.memory_reserved = lambda: 7 * 1024**3
        self.assertTrue(engine._vram_ceiling(torch))
        self.assertAlmostEqual(fractions[0], 9 / 12)

    def test_release_is_told_the_room_the_chat_model_needs(self):
        source = io.StringIO(
            '{"id":1,"method":"release","params":{"keepAbove":1000}}\n'
            '{"id":2,"method":"release","params":{"keepAbove":"all"}}\n'
            '{"id":3,"method":"unload","params":{"keepAbove":1000}}\n'
        )
        destination = io.StringIO()
        asked = []

        def release(keep_above=None):
            asked.append(keep_above)
            return dict(released=True, allocatedGiB=0, freedRamGiB=0)

        with patch('runner.protocol.release', release), patch('runner.protocol._log_failure', lambda *args: None):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        # The room asked, then the plain release of a worker that stops.
        self.assertEqual(asked, [1000, None])
        self.assertTrue(rows[1]['result']['released'])
        self.assertEqual(rows[2]['error']['message'], 'Invalid release parameters')
        self.assertEqual(rows[3]['error']['message'], 'This method accepts no parameters')

    def test_failed_generate_cleans_up_and_can_receive_next_request(self):
        source = io.StringIO('{"id":1,"method":"generate","params":{}}\n{"id":2,"method":"release","params":{}}\n')
        destination = io.StringIO()
        calls = []

        def fail(*args):
            raise RuntimeError('simulated OOM')

        with (
            patch('runner.protocol.generate', fail),
            patch(
                'runner.protocol.release',
                lambda **_: calls.append('release') or dict(released=True, allocatedGiB=0),
            ),
        ):
            serve({}, source, destination)
        rows = [json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(rows[1]['error']['message'], 'simulated OOM')
        self.assertTrue(rows[2]['result']['released'])
        self.assertGreaterEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
