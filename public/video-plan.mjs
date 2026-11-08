export function renderVideoPlan(container,request,node){
 container.replaceChildren();const plan=request.plan||{},parameters=plan.parameters||{};
 container.append(node('p','video-intention',plan.intention||'Proposition vidéo'));
 const details=node('dl','video-plan-fields');
 function row(label,value){if(value===undefined||value===null)return;details.append(node('dt','',label),node('dd','',String(value)));}
 row('Workflow',request.workflowName);if(parameters.width&&parameters.height)row('Résolution',parameters.width+' × '+parameters.height);row('Images',parameters.frames);row('Cadence',parameters.fps===undefined?undefined:parameters.fps+' i/s');if(parameters.frames&&parameters.fps)row('Durée estimée',(parameters.frames/parameters.fps).toFixed(2)+' s');row('Seed',parameters.seed);
 container.append(details);
 if(plan.references?.length){const refs=node('ul','video-plan-references');for(const ref of plan.references)refs.append(node('li','',(ref.label||ref.resource_id||'Image '+(ref.image+1))+' → '+(ref.role||ref.input)+(Number.isFinite(ref.time)?' · '+ref.time.toFixed(2)+' s':'')));container.append(refs);}else container.append(node('p','comfy-help','Aucune référence image transmise au workflow.'));
 const prompt=node('details','video-plan-prompt');prompt.open=true;prompt.append(node('summary','','Prompt'),node('p','',plan.prompt||request.args?.prompt||''));container.append(prompt);
 const other=node('details','video-plan-extra');other.append(node('summary','','Paramètres effectifs'),node('pre','',JSON.stringify(parameters,null,2)));container.append(other);
}
