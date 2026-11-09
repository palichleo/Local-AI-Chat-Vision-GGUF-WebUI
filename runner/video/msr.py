"""LTX2.5 learned image slots: repeated image latents at distinct negative times."""


def validate_msr(job,headers):
    from runner.models.headers import header
    adapters=job['loras']
    refs=[ref for ref in job['references'] if ref['role']=='msr_image']
    if not adapters:
        if refs:raise ValueError('MSR references require their compatible learned-slot LoRA')
        return
    if len(adapters)!=1:raise ValueError('This LTX2.5 executor supports one MSR LoRA at a time')
    entries=header(adapters[0]['path']);metadata=entries.get('__metadata__',{})
    required={'reference_slot_embedding_enabled':'True','reference_slot_embedding_type':'fourier_mlp',
        'reference_slot_time_offsets':'pic1_based_negative_time','reference_slot_embedding_dim':'128'}
    if any(metadata.get(key)!=value for key,value in required.items()):raise ValueError('Unsupported MSR slot metadata')
    slots={'frequencies':[16],'net.0.weight':[256,33],'net.0.bias':[256],'net.2.weight':[128,256],'net.2.bias':[128]}
    accepted={'__metadata__'}
    for key,shape in slots.items():
        name='diffusion_model.reference_slot_embedding.'+key
        if entries.get(name,{}).get('shape')!=shape:raise ValueError('Invalid learned MSR slot: '+key)
        accepted.add(name)
    count=0
    for key,spec in entries.items():
        if not key.endswith('.lora_A.weight'):continue
        stem=key.removesuffix('.lora_A.weight');other=stem+'.lora_B.weight'
        base=headers['model'].get('model.'+stem+'.weight',{}).get('shape',[])
        a=spec['shape'];b=entries.get(other,{}).get('shape',[])
        if len(base)!=2 or len(a)!=2 or len(b)!=2 or a[0]<1 or a[0]!=b[1] or [b[0],a[1]]!=base:raise ValueError('Invalid MSR LoRA pair: '+key)
        accepted.update((key,other));count+=1
    if not count or entries.keys()-accepted:raise ValueError('Unsupported MSR LoRA tensors')
    return entries


def slot_embedding(slot,store,torch,device,dtype):
    import torch.nn.functional as F
    def read(key):return store.get_tensor('diffusion_model.reference_slot_embedding.'+key).to(device=device,dtype=torch.float32)
    scaled=torch.tensor(slot/16,device=device,dtype=torch.float32)
    phases=scaled*read('frequencies')
    features=torch.cat((scaled.reshape(1),phases.sin(),phases.cos()))
    hidden=F.silu(F.linear(features,read('net.0.weight'),read('net.0.bias')))
    return F.linear(hidden,read('net.2.weight'),read('net.2.bias')).to(dtype)


def pipeline_class():
    import torch
    from diffusers import LTX2ConditionPipeline

    class MSRPipeline(LTX2ConditionPipeline):
        def prepare_latents(self,*args,**kwargs):
            latents,mask,clean,coords=super().prepare_latents(*args,**kwargs)
            extra=[];masks=[];positions=[]
            for index,ref in enumerate(self.msr_references):
                from PIL import Image
                from diffusers.pipelines.ltx2.pipeline_ltx2_condition import LTX2VideoCondition
                with Image.open(ref['path']) as source:image=source.convert('RGB')
                frames=[image]*self.msr_frames
                pixels,_,_,_=self.preprocess_conditions([LTX2VideoCondition(frames=frames,index=0,crf=0)],kwargs['height'],kwargs['width'],kwargs['num_frames'],device=kwargs['device'])
                encoded=self.vae.encode(pixels[0]).latent_dist.mode()
                encoded=self._normalize_latents(encoded,self.vae.latents_mean,self.vae.latents_std)
                encoded=encoded+slot_embedding(index+1,self.msr_store,torch,encoded.device,encoded.dtype).reshape(1,-1,1,1,1)
                _,_,f,h,w=encoded.shape
                packed=self._pack_latents(encoded,self.transformer_spatial_patch_size,self.transformer_temporal_patch_size).to(latents.dtype)
                position=self.transformer.rope.prepare_video_coords(1,f,h,w,encoded.device,fps=kwargs['frame_rate'])
                position[:,0]-=(len(self.msr_references)-index)/kwargs['frame_rate']
                extra.append(packed.expand(latents.shape[0],-1,-1));masks.append(torch.full_like(packed[:,:,:1],self.msr_strength));positions.append(position)
            if extra:
                added=torch.cat(extra,dim=1);newmask=torch.cat(masks,dim=1)
                noise=torch.randn(added.shape,device=added.device,dtype=added.dtype,generator=kwargs['generator'])
                latents=torch.cat((latents,added*newmask+noise*(1-newmask)),dim=1)
                clean=torch.cat((clean,added),dim=1);mask=torch.cat((mask,newmask),dim=1)
                extra_coords=torch.cat(positions,dim=2);coords=extra_coords if coords is None else torch.cat((coords,extra_coords),dim=2)
            return latents,mask,clean,coords
    return MSRPipeline
