import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { problem } from './engine.mjs';
import { nativeFields } from './native-messages.mjs';
import { ComfyClient } from './comfy-client.mjs';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function collectToolCalls(calls,delta) {
  for(const part of delta.tool_calls || []) {
    if(!Number.isInteger(part.index)||part.index<0||part.index>7) throw problem('Appel d’outil invalide.',502);
    const call=calls[part.index] ||= {id:'',type:'function',function:{name:'',arguments:''}};
    if(part.id) call.id=part.id;
    if(part.function?.name) call.function.name+=part.function.name;
    if(part.function?.arguments) call.function.arguments+=part.function.arguments;
    if(call.function.arguments.length>16000) throw problem('Paramètres d’outil trop longs.',502);
  }
}

export class ToolRuntime {
  constructor({engine,catalog,gallery,resources,getConfig,engineConfig,saveConfig=async()=>{},persist=()=>false,clientFactory=url=>new ComfyClient(url)}) {
    Object.assign(this,{engine,catalog,gallery,resources,getConfig,engineConfig,saveConfig,persist,clientFactory});
    this.pending=new Map();this.turns=new Map();this.job=null;this.finished=Promise.resolve();this.closing=false;this.gpuBlocked=false;
  }
  get active(){return this.gpuBlocked || !!this.job && !['done','error','cancelled'].includes(this.job.state);}
  status(){if(!this.job)return null;const {id,state,progress,error,record,warning}=this.job;return {id,state,progress,error,record,warning,blocked:this.gpuBlocked};}
  clear(){this.pending.clear();this.turns.clear();this.gallery.clearMemory?.();this.job=null;}
  forgetConversation(conversationId) {
    for (const [key, value] of this.pending) if (value.conversationId === conversationId) this.pending.delete(key);
    if (this.job?.record?.conversationId === conversationId && !this.active) this.job = null;
  }
  async request(calls,{conversationId,turnId,messages}) {
    if(this.closing)throw problem('L’application est en cours de fermeture.',409);
    if(!this.getConfig().enabled) throw problem('ComfyUI est désactivé.');
    if(!uuid.test(conversationId)||!uuid.test(turnId)) throw problem('Identifiant de conversation invalide.');
    if(calls.length!==1||!calls[0]?.id||calls[0].function?.name!=='comfy_generate_image') throw problem('Le modèle doit demander un seul appel ComfyUI à la fois.',502);
    if((this.turns.get(turnId)||0)>=this.getConfig().maxIterations) throw problem('La limite de générations pour ce message est atteinte.');
    const call=nativeFields({role:'assistant',tool_calls:calls}).tool_calls[0];let args;
    try{args=JSON.parse(call.function.arguments);}catch{throw problem('Le modèle a produit des paramètres d’outil invalides.',502);}
    if(!args||typeof args!=='object'||Array.isArray(args))throw problem('Paramètres d’outil invalides.',502);
    const workflow=await this.catalog.read(args.workflow_id);
    const refs=messages.filter(m=>m.role==='user'&&!m.internal).flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url').map(p=>p.image_url.url):[]);
    let reference=args.reference_image===undefined?undefined:refs[args.reference_image],resourceId,resourceFrame;
    const approvalArgs={...args};
    if(args.reference_resource!==undefined){
      if(!this.resources||!workflow.bindings?.image||args.reference_image!==undefined)throw problem('Référence de bibliothèque incompatible avec ce workflow.');
      resourceId=args.reference_resource;resourceFrame=args.reference_frame??0;
      const resource=await this.resources.readActive(resourceId);
      if(!Number.isInteger(resourceFrame)||resourceFrame<0||!resource.frames[resourceFrame])throw problem('Image de ressource introuvable.');
      reference=resource.frames[resourceFrame].url;args={...args};delete args.reference_resource;delete args.reference_frame;
    }else if(args.reference_frame!==undefined)throw problem('Une ressource est nécessaire pour choisir une image vidéo.');
    if(args.reference_image!==undefined&&!reference) throw problem('La référence demandée par le modèle est introuvable.');
    await this.catalog.prepare(args.workflow_id,args,{referenceImage:reference?'pending.png':undefined});
    const now=Date.now();for(const [key,p] of this.pending)if(now-p.created>900000)this.pending.delete(key);
    if(this.pending.size>=32)this.pending.delete(this.pending.keys().next().value);
    const requestId=randomUUID();
    this.pending.set(requestId,{call,args,digest:workflow.digest,conversationId,turnId,reference,resourceId,resourceFrame,created:now});
    return {requestId,call,workflowName:workflow.name,args:approvalArgs,autoAllow:this.getConfig().autoAllow};
  }
  async execute({requestId,permission}) {
    if(this.closing)throw problem('L’application est en cours de fermeture.',409);
    if(this.active||this.engine.busy)throw problem('Une opération GPU est déjà en cours.',409);
    const p=this.pending.get(requestId);
    if(!p||Date.now()-p.created>900000)throw problem('Cet appel a expiré. Relance la demande.',409);
    const cfg=this.getConfig();
    if(!cfg.enabled)throw problem('ComfyUI est désactivé.');
    if(!cfg.autoAllow&&!['once','always'].includes(permission))throw problem('Une autorisation est nécessaire.',403);
    if((this.turns.get(p.turnId)||0)>=cfg.maxIterations)throw problem('La limite de générations est atteinte.');
    const controller=new AbortController();let finish;
    this.finished=new Promise(resolve=>{finish=resolve;});
    this.job={id:randomUUID(),requestId,state:'checking',progress:'Vérification de ComfyUI…',controller,comfyUrl:cfg.baseUrl};
    this.pending.delete(requestId);
    try{
      if((await this.catalog.read(p.args.workflow_id)).digest!==p.digest)throw problem('Le workflow a été modifié. Une nouvelle autorisation est nécessaire.',409);
      if(p.resourceId)await this.resources.activeRecord(p.resourceId);
      const client=this.clientFactory(cfg.baseUrl);
      if(!(await client.status({signal:controller.signal})).idle)throw problem('ComfyUI exécute déjà une tâche. Attends sa fin.',409);
      controller.signal.throwIfAborted();
      if(permission==='always')await this.saveConfig({...cfg,autoAllow:true});
      controller.signal.throwIfAborted();
      this.turns.set(p.turnId,(this.turns.get(p.turnId)||0)+1);
      if(this.turns.size>256)this.turns.delete(this.turns.keys().next().value);
      this.job.state='unloading';this.job.progress='Libération du modèle et du projecteur…';
      this.run(p,client,controller).finally(finish);
      return this.status();
    }catch(error){this.job.state='error';this.job.error=error.message;finish();throw error;}
  }

