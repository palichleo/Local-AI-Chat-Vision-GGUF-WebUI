import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GenerationWorker} from './generation-worker.mjs';
import {GenerationAssets} from './generation-assets.mjs';
import {NativeWorkflowCatalog} from './native-workflows.mjs';
import {generatedMedia} from './generated-media.mjs';
import {problem} from './engine.mjs';
const defaults={enabled:false,autoAllow:false,maxIterations:5,pythonPath:'',tokenizerPath:''};
export function generationConfig(value){
 if(!value||typeof value.enabled!=='boolean'||typeof value.autoAllow!=='boolean'||!Number.isInteger(value.maxIterations)||value.maxIterations<1||value.maxIterations>10000)throw problem('Paramètres de génération invalides.');
 const result={enabled:value.enabled,autoAllow:value.autoAllow,maxIterations:value.maxIterations};
 for(const key of ['pythonPath','tokenizerPath']){
  if(typeof value[key]!=='string'||value[key].length>4096||/[\x00\r\n]/.test(value[key]))throw problem('Chemin de génération invalide.');
  result[key]=value[key].trim().replace(/^"(.*)"$/,'$1');
  if(result[key]&&!isAbsolute(result[key]))throw problem('Un chemin absolu est requis.');
 }
 if(/\.json$/i.test(result.tokenizerPath))result.tokenizerPath=dirname(result.tokenizerPath);
 return result;
}
export class GenerationService{
 constructor({root,dataDir,workflowDir,outputDir,worker}={}){
  Object.assign(this,{root,dataDir,outputDir});this.path=join(dataDir,'generation.json');this.workerPath=join(dataDir,'runner-config.json');
  this.config={...defaults};this.worker=worker||new GenerationWorker({root});
  this.assets=new GenerationAssets(join(dataDir,'generation-assets.json'));
  this.catalog=new NativeWorkflowCatalog(workflowDir,{assets:this.assets});this.inputDir=join(dataDir,'runner-input');
 }
 async init(){
  try{this.config=generationConfig(JSON.parse(await readFile(this.path,'utf8')));}catch(error){if(error.code!=='ENOENT')this.warning='Configuration de génération illisible.';}
  return this;
 }
 async save(value){
  const next=generationConfig(value);const changed=next.pythonPath!==this.config.pythonPath||next.tokenizerPath!==this.config.tokenizerPath;
  await mkdir(this.dataDir,{recursive:true});await writeFile(this.path+'.tmp',JSON.stringify(next,null,2),{mode:0o600});await rename(this.path+'.tmp',this.path);
  this.config=next;if(changed)await this.worker.close();
  if(changed||this.worker.status().state!=='ready')void this.start().catch(()=>{});
  return this.snapshot();
 }
 async start(){
  await mkdir(this.dataDir,{recursive:true});await mkdir(this.outputDir,{recursive:true});
  await writeFile(this.workerPath,JSON.stringify({tokenizerPath:this.config.tokenizerPath||join(this.dataDir,'tokenizer'),cacheRoot:join(this.dataDir,'generation-cache'),outputRoot:this.outputDir}),{mode:0o600});
  await this.worker.start({pythonPath:this.config.pythonPath,configPath:this.workerPath});this.syncCapabilities();
  return this.worker.status();
 }
 async snapshot(){
  this.syncCapabilities();
  return {config:this.config,runner:this.worker.status(),workflows:await this.catalog.list(),assets:await this.assets.list(),warning:this.warning||''};
 }
 syncCapabilities(){
  const state=this.worker.status();this.catalog.capabilities=structuredClone(state.capabilities);
  if(state.state!=='ready')for(const capability of Object.values(this.catalog.capabilities)){capability.ready=false;capability.reason=state.error||'Moteur Python indisponible.';}
  if(!this.config.tokenizerPath&&this.catalog.capabilities.krea2)this.catalog.capabilities.krea2={ready:false,reason:'Choisissez le tokenizer local dans les paramètres.'};
 }
 client(){const staged=new Set();return {
  status:async()=>{if(this.worker.status().state!=='ready')await this.start();return {idle:!this.worker.status().busy};},
  preflight:(job,options)=>this.worker.request('preflight',job,options),
  upload:async(bytes,{filename,mime,signal}={})=>{
   signal?.throwIfAborted();if(bytes.length>5*1024*1024||!['image/png','image/jpeg'].includes(mime))throw problem('Référence préparée invalide.');
   await mkdir(this.inputDir,{recursive:true});const file=join(this.inputDir,randomUUID()+(mime==='image/png'?'.png':'.jpg'));await writeFile(file,bytes,{mode:0o600});staged.add(file);return {path:file};
  },
  run:(job,{signal,onProgress}={})=>this.worker.request('generate',job,{signal,onProgress}),
  free:async()=>{try{return await this.worker.release();}finally{for(const file of staged){await rm(file,{force:true});staged.delete(file);}}},
  original:async source=>{const media=await generatedMedia(this.outputDir,source);try{return {bytes:await media.handle.readFile(),mime:media.mime};}finally{await media.handle.close();}}
 };}
 async close(){await this.worker.close();}
}
