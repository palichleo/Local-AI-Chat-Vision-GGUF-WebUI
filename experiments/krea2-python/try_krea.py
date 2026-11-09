"""Offline experiment: execute the supplied Krea2 graph with PyTorch/Diffusers, not ComfyUI."""
import argparse
from contextlib import nullcontext
import gc
import json
import math
import os
from pathlib import Path
import struct
import sys
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))  # Embedded Python can omit the script directory from its import path.


class Workflow:
    def __init__(self, path, width=None, height=None, no_refine=False, image=None):
        self.graph = json.loads(Path(path).read_text(encoding='utf-8-sig'))
        self.width, self.height = width, height
        self.no_refine, self.image = no_refine, image
        self.expanded = None
        self.refine_used = False

    def value(self, value):
        if not (isinstance(value, list) and len(value) == 2 and str(value[0]) in self.graph):
            return value
        key, index = str(value[0]), value[1]
        node = self.graph[key]
        kind, inputs = node['class_type'], node['inputs']
        get = lambda name: self.value(inputs[name])
        if kind.startswith('Primitive'):
            return get('value')
        if kind == 'ResolutionSelector':
            a, b = map(int, inputs['aspect_ratio'].split()[0].split(':'))
            scale = math.sqrt(inputs['megapixels'] * 1024**2 / (a*b))
            dimensions = (self.width if self.width is not None else round(a*scale/inputs['multiple'])*inputs['multiple'],
                          self.height if self.height is not None else round(b*scale/inputs['multiple'])*inputs['multiple'])
            return dimensions[index]
        if kind == 'StringConcatenate':
            return str(get('string_a')) + inputs['delimiter'] + str(get('string_b'))
        if kind == 'ComfySwitchNode':
            switch = bool(get('switch'))
            if self.graph.get(str(inputs.get('on_true', [''])[0]), {}).get('class_type') == 'TextGenerate' and self.no_refine:
                switch = False
            return self.value(inputs['on_true' if switch else 'on_false'])
        if kind == 'PreviewAny':
            return get('source')
        if kind == 'TextGenerate':
            self.refine_used = True
            if self.expanded is None:
                return '<prompt expansion pending>'
            return self.expanded
        raise ValueError(f'Unsupported value node: {key} ({kind})')

    def selected(self, link):
        key = str(link[0]); node = self.graph[key]; inputs = node['inputs']
        if node['class_type'] == 'ComfySwitchNode':
            active = bool(self.value(inputs['switch']))
            if self.graph.get(str(inputs['on_true'][0]), {}).get('class_type') == 'KSampler' and self.image:
                active = True
            return self.selected(inputs['on_true' if active else 'on_false'])
        return key, node

    def plan(self):
        self.refine_used = False
        save = next(n for n in self.graph.values() if n['class_type'] == 'SaveImage')
        link = save['inputs']['images']
        while True:
            _, node = self.selected(link)
            if node['class_type'] == 'VAEDecode':
                vae = self.graph[str(node['inputs']['vae'][0])]['inputs']['vae_name']
                _, sampler = self.selected(node['inputs']['samples']); break
            link = node['inputs']['images']
        inputs = sampler['inputs']; loras = []; link = inputs['model']
        while True:
            _, model = self.selected(link); data = model['inputs']
            if model['class_type'] == 'UNETLoader':
                transformer = data['unet_name']; break
            if model['class_type'] != 'LoraLoaderModelOnly':
                raise ValueError('Unsupported model chain')
            loras.insert(0, {'file':data['lora_name'], 'strength':data['strength_model']})
            link = data['model']
        _, positive = self.selected(inputs['positive'])
        encoder = self.graph[str(positive['inputs']['clip'][0])]['inputs']['clip_name']
        latent = self.graph[str(inputs['latent_image'][0])]
        source = None
        if latent['class_type'] == 'EmptyLatentImage':
            width, height = self.value(latent['inputs']['width']), self.value(latent['inputs']['height'])
        else:
            scale = self.graph[str(latent['inputs']['pixels'][0])]['inputs']
            width, height = self.value(scale['width']), self.value(scale['height'])
            image_node = self.graph[str(scale['image'][0])]['inputs']
            source = self.image or image_node['image']
        refine = next(n['inputs'] for n in self.graph.values() if n['class_type']=='TextGenerate')
        prompt = self.value(positive['inputs']['text'])
        return dict(transformer=transformer, encoder=encoder, vae=vae, loras=loras,
                    width=width, height=height, seed=self.value(inputs['seed']), steps=inputs['steps'],
                    cfg=inputs['cfg'], sampler=inputs['sampler_name'], scheduler=inputs['scheduler'],
                    denoise=self.value(inputs['denoise']), image=source,
                    prompt=prompt, refine_enabled=self.refine_used, refine_input=self.value(refine['prompt']),
                    refine_options=refine, output_prefix=save['inputs']['filename_prefix'])


