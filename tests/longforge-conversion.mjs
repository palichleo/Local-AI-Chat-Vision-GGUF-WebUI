import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectLongForge,convertLongForge} from '../lib/longforge-conversion.mjs';
import {validateNativeWorkflow} from '../lib/native-workflows.mjs';

function source(){return {nodes:[{type:'LongForgeLTXProject',widgets_values:['PRIVATE SCENE TEXT']},{type:'LongForgeLTXVideoSettings',widgets_values:[896,1600,5,'9',true]}],definitions:{subgraphs:[{nodes:[
 {type:'UNETLoader',widgets_values:['transformer.safetensors']},{type:'CLIPLoader',widgets_values:['text.safetensors']},
 {type:'VAELoader',widgets_values:['video-vae.safetensors']},{type:'VAELoader',widgets_values:['audio-vae.safetensors']},
 {type:'LongForgeLTXSampling',widgets_values:[456,true,true,false,'negative','1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0',1,1,.7,.7,18,0,1]}]}]}};}

test('LongForge conversion inspects the declared family/settings and isolates saved scene text',()=>{
 const plan=inspectLongForge(source());assert.equal(plan.parameters.seed.value,456);assert.equal(plan.parameters.frames.value,121);assert.equal(plan.parameters.width.value,896);
 assert.equal(plan.parameters.overlap_frames.value,9);assert.ok(!JSON.stringify(plan).includes('PRIVATE SCENE TEXT'));assert.match(plan.warnings.join(' '),/enhancer/i);
 const unknown=source();unknown.definitions.subgraphs[0].nodes.push({type:'UnknownSampler'});assert.throws(()=>inspectLongForge(unknown),/Unsupported/);
 const modified=source();modified.definitions.subgraphs[0].nodes.at(-1).widgets_values[6]=3;assert.throws(()=>inspectLongForge(modified),/CFG/);
});

test('explicit conversion backs up source bytes and saves a disabled editable native workflow',async t=>{
 const root=await mkdtemp(join(tmpdir(),'longforge-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const models=join(root,'models');await mkdir(models);for(const name of ['transformer','text','video-vae','audio-vae'])await writeFile(join(models,name+'.safetensors'),'local fixture');
 const path=join(root,'source.json'),bytes=JSON.stringify(source());await writeFile(path,bytes);const registered=[];
 const result=await convertLongForge(path,{modelRoot:models,backupDir:join(root,'backup'),assets:{list:async()=>[],register:async value=>{const asset={...value,id:value.kind};registered.push(asset);return asset;}},catalog:{save:async workflow=>validateNativeWorkflow(workflow)}});
 assert.equal(result.workflow.enabled,false);assert.equal(registered.length,4);assert.equal(result.workflow.pipeline,'ltx25');assert.equal(result.workflow.profiles.final.parameters.height,1600);
 assert.equal(await readFile(result.backupPath,'utf8'),bytes);assert.equal(await readFile(path,'utf8'),bytes);assert.ok(!JSON.stringify(result.workflow).includes('PRIVATE SCENE TEXT'));
});
