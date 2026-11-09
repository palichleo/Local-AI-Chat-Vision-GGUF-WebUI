import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generatedMedia} from '../lib/generated-media.mjs';
test('original local output can be read while traversal and unsupported files are rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-output-'));
 try{await mkdir(join(root,'run'));await writeFile(join(root,'run','test.png'),'image');
  const media=await generatedMedia(root,{type:'output',subfolder:'run',filename:'test.png'});
  assert.equal(media.mime,'image/png');assert.equal((await media.handle.readFile()).toString(),'image');await media.handle.close();
  for(const d of [{subfolder:'../',filename:'test.png'},{subfolder:'run',filename:'../secret.png'},{subfolder:'run',filename:'config.json'}])
   await assert.rejects(generatedMedia(root,{type:'output',...d}));
 }finally{await rm(root,{recursive:true,force:true});}
});
