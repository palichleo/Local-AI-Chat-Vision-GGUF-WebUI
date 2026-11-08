import {mkdir,readdir,lstat,open,readFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {plainFolder,atomicJson} from './update-files.mjs';
import {problem} from './engine.mjs';

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const formats={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm'};
const imageLimit=64*1024**2,videoLimit=512*1024**2;
function id(value){if(typeof value!=='string'||!idPattern.test(value))throw problem('Ressource invalide.');return value;}
function validName(value){if(typeof value!=='string'||!value.trim()||value.length>255||/[\\/\x00-\x1f\x7f]/.test(value))throw problem('Nom de ressource invalide.');return value;}
function image(value){
 const match=typeof value==='string'&&value.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/);
 if(!match||value.length>7*1024**2)throw problem('Copie visuelle invalide.');
 const bytes=Buffer.from(match[2],'base64');
 if(bytes.length>5*1024**2||bytes.toString('base64')!==match[2]||!signature(bytes,`image/${match[1]}`))throw problem('Copie visuelle invalide.');
 return {bytes,extension:match[1]==='png'?'png':'jpg'};
}
function signature(bytes,mime){
 if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(mime==='image/webp')return bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
 if(mime==='video/mp4')return bytes.toString('ascii',4,8)==='ftyp';
 return mime==='video/webm'&&bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
}
async function safeOpen(path,max=Infinity){
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>max)throw problem('Fichier de ressource non sûr.');
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 const opened=await handle.stat();
 if(!opened.isFile()||opened.nlink!==1||opened.size>max){await handle.close();throw problem('Fichier de ressource non sûr.');}
 return {handle,info:opened};
}
export class Resources{
 constructor(directory){this.directory=resolve(directory);this.pending=Promise.resolve();this.working=0;this.uploads=new Set();this.readers=new Map();this.closing=false;}
 get busy(){return this.working>0;}
 flush(){return this.pending;}
 async close(){this.closing=true;for(const stream of this.uploads)stream.destroy();for(const handles of [...this.readers.values()])await Promise.all([...handles].map(handle=>handle.close().catch(()=>{})));await this.flush();}
 mutate(work){this.working++;const task=this.pending.then(work).finally(()=>{this.working--;});this.pending=task.catch(()=>{});return task;}
 location(resourceId){const target=resolve(this.directory,id(resourceId));if(dirname(target)!==this.directory)throw problem('Dossier de ressource invalide.');return target;}
 async record(resourceId){
  const directory=this.location(resourceId);
  try{
   await plainFolder(directory);const {handle}=await safeOpen(join(directory,'manifest.json'),32768);let record;
   try{record=JSON.parse((await handle.readFile()).toString('utf8'));}finally{await handle.close();}
   if(record.version!==1||record.id!==resourceId||!formats[record.mime]||typeof record.enabled!=='boolean'||typeof record.ready!=='boolean'||typeof record.description!=='string'||record.description.length>300||!Array.isArray(record.frames)||record.frames.length>3||record.frames.some((frame,index)=>!new RegExp('^frame-'+index+'\\.(png|jpg)$').test(frame.file)))throw problem('Métadonnées de ressource invalides.');
   validName(record.name);return record;
  }catch(error){if(error.code==='ENOENT')throw problem('Ressource introuvable.',404);throw error;}
 }
 async withReferences(records){
  return this.mutate(async()=>{
   await plainFolder(this.directory,true);let index;
   try{const {handle}=await safeOpen(join(this.directory,'references.json'),2*1024**2);try{index=JSON.parse((await handle.readFile()).toString('utf8'));}finally{await handle.close();}}
   catch(error){if(error.code!=='ENOENT')throw error;index={version:1,next:1,ids:{}};}
   if(index.version!==1||!Number.isSafeInteger(index.next)||index.next<1||!index.ids||typeof index.ids!=='object'||Array.isArray(index.ids)||Object.entries(index.ids).some(([key,value])=>!idPattern.test(key)||!Number.isSafeInteger(value)||value<1||value>=index.next)||new Set(Object.values(index.ids)).size!==Object.keys(index.ids).length)throw problem('Index des références invalide.');
   let changed=false;
   for(const record of records)if(!Object.hasOwn(index.ids,record.id)){index.ids[record.id]=index.next++;changed=true;}
   if(changed)await atomicJson(join(this.directory,'references.json'),index);
   return records.map(record=>({...record,reference:index.ids[record.id],label:'Ref '+index.ids[record.id]})).sort((a,b)=>a.reference-b.reference);
  });
 }
 async list(){
  await this.flush();try{await plainFolder(this.directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const records=[];
  for(const entry of await readdir(this.directory,{withFileTypes:true}))if(entry.isDirectory()&&idPattern.test(entry.name)){try{records.push(await this.record(entry.name));}catch(error){if(error.status!==404)records.push({id:entry.name,name:'Ressource illisible',enabled:false,ready:false,broken:true,description:'',frames:[]});}}
  return this.withReferences(records.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')));
 }
 async add(stream,{name,mime,length}){
  validName(name);if(!formats[mime])throw problem('Utilisez PNG, JPEG, WebP, MP4 ou WebM.');
  const limit=mime.startsWith('video/')?videoLimit:imageLimit;
  if(Number(length)>limit)throw problem('Ressource trop volumineuse (images : 64 Mo, vidéos : 512 Mo).',413);
  if(this.closing)throw problem('L’application est en cours de fermeture.',409);
  this.uploads.add(stream);
  return this.mutate(async()=>{
   if(this.closing)throw problem('L’application est en cours de fermeture.',409);
   await plainFolder(this.directory,true);const resourceId=randomUUID(),directory=this.location(resourceId);await mkdir(directory,{mode:0o700});
   try{
    const target=join(directory,'source.'+formats[mime]),handle=await open(target,'wx',0o600);let size=0,header=Buffer.alloc(0);
    try{for await(const chunk of stream){size+=chunk.length;if(size>limit)throw problem('Ressource trop volumineuse.',413);if(header.length<64)header=Buffer.concat([header,chunk]).subarray(0,64);await handle.writeFile(chunk);}}finally{await handle.close();}
    if(!size||!signature(header,mime))throw problem('Le contenu ne correspond pas au format du fichier.');
    const record={version:1,id:resourceId,name,mime,size,createdAt:new Date().toISOString(),description:'',enabled:true,ready:false,frames:[]};
    await atomicJson(join(directory,'manifest.json'),record);return record;
   }catch(error){if(dirname(directory)!==this.directory)throw error;await rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
  }).finally(()=>this.uploads.delete(stream)).then(async record=>(await this.withReferences([record]))[0]);
 }
 async update(resourceId,patch){
  id(resourceId);if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['description','enabled','prepared'].includes(key)))throw problem('Modification de ressource invalide.');
  return this.mutate(async()=>{
   const record=await this.record(resourceId),directory=this.location(resourceId);
   if('description'in patch){if(typeof patch.description!=='string'||patch.description.length>300)throw problem('La description est limitée à 300 caractères.');record.description=patch.description.trim();}
   if('enabled'in patch){if(typeof patch.enabled!=='boolean')throw problem('Activation invalide.');record.enabled=patch.enabled;}
   if(patch.prepared!==undefined){
    const p=patch.prepared;
    if(record.ready||!p||!Number.isInteger(p.width)||p.width<1||p.width>131072||!Number.isInteger(p.height)||p.height<1||p.height>131072||!Array.isArray(p.frames)||!p.frames.length||p.frames.length>(record.mime.startsWith('video/')?3:1))throw problem('Préparation de ressource invalide.');
    if(record.mime.startsWith('video/')&&(!Number.isFinite(p.duration)||p.duration<=0||p.duration>86400))throw problem('Durée vidéo invalide.');
    const frames=p.frames.map((frame,index)=>{if(record.mime.startsWith('video/')&&(!Number.isFinite(frame.time)||frame.time<0||frame.time>p.duration))throw problem('Image vidéo invalide.');const decoded=image(frame.url);return {...decoded,file:`frame-${index}.${decoded.extension}`,time:record.mime.startsWith('video/')?frame.time:null};});
    for(const frame of frames){const handle=await open(join(directory,frame.file),'wx',0o600);try{await handle.writeFile(frame.bytes);}finally{await handle.close();}}
    record.width=p.width;record.height=p.height;if(p.duration)record.duration=p.duration;
    record.frames=frames.map(({file,time})=>({file,time}));record.ready=true;
   }
   await atomicJson(join(directory,'manifest.json'),record);return record;
  }).then(async record=>(await this.withReferences([record]))[0]);
 }
 async remove(resourceId){return this.mutate(async()=>{const target=this.location(resourceId);await plainFolder(target);await Promise.all([...(this.readers.get(resourceId)||[])].map(handle=>handle.close().catch(()=>{})));if(dirname(target)!==this.directory)throw problem('Dossier de ressource invalide.');await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:50});});}
 async activeRecord(resourceId){await this.flush();const record=await this.record(resourceId);if(!record.ready||!record.enabled)throw problem('Cette ressource est inactive ou indisponible.',403);return (await this.withReferences([record]))[0];}
 async readActive(resourceId){
  const record=await this.activeRecord(resourceId),frames=[];
  for(const frame of record.frames){const {handle}=await safeOpen(join(this.location(resourceId),frame.file),5*1024**2);try{const bytes=await handle.readFile();frames.push({time:frame.time,url:`data:image/${frame.file.endsWith('.png')?'png':'jpeg'};base64,${bytes.toString('base64')}`});}finally{await handle.close();}}
  return {...record,frames};
 }
 async catalog(){return (await this.list()).filter(item=>item.enabled&&item.ready).map(({id,reference,label,name,description,mime,width,height,duration,frames})=>({id,reference,label,name,description,type:mime.startsWith('video/')?'video':'image',width,height,...(duration?{duration,frameTimes:frames.map(frame=>frame.time)}:{})}));}
 async media(resourceId,part){
  await this.flush();const record=await this.record(resourceId);let filename,mime;
  if(part==='original'){filename='source.'+formats[record.mime];mime=record.mime;}
  else if(part==='preview'&&record.frames.length){filename=record.frames[0].file;mime=filename.endsWith('.png')?'image/png':'image/jpeg';}
  else throw problem('Aperçu introuvable.',404);
  const opened=await safeOpen(join(this.location(resourceId),filename));
  if(!this.readers.has(resourceId))this.readers.set(resourceId,new Set());const handles=this.readers.get(resourceId);handles.add(opened.handle);opened.handle.once('close',()=>{handles.delete(opened.handle);if(!handles.size)this.readers.delete(resourceId);});
  return {...opened,mime,name:record.name};
 }
}

