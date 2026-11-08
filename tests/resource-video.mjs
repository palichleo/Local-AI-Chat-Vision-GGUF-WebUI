import test from 'node:test';import assert from 'node:assert/strict';import{prepareResource}from'../public/resource-preparation.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
test('video preparation samples three timestamps, releases media and returns original dimensions',async t=>{
 const oldDocument=globalThis.document,oldBitmap=globalThis.createImageBitmap;let sampled=[],closed=0,unloaded=false;
 class Video{
  duration=10;videoWidth=1920;videoHeight=1080;readyState=3;time=0;listeners={};
  addEventListener(name,fn){(this.listeners[name]??=new Set()).add(fn);}removeEventListener(name,fn){this.listeners[name]?.delete(fn);}emit(name){for(const fn of [...this.listeners[name]||[]])fn();}
  set src(value){queueMicrotask(()=>this.emit('loadedmetadata'));}set currentTime(time){this.time=time;queueMicrotask(()=>this.emit('seeked'));}get currentTime(){return this.time;}pause(){}removeAttribute(){unloaded=true;}load(){}
 }
 globalThis.document={createElement:tag=>tag==='video'?new Video():{width:0,height:0,getContext:()=>({fillRect(){},drawImage(source){if(source instanceof Video)sampled.push(source.currentTime);}}),toBlob:callback=>callback(new Blob([Buffer.from([255,216,255])],{type:'image/jpeg'})),toDataURL:type=>type==='image/png'?png:'data:image/jpeg;base64,'+Buffer.alloc(500).toString('base64')}};
 globalThis.createImageBitmap=async()=>({width:1024,height:576,close(){closed++;}});t.after(()=>{globalThis.document=oldDocument;globalThis.createImageBitmap=oldBitmap;});
 const result=await prepareResource(new File([Buffer.from('video')],'reference.mp4',{type:'video/mp4'}));assert.deepEqual(sampled,[1,5,9]);assert.equal(result.width,1920);assert.equal(result.height,1080);assert.equal(result.duration,10);assert.equal(result.frames.length,3);assert.equal(closed,3);assert.equal(unloaded,true);
 const webm=await prepareResource(new File([Buffer.from('video')],'reference.webm'));assert.equal(webm.mime,'video/webm');
});
test('cancelled or unsupported resource files never begin video processing',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(prepareResource(new File(['data'],'clip.mp4',{type:'video/mp4'}),{signal:controller.signal}));await assert.rejects(prepareResource(new File(['data'],'script.svg',{type:'image/svg+xml'})),/Formats acceptés/);
});
