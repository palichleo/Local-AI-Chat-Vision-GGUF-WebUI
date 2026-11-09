"""Independent validation of already-resolved native jobs; no policy execution."""
import math
from pathlib import Path
import re


def fields(value, allowed, required=None, label='object'):
    if not isinstance(value,dict) or value.keys()-set(allowed) or set(required or allowed)-value.keys():
        raise ValueError('Invalid '+label+' fields')


def text(value, label, maximum=128):
    if not isinstance(value,str) or not value.strip() or len(value)>maximum or '\0' in value:
        raise ValueError('Invalid '+label)


def path(value, label):
    text(value,label,32768)
    if not Path(value).is_absolute():raise ValueError(label+' must be an absolute local path')
    return value


def number(value, label, low, high, integer=False):
    if type(value) not in ((int,) if integer else (int,float)) or not math.isfinite(value) or not low<=value<=high:
        raise ValueError('Invalid '+label)


def validate_config(config):
    fields(config,('tokenizerPath','cacheRoot','outputRoot','engine','tuned','cacheGiB'),
           ('tokenizerPath','cacheRoot','outputRoot'),'worker configuration')
    for key in ('tokenizerPath','cacheRoot','outputRoot'):path(config[key],key)
    result={'engine':'int8','tuned':True}|config
    if result['engine'] not in ('int8','stream'):raise ValueError('Unknown engine')
    if type(result['tuned']) is not bool:raise ValueError('Invalid tuned flag')
    if result['tuned'] and result['engine']!='int8':raise ValueError('Tuned kernels require INT8')
    if 'cacheGiB' in result:number(result['cacheGiB'],'cacheGiB',0,1024)
    return result


def validate_job(job):
    required=('schemaVersion','id','pipeline','mediaType','workflowId','workflowDigest','parameters','components','loras','references')
    fields(job,(*required,'promptExpansion'),required,label='resolved job')
    if type(job['schemaVersion']) is not int or job['schemaVersion']!=1:raise ValueError('Unsupported job schema version')
    for key in ('id','workflowId'):text(job[key],key)
    if not isinstance(job['workflowDigest'],str) or not re.fullmatch('[a-f0-9]{64}',job['workflowDigest']):
        raise ValueError('Invalid workflow digest')
    if job['pipeline']=='ltx25':
        from runner.video.contracts import validate_video_job
        return validate_video_job(job)
    if job['pipeline']!='krea2' or job['mediaType']!='image':raise ValueError('Unsupported pipeline/media type')
    parameters=job['parameters']
    required=('prompt','seed','width','height','steps','cfg','denoise')
    fields(parameters,(*required,'expandPrompt'),required,'parameters')
    text(parameters['prompt'],'prompt',8000)
    number(parameters['seed'],'seed',0,2**53-1,True)
    number(parameters['steps'],'steps',1,1000,True)
    for key in ('width','height'):
        number(parameters[key],key,64,4096,True)
        if parameters[key]%8:raise ValueError(key+' must be a multiple of eight')
    number(parameters['cfg'],'cfg',1,1)
    number(parameters['denoise'],'denoise',0,1)
    if parameters['denoise']==0:raise ValueError('Denoise must be greater than zero')
    if 'expandPrompt' in parameters and type(parameters['expandPrompt']) is not bool:raise ValueError('Invalid expandPrompt')
    if parameters.get('expandPrompt') and 'promptExpansion' not in job:raise ValueError('Prompt expansion requires concrete configuration')
    if 'promptExpansion' in job:
        expansion=job['promptExpansion']
        fields(expansion,('template','maxTokens','temperature','topK','topP','minP','repetitionPenalty','seed','suffix'),label='prompt expansion')
        text(expansion['template'],'expansion template',16000)
        if expansion['template'].count('{{prompt}}')!=1:raise ValueError('Expansion template must contain {{prompt}} exactly once')
        if not isinstance(expansion['suffix'],str) or len(expansion['suffix'])>8000 or '\0' in expansion['suffix']:raise ValueError('Invalid expansion suffix')
        for key,low,high,integer in [('maxTokens',1,4096,True),('temperature',0,5,False),
                ('topK',0,1000,True),('topP',0,1,False),('minP',0,1,False),
                ('repetitionPenalty',0,10,False),('seed',0,2**53-1,True)]:
            number(expansion[key],'expansion '+key,low,high,integer)
        if any(expansion[key]==0 for key in ('temperature','topP','repetitionPenalty')):raise ValueError('Expansion sampling values must be positive')
    fields(job['components'],('model','textEncoder','vae'),label='components')
    for key,value in job['components'].items():path(value,key)
    if not isinstance(job['loras'],list) or len(job['loras'])>32:raise ValueError('Invalid loras')
    seen=set()
    for item in job['loras']:
        fields(item,('id','path','strength'),label='LoRA')
        text(item['id'],'LoRA id');path(item['path'],'LoRA path');number(item['strength'],'LoRA strength',-4,4)
        if item['id'] in seen:raise ValueError('Duplicate LoRA id')
        seen.add(item['id'])
    if not isinstance(job['references'],list) or len(job['references'])>1:raise ValueError('Krea2 supports one img2img reference')
    for item in job['references']:
        fields(item,('input','role','path'),label='reference')
        text(item['input'],'reference input');path(item['path'],'reference path')
        if item['role']!='img2img':raise ValueError('Unsupported Krea2 reference role')
    return job
