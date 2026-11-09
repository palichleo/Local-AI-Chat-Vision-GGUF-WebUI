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
        calls=[]
        cuda=SimpleNamespace(is_initialized=lambda:True,synchronize=lambda:calls.append('sync'),
            empty_cache=lambda:calls.append('empty'),memory_allocated=lambda:0 if 'blas' in calls else 8519680)
        torch=SimpleNamespace(cuda=cuda,_C=SimpleNamespace(_cuda_clearCublasWorkspaces=lambda:calls.append('blas')))
        with patch.dict(sys.modules,torch=torch):self.assertEqual(release(),dict(released=True,allocatedGiB=0))
        self.assertLess(calls.index('sync'),calls.index('blas'))

    def test_ready_errors_recovery_and_shutdown_without_heavy_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'config.json'
            config.write_text(json.dumps({k:str(Path(directory)/k) for k in ('tokenizerPath','cacheRoot','outputRoot')}))
            code='import sys;sys.path.insert(0,sys.argv.pop(1));from runner.__main__ import main;main()'
            result=subprocess.run([sys.executable,'-c',code,str(Path.cwd()),'--config',str(config)],
                                  input='bad json\n{"id":"a","method":"diagnostics","params":{}}\n'
                                        '{"id":"b","method":"release","params":{}}\n'
                                        '{"id":"c","method":"shutdown","params":{}}\n',
                                  text=True,capture_output=True,timeout=15)
            self.assertEqual(result.returncode,0,result.stderr)
            rows=[json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(rows[0]['event'],'ready')
            self.assertEqual(rows[0]['protocol'],1)
            self.assertIsInstance(rows[0]['capabilities']['ltx25']['ready'],bool)
            self.assertEqual(rows[0]['capabilities']['ltx25']['mediaType'],'video')
            self.assertIn('error',rows[1])
            self.assertFalse(rows[2]['result']['cudaInitialized'])
            self.assertFalse(rows[2]['result']['torchImported'])
            self.assertEqual(rows[3]['result'],dict(released=True,allocatedGiB=0))

    def test_generate_releases_before_ack_and_dependency_logs_go_to_stderr(self):
        source=io.StringIO('{"id":1,"method":"generate","params":{}}\n')
        destination=io.StringIO(); calls=[]
        def generate(job,config,progress):
            print('dependency output')
            progress(stage='denoising',step=1,total=1)
            calls.append('generated')
            return {'jobId':'j','outputs':[],'metadata':{}}
        def release():calls.append('released');return dict(released=True,allocatedGiB=0)
        with patch('runner.protocol.generate',generate),patch('runner.protocol.release',release),patch('sys.stderr',io.StringIO()):
            serve({},source,destination)
        rows=[json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(calls[:2],['generated','released'])
        self.assertEqual(rows[1],{'event':'progress','id':1,'data':{'stage':'denoising','step':1,'total':1}})
        self.assertEqual(rows[2]['result']['jobId'],'j')

    def test_failed_generate_cleans_up_and_can_receive_next_request(self):
        source=io.StringIO('{"id":1,"method":"generate","params":{}}\n{"id":2,"method":"release","params":{}}\n')
        destination=io.StringIO();calls=[]
        def fail(*args):raise RuntimeError('simulated OOM')
        with patch('runner.protocol.generate',fail),patch('runner.protocol.release',lambda:(calls.append('release') or dict(released=True,allocatedGiB=0))):
            serve({},source,destination)
        rows=[json.loads(line) for line in destination.getvalue().splitlines()]
        self.assertEqual(rows[1]['error']['message'],'simulated OOM')
        self.assertTrue(rows[2]['result']['released'])
        self.assertGreaterEqual(len(calls),2)

    def test_architecture_preflight_imports_never_initialize_cuda(self):
        code='''import sys
sys.path.insert(0,sys.argv[1])
import torch
def forbid(*args,**kwargs):
    raise AssertionError('Preflight attempted CUDA initialization')
torch.cuda._lazy_init=forbid
from runner.models.shapes import validate_shapes
try:validate_shapes(dict(model={},textEncoder={},vae={}))
except ValueError:pass
assert not torch.cuda.is_initialized()
assert 'sageattention' not in sys.modules
'''
        result=subprocess.run([sys.executable,'-s','-c',code,str(Path.cwd())],text=True,capture_output=True,timeout=60)
        self.assertEqual(result.returncode,0,result.stderr)


if __name__=='__main__':unittest.main()
