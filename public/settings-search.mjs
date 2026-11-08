const normalized=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function setupSettingsSearch({dialog,input,empty}){
 const opened=new Map();
 function restore(){for(const[details,open]of opened)details.open=open;opened.clear();}
 function refresh(){
  restore();const terms=normalized(input.value).trim().split(/\s+/).filter(Boolean);
  const items=[...dialog.querySelectorAll('[data-settings-item]')];let count=0;
  for(const item of items){
   const section=item.closest('[data-settings-section]');const text=normalized((section?.dataset.settingsSection||'')+' '+(item.dataset.settingsKeywords||'')+' '+item.textContent);
   const matches=terms.every(term=>text.includes(term));item.hidden=!matches;if(matches)count++;
   if(terms.length&&matches)for(const details of item.querySelectorAll('details')){if(!opened.has(details)){opened.set(details,details.open);details.open=true;}}
  }
  for(const section of dialog.querySelectorAll('[data-settings-section]'))section.hidden=![...section.querySelectorAll('[data-settings-item]')].some(item=>!item.hidden);
  empty.hidden=count>0||!terms.length;dialog.scrollTop=0;
 }
 function reset(){input.value='';refresh();}
 input.addEventListener('input',refresh);input.addEventListener('keydown',event=>{if(event.key==='Escape'&&input.value){event.preventDefault();event.stopPropagation();reset();}});
 return {refresh,reset};
}
