import {createHash} from 'node:crypto';
import {readFile,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';

export async function appSources(root){
 const directory=await realpath(root),entries=await readdir(directory);
 const paths=['server.mjs','package.json',...['Lancer-Windows.cmd','lancer-linux.sh'].filter(name=>entries.includes(name))];
 async function collect(relative){
  for(const entry of await readdir(join(directory,relative),{withFileTypes:true})){
   if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
   const path=relative+'/'+entry.name;
   if(entry.isDirectory())await collect(path);else paths.push(path);
  }
 }
 for(const name of ['lib','public','scripts'])await collect(name);
 if(entries.includes('runner'))await collect('runner');
 const hash=createHash('sha256');
 for(const path of paths.sort()){const bytes=await readFile(join(directory,path));hash.update(path+'\0'+bytes.length+'\0').update(bytes);}
 return {installationId:createHash('sha256').update(process.platform==='win32'?directory.toLowerCase():directory).digest('hex'),sourceRevision:hash.digest('hex')};
}
