import {readdir,readFile,writeFile,lstat,open} from 'node:fs/promises';
import {basename,dirname,join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson,plainFolder} from './update-files.mjs';
import {problem} from './engine.mjs';

export function modelFolderName(path){return path?basename(dirname(path)):'';}
function paths(input){
 const result={};for(const key of ['modelPath','projectorPath']){
  const value=input?.[key]??'';if(typeof value!=='string'||value.length>4096||/[\0\r\n]/.test(value))throw problem('Chemin de modèle invalide.');
  const path=value.trim().replace(/^"(.*)"$/,'$1');if((key==='modelPath'||path)&&!isAbsolute(path))throw problem('Indiquez un chemin absolu vers le GGUF.');result[key]=path?resolve(path):'';
 }
 return result;
}
async function gguf(path){
 if(!/\.gguf$/i.test(path))throw problem('Un fichier GGUF est attendu.');
 let handle;try{
  if(!(await lstat(path)).isFile())throw Error('not a regular file');handle=await open(path,'r');const header=Buffer.alloc(8),{bytesRead}=await handle.read(header,0,8,0);
  if(bytesRead!==8||header.toString('ascii',0,4)!=='GGUF'||![2,3].includes(header.readUInt32LE(4)))throw Error('invalid header');
 }catch{throw problem('Fichier GGUF invalide ou inaccessible : '+path);}finally{await handle?.close();}
}
async function validate(input){const result=paths(input);if(/mmproj/i.test(basename(result.modelPath)))throw problem('Un fichier mmproj est un projecteur, pas le modèle principal.');if(result.projectorPath===result.modelPath)throw problem('Le modèle et le projecteur doivent être différents.');await gguf(result.modelPath);if(result.projectorPath)await gguf(result.projectorPath);return result;}
function modelName(value,fallback){if(value===undefined)return fallback;if(typeof value!=='string'||!value.trim()||value.trim().length>120||/[\x00-\x1f\x7f]/.test(value))throw problem('Le nom doit contenir entre 1 et 120 caractères.');return value.trim();}
function profile(value,name){const pair=[value.modelPath,value.projectorPath];const key=JSON.stringify(process.platform==='win32'?pair.map(p=>p.toLowerCase()):pair);return {id:createHash('sha256').update(key).digest('hex'),name:modelName(name,modelFolderName(value.modelPath)),...value};}
export class ModelLibrary{
 constructor(file,directory){this.file=file;this.directory=resolve(directory);this.pending=Promise.resolve();}
 async list({wait=true}={}){
  if(wait)await this.pending;let data;try{const info=await lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>10*1024**2)throw problem('Bibliothèque de modèles invalide.');data=JSON.parse(await readFile(this.file,'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(data.version!==1||!Array.isArray(data.models)||data.models.length>1000)throw problem('Bibliothèque de modèles invalide.');
  return data.models.map(item=>profile(paths(item),item.name));
 }
 async add(input){
  const value=await validate(input),item=profile(value,input.name),previous=this.pending;
  if(input.id!==undefined&&(typeof input.id!=='string'||! /^[a-f0-9]{64}$/.test(input.id)))throw problem('Identifiant de modèle invalide.');
  const task=(async()=>{
   await previous;const saved=await this.list({wait:false}),existing=saved.find(p=>p.id===item.id);
   if(input.id&&!saved.some(p=>p.id===input.id))throw problem('Modèle enregistré introuvable.',404);
   if(input.id&&existing&&existing.id!==input.id)throw problem('Ces chemins appartiennent déjà à un autre LLM.',409);
   if(existing&&input.name===undefined)return existing;
   const remaining=saved.filter(p=>p.id!==(input.id||item.id));
   if(remaining.length>=1000)throw problem('Bibliothèque limitée à 1 000 modèles.');
   const records=[...remaining,item].map(({modelPath,projectorPath,name})=>({modelPath,projectorPath,name}));
   await plainFolder(dirname(this.file),true);await atomicJson(this.file,{version:1,models:records});return item;
  })();
  this.pending=task.then(()=>{},()=>{});return task;
 }
 async get(id){if(typeof id!=='string'||! /^[a-f0-9]{64}$/.test(id))throw problem('Identifiant de modèle invalide.');const item=(await this.list()).find(p=>p.id===id);if(!item)throw problem('Modèle enregistré introuvable.',404);await validate(item);return item;}
 async scan(){
  await plainFolder(this.directory,true);
  try{await writeFile(join(this.directory,'put model folders here.txt'),'Put each MODEL FOLDER here, not loose files.\nEach folder: one model.gguf and optionally its matching mmproj.gguf.\nThe folder name is the model name. Open Configuration, choose the folder and click Ajouter un LLM.\nGGUF weights stay local and are ignored by Git.\n',{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
  const detected=[],errors=[];
  for(const entry of (await readdir(this.directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(!entry.isDirectory()||entry.isSymbolicLink())continue;
   const directory=join(this.directory,entry.name);
   try{
    await plainFolder(directory);const files=(await readdir(directory,{withFileTypes:true})).filter(f=>f.isFile());
    const main=files.filter(f=>/\.gguf$/i.test(f.name)&&!/mmproj/i.test(f.name)),vision=files.filter(f=>/mmproj/i.test(f.name));
    if(main.length!==1||vision.length>1)throw problem('Un seul GGUF principal et au maximum un projecteur mmproj sont attendus.');
    detected.push(profile(await validate({modelPath:join(directory,main[0].name),projectorPath:vision.length?join(directory,vision[0].name):''})));
   }catch(error){errors.push({name:entry.name,error:error.message});}
  }
  return {detected,errors};
 }
}
