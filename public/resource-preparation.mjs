import {compressImage,imageBudget} from './images.mjs';

function waitFor(video,event,signal){
 return new Promise((resolve,reject)=>{
  const finish=error=>{clearTimeout(timer);video.removeEventListener(event,success);video.removeEventListener('error',failure);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  const success=()=>finish(),failure=()=>finish(Error('Cette vidéo ne peut pas être décodée par le navigateur. Utilisez MP4 ou WebM avec un codec pris en charge.')),abort=()=>finish(signal.reason);
  const timer=setTimeout(()=>finish(Error('La préparation vidéo a dépassé le délai.')),15000);
  video.addEventListener(event,success,{once:true});video.addEventListener('error',failure,{once:true});signal?.addEventListener('abort',abort,{once:true});
 });
}
export async function prepareResource(file,{signal}={}){
 signal?.throwIfAborted();
 const mime=file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',webm:'video/webm'}[file.name.split('.').at(-1).toLowerCase()]);
 if(!['image/png','image/jpeg','image/webp','video/mp4','video/webm'].includes(mime))throw Error('Formats acceptés : PNG, JPEG, WebP, MP4 et WebM.');
 if(file.size>(mime.startsWith('video/')?512:64)*1024**2)throw Error('Limite : 64 Mo par image et 512 Mo par vidéo.');
 if(mime.startsWith('image/')){
  const source=file.type?file:new File([file],file.name,{type:mime});
  const image=await compressImage(source);signal?.throwIfAborted();
  return {mime,width:image.width,height:image.height,frames:[{url:image.url,time:null}]};
 }
 const video=document.createElement('video'),url=URL.createObjectURL(file);video.muted=true;video.playsInline=true;video.preload='auto';
 try{
  const metadata=waitFor(video,'loadedmetadata',signal);video.src=url;await metadata;
  if(!Number.isFinite(video.duration)||video.duration<=0||video.duration>86400||!video.videoWidth||video.videoWidth*video.videoHeight>64_000_000)throw Error('Durée ou résolution vidéo non prise en charge.');
  const times=video.duration<.2?[0]:[.1,.5,.9].map(fraction=>video.duration*fraction),frames=[];
  if(video.readyState<2)await waitFor(video,'loadeddata',signal);
  for(const time of times){
   signal?.throwIfAborted();
   if(Math.abs(video.currentTime-time)>.001){const seek=waitFor(video,'seeked',signal);video.currentTime=time;await seek;}
   const canvas=document.createElement('canvas'),side=imageBudget(times.length).maxSide,scale=Math.min(1,side/Math.max(video.videoWidth,video.videoHeight));
   canvas.width=Math.max(1,Math.floor(video.videoWidth*scale));canvas.height=Math.max(1,Math.floor(video.videoHeight*scale));
   try{canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.82));if(!blob)throw Error('Impossible de préparer cette image vidéo.');const prepared=await compressImage(blob,{name:file.name+' — '+time.toFixed(2)+'s',count:times.length});frames.push({time,url:prepared.url});}
   finally{canvas.width=0;canvas.height=0;}
  }
  return {mime,width:video.videoWidth,height:video.videoHeight,duration:video.duration,frames};
 }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
