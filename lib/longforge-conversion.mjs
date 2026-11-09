import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {localFiles,locateAsset} from './native-workflow-conversion.mjs';
import {validateNativeWorkflow} from './native-workflows.mjs';
const invalid=message=>Object.assign(new Error(message),{status:400});
const fixed=value=>({policy:'fixed',value});

export function inspectLongForge(source){
 if(!Array.isArray(source?.nodes)||!Array.isArray(source.definitions?.subgraphs))throw invalid('Select a LongForge LTX2.5 editor JSON with its model subgraph');
 const one=(nodes,type)=>{const matches=nodes.filter(node=>node.type===type);if(matches.length!==1)throw invalid(`Expected one ${type}`);return matches[0];};
 const settings=one(source.nodes,'LongForgeLTXVideoSettings').widgets_values;
 const models=source.definitions.subgraphs.flatMap(graph=>graph.nodes||[]),sampling=one(models,'LongForgeLTXSampling').widgets_values;
 if(models.some(node=>!['UNETLoader','CLIPLoader','VAELoader','LongForgeLTXSampling','LongForgeLTXOptionalEnhancer'].includes(node.type)))throw invalid('Unsupported model subgraph node; source was not converted');
 if(!Array.isArray(settings)||settings.length!==5||!Array.isArray(sampling))throw invalid('Unsupported saved LongForge controls');
 const negative=sampling.findIndex(value=>typeof value==='string');
 if(negative<3||sampling.length!==negative+9)throw invalid('Unsupported LongForge sampling layout');
 const sigmas=sampling[negative+1].split(',').map(value=>Number(value.trim()));
 if(JSON.stringify(sigmas)!==JSON.stringify([1,.99375,.9875,.98125,.975,.909375,.725,.421875,0])||sampling[negative+2]!==1||sampling[negative+3]!==1||sampling[negative+7]!==0||sampling[negative+8]!==1)throw invalid('Only the validated 8-step distilled schedule, CFG=1 and eta=0 can be converted');
 const [width,height,seconds,overlap]=settings;
 if(!Number.isFinite(seconds)||seconds<=0||seconds>20)throw invalid('Unsupported scene duration');
 const vaes=models.filter(node=>node.type==='VAELoader');
 if(vaes.length!==2)throw invalid('Expected separate video/audio VAE loaders');
 const audio=vaes.filter(node=>/audio/i.test(node.widgets_values?.[0]));
 if(audio.length!==1)throw invalid('Cannot identify the audio VAE unambiguously');
 const video=vaes.find(node=>node!==audio[0]),msr=source.nodes.find(node=>node.type==='LongForgeLTXMSRReferences');
 return {components:{model:one(models,'UNETLoader').widgets_values?.[0],textEncoder:one(models,'CLIPLoader').widgets_values?.[0],vae:video.widgets_values?.[0],audioVae:audio[0].widgets_values?.[0]},
  parameters:{prompt:{policy:'model',type:'string',maxLength:8000},seed:fixed(sampling[0]),width:fixed(width),height:fixed(height),steps:fixed(8),frames:fixed(Math.round(seconds*24/8)*8+1),fps:fixed(24),stage:{policy:'model',type:'string',choices:['draft','final'],default:'draft'},audio:fixed(true),start_strength:fixed(sampling[negative+4]),end_strength:fixed(sampling[negative+5]),image_compression:fixed(sampling[negative+6]),...(Number(overlap)?{overlap_frames:fixed(Number(overlap))}:{})},
  msr:msr?.widgets_values?.[0]&&msr.widgets_values[0]!=='NONE'?{file:msr.widgets_values[0],strength:msr.widgets_values[1],guideStrength:msr.widgets_values[2],frames:Number(msr.widgets_values[3])}:null,
  warnings:[...(sampling[2]?['The optional prompt enhancer is not converted. Supply the desired complete prompt to the native workflow.']:[]),'Saved scene texts and media paths are not imported. Native references must be assigned explicitly.','The native workflow is disabled until you review it. Its saved resolution may exceed the tested GPU budget.']};
}

export async function convertLongForge(sourcePath,{assets,catalog,modelRoot,additionalRoots,backupDir,id=randomUUID(),name='LongForge LTX2.5 native',description='Native LTX2.5 video with optional start/end images, learned MSR slots and separately approved draft/final renders.'}={}){
 if(typeof sourcePath!=='string'||!isAbsolute(sourcePath))throw invalid('Select an absolute local source path');
 const stat=await lstat(sourcePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024**2)throw invalid('Source must be a regular JSON file below 2 MiB');
 const bytes=await readFile(sourcePath),plan=inspectLongForge(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
 const index=await localFiles(modelRoot,additionalRoots),existing=await assets.list(),registered=[];
 async function register(filename,kind){
  const known=existing.filter(asset=>asset.kind===kind&&asset.family==='ltx25'&&basename(asset.path).toLowerCase()===String(filename).toLowerCase());
  const asset=known.length===1?await assets.resolve(known[0].id,{kind,family:'ltx25'}):await assets.register({path:await locateAsset(index,filename),kind,family:'ltx25'});
  registered.push(asset);return asset.id;
 }
 const components={};for(const [kind,filename]of Object.entries(plan.components))components[kind]={policy:'fixed',asset:await register(filename,kind)};
 const loras=[],references=[{id:'start',role:'start_image',required:false,name:'Start image'},{id:'end',role:'end_image',required:false,name:'End image'},{id:'source',role:'source_video',required:false,name:'Video to extend'}];
 if(plan.msr){
  loras.push({id:'reference-slots',asset:await register(plan.msr.file,'lora'),description:'Enable with MSR reference images.',enabled:{policy:'model',default:false},strength:fixed(plan.msr.strength)});
  plan.parameters.msr_strength=fixed(plan.msr.guideStrength);plan.parameters.msr_frames=fixed(plan.msr.frames);
  references.push(...[1,2].map(number=>({id:'subject-'+number,role:'msr_image',required:false,name:'Subject '+number})));
 }
 const workflow=validateNativeWorkflow({schemaVersion:1,id,name,description,enabled:false,pipeline:'ltx25',mediaType:'video',components,parameters:plan.parameters,loras,references,
  profiles:{draft:{parameters:{width:384,height:256,steps:8,frames:25,fps:24}},final:{parameters:{width:plan.parameters.width.value,height:plan.parameters.height.value,frames:plan.parameters.frames.value,fps:24,steps:8}}}});
 await mkdir(backupDir,{recursive:true});const backupPath=join(backupDir,'longforge-backup-'+randomUUID()+'.json');await writeFile(backupPath,bytes,{flag:'wx',mode:0o600});
 return {workflow:await catalog.save(workflow),assets:registered,backupPath,warnings:plan.warnings};
}
