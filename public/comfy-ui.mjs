import { compressImage } from './images.mjs';

export function setupComfy({api,state,node,notice,onChange,onSettingsBusyChange=()=>{}}){
  const $=id=>document.getElementById(id);
  let config,workflows=[],importGraph=null,urls=[],galleryVersion=0;
  function reset(){galleryVersion++;for(const url of urls)URL.revokeObjectURL(url);urls=[];$('gallery-list').replaceChildren();$('gallery').hidden=true;}
  async function original(record,index,signal){return (await api(`gallery/${record.conversationId}/${record.id}/${index}`,undefined,{signal})).blob();}
  async function renderGallery(conversationId){
    if(conversationId&&conversationId!==state.conversationId)return;
    reset();const version=galleryVersion;if(!conversationId)return;
    const result=await(await api(`gallery/${conversationId}`)).json();
    if(version!==galleryVersion||conversationId!==state.conversationId)return;
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
  let busy=false,working=false,workingCount=0,unlimited=false,lastLimited=5;
  let settingsVersion=0,refreshVersion=0,refreshController,connectionController;
  let addressDiscovery={detected:false};
  function changeWorking(delta){
    workingCount+=delta;
    const next=workingCount>0,changed=next!==working;working=next;
    setBusy(busy);
    if(changed)onSettingsBusyChange(working);
  }
  function cancelSettings(){
    settingsVersion++;refreshVersion++;importVersion++;
    refreshController?.abort();connectionController?.abort();
    descriptions.clear();queue=[];importGraph=null;
    $('workflow-import-panel').hidden=true;$('comfy-status').textContent='';
    setBusy(busy);
  }
  const descriptions=new Map();
  let queue=[],queueTotal=0,queueIndex=0,importVersion=0;
  function syncLimit(){
    $('comfy-unlimited').setAttribute('aria-pressed',String(unlimited));
    $('comfy-iterations').hidden=unlimited;
    $('comfy-iterations').required=!unlimited;
    $('comfy-iterations').disabled=busy||working||unlimited;
    $('comfy-infinity-value').hidden=!unlimited;
    $('comfy-limit-label').textContent=unlimited?'Sans limite':`${$('comfy-iterations').value||'—'} essai${Number($('comfy-iterations').value)>1?'s':''}`;
  }
  function values(){
    const maxIterations=unlimited?10000:Number($('comfy-iterations').value);
    if(!Number.isInteger(maxIterations)||maxIterations<1||maxIterations>(unlimited?10000:9999))throw Error('Le nombre de générations doit être un entier entre 1 et 9 999, ou choisissez ∞.');
    return {enabled:$('comfy-enabled').checked,baseUrl:$('comfy-url').value,autoAllow:$('comfy-auto').checked,maxIterations};
  }
  function workflowDescriptions(){return [...descriptions].map(([id,description])=>({id,description}));}
  function setBusy(value){
    busy=value;const disabled=value||working;
    for(const id of ['comfy-enabled','comfy-url','comfy-auto','comfy-iterations','comfy-test','comfy-address-edit','comfy-minus','comfy-plus','comfy-unlimited','workflow-file','workflow-skip','workflow-name','workflow-description','workflow-requires-image'])$(id).disabled=disabled;
    $('comfy-iterations').disabled=disabled||unlimited;
    $('workflow-import').disabled=disabled||!importGraph;
    for(const input of document.querySelectorAll('.comfy-settings select,.workflow-description,.workflow-remove'))input.disabled=disabled;
  }
  function connection(result){
    addressDiscovery=result;
    $('comfy-url').readOnly=result.detected===true;
    $('comfy-address-edit').hidden=!result.detected;
    $('comfy-detection').textContent=result.detected?'Adresse détectée · connexion locale':'Adresse manuelle · démarrez ComfyUI puis testez la connexion';
  }
  function applySettings(result,{settings=true}={}){
    config=result.config;workflows=result.workflows;state.comfy=config;
    if(settings){
      $('comfy-enabled').checked=config.enabled;$('comfy-url').value=config.baseUrl;$('comfy-auto').checked=config.autoAllow;
      unlimited=config.maxIterations===10000;if(!unlimited)lastLimited=config.maxIterations;
      $('comfy-iterations').value=lastLimited;syncLimit();connection(result.discovery||addressDiscovery);
    }
    $('workflow-list').replaceChildren();
    if(!workflows.length)$('workflow-list').append(node('p','comfy-help','Ajoutez vos workflows et décrivez quand les utiliser.'));
    for(const workflow of workflows){
      const card=node('article','workflow-card');const header=node('div','workflow-card-header');header.append(node('strong','',workflow.name));
      const remove=node('button','text-button workflow-remove','Retirer');remove.type='button';
      remove.onclick=async()=>{
        if(busy||working)return;
        const session=settingsVersion;changeWorking(1);
        try{await api('comfy/remove',{id:workflow.id});descriptions.delete(workflow.id);if(session===settingsVersion)await refresh({settings:false});}
        catch(e){if(session===settingsVersion)notice(e.message);}
        finally{changeWorking(-1);}
      };
      header.append(remove);const description=node('textarea','workflow-description');description.rows=2;description.maxLength=2000;
      description.placeholder='Ex. : portraits réalistes, style cinéma, lumière douce…';description.setAttribute('aria-label',`Quand utiliser ${workflow.name}`);
      description.value=descriptions.get(workflow.id)??workflow.description;
      description.oninput=()=>{if(description.value===workflow.description)descriptions.delete(workflow.id);else descriptions.set(workflow.id,description.value);};
      card.append(header,description);$('workflow-list').append(card);
    }
    setBusy(busy);
  }
  async function refresh({settings=true}={}){
    const version=++refreshVersion,controller=new AbortController();
    refreshController?.abort();refreshController=controller;changeWorking(1);
    try{
      const result=await(await api('comfy',undefined,{signal:controller.signal})).json();
      if(version===refreshVersion&&!controller.signal.aborted)applySettings(result,{settings});
    }catch(error){if(version===refreshVersion&&!controller.signal.aborted)throw error;}
    finally{if(refreshController===controller)refreshController=null;changeWorking(-1);}
  }
  function saved(result){
    refreshVersion++;refreshController?.abort();descriptions.clear();
    applySettings({config:result.comfy,workflows:result.workflows});
  }
  $('comfy-iterations').oninput=()=>{lastLimited=Number($('comfy-iterations').value)||5;syncLimit();};
  $('comfy-minus').onclick=()=>{if(unlimited){unlimited=false;lastLimited=9999;}else lastLimited=Math.max(1,(Number($('comfy-iterations').value)||1)-1);$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-plus').onclick=()=>{if(unlimited)return;const next=(Number($('comfy-iterations').value)||1)+1;if(next>=10000)unlimited=true;else lastLimited=next;$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-unlimited').onclick=()=>{if(!unlimited)lastLimited=Math.min(9999,Math.max(1,Number($('comfy-iterations').value)||5));unlimited=!unlimited;$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-address-edit').onclick=()=>{connection({detected:false});$('comfy-url').focus();};
  $('comfy-recover').onclick=async()=>{try{$('comfy-recover').disabled=true;await api('tools/recover',{});onChange();$('comfy-status').textContent='GPU libéré. Le modèle peut redémarrer.';}catch(e){$('comfy-status').textContent=e.message;}finally{$('comfy-recover').disabled=false;}};
  $('comfy-test').onclick=async()=>{
    if(busy||working)return;
    const session=settingsVersion,baseUrl=$('comfy-url').value,controller=new AbortController();
    connectionController=controller;changeWorking(1);$('comfy-status').textContent='Vérification de la connexion…';
    try{
      const result=await(await api('comfy/test',{baseUrl},{signal:controller.signal})).json();
      if(session!==settingsVersion||controller.signal.aborted||$('comfy-url').value!==baseUrl)return;
      $('comfy-url').value=result.baseUrl;connection(result);$('comfy-status').textContent=result.status.idle?'ComfyUI connecté · disponible':'ComfyUI connecté · occupé';
    }catch(e){if(session===settingsVersion&&!controller.signal.aborted){connection({detected:false});$('comfy-status').textContent=e.message;}}
    finally{if(connectionController===controller)connectionController=null;changeWorking(-1);}
  };
  async function nextWorkflow(){
    const version=++importVersion;
    importGraph=null;setBusy(busy);
    if(!queue.length){$('workflow-import-panel').hidden=true;return;}
    const file=queue.shift();queueIndex++;
    $('workflow-import-panel').hidden=false;$('workflow-import-fields').hidden=true;
    $('workflow-import-progress').textContent=`${queueIndex} / ${queueTotal} · ${file.name}`;
    changeWorking(1);
    try{
      if(file.size>2*1024*1024)throw Error('Workflow limité à 2 Mo.');
      const contents=await file.text();if(version!==importVersion)return;
      const graph=JSON.parse(contents);if(graph.nodes||graph.links)throw Error('Dans ComfyUI : File → Export (API). Le JSON de l’éditeur ne suffit pas.');
      const options=[];
      for(const[id,value]of Object.entries(graph)){if(!value?.class_type||!value.inputs)throw Error('Le fichier doit être un export API ComfyUI.');for(const[input,current]of Object.entries(value.inputs))if(['string','number','boolean'].includes(typeof current)||Array.isArray(current))options.push({id,input,label:`${id} · ${value._meta?.title||value.class_type} · ${input}`});}
      importGraph=graph;$('workflow-name').value=file.name.replace(/\.json$/i,'');$('workflow-description').value='';$('workflow-requires-image').checked=false;
      for(const key of ['prompt','seed','width','height','image','negative_prompt']){
        const select=$(`binding-${key}`);select.replaceChildren(new Option('Non utilisé',''));
        for(const option of options)select.add(new Option(option.label,JSON.stringify({node:option.id,input:option.input})));
        const match=options.find(o=>key==='prompt'?(/CLIPTextEncode/.test(graph[o.id].class_type)&&o.input==='text'&&typeof graph[o.id].inputs.text==='string'&&!/negative|négatif/i.test(graph[o.id]._meta?.title||'')):key==='image'?graph[o.id].class_type==='LoadImage'&&o.input==='image':o.input===key);
        if(match)select.value=JSON.stringify({node:match.id,input:match.input});
      }
      document.querySelector('.workflow-bindings').open=!$('binding-prompt').value;
      $('workflow-import-fields').hidden=false;$('comfy-status').textContent='Décrivez quand utiliser ce workflow, puis choisissez ses entrées modifiables.';
    }catch(e){if(version===importVersion){importGraph=null;$('comfy-status').textContent=e.message;}}
    finally{changeWorking(-1);}
  }
  $('workflow-file').onchange=async event=>{queue=[...event.target.files];event.target.value='';queueTotal=queue.length;queueIndex=0;await nextWorkflow();};
  $('workflow-skip').onclick=()=>nextWorkflow();
  $('workflow-import').onclick=async()=>{
    const description=$('workflow-description').value.trim();
    if(!description){$('comfy-status').textContent='Ajoutez une courte description pour que le modèle sache quand choisir ce workflow.';$('workflow-description').focus();return;}
    if(busy||working||!importGraph)return;
    const session=settingsVersion;changeWorking(1);
    try{
      const bindings={};for(const key of ['prompt','seed','width','height','image','negative_prompt']){const value=$(`binding-${key}`).value;if(value)bindings[key]=JSON.parse(value);}
      if(!bindings.prompt){document.querySelector('.workflow-bindings').open=true;throw Error('Choisissez l’entrée du prompt dans « Entrées que le modèle peut modifier ».');}
      const outputNodes=Object.entries(importGraph||{}).filter(([,n])=>/SaveImage/.test(n.class_type)).map(([id])=>id);
      if(!outputNodes.length)throw Error('Le workflow doit contenir un nœud SaveImage.');
      await api('comfy/import',{name:$('workflow-name').value,description,graph:importGraph,bindings,outputNodes,requiresImage:$('workflow-requires-image').checked});
      if(session!==settingsVersion)return;
      await refresh({settings:false});if(session!==settingsVersion)return;await nextWorkflow();if(!queue.length&&$('workflow-import-panel').hidden)$('comfy-status').textContent='Workflows ajoutés. Le modèle choisira selon leurs descriptions.';
    }catch(e){if(session===settingsVersion)$('comfy-status').textContent=e.message;}
    finally{changeWorking(-1);}
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
    signal.throwIfAborted();
    const cancel=()=>{api('tools/cancel',{requestId:request.requestId}).catch(()=>{});};
    signal.addEventListener('abort',cancel,{once:true});let terminal=false;
    try{
      let job=await(await api('tools/execute',{requestId:request.requestId,permission:decision})).json();
      if(signal.aborted){cancel();signal.throwIfAborted();}
      const jobId=job.id;
      while(!['done','error','cancelled'].includes(job.state)){
        signal.throwIfAborted();onProgress(job.progress);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},700);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});});
        job=await(await api('tools/job',undefined,{signal})).json();
        if(job?.id!==jobId)throw Error('La génération suivie a été remplacée par une autre tâche.');
      }
      terminal=true;
      if(!job.record)return {content:JSON.stringify({status:'error',message:job.error}),images:[],failed:true,error:job.error};
      const record=job.record;
      if(record.conversationId!==state.conversationId)throw Error('Cette sortie ne correspond pas à la conversation courante.');
      const showGallery=()=>renderGallery(record.conversationId).catch(error=>notice(`Galerie indisponible : ${error.message}`));
      await showGallery();
      if(job.warning)notice(job.warning);
      let images=[],error=job.state==='done'?'':job.error||'La génération a été interrompue après production de l’image.';
      onProgress('Préparation des copies pour la vision…');
      try{
        for(let index=0;index<record.outputs.length;index++){
          signal.throwIfAborted();
          const blob=await original(record,index,signal);
          const image=await compressImage(blob,{name:record.outputs[index].source.filename,count:record.outputs.length});images.push(image.url);
        }
      }catch(failure){
        if(signal.aborted)throw failure;
        images=[];error=[error,`Image générée, mais copie pour l’analyse indisponible : ${failure.message}`].filter(Boolean).join(' ');notice(error);
      }
      signal.throwIfAborted();
      if(images.length){
        try{await api('gallery/analysis',{conversationId:record.conversationId,id:record.id,images},{signal});}
        catch(failure){if(signal.aborted)throw failure;notice(`Copies d’analyse non enregistrées : ${failure.message}`);}
      }
      await showGallery();
      return {content:JSON.stringify({status:error?'generated':'success',run_id:record.id,workflow:record.workflowName,prompt:record.prompt,outputs:record.outputs.map(o=>o.source),...(error?{warning:error}:{}),note:images.length?'Les images jointes ensuite sont les copies réduites des sorties. Les originaux sont dans la galerie.':'Les originaux sont dans la galerie. Aucune copie visuelle n’est disponible pour vérifier le résultat.'}),images,record,failed:!!error,error};
    }catch(error){if(!terminal)cancel();if(signal.aborted)throw signal.reason;throw error;}
    finally{signal.removeEventListener('abort',cancel);onChange();}
  }
  return {refresh,cancelSettings,reset,renderGallery,requestTool,saveReview,values,workflowDescriptions,saved,setBusy};
}