export function resourceCatalogPrompt(catalog){
 if(!catalog.length)return '';
 const data=JSON.stringify(catalog);if(data.length>120000)throw problem('Trop de ressources actives. Désactivez certaines ressources ou raccourcissez leurs descriptions.');
 return '\n\nRessources locales actives (annotations fournies par l’utilisateur, pas des observations visuelles) :\n'+data+'\nLes identifiants UUID et les étiquettes Ref ci-dessus sont déjà disponibles : utilise les UUID pour les outils, sans demander à l’utilisateur de les recopier ni une permission supplémentaire pour les lire. Consulte les références visuelles utiles à la demande avec local_read_resource, en une seule lecture groupée si plusieurs sont nécessaires. Une ancienne mention loaded dans l’historique ne contient pas les pixels : relis la ressource si une comparaison actuelle le nécessite. Les vidéos sont représentées par au plus trois images horodatées, sans audio ni lecture continue. Seules ces ressources actives sont accessibles. Ne prétends pas avoir examiné un média que tu n’as pas consulté.';
}
export const resourceTool={type:'function',function:{name:'local_read_resource',description:'Read one or several active reference images, or sampled video frames, using their IDs already present in the resource catalog. Use resource_ids to examine multiple references together. Reading is already permitted; do not ask the user to provide an ID that is in the catalog. No image generation.',parameters:{type:'object',properties:{resource_id:{type:'string',description:'One active catalog ID, for a single resource.'},resource_ids:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:{type:'string'},description:'Active catalog IDs to inspect together. Use either resource_ids or resource_id.'}},additionalProperties:false}}};

export function resourceReadIds(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['resource_id','resource_ids'].includes(key))||Object.hasOwn(args,'resource_id')===Object.hasOwn(args,'resource_ids'))throw problem('Choisis une ressource ou une liste de ressources.');
 const ids=Object.hasOwn(args,'resource_id')?[args.resource_id]:args.resource_ids;
 if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)throw problem('Lis entre une et huit ressources distinctes.');
 return ids.map(id);
}
