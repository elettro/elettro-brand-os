const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const crypto=require('node:crypto');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const brands=[{id:'elettro',dropboxRoot:'/1---elettro-brand-os/brands/elettro'}];
const identity={clientId:'claude_code',brandSlugs:['elettro'],permissions:['assets:read','assets:write','assets:upload','folders:write']};
function load(file,mocks={},globals={}){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
 assert.equal((result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,file);
 const module={exports:{}};
 vm.runInNewContext(result.outputText,{module,exports:module.exports,require:n=>n in mocks?mocks[n]:require(n),
  Buffer,URL,URLSearchParams,Date,AbortSignal,console,process:{env:{}},...globals},{filename:file});
 return module.exports;
}
class GatewayError extends Error{constructor(status,message){super(message);this.status=status;}}
const inside=(slug,p)=>p.startsWith('/1---elettro-brand-os/brands/'+slug+'/');
const mocks={
 '@/lib/asset-ai-enrichment':{enrichAfterRegistrationIfEnabled:async()=>({attempted:false})},
 '@/lib/cognito-auth':{serverSetting:async()=> 's'.repeat(64)},
 '@/lib/brand-config':{brandConfigs:brands},
 '@/lib/ai-mcp-upload-result':load('apps/web/lib/ai-mcp-upload-result.ts'),
 '@/lib/ai-mcp-intake':{safeFilename:n=>{if(/[\\/]/.test(n))throw Error('bad');return n;},mediaType:()=> 'image/png',
  normalizedMetadata:(m,n)=>({title:n,tags:[],priority:'normal',...m}),insideBrand:inside},
};
function transfer(overrides={}){
 const calls=[];let actual={'.tag':'file',id:'id:abcdefghijk',path_display:'/1---elettro-brand-os/brands/elettro/test/a.png',size:3,content_hash:'a'.repeat(64)};
 const m={...mocks,
  '@/lib/ai-gateway':{GatewayError,executeAiGateway:async args=>{calls.push(args);return args.action==='inspect_global_dropbox_id'?{globalLookupVerified:true}:args.action==='inspect_registered_asset'?{registrationVerified:true}:{ok:true};}},
  '@/lib/ai-mcp-upload':{dropboxToken:async()=> 'secret',metadata:async()=>actual,matchingBrandFile:async()=>null,...overrides},
 };
 const module=load('apps/web/lib/ai-mcp-claude-upload.ts',m,{fetch:async(url,options)=>{
  if(url.includes('upload_session/')){
   calls.push({url,arg:JSON.parse(options.headers['dropbox-api-arg']),size:options.body.byteLength});
   return {ok:true,text:async()=>url.endsWith('/start')?JSON.stringify({session_id:'session-abcdefghijk'}):'{}'};
  }
  calls.push({url,body:JSON.parse(options.body)});
  return {ok:true,json:async()=>url.includes('temporary_upload')?{link:'https://content.dropboxapi.com/upload/capability'}:{ok:true,asset:{id:'00112233-4455-6677-8899-aabbccddeeff'}}};
 }});
 return {module,calls,setActual:v=>actual=v};
}
const args={brandSlug:'elettro',filename:'a.png',folder:'/1---elettro-brand-os/brands/elettro/test',size:3,contentHash:'a'.repeat(64),confirmed:true};
test('prepare fails before upload if permission, brand, size or confirmation is invalid',async()=>{
 const {module,calls}=transfer();
 for(const [command,client] of [[{...args,confirmed:false},identity],[args,{...identity,permissions:[]}],[{...args,size:20971521},identity],[{...args,folder:'/outside'},identity]])
  await assert.rejects(module.prepareClaudeTransfer(command,client));
 assert.equal(calls.length,0);
});
test('existing exact content is reused without issuing an upload link',async()=>{
 const {module,calls}=transfer({matchingBrandFile:async()=>({id:'id:abcdefghijk',path:'/1---elettro-brand-os/brands/elettro/test/a.png'})});
 const prepared=await module.prepareClaudeTransfer(args,identity);
 assert.equal(prepared.uploadRequired,false);assert.equal(prepared.reusedExistingFile,true);
 assert.equal(calls.some(c=>c.url),false);
});
test('new transfer uses strict non-overwriting Dropbox commit',async()=>{
 const {module,calls}=transfer({metadata:async()=>null});
 const prepared=await module.prepareClaudeTransfer(args,identity);
 assert.equal(prepared.uploadRequired,true);
 const commit=calls.find(c=>c.url).body.commit_info;
 assert.equal(commit.mode,'add');assert.equal(commit.autorename,false);assert.equal(commit.strict_conflict,true);
});
test('completion checks signature, connection, brand and actual bytes before registration',async()=>{
 const {module,calls,setActual}=transfer();
 const prepared=await module.prepareClaudeTransfer(args,identity);
 const complete={brandSlug:'elettro',transferToken:prepared.transferToken,confirmed:true};
 await assert.rejects(module.completeClaudeTransfer({...complete,transferToken:prepared.transferToken+'x'},identity));
 await assert.rejects(module.completeClaudeTransfer(complete,{...identity,clientId:'claude_web'}));
 setActual({'.tag':'file',id:'id:abcdefghijk',size:4,content_hash:'a'.repeat(64)});
 await assert.rejects(module.completeClaudeTransfer(complete,identity));
 assert.equal(calls.some(c=>c.url),false);
});
test('completion registers raw Approved by default and enriches through preserving metadata path',async()=>{
 const {module,calls}=transfer();
 const prepared=await module.prepareClaudeTransfer(args,identity);
 const result=await module.completeClaudeTransfer({brandSlug:'elettro',transferToken:prepared.transferToken,confirmed:true},identity);
 assert.equal(result.ok,true);assert.equal(result.identityVerified,undefined);
 const registration=calls.find(c=>c.url).body;
 assert.equal(registration.mode,'raw');assert.equal(registration.metadata.sendToApprovalQueue,false);
 assert.equal(registration.metadata.allowedDestinations.length,0);
 assert.ok(calls.some(c=>c.action==='update_asset_metadata'));
 assert.ok(calls.some(c=>c.action==='inspect_global_dropbox_id'));
});
test('Claude transfer and folder tools remain hidden from ChatGPT and read-only clients',()=>{
 const {toolsForClient}=load('apps/web/lib/ai-mcp-tools.ts');
 const names=toolsForClient(identity).map(t=>t.name);
 for(const name of ['elettro_prepare_file_transfer','elettro_complete_file_transfer','elettro_move_brand_folder','elettro_rename_brand_folder']){
  assert.ok(names.includes(name));
  assert.ok(!toolsForClient({...identity,clientId:'chatgpt_private'}).some(t=>t.name===name));
  assert.ok(!toolsForClient({...identity,permissions:['assets:read','folders:read']}).some(t=>t.name===name));
 }
});
test('web upload page fixes approved filename/folder/metadata and rejects a modified capability',async()=>{
 const {module,calls}=transfer();
 const page=await module.prepareClaudeUploadPage({...args,metadata:{title:'Approved title'}},identity);
 const portalToken=page.uploadPage.split('#')[1];
 const preview=await module.handleClaudeUploadPage({action:'preview',portalToken});
 assert.equal(preview.filename,'a.png');assert.equal(preview.metadata.title,'Approved title');
 await assert.rejects(module.handleClaudeUploadPage({action:'preview',portalToken:portalToken+'x'}));
 const prepare=await module.handleClaudeUploadPage({action:'prepare',portalToken,size:3,contentHash:'a'.repeat(64),
  folder:'/outside',filename:'evil.png',metadata:{title:'changed'}});
 const completion=await module.handleClaudeUploadPage({action:'complete',portalToken,transferToken:prepare.transferToken});
 assert.equal(completion.ok,true);
 assert.equal(calls.find(c=>c.action==='update_asset_metadata').metadata.title,'Approved title');
});
test('web chunk handler checks bounds and signed cursor before Dropbox writes',async()=>{
 const {module,calls}=transfer();
 const page=await module.prepareClaudeUploadPage(args,identity);const portalToken=page.uploadPage.split('#')[1];
 const prepared=await module.handleClaudeUploadPage({action:'prepare',portalToken,size:3,contentHash:'a'.repeat(64)});
 const base={action:'chunk',portalToken,transferToken:prepared.transferToken};
 await assert.rejects(module.handleClaudeUploadPage({...base,chunkBase64:Buffer.from('four').toString('base64')}));
 await assert.rejects(module.handleClaudeUploadPage({...base,chunkBase64:Buffer.from('a').toString('base64'),cursorToken:'fake'}));
 assert.equal(calls.some(c=>c.url),false);
});
test('web chunks finish a single-chunk upload and bind subsequent chunks to the same signed transfer',async()=>{
 const {module,calls}=transfer();
 const page=await module.prepareClaudeUploadPage(args,identity);const portalToken=page.uploadPage.split('#')[1];
 const prepared=await module.handleClaudeUploadPage({action:'prepare',portalToken,size:3,contentHash:'a'.repeat(64)});
 const base={action:'chunk',portalToken,transferToken:prepared.transferToken};
 const single=await module.handleClaudeUploadPage({...base,chunkBase64:Buffer.from('abc').toString('base64')});
 assert.equal(single.complete,true);assert.equal(single.offset,3);
 const finish=calls.find(c=>c.url?.endsWith('/finish'));
 assert.equal(finish.arg.cursor.offset,3);assert.equal(finish.size,0);assert.equal(finish.arg.commit.strict_conflict,true);
 calls.length=0;
 const first=await module.handleClaudeUploadPage({...base,chunkBase64:Buffer.from('a').toString('base64')});
 assert.equal(first.complete,false);assert.equal(first.offset,1);
 const second=await module.handleClaudeUploadPage({...base,cursorToken:first.cursorToken,chunkBase64:Buffer.from('bc').toString('base64')});
 assert.equal(second.complete,true);
 assert.equal(calls.find(c=>c.url?.endsWith('/finish')).arg.cursor.offset,1);
});
function folderHarness({failUpdate=false,failCommit=false}={}){
 let moved=false;const queries=[];const operations=[];
 const asset={id:'asset',brandId:'brand',sourceFileId:'id:abcdefghijk',sourcePath:'/1---elettro-brand-os/brands/elettro/old/a.png',sourcePathLower:'/1---elettro-brand-os/brands/elettro/old/a.png',sourceUrl:null,sourceMetadata:{path:'/1---elettro-brand-os/brands/elettro/old/a.png'}};
 const client={query:async(sql,values)=>{queries.push({sql,values});
  if(sql.startsWith('SELECT "id" FROM "Brand"'))return {rows:[{id:'brand'}]};
  if(sql.includes('FROM "Asset" WHERE'))return {rows:[asset]};
  if(failUpdate&&sql.startsWith('UPDATE'))throw Error('database update failed');
  if(failCommit&&sql==='COMMIT')throw Error('commit response lost');
  return {rows:[]};},end:async()=>{}};
 let source=fs.readFileSync(path.join(root,'services/dev-api-lambda/claude-folder-ops.mjs'),'utf8').replace(/^import .*;\n/,'').replace(/export /g,'');
 source+='\nmodule.exports={moveBrandFolder,repairClaudeTestStatus};';
 const module={exports:{}};
 vm.runInNewContext(source,{module,SecretsManagerClient:class{send(){return {SecretString:JSON.stringify({refreshToken:'r',appKey:'k',appSecret:'s'})};}},GetSecretValueCommand:class{},
  process:{env:{}},URLSearchParams,AbortSignal,fetch:async(url,options)=>{
   if(url.endsWith('/token'))return {ok:true,json:async()=>({access_token:'t'})};
   const body=JSON.parse(options.body);operations.push({url,body});
   if(url.endsWith('list_folder'))return {ok:true,json:async()=>({entries:[{'.tag':'file',id:asset.sourceFileId,path_display:asset.sourcePath}],has_more:false})};
   if(url.endsWith('move_v2')){moved=true;return {ok:true,json:async()=>({metadata:{id:'id:folderabcdefgh',path_display:body.to_path}})};}
   return {ok:true,json:async()=>body.path==='id:abcdefghijk'?{'.tag':'file',id:body.path,path_display:asset.sourcePath}:{'.tag':'folder',id:'id:folderabcdefgh',path_display:body.path}};
  }});
 const json=(statusCode,body)=>({statusCode,body});
 return {module:module.exports,client,queries,operations,json,moved:()=>moved};
}
const rename={operation:'rename',brandSlug:'elettro',path:'/1---elettro-brand-os/brands/elettro/old',name:'new',confirmed:true};
test('rename preserves Dropbox ID and only changes source path fields',async()=>{
 const h=folderHarness();const result=await h.module.moveBrandFolder(rename,async()=>h.client,h.json);
 assert.equal(result.body.ok,true);assert.equal(result.body.dropboxFolderId,'id:folderabcdefgh');
 const update=h.queries.find(q=>q.sql.startsWith('UPDATE'));
 assert.equal(update.values[1],'/1---elettro-brand-os/brands/elettro/new/a.png');
 assert.ok(!/ingestStatus|approvalStatus|enrichmentStatus|sourceFileId.*=/.test(update.sql));
 assert.equal(h.operations.find(c=>c.url.endsWith('move_v2')).body.autorename,false);
});
test('brand roots, cross-brand destinations and descendant moves cannot mutate Dropbox',async()=>{
 for(const invalid of [{...rename,path:'/1---elettro-brand-os/brands/elettro'},
  {...rename,operation:'move',parentPath:'/1---elettro-brand-os/brands/stashbox/new'},
  {...rename,operation:'move',parentPath:rename.path+'/child'}, {...rename,confirmed:false}]){
  const h=folderHarness();const result=await h.module.moveBrandFolder(invalid,async()=>h.client,h.json);
  assert.equal(result.body.ok,false);assert.equal(h.moved(),false);
 }
});
test('database update failure compensates folder move; ambiguous commit reports reconciliation',async()=>{
 const rollback=folderHarness({failUpdate:true});const a=await rollback.module.moveBrandFolder(rename,async()=>rollback.client,rollback.json);
 assert.equal(a.body.moveRolledBack,true);assert.equal(a.body.reconciliationRequired,false);
 assert.equal(rollback.operations.filter(o=>o.url.endsWith('move_v2')).length,2);
 const ambiguous=folderHarness({failCommit:true});const b=await ambiguous.module.moveBrandFolder(rename,async()=>ambiguous.client,ambiguous.json);
 assert.equal(b.body.reconciliationRequired,true);
 assert.equal(ambiguous.operations.filter(o=>o.url.endsWith('move_v2')).length,1);
});
