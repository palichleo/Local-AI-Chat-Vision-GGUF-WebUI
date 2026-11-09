"""Optional real-kernel checks: set KREA_TEST_CUDA=1 on a free CUDA GPU."""
from contextlib import nullcontext
import os
from pathlib import Path
import tempfile
import unittest


@unittest.skipUnless(os.environ.get('KREA_TEST_CUDA')=='1','Set KREA_TEST_CUDA=1 for real CUDA kernel checks')
class KernelTests(unittest.TestCase):
    def test_prepared_kernel_cache_and_reference(self):
        import torch
        from safetensors import safe_open
        from safetensors.torch import save_file
        from fast_krea import PreparedWeights,PreparedLinear
        from try_krea import rotation_matrix
        torch.manual_seed(13)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);model=root/'model.safetensors';lora=root/'lora.safetensors'
            q=torch.randint(-100,100,(128,256),dtype=torch.int8);scale=torch.ones(128,1)*.001
            a=torch.randn(8,256)*.02;b=torch.randn(128,8)*.02;bias=torch.randn(128)*.01
            save_file({'q.weight':q,'q.weight_scale':scale,'q.bias':bias},str(model))
            save_file({'q.lora_A.weight':a,'q.lora_B.weight':b},str(lora))
            files={'transformer':model,'loras':[({'strength':.55},lora)]}
            h=rotation_matrix(256,torch,'cuda',torch.float32)
            x=torch.randn(2,8,256,device='cuda',dtype=torch.bfloat16)
            expected=x.float()@((q.float().cuda()*scale.cuda())@h).T
            expected=expected+((x.float()@a.cuda().T)@b.cuda().T)*.55+bias.cuda()
            with safe_open(str(model),framework='pt') as source,safe_open(str(lora),framework='pt') as adapter:
                manager=PreparedWeights(files,source,root/'cache',0,lambda _:nullcontext(),lambda *a,**k:None)
                layer=PreparedLinear('q.weight',[(adapter,'q',.55)],h,manager)
                actual=layer(x)
                error=((actual.float()-expected).square().mean()/expected.square().mean()).sqrt().item()
                self.assertLess(error,.03)
                self.assertEqual(actual.shape,expected.shape)
                self.assertTrue(torch.isfinite(actual).all())
                self.assertEqual(manager.stats()['prepared'],1)
                self.assertEqual(manager.stats()['gpu_cache_gib'],0)
                manager.clear()
                cached=PreparedWeights(files,source,root/'cache',.01,lambda _:nullcontext(),lambda *a,**k:None)
                repeated=PreparedLinear('q.weight',[(adapter,'q',.55)],h,cached)
                first=repeated(x);second=repeated(x)
                torch.testing.assert_close(first,second,rtol=0,atol=0)
                self.assertEqual(cached.stats()['reused'],1)
                self.assertEqual(cached.stats()['cache_hits'],1)
                self.assertLessEqual(cached.bytes,cached.limit)
                cached.clear()
                self.assertEqual(cached.bytes,0)


if __name__=='__main__':unittest.main()
