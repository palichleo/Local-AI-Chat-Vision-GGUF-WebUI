import builtins
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from runner import engine, warm
from runner.contracts import validate_config
from runner.protocol import serve

# Modules of the standard library nothing here imports: what a « creation » imports in these tests.
LIGHT = ('colorsys', 'graphlib', 'stringprep')
# A library that takes its time: its import ends when the test says so.
SLOW = 'warm_slow_library'


def _forget(*names):
    for name in names:
        sys.modules.pop(name, None)


def _settle():
    """The background import, to its end."""
    warm._thread.join(20)
    assert not warm._thread.is_alive()


def _until(condition):
    limit = time.perf_counter() + 10
    while not condition():
        assert time.perf_counter() < limit
        time.sleep(0.005)


class WarmTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.config = dict(cacheRoot=self.folder.name, outputRoot=self.folder.name)
        self.addCleanup(setattr, warm, '_thread', None)
        warm._thread = None
        # (PyTorch is not what is tested: nothing heavy is imported here.)
        patch = mock.patch.object(warm, 'ALWAYS', ())
        patch.start()
        self.addCleanup(patch.stop)
        _forget(*LIGHT, SLOW)
        self.addCleanup(_forget, *LIGHT, SLOW)

    def kept(self):
        return json.loads((Path(self.folder.name) / warm.NAME).read_text(encoding='utf-8'))

    def test_a_library_every_family_computes_with_that_cannot_be_imported_is_said(self):
        # (0.6.110) The application no longer imports them all before every start of the worker: one
        # that does not open is said by the worker, and the application checks its environment.
        (Path(self.folder.name) / warm.NAME).write_text(
            json.dumps(dict(krea2=['warm_library_noted_and_gone', LIGHT[0]])), encoding='utf-8'
        )
        said = []

        def failed(name, error):
            said.append((name, type(error).__name__))
            raise RuntimeError('the application is gone')

        with mock.patch.object(warm, 'ALWAYS', ('warm_library_that_is_not_there',)):
            self.assertTrue(warm.start(dict(self.config, warm=True), failed=failed))
            _settle()
        # One nothing is created without: said. One noted at an earlier creation and gone since (an
        # update of the libraries): passed over, as before. Saying it never stops the rest.
        self.assertEqual(said, [('warm_library_that_is_not_there', 'ModuleNotFoundError')])
        self.assertIn(LIGHT[0], sys.modules)

    def keep(self, **families):
        (Path(self.folder.name) / warm.NAME).write_text(json.dumps(families), encoding='utf-8')

    def slow(self):
        """A worker importing SLOW in the background, stopped inside it; what lets it end."""
        libraries = tempfile.TemporaryDirectory()
        self.addCleanup(libraries.cleanup)
        (Path(libraries.name) / (SLOW + '.py')).write_text(
            'import builtins\nbuiltins.warm_test_gate.wait(10)\nDONE = True\n', encoding='utf-8'
        )
        sys.path.insert(0, libraries.name)
        self.addCleanup(sys.path.remove, libraries.name)
        gate = builtins.warm_test_gate = threading.Event()
        self.addCleanup(delattr, builtins, 'warm_test_gate')
        self.addCleanup(lambda: (gate.set(), _settle()))
        self.keep(krea2=[SLOW, 'colorsys'])
        self.assertTrue(warm.start(self.config | {'warm': True}))
        _until(lambda: SLOW in sys.modules)
        return gate

    def test_a_creation_says_what_it_imported_and_the_next_start_imports_it(self):
        with warm.watch(self.config, dict(pipeline='krea2')):
            import colorsys  # noqa: F401
        self.assertEqual(self.kept(), {'krea2': ['colorsys']})
        # Another family beside it, and what a later creation adds to the first: nothing is lost.
        with warm.watch(self.config, dict(pipeline='ltx25')):
            import graphlib  # noqa: F401
        _forget('colorsys')
        with warm.watch(self.config, dict(pipeline='krea2')):
            import colorsys  # noqa: F401, F811
        self.assertEqual(self.kept(), {'krea2': ['colorsys'], 'ltx25': ['graphlib']})
        # The next worker: imported in the background as it starts, before any creation.
        _forget(*LIGHT)
        self.assertTrue(warm.start(self.config | {'warm': True}))
        _settle()
        self.assertIn('colorsys', sys.modules)
        self.assertIn('graphlib', sys.modules)
        # Once in a process.
        self.assertFalse(warm.start(self.config | {'warm': True}))

    def test_what_the_check_before_a_creation_imports_is_kept_too(self):
        # The application asks for the check first, and the libraries are imported there.
        def check(job, config):
            import colorsys  # noqa: F401

            return dict(ready=True)

        def refuse(job, config):
            import graphlib  # noqa: F401

            raise ValueError('Invalid job')

        with mock.patch.object(engine, '_preflight', check):
            self.assertEqual(engine.preflight(dict(pipeline='krea2'), self.config), dict(ready=True))
        self.assertEqual(self.kept(), {'krea2': ['colorsys']})
        # A check that refuses the job keeps nothing of it.
        with mock.patch.object(engine, '_preflight', refuse), self.assertRaises(ValueError):
            engine.preflight(dict(pipeline='ltx25'), self.config)
        self.assertEqual(self.kept(), {'krea2': ['colorsys']})

    def test_nothing_is_imported_unless_asked(self):
        with warm.watch(self.config, dict(pipeline='krea2')):
            import colorsys  # noqa: F401
        _forget(*LIGHT)
        self.assertFalse(warm.start(self.config))
        self.assertFalse(warm.start(self.config | {'warm': False}))
        self.assertIsNone(warm._thread)
        self.assertNotIn('colorsys', sys.modules)
        # And a request finds nothing to wait for.
        with warm.aside():
            pass

    def test_a_module_gone_since_is_passed_over(self):
        self.keep(krea2=['no_such_library_at_all', 'colorsys', 7], x='not a list')
        self.assertTrue(warm.start(self.config | {'warm': True}))
        _settle()
        self.assertIn('colorsys', sys.modules)

    def test_a_file_that_cannot_be_read_starts_with_nothing(self):
        (Path(self.folder.name) / warm.NAME).write_text('{', encoding='utf-8')
        self.assertTrue(warm.start(self.config | {'warm': True}))
        _settle()
        with warm.watch(self.config, dict(pipeline='krea2')):
            import colorsys  # noqa: F401
        self.assertEqual(self.kept(), {'krea2': ['colorsys']})

    def test_a_creation_that_fails_keeps_nothing(self):
        with self.assertRaises(RuntimeError):
            with warm.watch(self.config, dict(pipeline='krea2')):
                import colorsys  # noqa: F401

                raise RuntimeError('out of memory')
        self.assertFalse((Path(self.folder.name) / warm.NAME).exists())
        # Nor one whose job is not even a job.
        _forget(*LIGHT)
        with warm.watch(self.config, None):
            import colorsys  # noqa: F401, F811
        self.assertFalse((Path(self.folder.name) / warm.NAME).exists())

    def test_our_own_modules_those_made_on_the_fly_and_comfyui_are_not_kept(self):
        # (A pipeline refuses to end with ComfyUI imported: prepared at the start, every creation failed.)
        named = ('comfy', 'comfy.sd', 'runner.not_a_real_one')
        with warm.watch(self.config, dict(pipeline='krea2')):
            sys.modules['made_on_the_fly'] = types.ModuleType('made_on_the_fly')
            for name in named:
                module = types.ModuleType(name)
                module.__spec__ = importlib.machinery.ModuleSpec(name, None)
                sys.modules[name] = module
            import colorsys  # noqa: F401
        self.addCleanup(_forget, 'made_on_the_fly', *named)
        self.assertEqual(self.kept(), {'krea2': ['colorsys']})

    def test_a_request_takes_over_once_the_module_being_imported_is_imported(self):
        gate = self.slow()
        threading.Timer(0.2, gate.set).start()
        began = time.perf_counter()
        with warm.aside():
            # It waited for that library (it would have imported it itself), entirely imported now.
            self.assertGreater(time.perf_counter() - began, 0.15)
            self.assertTrue(sys.modules[SLOW].DONE)
            # The rest is the request's: nothing is imported beside it, however long it takes.
            time.sleep(0.2)
            self.assertNotIn('colorsys', sys.modules)
        # The background import goes on after it.
        _settle()
        self.assertIn('colorsys', sys.modules)

    def test_the_worker_answers_meanwhile_and_only_what_needs_the_libraries_waits(self):
        gate = self.slow()

        def ask(method):
            answers = io.StringIO()
            requests = [dict(id=1, method=method, params={}), dict(id=2, method='shutdown', params={})]
            serve(self.config, io.StringIO(''.join(json.dumps(request) + '\n' for request in requests)), answers)
            return json.loads(answers.getvalue().splitlines()[1])

        # Making room for the chat model, as the application starts: answered at once.
        self.assertEqual(ask('release')['result']['released'], True)
        self.assertIsNone(warm.whole(SLOW))
        # A creation's first check imports: after the library being imported, not beside it.
        threading.Timer(0.2, gate.set).start()
        self.assertEqual(ask('preflight')['error']['code'], 'INVALID_REQUEST')
        self.assertTrue(sys.modules[SLOW].DONE)

    def test_a_request_that_fails_gives_the_turn_back(self):
        self.keep(krea2=['colorsys'])
        answers = io.StringIO()
        requests = [dict(id=1, method='generate', params=dict(not_a='job')), dict(id=2, method='shutdown', params={})]
        serve(
            self.config | {'warm': True},
            io.StringIO(''.join(json.dumps(request) + '\n' for request in requests)),
            answers,
        )
        ready, failed, closed = (json.loads(line) for line in answers.getvalue().splitlines())
        self.assertEqual((ready['event'], failed['error']['code'], closed['id']), ('ready', 'INVALID_REQUEST', 2))
        self.assertEqual(warm._requests, 0)
        _settle()
        self.assertIn('colorsys', sys.modules)

    def test_a_library_being_imported_is_not_there_yet(self):
        # This interpreter marks it as `whole` reads it.
        gate = self.slow()
        self.assertIn(SLOW, sys.modules)
        self.assertIsNone(warm.whole(SLOW))
        gate.set()
        _settle()
        self.assertTrue(warm.whole(SLOW).DONE)
        self.assertIsNone(warm.whole('no_such_library_at_all'))
        # PyTorch in that state: in `sys.modules`, without what the worker asks of it.
        half = types.ModuleType('torch')
        half.__spec__ = importlib.machinery.ModuleSpec('torch', None)
        half.__spec__._initializing = True
        with mock.patch.dict(sys.modules, torch=half):
            self.assertFalse(engine.diagnostics(self.config)['torchImported'])
            # (What the application asks as it closes, or to make room for the chat model.)
            self.assertEqual(engine.release()['allocatedGiB'], 0)
            # Entirely imported, it is looked at again, whatever else is being imported.
            half.__spec__._initializing = False
            half.cuda = types.SimpleNamespace(is_initialized=lambda: False)
            self.assertTrue(engine.diagnostics(self.config)['torchImported'])

    def test_no_read_is_in_progress_while_the_libraries_are_imported(self):
        gate = self.slow()
        # Something that is not a file of the system (the tests of the protocol): nothing to wait for.
        began = time.perf_counter()
        warm.await_input(io.StringIO('{}\n'))
        self.assertLess(time.perf_counter() - began, 1)
        # The worker's pipe: it comes back when a request is there to read, not before.
        read_end, write_end = os.pipe()
        source = os.fdopen(read_end, 'r', encoding='utf-8')
        self.addCleanup(source.close)
        threading.Timer(0.3, os.write, (write_end, b'{}\n')).start()
        began = time.perf_counter()
        warm.await_input(source)
        waited = time.perf_counter() - began
        if sys.platform == 'win32':
            self.assertGreater(waited, 0.25)
        self.assertLess(waited, 5)
        self.assertEqual(source.readline(), '{}\n')
        # The application gone (its end of the pipe closed): the read says so, at once.
        os.close(write_end)
        began = time.perf_counter()
        warm.await_input(source)
        self.assertLess(time.perf_counter() - began, 1)
        self.assertEqual(source.readline(), '')
        self.assertTrue(warm._thread.is_alive())
        gate.set()

    def test_the_wait_ends_with_the_import(self):
        gate = self.slow()
        read_end, write_end = os.pipe()
        source = os.fdopen(read_end, 'r', encoding='utf-8')
        self.addCleanup(source.close)
        self.addCleanup(os.close, write_end)
        threading.Timer(0.3, gate.set).start()
        began = time.perf_counter()
        warm.await_input(source)
        self.assertLess(time.perf_counter() - began, 5)
        _settle()
        # Nothing is imported any more: the worker reads the usual way, without a look at the pipe.
        with mock.patch.object(warm.ctypes, 'windll', None, create=True):
            warm.await_input(source)

    @unittest.skipUnless(sys.platform == 'win32', 'What waited is Windows opening a library.')
    def test_a_worker_waiting_for_its_first_request_imports_meanwhile(self):
        # The real worker on a real pipe, nothing sent to it. numpy's library is one of those that
        # waited for the worker's read: imported 12 s after the start, once a request had come.
        if importlib.util.find_spec('numpy') is None:
            self.skipTest('numpy is not installed here')
        self.keep(krea2=['numpy'])
        code = (
            'import sys, threading, time\n'
            'from runner import warm\n'
            'from runner.protocol import serve\n'
            'warm.ALWAYS = ()\n'
            'def tell():\n'
            "    while warm.whole('numpy') is None:\n"
            '        time.sleep(0.02)\n'
            "    print('imported', file=sys.stderr, flush=True)\n"
            'threading.Thread(target=tell, daemon=True).start()\n'
            'serve(dict(cacheRoot=sys.argv[1], outputRoot=sys.argv[1], warm=True))\n'
        )
        worker = subprocess.Popen(
            [sys.executable, '-s', '-u', '-c', code, self.folder.name],
            cwd=Path(__file__).resolve().parents[2],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
        )
        self.addCleanup(lambda: [stream.close() for stream in (worker.stdin, worker.stdout, worker.stderr)])
        self.addCleanup(worker.kill)
        self.assertEqual(json.loads(worker.stdout.readline())['event'], 'ready')
        said = []
        reader = threading.Thread(target=lambda: said.append(worker.stderr.readline()), daemon=True)
        reader.start()
        reader.join(15)
        self.assertEqual(said, ['imported\n'], 'the import waited for a request')
        # And it still answers: the request is read once it is there.
        worker.stdin.write(json.dumps(dict(id=1, method='shutdown', params={})) + '\n')
        worker.stdin.flush()
        self.assertEqual(json.loads(worker.stdout.readline())['id'], 1)
        self.assertEqual(worker.wait(20), 0)

    def test_the_configuration_takes_the_flag_and_nothing_else_for_it(self):
        self.assertIs(validate_config(self.config | {'warm': True})['warm'], True)
        self.assertNotIn('warm', validate_config(self.config))
        with self.assertRaises(ValueError):
            validate_config(self.config | {'warm': 'yes'})


if __name__ == '__main__':
    unittest.main()
