import { compressImage } from './images.mjs';

export function setupComfy({api,state,node,notice,onChange,onSettingsBusyChange=()=>{},openOutput,onOutput=()=>{}}){
  const $=id=>document.getElementById(id);
  let config,workflows=[],importGraph=null,urls=[],galleryVersion=0;
  function reset(){galleryVersion++;for(const url of urls)URL.revokeObjectURL(url);urls=[];$('gallery-list').replaceChildren(node('p','asset-empty','Aucune génération dans cette conversation.'));}
  async function original(record,index,signal){return (await api(`gallery/${record.conversationId}/${record.id}/${index}`,undefined,{signal})).blob();}
  async function renderGallery(conversationId){
    if(conversationId&&conversationId!==state.conversationId)return;
    reset();const version=galleryVersion;if(!conversationId)return;
    const result=await(await api(`gallery/${conversationId}`)).json();
    if(version!==galleryVersion||conversationId!==state.conversationId)return;
    if(result.runs.length)$('gallery-list').replaceChildren();
    for(const record of result.runs){
      for(const [index,output]of record.outputs.entries()){
        const card=node('article','gallery-card');
        if(output.analysisDataUrl){const img=node('img');img.loading='lazy';img.decoding='async';img.src=output.analysisDataUrl;img.alt=record.prompt;img.onclick=()=>openOutput(record,index);card.append(img);}
        const prompt=node('details','output-prompt'),summary=node('summary');summary.setAttribute('aria-label','Afficher ou réduire le prompt');summary.append(node('span','',record.prompt));prompt.append(summary);
        card.append(node('strong','',record.workflowName),prompt,node('small','',new Date(record.createdAt).toLocaleString('fr-FR')));
        const labels={reviewed:'Analyse disponible',correction_requested:'Nouvelle génération demandée'};
        card.append(node('small','gallery-meta',`${record.parameters.seed===undefined?'':`Seed : ${record.parameters.seed} · `}${labels[record.analysis?.status]||'À analyser'}`));
        if(record.analysis?.text){const details=node('details','gallery-review');details.append(node('summary','','Analyse du modèle'),node('p','',record.analysis.text));card.append(details);}
        const actions=node('div','gallery-actions');
        for(const download of [false,true]){
          const button=node('button','secondary',download?'Télécharger':'Details');button.type='button';
          button.onclick=async()=>{
            if(!download){await openOutput(record,index);return;}
            button.disabled=true;
            try{const blob=await original(record,index);const url=URL.createObjectURL(blob);urls.push(url);
              const a=node('a');a.href=url;a.download=output.source.filename;a.click();
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
    descriptions.clear();queue=[];importGraph=null;currentFile=null;clearImportError();
    $('workflow-import-panel').hidden=true;$('comfy-status').textContent='';
    setBusy(busy);
  }
  const descriptions=new Map();
  let queue=[],queueTotal=0,queueIndex=0,importVersion=0,currentFile=null,importFailure='',imageInputs=[],imageOptions=[],nextImageId=0;
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
    for(const id of ['comfy-enabled','comfy-url','comfy-auto','comfy-iterations','comfy-test','comfy-address-edit','comfy-minus','comfy-plus','comfy-unlimited','workflow-file','workflow-skip','workflow-name','workflow-description','workflow-add-image'])$(id).disabled=disabled;
    $('comfy-iterations').disabled=disabled||unlimited;
    $('workflow-import').disabled=disabled||!importGraph;
    $('workflow-add-image').disabled=disabled||!importGraph||imageInputs.length>=64;
    for(const row of imageInputs)for(const control of row.controls)control.disabled=disabled;
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
      const count=workflow.imageInputs?.length||(workflow.bindings?.image?1:0);card.append(header,description,node('small','comfy-help',count?`${count} entrée(s) image configurée(s)`:'Aucune entrée image configurée · références transmises par le texte uniquement'));$('workflow-list').append(card);
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
  function renderImageInputs(){
    $('workflow-image-inputs').replaceChildren(...imageInputs.map(row=>row.card));setBusy(busy);
  }
  $('workflow-add-image').onclick=()=>{
    if(busy||working||!importGraph||imageInputs.length>=64)return;
    const id='ref_'+(++nextImageId),card=node('div','workflow-image-row');
    const name=node('input');name.type='text';name.maxLength=80;name.placeholder='Nom de l’entrée';name.setAttribute('aria-label','Nom de '+id);
    const description=node('textarea');description.rows=2;description.maxLength=300;description.placeholder='Rôle de cette image dans le workflow…';description.setAttribute('aria-label','Rôle de '+id);
    const target=node('select');target.setAttribute('aria-label','Champ du workflow pour '+id);target.add(new Option('Choisir le champ de fichier…',''));
    for(const option of imageOptions)target.add(new Option(option.label,JSON.stringify({node:option.id,input:option.input})));
    const required=node('input');required.type='checkbox';const label=node('label','history-toggle');label.append(required,node('span','','Référence obligatoire'));
    const remove=node('button','text-button workflow-image-remove','Retirer cette entrée');remove.type='button';
    const row={id,card,name,description,target,required,controls:[name,description,target,required,remove]};
    remove.onclick=()=>{if(busy||working)return;imageInputs=imageInputs.filter(item=>item!==row);renderImageInputs();};
    card.append(name,description,target,label,remove);imageInputs.push(row);renderImageInputs();name.focus();
  };
  function clearImportError(){importFailure='';$('workflow-import-error').textContent='';$('workflow-import-error').hidden=true;}
  function importError(message,control=$('workflow-import-error')){
    importFailure=message;$('workflow-import-error').textContent=message;$('workflow-import-error').hidden=false;
    control.scrollIntoView?.({block:'nearest'});control.focus({preventScroll:true});
  }
  function hasPendingImport(){return currentFile!==null||queue.length>0;}
  async function nextWorkflow(){
    const version=++importVersion;
    importGraph=null;currentFile=null;clearImportError();setBusy(busy);
    if(!queue.length){$('workflow-import-panel').hidden=true;return;}
    const file=currentFile=queue.shift();queueIndex++;
    $('workflow-import-panel').hidden=false;$('workflow-import-fields').hidden=true;
    $('workflow-import-progress').textContent=`${queueIndex} / ${queueTotal} · ${file.name} · À configurer`;
    $('workflow-import-panel').scrollIntoView?.({block:'nearest'});
    changeWorking(1);
    try{
      if(file.size>2*1024*1024)throw Error('Workflow limité à 2 Mo.');
      const contents=await file.text();if(version!==importVersion)return;
      const graph=JSON.parse(contents);if(graph?.nodes||graph?.links)throw Error('Ce fichier est un workflow de l’éditeur ComfyUI, pas un export API. Dans ComfyUI, ouvrez ce workflow puis choisissez File → Export (API). Importez ensuite le fichier exporté. Aucun workflow n’a été ajouté.');
      const options=[];
      for(const[id,value]of Object.entries(graph)){if(!value?.class_type||!value.inputs)throw Error('Le fichier doit être un export API ComfyUI.');for(const[input,current]of Object.entries(value.inputs))if(['string','number','boolean'].includes(typeof current)||Array.isArray(current))options.push({id,input,label:`${id} · ${value._meta?.title||value.class_type} · ${input}`});}
      importGraph=graph;$('workflow-name').value=file.name.replace(/\.json$/i,'');$('workflow-description').value='';imageInputs=[];nextImageId=0;imageOptions=options.filter(option=>typeof graph[option.id].inputs[option.input]==='string');renderImageInputs();
      for(const key of ['prompt','seed','width','height','negative_prompt']){
        const select=$(`binding-${key}`);select.replaceChildren(new Option('Non utilisé',''));
        for(const option of options)select.add(new Option(option.label,JSON.stringify({node:option.id,input:option.input})));
        const match=options.find(o=>key==='prompt'?(/CLIPTextEncode/.test(graph[o.id].class_type)&&o.input==='text'&&typeof graph[o.id].inputs.text==='string'&&!/negative|négatif/i.test(graph[o.id]._meta?.title||'')):o.input===key);
        if(match)select.value=JSON.stringify({node:match.id,input:match.input});
      }
      document.querySelector('.workflow-bindings').open=!$('binding-prompt').value;
      $('workflow-import-fields').hidden=false;$('comfy-status').textContent='Décrivez quand utiliser ce workflow, puis cliquez sur Ajouter le workflow ou Enregistrer.';
    }catch(e){if(version===importVersion){importGraph=null;importError(e.message);}}
    finally{changeWorking(-1);if(version===importVersion&&importGraph){$('workflow-description').focus({preventScroll:true});$('workflow-description').scrollIntoView?.({block:'nearest'});}}
  }
  $('workflow-file').onchange=async event=>{const files=[...event.target.files];event.target.value='';if(!files.length)return;if(currentFile){queue.push(...files);queueTotal+=files.length;$('workflow-import-progress').textContent=`${queueIndex} / ${queueTotal} · ${currentFile.name} · À configurer`;return;}queue=files;queueTotal=queue.length;queueIndex=0;await nextWorkflow();};
  $('workflow-skip').onclick=()=>nextWorkflow();
  async function importWorkflow(){
    if(busy||working)return false;
    if(!importGraph){importError(importFailure||'Sélectionnez un workflow au format API valide.');return false;}
    clearImportError();
    const description=$('workflow-description').value.trim();
    if(!description){importError('Ajoutez une courte description pour que le modèle sache quand choisir ce workflow.',$('workflow-description'));return false;}
    const session=settingsVersion;changeWorking(1);
    try{
      const bindings={};for(const key of ['prompt','seed','width','height','negative_prompt']){const value=$(`binding-${key}`).value;if(value)bindings[key]=JSON.parse(value);}
      if(!bindings.prompt){document.querySelector('.workflow-bindings').open=true;throw Error('Choisissez l’entrée du prompt dans « Entrées que le modèle peut modifier ».');}
      const images=imageInputs.map(row=>{if(!row.name.value.trim()||!row.description.value.trim()||!row.target.value)throw Error('Chaque entrée image doit avoir un nom, un rôle et un champ de fichier.');return {id:row.id,name:row.name.value.trim(),description:row.description.value.trim(),...JSON.parse(row.target.value),required:row.required.checked};});
      if(new Set(images.map(slot=>JSON.stringify([slot.node,slot.input]))).size!==images.length)throw Error('Chaque entrée image doit cibler un champ différent.');
      const outputNodes=Object.entries(importGraph||{}).filter(([,n])=>/SaveImage/.test(n.class_type)).map(([id])=>id);
      if(!outputNodes.length)throw Error('Le workflow doit contenir un nœud SaveImage.');
      await api('comfy/import',{name:$('workflow-name').value,description,graph:importGraph,bindings,outputNodes,imageInputs:images});
      if(session!==settingsVersion)return false;
      importGraph=null;currentFile=null;
      try{await refresh({settings:false});}catch(error){notice('Workflow enregistré, mais sa liste n’a pas pu être actualisée : '+error.message);}
      if(session!==settingsVersion)return false;await nextWorkflow();if(!hasPendingImport())$('comfy-status').textContent='Workflows ajoutés. Le modèle choisira selon leurs descriptions.';
      return true;
    }catch(e){if(session===settingsVersion)importError(e.message);return false;}
    finally{changeWorking(-1);}
  }
  $('workflow-import').onclick=importWorkflow;
  async function finishImport(){
    if(!hasPendingImport())return true;
    return await importWorkflow()&&!hasPendingImport();
  }
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
  async function requestTool(request,signal,onProgress,onImage=()=>{}){
    const cancel=()=>api('tools/cancel',{requestId:request.requestId}).catch(()=>{});
    let decision;try{decision=await permission(request,signal);signal.throwIfAborted();}catch(error){await cancel();throw error;}
    if(decision==='deny')await cancel();
    if(decision==='deny')return {content:JSON.stringify({status:'denied',message:'L’utilisateur a refusé cette génération. Ne réessaie pas sans nouvelle demande.'}),images:[],denied:true};
    signal.throwIfAborted();
    signal.addEventListener('abort',cancel,{once:true});let terminal=false,originalsTask;const originalsController=new AbortController(),originalsSignal=AbortSignal.any([signal,originalsController.signal]);
    function receiveOriginals(record){
      if(originalsTask)return;
      if(record.conversationId!==state.conversationId)throw Error('Cette sortie ne correspond pas à la conversation courante.');
      // Transfer and compress one original at a time, including large workflow batches.
      originalsTask=(async()=>{
        const prepared=[],errors=[];
        for(const [index,output] of record.outputs.entries()){
          try{
          originalsSignal.throwIfAborted();const blob=await original(record,index,originalsSignal);
          try{onImage({record,index,blob});}catch(error){notice('Affichage de l’original indisponible : '+error.message);}
          const image=await compressImage(blob,{name:output.source.filename,count:record.outputs.length});
          prepared.push({url:image.url,width:image.width,height:image.height});
          }catch(error){originalsSignal.throwIfAborted();errors.push(`Sortie ${index+1} : ${error.message}`);}
        }
        return errors.length?{error:new Error(errors.join(' '))}:{prepared};
      })().catch(error=>({error}));
    }
    try{
      let job=await(await api('tools/execute',{requestId:request.requestId,permission:decision})).json();
      if(signal.aborted){cancel();signal.throwIfAborted();}
      const jobId=job.id;
      while(!['done','error','cancelled'].includes(job.state)){
        if(job.record)receiveOriginals(job.record);
        signal.throwIfAborted();onProgress(job.progress);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},700);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});});
        job=await(await api('tools/job',undefined,{signal})).json();
        if(job?.id!==jobId)throw Error('La génération suivie a été remplacée par une autre tâche.');
      }
      terminal=true;
      if(!job.record)return {content:JSON.stringify({status:'error',message:job.error}),images:[],failed:true,error:job.error};
      const record=job.record;receiveOriginals(record);
      if(record.conversationId!==state.conversationId)throw Error('Cette sortie ne correspond pas à la conversation courante.');
      const showGallery=()=>renderGallery(record.conversationId).catch(error=>notice(`Galerie indisponible : ${error.message}`));
      await showGallery(); onOutput();
      if(job.warning)notice(job.warning);
      let images=[],dimensions=[],error=job.state==='done'?'':job.error||'La génération a été interrompue après production de l’image.';
      onProgress('Préparation des copies pour la vision…');
      try{
        const originals=await originalsTask;if(originals.error)throw originals.error;
        for(let index=0;index<record.outputs.length;index++){
          signal.throwIfAborted();
          const image=originals.prepared[index];images.push(image.url);record.outputs[index].analysisDataUrl=image.url;const size=image.width&&image.height?{width:image.width,height:image.height}:null;dimensions.push(size);if(size)Object.assign(record.outputs[index],size);
        }
      }catch(failure){
        if(signal.aborted)throw failure;
        images=[];error=[error,`Image générée, mais copie pour l’analyse indisponible : ${failure.message}`].filter(Boolean).join(' ');notice(error);
      }
      signal.throwIfAborted();
      if(images.length){
        try{await api('gallery/analysis',{conversationId:record.conversationId,id:record.id,images,dimensions},{signal});}
        catch(failure){if(signal.aborted)throw failure;notice(`Copies d’analyse non enregistrées : ${failure.message}`);}
      }
      await showGallery();
      return {content:JSON.stringify({status:error?'generated':'success',run_id:record.id,workflow:record.workflowName,prompt:record.prompt,reference_count:record.parameters?.reference_count??null,reference_capacity:record.parameters?.reference_capacity??null,reference_mode:record.parameters?.reference_mode||'unknown',outputs:record.outputs.map(o=>o.source),...(error?{warning:error}:{}),note:images.length?'Les images jointes ensuite sont les copies réduites des sorties. Les originaux sont dans la galerie.':'Les originaux sont dans la galerie. Aucune copie visuelle n’est disponible pour vérifier le résultat.'}),images,record,failed:!!error,error};
    }catch(error){if(!terminal)cancel();if(signal.aborted)throw signal.reason;throw error;}
    finally{originalsController.abort();signal.removeEventListener('abort',cancel);onChange();}
  }
  return {refresh,cancelSettings,reset,renderGallery,requestTool,saveReview,values,workflowDescriptions,hasPendingImport,finishImport,saved,setBusy};
}
