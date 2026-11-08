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
  let busy=false,working=false,unlimited=false,lastLimited=3;
  const descriptions=new Map();
  let queue=[],queueTotal=0,queueIndex=0,importVersion=0;
  function syncLimit(){
    $('comfy-unlimited').setAttribute('aria-pressed',String(unlimited));
    $('comfy-iterations').hidden=unlimited;
    $('comfy-infinity-value').hidden=!unlimited;
    $('comfy-limit-label').textContent=unlimited?'Sans limite':`${$('comfy-iterations').value||'—'} essai${Number($('comfy-iterations').value)>1?'s':''}`;
  }
  function values(){
    return {enabled:$('comfy-enabled').checked,baseUrl:$('comfy-url').value,autoAllow:$('comfy-auto').checked,maxIterations:unlimited?10000:Number($('comfy-iterations').value)};
  }
  function workflowDescriptions(){return [...descriptions].map(([id,description])=>({id,description}));}
  function setBusy(value){
    busy=value;const disabled=value||working;
    for(const id of ['comfy-enabled','comfy-url','comfy-auto','comfy-iterations','comfy-test','comfy-address-edit','comfy-minus','comfy-plus','comfy-unlimited','workflow-file','workflow-skip','workflow-name','workflow-description','workflow-requires-image'])$(id).disabled=disabled;
    $('workflow-import').disabled=disabled||!importGraph;
    for(const input of document.querySelectorAll('.comfy-settings select,.workflow-description,.workflow-remove'))input.disabled=disabled;
  }
  function connection(result){
    $('comfy-url').readOnly=result.detected===true;
    $('comfy-address-edit').hidden=!result.detected;
    $('comfy-detection').textContent=result.detected?'Adresse détectée · connexion locale':'Adresse manuelle · démarrez ComfyUI puis testez la connexion';
  }
  async function refresh({settings=true}={}){
    const result=await(await api('comfy')).json();config=result.config;workflows=result.workflows;state.comfy=config;
    if(settings){
      $('comfy-enabled').checked=config.enabled;$('comfy-url').value=config.baseUrl;$('comfy-auto').checked=config.autoAllow;
      unlimited=config.maxIterations===10000;if(!unlimited)lastLimited=config.maxIterations;
      $('comfy-iterations').value=lastLimited;syncLimit();connection(result.discovery||{});
    }
    $('workflow-list').replaceChildren();
    if(!workflows.length)$('workflow-list').append(node('p','comfy-help','Ajoutez vos workflows et décrivez quand les utiliser.'));
    for(const workflow of workflows){
      const card=node('article','workflow-card');const header=node('div','workflow-card-header');header.append(node('strong','',workflow.name));
      const remove=node('button','text-button workflow-remove','Retirer');remove.type='button';
      remove.onclick=async()=>{try{await api('comfy/remove',{id:workflow.id});descriptions.delete(workflow.id);await refresh({settings:false});}catch(e){notice(e.message);}};
      header.append(remove);const description=node('textarea','workflow-description');description.rows=2;description.maxLength=2000;
      description.placeholder='Ex. : portraits réalistes, style cinéma, lumière douce…';description.setAttribute('aria-label',`Quand utiliser ${workflow.name}`);
      description.value=descriptions.get(workflow.id)??workflow.description;
      description.oninput=()=>{if(description.value===workflow.description)descriptions.delete(workflow.id);else descriptions.set(workflow.id,description.value);};
      card.append(header,description);$('workflow-list').append(card);
    }
    setBusy(busy);
  }
  async function saved(){descriptions.clear();await refresh();}
  $('comfy-iterations').oninput=()=>{lastLimited=Number($('comfy-iterations').value)||3;syncLimit();};
  $('comfy-minus').onclick=()=>{if(unlimited){unlimited=false;lastLimited=9999;}else lastLimited=Math.max(1,(Number($('comfy-iterations').value)||1)-1);$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-plus').onclick=()=>{if(unlimited)return;const next=(Number($('comfy-iterations').value)||1)+1;if(next>=10000)unlimited=true;else lastLimited=next;$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-unlimited').onclick=()=>{if(!unlimited)lastLimited=Math.min(9999,Math.max(1,Number($('comfy-iterations').value)||3));unlimited=!unlimited;$('comfy-iterations').value=lastLimited;syncLimit();};
  $('comfy-address-edit').onclick=()=>{connection({detected:false});$('comfy-url').focus();};
  $('comfy-recover').onclick=async()=>{try{$('comfy-recover').disabled=true;await api('tools/recover',{});onChange();$('comfy-status').textContent='GPU libéré. Le modèle peut redémarrer.';}catch(e){$('comfy-status').textContent=e.message;}finally{$('comfy-recover').disabled=false;}};
  $('comfy-test').onclick=async()=>{
    $('comfy-test').disabled=true;$('comfy-status').textContent='Vérification de la connexion…';
    try{const result=await(await api('comfy/test',{baseUrl:$('comfy-url').value})).json();$('comfy-url').value=result.baseUrl;connection(result);$('comfy-status').textContent=result.status.idle?'ComfyUI connecté · disponible':'ComfyUI connecté · occupé';}
    catch(e){connection({detected:false});$('comfy-status').textContent=e.message;}
    finally{$('comfy-test').disabled=busy;}
  };
  async function nextWorkflow(){
    const version=++importVersion;
    importGraph=null;setBusy(busy);
    if(!queue.length){$('workflow-import-panel').hidden=true;return;}
    const file=queue.shift();queueIndex++;
    $('workflow-import-panel').hidden=false;$('workflow-import-fields').hidden=true;
    $('workflow-import-progress').textContent=`${queueIndex} / ${queueTotal} · ${file.name}`;
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
    setBusy(busy);
  }
  $('workflow-file').onchange=async event=>{queue=[...event.target.files];event.target.value='';queueTotal=queue.length;queueIndex=0;await nextWorkflow();};
  $('workflow-skip').onclick=()=>nextWorkflow();
  $('workflow-import').onclick=async()=>{
    const description=$('workflow-description').value.trim();
    if(!description){$('comfy-status').textContent='Ajoutez une courte description pour que le modèle sache quand choisir ce workflow.';$('workflow-description').focus();return;}
    working=true;setBusy(busy);
    try{
      const bindings={};for(const key of ['prompt','seed','width','height','image','negative_prompt']){const value=$(`binding-${key}`).value;if(value)bindings[key]=JSON.parse(value);}
      if(!bindings.prompt){document.querySelector('.workflow-bindings').open=true;throw Error('Choisissez l’entrée du prompt dans « Entrées que le modèle peut modifier ».');}
      const outputNodes=Object.entries(importGraph||{}).filter(([,n])=>/SaveImage/.test(n.class_type)).map(([id])=>id);
      if(!outputNodes.length)throw Error('Le workflow doit contenir un nœud SaveImage.');
      await api('comfy/import',{name:$('workflow-name').value,description,graph:importGraph,bindings,outputNodes,requiresImage:$('workflow-requires-image').checked});
      await refresh({settings:false});await nextWorkflow();if(!queue.length&&$('workflow-import-panel').hidden)$('comfy-status').textContent='Workflows ajoutés. Le modèle choisira selon leurs descriptions.';
    }catch(e){$('comfy-status').textContent=e.message;}
    finally{working=false;setBusy(busy);}
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
  return {refresh,reset,renderGallery,requestTool,saveReview,values,workflowDescriptions,saved,setBusy};
}