  async run(p,client,controller) {
    let released=false,record;const job=this.job;const signal=controller.signal;
    try{
      await this.engine.stop();signal.throwIfAborted();
      if(p.resourceId)await this.resources.activeRecord(p.resourceId);
      let referenceImage;
      if(p.reference){const mime=p.reference.startsWith('data:image/png')?'image/png':'image/jpeg';referenceImage=await client.upload(Buffer.from(p.reference.split(',')[1],'base64'),{filename:`atelier-${job.id}.${mime==='image/png'?'png':'jpg'}`,mime,signal});}
      const prepared=await this.catalog.prepare(p.args.workflow_id,p.args,{referenceImage});
      if(prepared.workflow.digest!==p.digest)throw problem('Le workflow a été modifié avant son exécution.');
      job.state='generating';job.progress='Génération ComfyUI…';
      const generationStarted=Date.now();
      const result=await client.run(prepared.graph,{signal,outputNodes:prepared.outputNodes,onProgress:v=>{job.progress=typeof v==='string'?v:JSON.stringify(v);}});
      const parameters={...p.args,...(p.resourceId?{reference_resource:p.resourceId,reference_frame:p.resourceFrame}:{})};
      if(result.promptId)parameters.comfy_prompt_id=result.promptId;
      parameters.workflow_digest=prepared.workflow.digest;parameters.comfy_duration_ms=Date.now()-generationStarted;
      const inputs=Object.fromEntries(Object.entries(prepared.graph).map(([id,node])=>[id,{type:node.class_type,inputs:Object.fromEntries(Object.entries(node.inputs||{}).filter(([,value])=>typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=300&&!value.startsWith('data:')))}]));
      if(Buffer.byteLength(JSON.stringify({...parameters,workflow_inputs:inputs}))<19000)parameters.workflow_inputs=inputs;
      for(const key of ['seed','width','height','negative_prompt']){const binding=prepared.workflow.bindings?.[key];const value=binding&&prepared.graph[binding.node]?.inputs[binding.input];if(typeof value==='number'&&Number.isFinite(value)||key==='negative_prompt'&&typeof value==='string')parameters[key]=value;}
      const outputRecord={id:job.id,conversationId:p.conversationId,workflowId:p.args.workflow_id,workflowName:prepared.workflow.name,prompt:p.args.prompt,parameters,comfyUrl:job.comfyUrl,createdAt:new Date().toISOString(),outputs:result.outputs.map(source=>({source}))};
      const persist=this.persist();
      try{record=await this.gallery.put(outputRecord,{persist});}
      catch(error){
        if(!persist)throw error;
        record=await this.gallery.put(outputRecord,{persist:false});
        job.warning=`Historique de l’image non enregistré : ${error.message} Les liens restent disponibles dans cette session.`;
      }
      job.record=record;
    }catch(error){job.error=signal.aborted?'Génération annulée.':error.message;}
    finally{
      job.executionError=job.error||'';
      job.state='releasing';job.progress='Libération des modèles ComfyUI…';
      try{await client.free({signal:AbortSignal.timeout(90000)});released=true;this.gpuBlocked=false;}catch(error){this.gpuBlocked=true;job.error=`${job.error||''} Libération ComfyUI non confirmée : ${error.message}`.trim();}
      if(released&&!this.closing){
        job.state='restarting';job.progress='Rechargement du modèle et de la vision…';
        try{
          await this.engine.start(this.engineConfig());
          const deadline=Date.now()+300000;
          while(this.engine.state==='loading'&&Date.now()<deadline&&!this.closing)await delay(250);
          if(this.engine.state!=='ready')throw Error(this.engine.error||'Le modèle n’a pas redémarré.');
        }catch(error){job.error=`${job.error||''} ${error.message}`.trim();}
      }
      job.state=job.error?(signal.aborted?'cancelled':'error'):'done';job.progress=job.error||'Image prête pour vérification.';
    }
  }
  async recover(){
    if(this.closing||!this.gpuBlocked||!this.job||!['error','cancelled'].includes(this.job.state))throw problem('Aucune libération à reprendre.',409);
    const job=this.job;job.state='releasing';
    let finish;this.finished=new Promise(resolve=>{finish=resolve;});
    try{
      await this.clientFactory(job.comfyUrl).free({signal:AbortSignal.timeout(90000)});
      this.gpuBlocked=false;job.error=job.executionError||'';
      job.state=job.error?(job.controller.signal.aborted?'cancelled':'error'):'done';
      job.progress=job.error||'GPU libéré. Le modèle peut redémarrer.';return this.status();
    }catch(error){job.state='error';job.error=error.message;throw error;}
    finally{finish();}
  }
  cancel({requestId,jobId}={}){
    if((requestId&&this.job?.requestId!==requestId)||(jobId&&this.job?.id!==jobId))throw problem('Cette génération n’est plus la tâche courante.',409);
    this.job?.controller.abort();return this.status();
  }
  async close(){this.closing=true;this.cancel();await this.finished;}
}
