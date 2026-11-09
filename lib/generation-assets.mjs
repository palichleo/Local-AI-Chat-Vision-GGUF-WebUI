import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const invalid = message => Object.assign(new Error(message), { status:400 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [null,Object.prototype].includes(Object.getPrototypeOf(value));
const kinds = ['model','textEncoder','vae','audioVae','textProjection','enhancer','lora'];
const families = ['krea2','ltx25'];
const bytesPerElement = {BOOL:1,U8:1,I8:1,I16:2,U16:2,F16:2,BF16:2,I32:4,U32:4,F32:4,I64:8,U64:8,F64:8,F8_E4M3:1,F8_E5M2:1,F8_E4M3FN:1,F8_E4M3FNUZ:1,F8_E5M2FNUZ:1};

function identifier(value) {
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)||/^(con|prn|aux|nul|com\d|lpt\d|constructor|prototype)$/i.test(value)) throw invalid('Invalid asset id');
  return value;
}
function record(input) {
  if(!plain(input)||Object.keys(input).some(key=>!['id','name','path','kind','family','inspection'].includes(key)))throw invalid('Invalid asset registry entry');
  const id=identifier(input.id??randomUUID());
  if(!kinds.includes(input.kind)||!families.includes(input.family))throw invalid('Unsupported asset kind or family');
  if(typeof input.path!=='string'||!isAbsolute(input.path)||input.path.includes('\0'))throw invalid('Asset path must be an absolute local path');
  if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>120))throw invalid('Asset name must contain 1 to 120 characters');
  return {id,name:input.name?.trim()??id,path:resolve(input.path),kind:input.kind,family:input.family};
}

async function inspect(asset) {
  const path=await realpath(asset.path);
  const file=await open(path,'r');
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size<10)throw invalid('Asset must be a regular safetensors file');
    const prefix=Buffer.alloc(8);await file.read(prefix,0,8,0);
    const length=prefix.readBigUInt64LE();
    if(length<2||length>64n*1024n*1024n||length>BigInt(stat.size-8))throw invalid('Invalid safetensors header size');
    const bytes=Buffer.alloc(Number(length));
    const {bytesRead}=await file.read(bytes,0,bytes.length,8);
    if(bytesRead!==bytes.length)throw invalid('Incomplete safetensors header');
    let header;
    try {header=JSON.parse(bytes.toString('utf8'));}catch {throw invalid('Invalid safetensors header JSON');}
    if(!plain(header))throw invalid('Invalid safetensors header');
    const tensors=Object.entries(header).filter(([key])=>key!=='__metadata__');
    if(!tensors.length)throw invalid('Safetensors header contains no tensors');
    const intervals=[];
    for(const [key,tensor] of tensors){
      if(!key||!plain(tensor)||!Object.hasOwn(bytesPerElement,tensor.dtype)||!Array.isArray(tensor.shape)||tensor.shape.length>16||tensor.shape.some(value=>!Number.isSafeInteger(value)||value<0)
        ||!Array.isArray(tensor.data_offsets)||tensor.data_offsets.length!==2||tensor.data_offsets.some(value=>!Number.isSafeInteger(value)||value<0))throw invalid(`Invalid safetensors header tensor: ${key}`);
      const [start,end]=tensor.data_offsets;
      const expected=tensor.shape.reduce((size,value)=>size*BigInt(value),BigInt(bytesPerElement[tensor.dtype]));
      if(end<start||end>stat.size-8-Number(length)||BigInt(end-start)!==expected)throw invalid(`Invalid safetensors tensor offsets or size: ${key}`);
      if(end>start)intervals.push([start,end]);
    }
    intervals.sort((a,b)=>a[0]-b[0]);
    for(let index=1;index<intervals.length;index++)if(intervals[index][0]<intervals[index-1][1])throw invalid('Overlapping safetensors tensor offsets');
    const keys=tensors.map(([key])=>key);
    const has=(pattern,shape)=>keys.some(key=>pattern.test(key)&&(!shape||shape(header[key].shape)));
    // Header signatures are an early role check; the worker validates every architecture shape before GPU ownership changes.
    const compatible=asset.family==='krea2'?{
      model:has(/^(?:model\.diffusion_model\.|diffusion_model\.)?first\.weight$/,shape=>shape.length===2&&shape[0]===6144&&shape[1]===64)&&has(/^(?:model\.diffusion_model\.|diffusion_model\.)?blocks\.\d+\.attn\.wq\.weight$/,shape=>shape.length===2&&shape[0]===6144&&shape[1]===6144),
      textEncoder:has(/^(?:model\.)?embed_tokens\.weight$/,shape=>shape.length===2&&shape[0]>0&&shape[1]===2560),
      vae:has(/^encoder\.conv1\.weight$/,shape=>shape.length===5&&shape[1]===3)&&has(/^decoder\.conv1\.weight$/,shape=>shape.length===5&&shape[1]===16),
      lora:has(/(?:^|\.)lora_A\.weight$/,shape=>shape.length===2&&shape[0]>0&&shape[1]>0)&&has(/(?:^|\.)lora_B\.weight$/,shape=>shape.length===2&&shape[0]>0&&shape[1]>0),
    }:{
      model:has(/(?:^|\.)(?:transformer_blocks|diffusion_model\.transformer_blocks)\.\d+\./),
      textEncoder:has(/(?:^|\.)embed_tokens\.weight$/),
      vae:has(/(?:^|\.)encoder\./)&&has(/(?:^|\.)decoder\./),
      audioVae:has(/(?:^|\.)encoder\./)&&has(/(?:^|\.)decoder\./),
      textProjection:has(/(?:projection|connector|projector)/),
      enhancer:has(/(?:^|\.)weight$/),
      lora:has(/(?:^|\.)(?:lora_A|lora_down)\.weight$/)&&has(/(?:^|\.)(?:lora_B|lora_up)\.weight$/),
    };
    if(!compatible[asset.kind])throw invalid(`Checkpoint layout is not compatible with ${asset.family} ${asset.kind}`);
    return {...asset,path,inspection:{format:'safetensors',tensors:tensors.length,bytes:stat.size}};
  } finally {await file.close();}
}

