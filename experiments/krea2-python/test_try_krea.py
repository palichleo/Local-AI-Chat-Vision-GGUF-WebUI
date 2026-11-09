"""Small offline checks: graph selection and ConvRot algebra, no model loading."""
import unittest
from types import SimpleNamespace

from try_krea import HERE, Workflow, rotation_matrix
from profile_krea import summarize


class WorkflowTests(unittest.TestCase):
    def test_profile_ignores_duplicate_cuda_annotations(self):
        def event(key,cuda,device='DeviceType.CPU'):
            return SimpleNamespace(key=key,device_type=device,count=1,cpu_time_total=20,
                                   device_time_total=cuda,self_device_time_total=cuda)
        events=[event('krea/step',1000),event('krea/base.linear',600),
                event('krea/base.linear',5000,'DeviceType.CUDA'),
                event('aten::scaled_dot_product_attention',250),event('aten::mm',600)]
        profile=SimpleNamespace(key_averages=lambda:events)
        result=summarize(profile,2,.002)
        self.assertEqual(result['cuda_work_seconds'],.001)
        self.assertEqual(result['categories']['base.linear']['cuda_seconds'],.0006)
        self.assertEqual(result['categories']['other']['cuda_seconds'],.00015)
        events[1].device_time_total=1200
        with self.assertRaises(RuntimeError):summarize(profile,2,.002)

    def test_original_graph(self):
        plan = Workflow(HERE/'workflow.json').plan()
        self.assertEqual((plan['width'], plan['height']), (1448,1448))
        self.assertEqual((plan['steps'],plan['cfg'],plan['sampler'],plan['scheduler']), (8,1,'euler','simple'))
        self.assertEqual(len(plan['loras']),3)
        self.assertIsNone(plan['image'])
        self.assertIn('<prompt expansion pending>',plan['prompt'])
        self.assertTrue(plan['refine_enabled'])

    def test_no_refine_and_image_branch(self):
        plan = Workflow(HERE/'workflow.json',512,768,True,'reference.png').plan()
        self.assertEqual((plan['width'],plan['height']),(512,768))
        self.assertEqual(plan['image'],'reference.png')
        self.assertAlmostEqual(plan['denoise'],0.4)
        self.assertNotIn('<prompt expansion pending>',plan['prompt'])
        self.assertFalse(plan['refine_enabled'])

    def test_disabled_workflow_refiner(self):
        workflow=Workflow(HERE/'workflow.json')
        workflow.graph['60:2']['inputs']['value']=False
        self.assertFalse(workflow.plan()['refine_enabled'])

    def test_unknown_nodes_fail(self):
        graph = Workflow(HERE/'workflow.json')
        graph.graph = {'test':{'class_type':'Unknown','inputs':{}}}
        with self.assertRaisesRegex(ValueError,'Unsupported'):
            graph.value(['test',0])

    def test_convrot_preserves_linear_with_unrotated_lora(self):
        import torch
        torch.manual_seed(3)
        h=rotation_matrix(256,torch,'cpu',torch.float32)
        torch.testing.assert_close(h @ h.T,torch.eye(256))
        x=torch.randn(7,512); w=torch.randn(32,512)
        a=torch.randn(4,512); b=torch.randn(32,4)
        rotated_x=(x.reshape(-1,256) @ h).reshape_as(x)
        rotated_w=(w.reshape(-1,256) @ h).reshape_as(w)
        actual=rotated_x @ rotated_w.T + (x @ a.T) @ b.T
        expected=x @ w.T + (x @ a.T) @ b.T
        torch.testing.assert_close(actual,expected,atol=4e-5,rtol=1e-5)
        with self.assertRaises(ValueError):
            rotation_matrix(128,torch,'cpu',torch.float32)


if __name__=='__main__':
    unittest.main()
