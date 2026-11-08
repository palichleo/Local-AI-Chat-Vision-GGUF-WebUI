import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from '../server.mjs';

export async function runLauncher({root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),port=8787,open=false,signal=new AbortController().signal}={}){
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22 ou plus récent est requis.');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Port invalide.');
  const url=`http://127.0.0.1:${port}`;
  let child,childError,childExited=false,reader,boot,restarting=false;
  async function bootstrap(){
    let response;
    try{response=await fetch(url+'/api/bootstrap',{signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});}
    catch(error){signal.throwIfAborted();return null;}
    let value;try{value=await response.json();}catch{}
    if(!response.ok||value?.application!=='atelier-local'||typeof value.token!=='string')throw Error(`Le port ${port} est occupé par un autre service ou une ancienne instance. Aucun processus n’a été arrêté.`);
    return value;
  }
  async function ready(previousToken,timeout){
    const end=Date.now()+timeout;
    while(Date.now()<end){
      signal.throwIfAborted();const value=await bootstrap();
      if(value&&value.token!==previousToken)return value;
      if(!previousToken&&(childError||childExited))throw childError||Error('Le serveur s’est arrêté au lancement.');
      await delay(100,undefined,{signal});
    }
    throw Error('Le démarrage de l’application n’a pas pu être confirmé.');
  }
  try{
    signal.throwIfAborted();boot=await bootstrap();
    if(!boot){
      child=spawn(process.execPath,[join(root,'server.mjs'),`--port=${port}`],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,ATELIER_MANAGED_LAUNCH:'1'}});
      child.once('error',error=>{childError=error;});child.once('exit',()=>{childExited=true;});
      boot=await ready(undefined,15000);
    }
    if(boot.controlled){console.log(`Atelier local est déjà ouvert : ${url}`);if(open)openBrowser(url);return;}
    let opened=false;
    while(true){
      signal.throwIfAborted();
      const response=await fetch(url+'/api/lifecycle',{headers:{Authorization:`Bearer ${boot.token}`},signal});
      if(response.status===409){if(open&&!opened)openBrowser(url);return;}
      if(!response.ok||!response.body)throw Error('Impossible de prendre le contrôle de cette instance.');
      console.log(`\nAtelier local — ${url}\nGardez cette fenêtre ouverte. Ctrl+C arrête l’application et son modèle.\n`);
      if(open&&!opened){openBrowser(url);opened=true;}
      reader=response.body.getReader();let buffer='',lastState;
      let lost;
      try{while(true){
        const {value,done}=await reader.read();if(done)break;
        buffer+=new TextDecoder().decode(value);if(buffer.length>4096)throw Error('Réponse de contrôle invalide.');
        let newline;while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line)lastState=JSON.parse(line).state;}
      }}catch(error){lost=error;}
      if(lost)await reader.cancel().catch(()=>{});
      reader.releaseLock();reader=null;
      signal.throwIfAborted();
      if(lastState==='stopped')return;
      if(lastState!=='restarting'){
        const deadline=Date.now()+1500;let live;
        while(Date.now()<deadline){live=await bootstrap();if(live?.token===boot.token)break;await delay(100,undefined,{signal});}
        if(live?.token===boot.token){console.log('Reconnexion au serveur local…');continue;}
        throw lost||Error('La connexion de contrôle a été interrompue.');
      }
      restarting=true;console.log('Mise à jour en cours… Cette fenêtre reste active.');
      boot=await ready(boot.token,90000);restarting=false;
    }
  }catch(error){if(!signal.aborted)throw error;}
  finally{
    await reader?.cancel().catch(()=>{});
    if(child&&!boot&&!childExited)child.kill();
    // A replacement remains controlled by its stream, even though the installer started it.
    if(childExited||restarting)child?.unref();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const controller=new AbortController();
  const stop=()=>controller.abort();
  const signals=['SIGINT','SIGTERM','SIGHUP',...(process.platform==='win32'?['SIGBREAK']:[])];
  for(const signal of signals)process.on(signal,stop);
  const portArg=process.argv.find(arg=>arg.startsWith('--port='));
  try{await runLauncher({port:portArg?Number(portArg.split('=')[1]):8787,open:process.argv.includes('--open')&&!process.argv.includes('--no-open'),signal:controller.signal});}
  catch(error){console.error(error.message);process.exitCode=1;}
  finally{for(const signal of signals)process.off(signal,stop);}
}
