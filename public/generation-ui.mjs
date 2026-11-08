export function setupGenerationUI({api,node,openOutput,onResize=()=>{}}){
 const cards=new Set();
 function mount(container,request={}){
  const figure=node('figure','generation-card'),frame=node('div','generation-frame'),caption=node('figcaption','generation-caption'),label=node('span','','Préparation de la génération…'),size=node('span','generation-size');
  frame.setAttribute('aria-busy','true');frame.setAttribute('aria-label','Génération d’image en cours');caption.append(label,size);figure.append(frame,caption);container.replaceChildren(figure);
  let disposed=false,finished=false,record,controller=new AbortController();const urls=[],seen=new Set();
  function dimensions(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0)return;frame.style.aspectRatio=`${width} / ${height}`;frame.style.maxWidth=`min(100%, ${width}px, calc(65dvh * ${width/height}))`;size.textContent=`${width} × ${height}`;onResize();}
  dimensions(request.resolution?.width,request.resolution?.height);
  function progress(value){if(disposed)return;const text=typeof value==='string'&&!value.trim().startsWith('{')?value:'Génération de l’image…';label.textContent=text;}
  function image({record:outputRecord,index,blob}){
   if(disposed||seen.has(index))return;seen.add(index);record=outputRecord;
   const button=node('button','generation-original'),img=node('img');button.type='button';button.setAttribute('aria-label','Afficher les détails de l’image originale');img.alt=record.prompt||'Image originale générée';img.decoding='async';
   const url=URL.createObjectURL(blob);urls.push(url);img.onload=()=>{if(!disposed)dimensions(img.naturalWidth,img.naturalHeight);};img.src=url;button.append(img);button.onclick=()=>openOutput(record,index,blob);
   if(seen.size===1)frame.replaceChildren(button);else frame.append(button);
   frame.classList.add('has-image');frame.setAttribute('aria-busy','false');label.textContent='Image originale · '+record.workflowName;onResize();
  }
  function fail(message){if(disposed)return;finished=true;frame.classList.add('is-finished');frame.setAttribute('aria-busy','false');label.textContent=message||'Génération interrompue.';}
  function finish(result){finished=true;frame.classList.add('is-finished');frame.setAttribute('aria-busy','false');if(result.denied)fail('Génération refusée.');else if(result.record&&!seen.size)fail('Original indisponible · consultez Output pour les détails.');else if(result.failed)progress(result.error||'Image produite · analyse indisponible.');else if(record){const count=record.parameters?.reference_count;label.textContent=`Image originale · ${record.workflowName}${Number.isInteger(count)?' · '+count+' référence(s) transmise(s)':''}`;}}
  function dispose(){disposed=true;controller.abort();for(const url of urls)URL.revokeObjectURL(url);cards.delete(card);}
  const card={progress,image,fail,finish,dispose,async load(conversationId,runId){try{const response=await(await api(`gallery/${conversationId}/${runId}`,undefined,{signal:controller.signal})).json();for(const[index,output]of response.outputs.entries()){const blob=await(await api(`gallery/${conversationId}/${runId}/${index}`,undefined,{signal:controller.signal})).blob();image({record:response,index,blob});}finish({record:response});}catch(error){if(!disposed)fail('Original indisponible : '+error.message);}},get finished(){return finished;}};
  cards.add(card);return card;
 }
 return {mount,restore(container,conversationId,runId){const card=mount(container);void card.load(conversationId,runId);return card;},clear(){for(const card of [...cards])card.dispose();}};
}
