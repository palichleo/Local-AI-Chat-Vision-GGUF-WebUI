"""Validate only video behavior implemented by the native executor."""
from runner.contracts import fields, text, path, number


def validate_video_job(job):
    if job['mediaType']!='video':raise ValueError('LTX2.5 requires video mediaType')
    if 'promptExpansion' in job:raise ValueError('LTX2.5 prompt enhancement is not implemented')
    parameters=job['parameters']
    required=('prompt','seed','width','height','steps','frames','fps','stage','audio')
    fields(parameters,(*required,'cfg','negative_prompt','start_strength','end_strength','image_compression','overlap_frames','msr_frames','msr_strength'),required,'video parameters')
    text(parameters['prompt'],'prompt',8000)
    number(parameters['seed'],'seed',0,2**53-1,True)
    for key in ('width','height'):
        number(parameters[key],key,64,4096,True)
        if parameters[key]%32:raise ValueError('LTX2.5 '+key+' must be a multiple of 32')
    number(parameters['frames'],'frames',9,481,True)
    if (parameters['frames']-1)%8:raise ValueError('LTX2.5 frames must be 8n+1')
    number(parameters['fps'],'fps',1,60)
    number(parameters['steps'],'distilled steps',8,8,True)
    number(parameters.get('cfg',1),'distilled cfg',1,1)
    if parameters['stage'] not in ('draft','final'):raise ValueError('Select draft or final video stage')
    if type(parameters['audio']) is not bool:raise ValueError('Invalid video audio flag')
    if 'negative_prompt' in parameters:
        if not isinstance(parameters['negative_prompt'],str) or parameters['negative_prompt']:raise ValueError('Distilled CFG=1 does not use a negative prompt')
    fields(job['components'],('model','textEncoder','vae','audioVae'),label='LTX2.5 components')
    for key,value in job['components'].items():path(value,key)
    if not isinstance(job['loras'],list) or len(job['loras'])>1:raise ValueError('Native LTX2.5 supports one learned-slot MSR LoRA')
    for lora in job['loras']:
        fields(lora,('id','path','strength'),label='video LoRA');text(lora['id'],'LoRA id');path(lora['path'],'LoRA path');number(lora['strength'],'LoRA strength',0,2)
    if not isinstance(job['references'],list) or len(job['references'])>4:raise ValueError('Too many LTX2.5 references')
    roles=set()
    for ref in job['references']:
        fields(ref,('input','role','path'),label='video reference');text(ref['input'],'reference input');path(ref['path'],'reference path')
        if ref['role'] not in ('start_image','end_image','source_video','msr_image') or ref['role']!='msr_image' and ref['role'] in roles:raise ValueError('Unsupported or duplicate video reference role')
        roles.add(ref['role'])
    if {'start_image','source_video'}<=roles:raise ValueError('Choose a start image or source video, not both')
    if 'source_video' in roles:
        if parameters['audio']:raise ValueError('Audio continuation has not been validated')
        overlap=parameters.get('overlap_frames',9)
        if type(overlap) is not int or overlap not in (1,9,17,25,33) or overlap>=parameters['frames']:raise ValueError('Invalid continuation overlap')
    elif 'overlap_frames' in parameters:
        if type(parameters['overlap_frames']) is not int or parameters['overlap_frames'] not in (1,9,17,25,33):raise ValueError('Invalid continuation overlap')
    msr=[ref for ref in job['references'] if ref['role']=='msr_image']
    if len(msr)>2 or msr and not job['loras']:raise ValueError('One or two MSR images require the learned-slot LoRA')
    if 'msr_frames' in parameters and parameters['msr_frames'] not in (25,33):raise ValueError('MSR frames must be 25 or 33')
    if 'msr_strength' in parameters:number(parameters['msr_strength'],'MSR strength',0,1)
    for key in ('start_strength','end_strength'):
        if key in parameters:number(parameters[key],key,0,1)
    if 'image_compression' in parameters:number(parameters['image_compression'],'image_compression',0,51,True)
    return job