export class GenerationAssets {
  constructor(file){if(typeof file!=='string'||!file)throw invalid('Asset registry file is required');this.file=resolve(file);this.warnings=[];this.pending=Promise.resolve();}

  async list(){
    this.warnings=[];
    let stored;
    try {
      const stat=await lstat(this.file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw invalid('Asset registry must be a regular JSON file below 2 MiB');
      stored=JSON.parse(await readFile(this.file,'utf8'));
    } catch(error){if(error.code==='ENOENT')return [];throw error;}
    if(!plain(stored)||stored.schemaVersion!==1||!Array.isArray(stored.assets))throw invalid('Unsupported or invalid asset registry');
    const entries=[],ids=new Set();
    for(const input of stored.assets){
      try {const asset=record(input);if(ids.has(asset.id))throw invalid('Duplicate asset id');ids.add(asset.id);entries.push({...asset,...(plain(input.inspection)?{inspection:input.inspection}:{})});}
      catch(error){this.warnings.push(`Skipped invalid asset registry entry ${String(input?.id??'unknown')}: ${error.message}`);}
    }
    return entries;
  }

  async read(id){identifier(id);const asset=(await this.list()).find(item=>item.id===id);if(!asset)throw invalid(`Asset ${id} not found`);return asset;}
  async resolve(id,{kind,family}={}){
    const asset=await this.read(id);
    if(kind!==undefined&&asset.kind!==kind)throw invalid(`Asset ${id} has incompatible kind; expected ${kind}`);
    if(family!==undefined&&asset.family!==family)throw invalid(`Asset ${id} has incompatible family; expected ${family}`);
    return inspect(asset);
  }

  async register(input){
    const asset=await inspect(record(input));
    const operation=this.pending.then(async()=>{
      const entries=await this.list();
      const index=entries.findIndex(item=>item.id===asset.id);
      if(index<0)entries.push(asset);else entries[index]=asset;
      await mkdir(dirname(this.file),{recursive:true});
      const temporary=`${this.file}.${randomUUID()}.tmp`;
      try {await writeFile(temporary,JSON.stringify({schemaVersion:1,assets:entries},null,2),{flag:'wx',mode:0o600});await rename(temporary,this.file);}
      finally {await rm(temporary,{force:true});}
      return asset;
    });
    this.pending=operation.catch(()=>{});
    return operation;
  }
}
