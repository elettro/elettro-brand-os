import test from 'node:test';
import assert from 'node:assert/strict';
import {handleFolderRelay} from '../services/dropbox-sync-lambda/claude-folder-relay.mjs';
const root='/1---elettro-brand-os/elettro';
const base={action:'claude-folder-relay-v1',brandSlug:'elettro',endpoint:'move_v2',body:{from_path:'id:folder',to_path:root+'/new'}};
test('relay rejects public calls and cross-brand paths before credential access',async()=>{
 for(const event of [{...base,requestContext:{}},{...base,brandSlug:'unknown'},
  {...base,endpoint:'delete_v2'},{...base,body:{...base.body,to_path:'/1---elettro-brand-os/stashbox/new'}}]){
  const result=await handleFolderRelay(event,()=>{throw Error('Credential access should not happen');});
  assert.equal(result.ok,false);assert.equal(result.uncertainMove,false);
  assert.notEqual(result.error,'Credential access should not happen');
 }
});
test('relay verifies immutable folder identity and disables auto-renaming',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});
  return {ok:true,json:async()=>url.endsWith('get_metadata')?{'.tag':'folder',id:'id:folder',path_display:root+'/old'}:
   {metadata:{id:'id:folder',path_display:root+'/new'}}};};
 try{const result=await handleFolderRelay(base,async()=> 'private-token');
  assert.equal(result.ok,true);assert.equal(calls.length,2);
  assert.equal(calls[1].body.from_path,'id:folder');assert.equal(calls[1].body.autorename,false);
  assert.ok(!JSON.stringify(result).includes('private-token'));
 }finally{globalThis.fetch=original;}
});
test('lost Dropbox move response remains ambiguous, explicit conflict does not',async()=>{
 const original=globalThis.fetch;
 try{for(const mode of ['lost','conflict']){
  globalThis.fetch=async(url)=>{
   if(url.endsWith('get_metadata'))return {ok:true,json:async()=>({'.tag':'folder',id:'id:folder',path_display:root+'/old'})};
   if(mode==='lost')throw Error('network response lost');
   return {ok:false,status:409};
  };
  const result=await handleFolderRelay(base,async()=> 't');
  assert.equal(result.ok,false);assert.equal(result.uncertainMove,mode==='lost');
 }}finally{globalThis.fetch=original;}
});
