import { compressImage } from './images.mjs';

export function setupComfy({api,state,node,notice,onChange}){
  const $=id=>document.getElementById(id);
  let config,workflows=[],importGraph=null,urls=[];
  function reset(){for(const url of urls)URL.revokeObjectURL(url);urls=[];$('gallery-list').replaceChildren();$('gallery').hidden=true;}
  async function original(record,index){return (await api(`gallery/${record.conversationId}/${record.id}/${index}`)).blob();}
  async function renderGallery(conversationId){
    reset();if(!conversationId)return;
    const result=await(await api(`gallery/${conversationId}`)).json();
    if(conversationId!==state.conversationId)return;
    $('gallery').hidden=!result.runs.length;
    for(const record of result.runs){
      for(const [index,output]of record.outputs.entries()){
        const card=node('article','gallery-card');
        if(output.analysisDataUrl){const img=node('img');img.src=output.analysisDataUrl;img.alt=record.prompt;card.append(img);}
        card.append(node('strong','',record.workflowName),node('p','',record.prompt),node('small','',new Date(record.createdAt).toLocaleString('fr-FR')));
        const labels={reviewed:'Analyse disponible',correction_requested:'Nouvelle génération demandée'};
        card.append(node('small','gallery-meta',`${record.parameters.seed===undefined?'':`Seed : ${record.parameters.seed} · `}${labels[record.analysis?.status]||'À analyser'}`));
        if(record.analysis?.text){const details=node('details','gallery-review');details.append(node('summary','','Analyse du modèle'),node('p','',record.analysis.text));card.append(details);}
        const actions=node('div','gallery-actions');
        for(const download of [false,true]){
          const button=node('button','secondary',download?'Télécharger':'Voir l’original');button.type='button';
          button.onclick=async()=>{
            button.disabled=true;
            try{const blob=await original(record,index);const url=URL.createObjectURL(blob);urls.push(url);
              if(download){const a=node('a');a.href=url;a.download=output.source.filename;a.click();}
              else{$('original-image').src=url;$('original-name').textContent=output.source.filename;$('original-dialog').showModal();}
            }catch(error){notice(`Original indisponible : ${error.message}`);}finally{button.disabled=false;}
          };actions.append(button);
        }
        card.append(actions);$('gallery-list').append(card);
      }
    }
  }
  async function refresh(){
    ({config,workflows}=await(await api('comfy')).json());
    state.comfy=config;
    $('comfy-enabled').checked=config.enabled;$('comfy-url').value=config.baseUrl;$('comfy-auto').checked=config.autoAllow;$('comfy-iterations').value=config.maxIterations;
    $('workflow-list').replaceChildren();
    for(const workflow of workflows){
      const row=node('div','workflow-row');row.append(node('span','',workflow.name));
      const remove=node('button','text-button','Retirer');remove.type='button';remove.onclick=async()=>{try{await api('comfy/remove',{id:workflow.id});await refresh();}catch(e){notice(e.message);}};row.append(remove);$('workflow-list').append(row);
    }
  }
  $('comfy-recover').onclick=async()=>{try{$('comfy-recover').disabled=true;await api('tools/recover',{});onChange();$('comfy-status').textContent='GPU libéré. Le modèle peut redémarrer.';}catch(e){$('comfy-status').textContent=e.message;}finally{$('comfy-recover').disabled=false;}};
  $('comfy-save').onclick=async()=>{
    try{await api('comfy/config',{enabled:$('comfy-enabled').checked,baseUrl:$('comfy-url').value,autoAllow:$('comfy-auto').checked,maxIterations:Number($('comfy-iterations').value)});await refresh();$('comfy-status').textContent='Configuration enregistrée.';}catch(e){$('comfy-status').textContent=e.message;}
  };
  $('comfy-test').onclick=async()=>{
    try{const result=await(await api('comfy/status')).json();$('comfy-status').textContent=result.idle?'ComfyUI connecté · disponible':'ComfyUI connecté · occupé';}catch(e){$('comfy-status').textContent=e.message;}
  };
  $('workflow-file').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    try{
      if(file.size>2*1024*1024)throw Error('Workflow limité à 2 Mo.');
      importGraph=JSON.parse(await file.text());if(importGraph.nodes||importGraph.links)throw Error('Dans ComfyUI : File → Export (API). Le JSON de l’éditeur ne suffit pas.');
      const options=[];
      for(const [id,value]of Object.entries(importGraph)){if(!value?.class_type||!value.inputs)throw Error('Le fichier doit être un export API ComfyUI.');for(const [input,current]of Object.entries(value.inputs)){if(['string','number','boolean'].includes(typeof current)||Array.isArray(current))options.push({id,input,label:`${id} · ${value._meta?.title||value.class_type} · ${input}`});}}
      $('workflow-name').value=file.name.replace(/\.json$/i,'');
      for(const key of ['prompt','seed','width','height','image','negative_prompt']){
        const select=$(`binding-${key}`);select.replaceChildren(new Option('Non utilisé',''));
        for(const option of options)select.add(new Option(option.label,JSON.stringify({node:option.id,input:option.input})));
        const match=options.find(o=>key==='prompt'?(/CLIPTextEncode/.test(importGraph[o.id].class_type)&&o.input==='text'):key==='image'?importGraph[o.id].class_type==='LoadImage'&&o.input==='image':o.input===key);
        if(match)select.value=JSON.stringify({node:match.id,input:match.input});
      }
      $('workflow-import-fields').hidden=false;$('comfy-status').textContent='Choisissez les entrées que le modèle pourra modifier.';
    }catch(e){importGraph=null;$('workflow-import-fields').hidden=true;$('comfy-status').textContent=e.message;}
  };
  $('workflow-import').onclick=async()=>{
    try{
      const bindings={};for(const key of ['prompt','seed','width','height','image','negative_prompt']){const value=$(`binding-${key}`).value;if(value)bindings[key]=JSON.parse(value);}
      const outputNodes=Object.entries(importGraph||{}).filter(([,n])=>/SaveImage/.test(n.class_type)).map(([id])=>id);
      if(!outputNodes.length)throw Error('Le workflow doit contenir un nœud SaveImage.');
      await api('comfy/import',{name:$('workflow-name').value,description:$('workflow-description').value,graph:importGraph,bindings,outputNodes,requiresImage:$('workflow-requires-image').checked});
      importGraph=null;$('workflow-import-fields').hidden=true;await refresh();$('comfy-status').textContent='Workflow disponible pour le modèle.';
    }catch(e){$('comfy-status').textContent=e.message;}
  };
  $('original-close').onclick=()=>{$('original-dialog').close();$('original-image').removeAttribute('src');};
  async function permission(request,signal){
    if(request.autoAllow)return undefined;
    $('tool-name').textContent=request.workflowName;$('tool-arguments').textContent=JSON.stringify(request.args,null,2);$('tool-dialog').showModal();
    return new Promise((resolve,reject)=>{
      const finish=value=>{cleanup();resolve(value);};const cancel=event=>{event?.preventDefault();finish('deny');};
      const abort=()=>{cleanup();reject(signal.reason||new DOMException('Annulé','AbortError'));};
      function cleanup(){$('tool-dialog').close();signal.removeEventListener('abort',abort);$('tool-dialog').removeEventListener('cancel',cancel);for(const [id]of buttons)$(id).onclick=null;}
      const buttons=[['tool-deny','deny'],['tool-once','once'],['tool-always','always']];for(const[id,value]of buttons)$(id).onclick=()=>finish(value);
      $('tool-dialog').addEventListener('cancel',cancel);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  async function saveReview(record,text,status){await api('gallery/review',{id:record.id,conversationId:record.conversationId,text,status});await renderGallery(record.conversationId);}
  async function requestTool(request,signal,onProgress){
    const decision=await permission(request,signal);
    if(decision==='deny')return {content:JSON.stringify({status:'denied',message:'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.'}),images:[],denied:true};
    signal.throwIfAborted();let job=await(await api('tools/execute',{requestId:request.requestId,permission:decision})).json();
    const cancel=()=>{api('tools/cancel',{}).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();signal.throwIfAborted();}
    try{
      while(!['done','error','cancelled'].includes(job.state)){
        signal.throwIfAborted();onProgress(job.progress);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},700);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});});
        job=await(await api('tools/job',undefined,{signal})).json();
      }
      if(job.record)try{await renderGallery(state.conversationId);}catch(error){notice(`Galerie indisponible : ${error.message}`);}
      if(job.state!=='done')return {content:JSON.stringify({status:'error',message:job.error}),images:[],failed:true};
      onProgress('Préparation des copies pour la vision…');
      const images=[];
      for(let index=0;index<job.record.outputs.length;index++){
        signal.throwIfAborted();const blob=await original(job.record,index);const image=await compressImage(blob,{name:job.record.outputs[index].source.filename,count:job.record.outputs.length});images.push(image.url);
      }
      signal.throwIfAborted();
      await api('gallery/analysis',{conversationId:state.conversationId,id:job.record.id,images});
      await renderGallery(state.conversationId);
      return {content:JSON.stringify({status:'success',run_id:job.record.id,workflow:job.record.workflowName,prompt:job.record.prompt,outputs:job.record.outputs.map(o=>o.source),note:'Les images jointes ensuite sont les copies réduites des sorties. Les originaux sont dans la galerie.'}),images,record:job.record};
    }finally{signal.removeEventListener('abort',cancel);onChange();}
  }
  return {refresh,reset,renderGallery,requestTool,saveReview};
}
