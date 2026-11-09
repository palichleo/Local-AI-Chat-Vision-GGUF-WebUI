"""Prepared LoRA weights, standalone INT8 kernels and a bounded per-job GPU cache."""
import hashlib
import json
import math
import os
from pathlib import Path
import uuid

import torch
import torch.nn.functional as F
from safetensors import safe_open
from safetensors.torch import save_file


def cache_key(model, adapters):
    def identity(path):
        path=Path(path).resolve(); stat=path.stat()
        # shortcut: Local checkpoints are identified by path/size/mtime; hash contents if mutable files are supported.
        return [str(path),stat.st_size,stat.st_mtime_ns]
    payload={'version':1,'model':identity(model),
             'adapters':[[identity(path),item['strength']] for item,path in adapters]}
    return hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()


def fuse(weight, scale, rotation, adapters):
    """Merge in the stored basis, including A @ H for ConvRot, then quantize once."""
    quantized=weight.dtype==torch.int8
    value=weight.float()
    if scale is not None:value=value*scale.float()
    for a,b,strength in adapters:
        a=a.to(device=value.device,dtype=torch.float32)
        b=b.to(device=value.device,dtype=torch.float32)
        if rotation is not None:
            size=rotation.shape[0]
            a=(a.reshape(-1,size) @ rotation.float()).reshape_as(a)
        value.addmm_(b,a,alpha=strength)
    if not torch.isfinite(value).all():raise ValueError('Non-finite fused weight')
    if quantized:
        factor=(value.abs().amax(-1,keepdim=True)/127).clamp_min(1e-30)
        data=(value/factor).round().clamp(-127,127).to(torch.int8)
        relative_error=((data.float()*factor-value).square().sum()/value.square().sum().clamp_min(1e-30)).sqrt().item()
        return {'weight':data,'scale':factor},relative_error
    return {'weight':value.to(torch.bfloat16)},0.0