def header(path):
    with Path(path).open('rb') as f:
        size = struct.unpack('<Q', f.read(8))[0]
        if size > 64*1024**2:
            raise ValueError('Invalid safetensors header')
        return json.loads(f.read(size))


def locate(root, name):
    found = list(Path(root).rglob(name))
    if len(found) != 1:
        raise ValueError(f'Expected exactly one local {name}; found {len(found)}')
    return found[0]


def rotation_matrix(size, torch, device, dtype):
    """Regular orthogonal Hadamard basis used by ConvRot checkpoint metadata."""
    if size < 4 or size & (size-1) or size.bit_length() % 2 != 1:
        raise ValueError('ConvRot group size must be a power of four')
    base = torch.ones(4, 4, device=device, dtype=dtype) - 2*torch.eye(4, device=device, dtype=dtype).flip(1)
    result = base
    while result.shape[0] < size:
        result = torch.kron(result, base)
    return result/math.sqrt(size)


def execute(args, workflow, plan, files):
    import torch
    import torch.nn.functional as F
    from safetensors import safe_open
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from transformers import Qwen3Config, Qwen3ForCausalLM, AutoTokenizer
    from diffusers import Krea2Transformer2DModel, AutoencoderKLQwenImage, Krea2Pipeline
    from diffusers.loaders.single_file_utils import convert_krea2_transformer_checkpoint_to_diffusers, convert_wan_vae_to_diffusers
    from PIL import Image, ImageOps, PngImagePlugin
    if args.profile:
        from profile_krea import summarize

    if not torch.cuda.is_available():
        raise RuntimeError('This experimental streaming implementation requires a CUDA GPU')
    free, _ = torch.cuda.mem_get_info()
    if free < 9*1024**3:
        raise RuntimeError(f'Only {free/1024**3:.1f} GiB VRAM free. Free other models first; no process was stopped.')
    if plan['sampler'] != 'euler' or plan['scheduler'] != 'simple':
        raise ValueError('This try implements Euler + simple only')
    if plan['cfg'] != 1:
        raise ValueError('This try implements the supplied CFG=1 workflow only')
    if not isinstance(plan['steps'],int) or not 1 <= plan['steps'] <= 10000:
        raise ValueError('Steps must be an integer between 1 and 10000')
    dtype, device = torch.bfloat16, 'cuda'
    scope = torch.profiler.record_function if args.profile else lambda _:nullcontext()
    profile_report = None
    start = time.perf_counter(); torch.cuda.reset_peak_memory_stats()

    def progress(stage, **extra):
        data = dict(stage=stage, seconds=round(time.perf_counter()-start, 2),
                    allocated_gib=round(torch.cuda.memory_allocated()/1024**3, 3), **extra)
        print(json.dumps(data, ensure_ascii=False), flush=True)

    def release():
        gc.collect(); torch.cuda.empty_cache()

    def tensor(store, key):
        # Transfer quantized bytes first; converting on the CPU wastes bandwidth and cores.
        with scope('krea/weights.read'):
            value = store.get_tensor(key)
        with scope('krea/weights.upload'):
            value = value.to(device=device)
        with scope('krea/weights.dequantize'):
            value = value.to(dtype=dtype)
        with scope('krea/weights.read'):
            scale = key[:-7]+'.weight_scale' if key.endswith('.weight') else None
            scaled = scale and scale in store.keys()
            factor = store.get_tensor(scale) if scaled else None
        if scaled:
            with scope('krea/weights.upload'):
                factor = factor.to(device=device, dtype=dtype)
            with scope('krea/weights.dequantize'):
                value = value * factor
        return value

    progress('loading text encoder')
    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
    # shortcut: Fixed Qwen/Krea2 architecture for this try; read model configs for other families.
    config = Qwen3Config(vocab_size=151936, hidden_size=2560, intermediate_size=9728,
                        num_hidden_layers=36, num_attention_heads=32, num_key_value_heads=8,
                        head_dim=128, rope_theta=5000000.0, rms_norm_eps=1e-6,
                        max_position_embeddings=262144, tie_word_embeddings=True)
    config._attn_implementation = 'sdpa'
    with init_empty_weights():
        text_model = Qwen3ForCausalLM(config)
    with safe_open(str(files['encoder']), framework='pt', device='cpu') as store:
        for key, parameter in list(text_model.named_parameters()):
            if key == 'lm_head.weight':
                continue
            if key not in store.keys():
                raise ValueError('Missing text weight: '+key)
            value = tensor(store, key)
            if tuple(value.shape) != tuple(parameter.shape):
                raise ValueError('Text shape mismatch: '+key)
            set_module_tensor_to_device(text_model, key, device, value=value, dtype=dtype)
    text_model.lm_head.weight = text_model.model.embed_tokens.weight
    text_model.eval().to(device)
    with torch.inference_mode():
        if plan['refine_enabled']:
            progress('expanding prompt')
            options = plan['refine_options']
            prompt = '<|im_start|>user\n'+plan['refine_input']+'<|im_end|>\n<|im_start|>assistant\n'
            tokens = tokenizer(prompt, return_tensors='pt').to(device)
            torch.manual_seed(options.get('sampling_mode.seed', 0))
            generated = text_model.generate(**tokens, do_sample=True,
                max_new_tokens=options['max_length'] if isinstance(options['max_length'],int) else workflow.value(options['max_length']),
                temperature=options['sampling_mode.temperature'], top_k=options['sampling_mode.top_k'],
                top_p=options['sampling_mode.top_p'], min_p=options['sampling_mode.min_p'],
                repetition_penalty=options['sampling_mode.repetition_penalty'],
                eos_token_id=[151643,151645], pad_token_id=151643)
            workflow.expanded = tokenizer.decode(generated[0, tokens.input_ids.shape[1]:], skip_special_tokens=True).strip()
            if not workflow.expanded:
                raise RuntimeError('Prompt expansion returned no text')
            plan = workflow.plan()
            del generated, tokens
        progress('encoding prompt', prompt=plan['prompt'])
        prefix = '<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:<|im_end|>\n<|im_start|>user\n'
        text = prefix+plan['prompt']+'<|im_end|>\n<|im_start|>assistant\n'
        tokens = tokenizer(text, return_tensors='pt').to(device)
        outputs = text_model.model(**tokens, output_hidden_states=True, use_cache=False)
        prefix_length = len(tokenizer.encode(prefix))
        conditioning = torch.stack([outputs.hidden_states[i][:,prefix_length:] for i in (2,5,8,11,14,17,20,23,26,29,32,35)], dim=2).to(dtype)
        del outputs, tokens, text_model
        release()

        progress('loading VAE')
        with init_empty_weights():
            vae = AutoencoderKLQwenImage()
        with safe_open(str(files['vae']), framework='pt', device='cpu') as store:
            state = convert_wan_vae_to_diffusers({k:store.get_tensor(k) for k in store.keys()})
            vae.load_state_dict(state, strict=True, assign=True)
        del state
        vae.eval().to(dtype=dtype)
        vae.enable_tiling()
        mean = torch.tensor(vae.config.latents_mean, device=device, dtype=dtype).view(1,16,1,1)
        std = torch.tensor(vae.config.latents_std, device=device, dtype=dtype).view(1,16,1,1)
        height, width = plan['height']//8, plan['width']//8
        generator = torch.Generator('cpu').manual_seed(plan['seed'])
        noise = torch.randn((1,16,height,width), generator=generator).to(device)
        source = torch.zeros_like(noise)
        if plan['image']:
            image = ImageOps.fit(Image.open(plan['image']).convert('RGB'), (plan['width'],plan['height']), method=Image.Resampling.LANCZOS)
            import numpy as np
            pixels = torch.from_numpy(np.array(image).copy()).permute(2,0,1).unsqueeze(0).unsqueeze(2).to(device=device,dtype=dtype)/127.5-1
            vae.to(device); source = (vae.encode(pixels).latent_dist.mode()[:,:,0]-mean)/std
            vae.to('cpu'); del pixels; release()

        progress('preparing streaming transformer')
        transformer_header = header(files['transformer'])
        rename = {}
        for key, entry in transformer_header.items():
            if key == '__metadata__': continue
            meta = torch.empty(entry['shape'], device='meta')
            converted = convert_krea2_transformer_checkpoint_to_diffusers({key:meta})
            rename.update({dest:key for dest in converted})
        weights = safe_open(str(files['transformer']), framework='pt', device='cpu')
        adapters = [(safe_open(str(path),framework='pt',device='cpu'), item['strength']) for item,path in files['loras']]
        rotations = {}

        class StreamingLinear(torch.nn.Module):
            def __init__(self, name, original):
                super().__init__(); self.source=original; self.in_features=transformer_header[original]['shape'][1]; self.out_features=transformer_header[original]['shape'][0]
                quant_key=original.removesuffix('.weight')+'.comfy_quant'
                quant=json.loads(bytes(weights.get_tensor(quant_key).tolist())) if quant_key in weights.keys() else {}
                self.rotation_size=quant.get('convrot_groupsize',256) if quant.get('convrot') else None
                if self.rotation_size:
                    if self.in_features % self.rotation_size: raise ValueError('Invalid ConvRot dimensions: '+original)
                    if self.rotation_size not in rotations:
                        rotations[self.rotation_size]=rotation_matrix(self.rotation_size,torch,device,dtype)
                self.adapters=[]
                for store, strength in adapters:
                    stem=original.removesuffix('.weight')
                    for candidate in (stem, 'diffusion_model.'+stem, 'model.diffusion_model.'+stem):
                        if candidate+'.lora_A.weight' in store.keys():
                            self.adapters.append((store,candidate,strength)); break
            def forward(self, value):
                weight=tensor(weights,self.source); bias_key=self.source[:-7]+'.bias'
                bias=tensor(weights,bias_key) if bias_key in weights.keys() else None
                rotated=value
                with scope('krea/convrot'):
                    if self.rotation_size:
                        rotated=(value.reshape(-1,self.rotation_size) @ rotations[self.rotation_size]).reshape(value.shape)
                with scope('krea/base.linear'):
                    result=F.linear(rotated,weight,bias)
                del weight,bias,rotated
                for store,key,strength in self.adapters:
                    with scope('krea/lora.read'):
                        a=store.get_tensor(key+'.lora_A.weight')
                        b=store.get_tensor(key+'.lora_B.weight')
                        alpha=store.get_tensor(key+'.alpha').item()/a.shape[0] if key+'.alpha' in store.keys() else 1.0
                    with scope('krea/lora.upload_cast'):
                        a=a.to(device=device,dtype=value.dtype)
                        b=b.to(device=device,dtype=value.dtype)
                    with scope('krea/lora.linear'):
                        result=result+F.linear(F.linear(value,a),b)*(strength*alpha)
                return result

        with init_empty_weights():
            transformer = Krea2Transformer2DModel()
        for name,module in list(transformer.named_modules()):
            if isinstance(module,torch.nn.Linear):
                if name+'.weight' not in rename: raise ValueError('Missing transformer matrix: '+name)
                transformer.set_submodule(name,StreamingLinear(name,rename[name+'.weight']))
        for key,parameter in list(transformer.named_parameters()):
            if key not in rename: raise ValueError('Missing transformer weight: '+key)
            value=tensor(weights,rename[key])
            if value.numel()!=parameter.numel(): raise ValueError('Transformer shape mismatch: '+key)
            set_module_tensor_to_device(transformer,key,device,value=value.reshape(parameter.shape),dtype=dtype)
        transformer.eval().to(device)
        steps=plan['steps']; denoise=plan['denoise']
        if not 0 < denoise <= 1: raise ValueError('Denoise must be in (0,1]')
        total_steps=max(steps,int(steps/denoise))
        grid=torch.arange(1,10001,dtype=torch.float32)/10000
        shifted=math.exp(1.15)/(math.exp(1.15)+(1/grid-1))
        sigmas=torch.tensor([float(shifted[-(1+int(i*10000/total_steps))]) for i in range(total_steps)]+[0.0],device=device)[-(steps+1):]
        latents=noise*sigmas[0]+source*(1-sigmas[0]); del noise,source
        gh,gw=(height+1)//2,(width+1)//2
        positions=Krea2Pipeline.prepare_position_ids(conditioning.shape[1],gh,gw,device)
        for i in range(steps):
            sample = args.profile and i==min(1,steps-1)
            if sample:
                torch.cuda.synchronize()
                capture=torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU,torch.profiler.ProfilerActivity.CUDA])
                capture.start(); sampled_start=time.perf_counter()
            with scope('krea/step'):
                padded=F.pad(latents.to(dtype),(0,width%2,0,height%2),mode='circular')
                packed=padded.reshape(1,16,gh,2,gw,2).permute(0,2,4,1,3,5).reshape(1,gh*gw,64)
                prediction=transformer(hidden_states=packed,timestep=sigmas[i:i+1].to(dtype),encoder_hidden_states=conditioning,position_ids=positions,return_dict=False)[0]
                prediction=prediction.reshape(1,gh,gw,16,2,2).permute(0,3,1,4,2,5).reshape(1,16,gh*2,gw*2)[:,:,:height,:width]
                latents=latents+prediction.float()*(sigmas[i+1]-sigmas[i])
                if not torch.isfinite(latents).all(): raise RuntimeError('Non-finite latent values; refusing to save a corrupt result')
            if sample:
                torch.cuda.synchronize(); sampled_seconds=time.perf_counter()-sampled_start
                capture.stop()
                profile_report=summarize(capture,i+1,sampled_seconds)
                del capture; gc.collect()
                progress('profiled step',profile=profile_report)
            progress('denoising',step=i+1,total=steps)
        del transformer,conditioning,prediction,packed,padded,adapters,weights
        release(); progress('decoding image')
        vae.to(device)
        decoded=vae.decode((latents.to(dtype)*std+mean).unsqueeze(2),return_dict=False)[0][0,:,0]
        if not torch.isfinite(decoded).all(): raise RuntimeError('Non-finite decoded image')
        pixels=((decoded.float().clamp(-1,1)+1)*127.5).round().byte().permute(1,2,0).cpu().numpy()
        destination=Path(args.output);destination.mkdir(parents=True,exist_ok=True)
        prefix=Path(plan['output_prefix'].replace('\\','/')).name
        output=destination/(prefix+'_'+str(plan['seed'])+'_'+str(time.time_ns())+'.png')
        comfy_imported=any(k in ('comfy','comfy_kitchen') or k.startswith(('comfy.','comfy_kitchen.')) for k in __import__('sys').modules)
        if comfy_imported: raise RuntimeError('Unexpected Comfy module import')
        metadata=dict(plan=plan,seconds=round(time.perf_counter()-start,2),peak_vram_gib=round(torch.cuda.max_memory_allocated()/1024**3,3),backend='pytorch-diffusers-streaming',comfy_imported=comfy_imported)
        if profile_report is not None: metadata['profile']=profile_report
        info=PngImagePlugin.PngInfo();info.add_text('atelier',json.dumps(metadata,ensure_ascii=False));Image.fromarray(pixels).save(output,pnginfo=info)
        output.with_suffix('.json').write_text(json.dumps(metadata,indent=2,ensure_ascii=False),encoding='utf-8')
        progress('complete',output=str(output),peak_vram_gib=metadata['peak_vram_gib'],comfy_imported=metadata['comfy_imported'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workflow',default=str(HERE/'workflow.json'))
    parser.add_argument('--config',type=Path,default=HERE/'local.json')
    parser.add_argument('--models-root');parser.add_argument('--tokenizer')
    parser.add_argument('--width',type=int);parser.add_argument('--height',type=int)
    parser.add_argument('--image');parser.add_argument('--no-refine',action='store_true')
    parser.add_argument('--inspect',action='store_true');parser.add_argument('--output',default=str(HERE/'outputs'))
    parser.add_argument('--profile',action='store_true',help='Profile the second diffusion step with CPU/CUDA attribution')
    args=parser.parse_args()
    local=json.loads(args.config.read_text(encoding='utf-8')) if args.config.exists() else {}
    args.models_root=args.models_root or local.get('models_root');args.tokenizer=args.tokenizer or local.get('tokenizer')
    workflow=Workflow(args.workflow,args.width,args.height,args.no_refine,args.image);plan=workflow.plan()
    for key in ('width','height'):
        if plan[key]<64 or plan[key]%8: raise ValueError('Resolution must be a positive multiple of 8, at least 64')
    if not args.models_root or not args.tokenizer: parser.error('Provide --models-root and --tokenizer, or an ignored local.json')
    files={key:locate(args.models_root,plan[key]) for key in ('transformer','encoder','vae')}
    files['loras']=[(item,locate(args.models_root,item['file'])) for item in plan['loras']]
    if args.inspect:
        print(json.dumps(dict(plan=plan,files={k:str(v) for k,v in files.items() if k!='loras'}),indent=2,ensure_ascii=False));return
    if plan['image'] and not Path(plan['image']).is_file(): parser.error('Input image does not exist: '+plan['image'])
    execute(args,workflow,plan,files)


if __name__=='__main__':
    main()
