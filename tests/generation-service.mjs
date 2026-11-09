import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GenerationService} from '../lib/generation-service.mjs';

test('closing during asynchronous worker setup cannot spawn an orphan after shutdown',async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-start-close-'));t.after(()=>rm(root,{recursive:true,force:true}));let starts=0;
 const worker={status:()=>({state:'stopped',capabilities:{}}),close:async()=>{},start:async()=>{starts++;}};
 const service=new GenerationService({root,dataDir:root,workflowDir:join(root,'workflow'),outputDir:join(root,'output'),worker});
 const starting=service.start(),rejected=assert.rejects(starting,/fermé/);await service.close();await rejected;
 assert.equal(starts,0);await assert.rejects(service.start(),/fermé/);
});