class PreparedWeights:
    def __init__(self, files, source, cache_root, cache_gib, scope, progress):
        import comfy_kitchen
        if not comfy_kitchen.list_backends()['cuda']['available']:
            raise RuntimeError('Optimized mode requires the installed comfy-kitchen CUDA backend')
        self.kernels=comfy_kitchen
        self.source=source
        self.folder=Path(cache_root)/cache_key(files['transformer'],files['loras'])
        self.folder.mkdir(parents=True,exist_ok=True)
        self.limit=int(cache_gib*1024**3)
        self.gpu={}; self.host={}; self.bytes=0
        self.scope=scope; self.progress=progress
        self.built=0; self.reused=0; self.hits=0; self.misses=0; self.uploaded_bytes=0
        self.max_quantization_error=0.0

    def prepare(self, original, adapters, rotation):
        path=self.folder/(hashlib.sha256(original.encode()).hexdigest()+'.safetensors')
        shape=tuple(self.source.get_slice(original).get_shape())
        rotation_size=rotation.shape[0] if rotation is not None else 0
        if path.exists():
            with safe_open(str(path),framework='pt') as store:
                metadata=store.metadata()
                if metadata.get('source')!=original or tuple(store.get_slice('weight').get_shape())!=shape:
                    raise ValueError('Invalid prepared cache entry: '+str(path))
                self.max_quantization_error=max(self.max_quantization_error,float(metadata.get('relative_error','0')))
            self.reused+=1
        else:
            weight=self.source.get_tensor(original).to('cuda')
            scale_key=original.removesuffix('.weight')+'.weight_scale'
            scale=self.source.get_tensor(scale_key).to('cuda') if scale_key in self.source.keys() else None
            values=[]
            for store,key,strength in adapters:
                a=store.get_tensor(key+'.lora_A.weight')
                b=store.get_tensor(key+'.lora_B.weight')
                alpha=store.get_tensor(key+'.alpha').item()/a.shape[0] if key+'.alpha' in store.keys() else 1.0
                values.append((a,b,strength*alpha))
            if values:
                bundle,error=fuse(weight,scale,rotation,values)
            else:
                bundle={'weight':weight}; error=0.0
                if scale is not None:bundle['scale']=scale
            bias_key=original.removesuffix('.weight')+'.bias'
            if bias_key in self.source.keys():bundle['bias']=self.source.get_tensor(bias_key).to(torch.bfloat16)
            bundle={key:value.cpu().contiguous() for key,value in bundle.items()}
            metadata={'source':original,'rotation':str(rotation_size),'relative_error':str(error)}
            temporary=path.with_suffix('.'+uuid.uuid4().hex+'.tmp')
            try:
                save_file(bundle,str(temporary),metadata=metadata)
                os.replace(temporary,path)
            finally:
                temporary.unlink(missing_ok=True)
            self.max_quantization_error=max(self.max_quantization_error,error)
            self.built+=1
        if (self.built+self.reused)%32==0:
            self.progress('preparing weights',built=self.built,reused=self.reused)
        return path,rotation_size

    def load(self, path):
        if path in self.gpu:
            self.hits+=1
            return self.gpu[path]
        self.misses+=1
        with self.scope('krea/weights.upload'):
            if path not in self.host:
                with safe_open(str(path),framework='pt',device='cpu') as store:
                    self.host[path]={key:store.get_tensor(key) for key in store.keys()}
            # Retain mmap sources until GPU work completes; avoid remapping every layer/step.
            result={key:value.to('cuda',non_blocking=True) for key,value in self.host[path].items()}
        size=sum(value.numel()*value.element_size() for value in result.values())
        self.uploaded_bytes+=size
        # Keep selected layers resident: an LRU smaller than a full traversal would thrash.
        if self.bytes+size<=self.limit:
            self.gpu[path]=result; self.bytes+=size
        return result

    def stats(self):
        return {'prepared':self.built,'reused':self.reused,'cache_key':self.folder.name,
                'gpu_cache_gib':round(self.bytes/1024**3,3),'gpu_cache_limit_gib':round(self.limit/1024**3,3),
                'cache_hits':self.hits,'cache_misses':self.misses,'uploaded_gib':round(self.uploaded_bytes/1024**3,3),
                'max_weight_quantization_relative_rmse':self.max_quantization_error}

    def clear(self):
        torch.cuda.synchronize()
        self.gpu.clear(); self.host.clear(); self.bytes=0


class PreparedLinear(torch.nn.Module):
    def __init__(self, original, adapters, rotation, manager):
        super().__init__()
        self.manager=manager
        self.path,self.rotation_size=manager.prepare(original,adapters,rotation)
        self.out_features,self.in_features=manager.source.get_slice(original).get_shape()

    def forward(self, value):
        bundle=self.manager.load(self.path)
        with self.manager.scope('krea/base.linear'):
            if bundle['weight'].dtype==torch.int8:
                # The library's torch op also lets the profiler attribute its external CUDA kernels.
                return torch.ops.comfy_kitchen.int8_linear(value,bundle['weight'],bundle['scale'],
                    bundle.get('bias'),self.manager.kernels.DTYPE_TO_CODE[value.dtype],
                    bool(self.rotation_size),self.rotation_size or 256)
            return F.linear(value,bundle['weight'],bundle.get('bias'))


def rotation_matrix(size, torch, device, dtype):
    """Regular orthogonal Hadamard basis used by ConvRot checkpoint metadata."""
    if size < 4 or size & (size-1) or size.bit_length() % 2 != 1:
        raise ValueError('ConvRot group size must be a power of four')
    base = torch.ones(4, 4, device=device, dtype=dtype) - 2*torch.eye(4, device=device, dtype=dtype).flip(1)
    result = base
    while result.shape[0] < size:
        result = torch.kron(result, base)
    return result/math.sqrt(size)

