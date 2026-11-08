export function setupGenerationUI({api,node,openOutput,onResize=()=>{}}){
 const cards=new Set(),watched=new Map();let downloads=Promise.resolve();
 const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)watched.get(entry.target)?.(entry.isIntersecting);},{rootMargin:'200px'}):null;
 function watch(element,change){watched.set(element,change);if(observer)observer.observe(element);else change(true);}
 function unwatch(element){observer?.unobserve(element);watched.delete(element);}
 function mount(container,request={}){
  const figure=node('figure','generation-card'),frame=node('div','generation-frame'),caption=node('figcaption','generation-caption'),label=node('span','','Préparation de la génération…'),size=node('span','generation-size');
  frame.setAttribute('aria-busy','true');frame.setAttribute('aria-label','Génération d’image en cours');caption.append(label,size);figure.append(frame,caption);container.replaceChildren(figure);
  let disposed=false,finished=false,record,controller=new AbortController();const slots=new Map();
  function dimensions(width,height){if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0)return;frame.style.aspectRatio=`${width} / ${height}`;frame.style.maxWidth=`min(100%, ${width}px, calc(65dvh * ${width/height}))`;size.textContent=`${width} × ${height}`;onResize();}
  dimensions(request.resolution?.width,request.resolution?.height);
  function progress(value){if(disposed)return;const text=typeof value==='string'&&!value.trim().startsWith('{')?value:'Génération de l’image…';label.textContent=text;}
  function release(slot){
   slot.controller?.abort();slot.img.onload=null;
   if(slot.url)URL.revokeObjectURL(slot.url);slot.url=null;slot.blob=null;
   const preview=record?.outputs?.[slot.index]?.analysisDataUrl;
   slot.img.hidden=!preview;if(preview)slot.img.src=preview;else slot.img.removeAttribute('src');
  }
  function display(slot,blob){
   if(disposed)return;slot.blob=blob;slot.url=URL.createObjectURL(blob);
   slot.img.onload=()=>{
    if(disposed)return;const width=slot.img.naturalWidth,height=slot.img.naturalHeight;
    if(width&&height){slot.button.style.aspectRatio=`${width} / ${height}`;slot.button.style.width=`min(100%, ${width}px, calc(65dvh * ${width/height}))`;dimensions(width,height);}
   };
   slot.img.hidden=false;slot.img.src=slot.url;slot.button.setAttribute('aria-busy','false');
  }
  function loadOriginal(slot){
   if(disposed||!slot.visible||slot.url||slot.pending)return;
   slot.pending=true;
   downloads=downloads.then(async()=>{
    if(disposed||!slot.visible||slot.url)return;
    slot.controller=new AbortController();slot.button.setAttribute('aria-busy','true');
    try{
     const blob=await(await api(`gallery/${record.conversationId}/${record.id}/${slot.index}`,undefined,{signal:slot.controller.signal})).blob();
     if(!disposed&&slot.visible&&!slot.controller.signal.aborted)display(slot,blob);
    }catch(error){if(!disposed&&!slot.controller.signal.aborted)label.textContent='Original indisponible : '+error.message;}
    finally{slot.button.setAttribute('aria-busy','false');}
   }).finally(()=>{slot.pending=false;if(!disposed&&slot.visible&&!slot.url&&slot.controller?.signal.aborted)loadOriginal(slot);});
  }
  function image({record:outputRecord,index,blob}){
   if(disposed||slots.has(index))return;record=outputRecord;
   const button=node('button','generation-original'),img=node('img');button.type='button';button.setAttribute('aria-label','Afficher les détails de l’image originale');img.alt=record.prompt||'Image originale générée';img.decoding='async';img.loading='lazy';
   button.style.aspectRatio='1';button.style.width='min(100%, 65dvh)';
   const output=record.outputs?.[index],slot={index,button,img,visible:true,blob:null,url:null,pending:false};slots.set(index,slot);
   if(output?.width&&output.height){button.style.aspectRatio=`${output.width} / ${output.height}`;button.style.width=`min(100%, ${output.width}px, calc(65dvh * ${output.width/output.height}))`;}
   button.append(img);button.onclick=()=>openOutput(record,index,slot.blob||undefined);
   if(slots.size===1)frame.replaceChildren(button);else frame.append(button);
   if(blob)display(slot,blob);else if(output?.analysisDataUrl)img.src=output.analysisDataUrl;else img.hidden=true;
   watch(button,visible=>{slot.visible=visible;if(visible)loadOriginal(slot);else release(slot);});
   frame.classList.add('has-image');frame.setAttribute('aria-busy','false');label.textContent='Image originale · '+record.workflowName;onResize();
  }
  function fail(message){if(disposed)return;finished=true;frame.classList.add('is-finished');frame.setAttribute('aria-busy','false');label.textContent=message||'Génération interrompue.';}
  function finish(result){
   if(disposed)return;finished=true;frame.classList.add('is-finished');frame.setAttribute('aria-busy','false');
   if(result.record)record=result.record;
   if(result.denied)fail('Génération refusée.');else if(result.record&&!slots.size)fail('Original indisponible · consultez Output pour les détails.');else if(result.failed)progress(result.error||'Image produite · analyse indisponible.');else if(record){const count=record.parameters?.reference_count;label.textContent=`Image originale · ${record.workflowName}${Number.isInteger(count)?' · '+count+' référence(s) transmise(s)':''}`;}
  }
  function dispose(){disposed=true;controller.abort();unwatch(figure);for(const slot of slots.values()){unwatch(slot.button);release(slot);slot.button.onclick=null;}slots.clear();cards.delete(card);}
  const card={progress,image,fail,finish,dispose,async load(conversationId,runId){
   try{
    const response=await(await api(`gallery/${conversationId}/${runId}`,undefined,{signal:controller.signal})).json();
    if(disposed)return;record=response;
    for(const[index]of response.outputs.entries())image({record:response,index});
    finish({record:response});
   }catch(error){if(!disposed)fail('Original indisponible : '+error.message);}
  },get finished(){return finished;}};
  cards.add(card);return {card,figure,frame,label};
 }
 return {
  mount(container,request){return mount(container,request).card;},
  restore(container,conversationId,runId){
   const {card,figure,frame,label}=mount(container);frame.classList.add('is-finished');frame.setAttribute('aria-busy','false');label.textContent='Image générée';
   watch(figure,visible=>{if(visible){unwatch(figure);void card.load(conversationId,runId);}});return card;
  },
  clear(){for(const card of [...cards])card.dispose();}
 };
}
