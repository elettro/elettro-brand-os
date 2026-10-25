// Regression tests for the ChatGPT stabilization sprint: wrong-brand asset
// lookups and accurate ChatGPT upload results. Modules load with mocked
// imports and a scripted fetch, so no AWS, Dropbox or registry call is made.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const KEYMOCK={connectKeyHeaders:async(h={})=>({...h,'x-elettro-connect-key':'test-key'})};
function load(file,mocks={},globals={}){
 const source=fs.readFileSync(path.join(root,file),'utf8');
 const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
 assert.equal((result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,file);
 const module={exports:{}};
 vm.runInNewContext(result.outputText,{module,exports:module.exports,require:n=>n in mocks?mocks[n]:n==='@/lib/dev-api-key'?KEYMOCK:require(n),
  Buffer,URL,URLSearchParams,Date,AbortSignal,Uint8Array,console,process:{env:{}},...globals},{filename:file});
 return module.exports;
}
const brands=[{id:'stashbox',dropboxRoot:'/1---elettro-brand-os/brands/stashbox'},{id:'elettro',dropboxRoot:'/1---elettro-brand-os/brands/elettro'}];
const secretsMock={SecretsManagerClient:class{async send(){return {SecretString:JSON.stringify({refresh_token:'r',app_key:'k',app_secret:'s'})};}},GetSecretValueCommand:class{}};
const json=(value,status=200)=>({ok:status<300,status,json:async()=>value,headers:new Map()});
const {mcpErrorText}=load('apps/web/lib/ai-mcp-errors.ts');
const results=load('apps/web/lib/ai-mcp-upload-result.ts');
const identityModule=load('apps/web/lib/ai-mcp-dropbox-identity.ts');

// ---------- Wrong-brand lookups ----------
const ELETTRO_ASSET={id:'c2ec7a41-1cb6-43d4-a25b-eae925803b23',brandSlug:'elettro',filename:'epe-web-test.png',
 sourceType:'dropbox',sourcePath:'/1---elettro-brand-os/brands/elettro/test/epe-web-test.png',sourceFileId:'id:UM9GhyUcVDgAAAAAAAMEFg'};
function gateway(asset){
 return load('apps/web/lib/ai-gateway.ts',{'@aws-sdk/client-secrets-manager':secretsMock,'@/lib/brand-config':{brandConfigs:brands}},
  {fetch:async url=>url.includes('/assets?id=')?json(asset?{ok:true,asset}:{ok:true,asset:null}):json({ok:false},500)});
}
for(const action of ['get_asset','inspect_global_dropbox_id','inspect_registered_asset']){
 test(`${action}: wrong brand is a 404 that records the real brand without putting it in the message`,async()=>{
  const g=gateway(ELETTRO_ASSET);
  const error=await g.executeAiGateway({action,scope:'brand',brandSlug:'stashbox',assetId:ELETTRO_ASSET.id}).then(()=>null,e=>e);
  assert.ok(error instanceof g.GatewayError);
  assert.equal(error.status,404);
  assert.equal(error.actualBrandSlug,'elettro');
  assert.doesNotMatch(error.message,/elettro/);
 });
}
test('get_asset in the correct brand still returns the asset',async()=>{
 const result=await gateway(ELETTRO_ASSET).executeAiGateway({action:'get_asset',scope:'brand',brandSlug:'elettro',assetId:ELETTRO_ASSET.id});
 assert.equal(result.ok,true);assert.equal(result.asset.brandSlug,'elettro');
});
test('a missing asset carries no brand hint',async()=>{
 for(const asset of [null,{}]){
  const error=await gateway(asset).executeAiGateway({action:'get_asset',scope:'brand',brandSlug:'stashbox',assetId:ELETTRO_ASSET.id}).then(()=>null,e=>e);
  assert.ok(error);assert.equal(error.actualBrandSlug,undefined);
 }
});
test('MCP error text reveals the real brand only to callers authorized for it',()=>{
 const error={message:'Asset not found in selected brand',actualBrandSlug:'elettro'};
 assert.match(mcpErrorText(error,['stashbox','elettro']),/registered under brand "elettro"; retry with brandSlug "elettro"/);
 assert.equal(mcpErrorText(error,['stashbox']),'Asset not found in selected brand');
 assert.equal(mcpErrorText({message:'Asset not found in selected brand'},['stashbox','elettro']),'Asset not found in selected brand');
 assert.equal(mcpErrorText({message:'x',actualBrandSlug:42},['stashbox']),'x');
});
test('MCP route formats gateway errors with the caller\'s own brand scope',()=>{
 const route=fs.readFileSync(path.join(root,'apps/web/app/api/mcp/route.ts'),'utf8');
 assert.match(route,/mcpErrorText\(error,identity\.brandSlugs\)/);
});

// ---------- ChatGPT upload results ----------
const FOLDER='/1---elettro-brand-os/brands/stashbox/graphics';
const BYTES=Buffer.from('elettro-test-image');
const {dropboxContentHash}=load('apps/web/lib/ai-mcp-upload.ts',uploadMocks({}));
const HASH=dropboxContentHash(BYTES);
const TARGET=FOLDER+'/new.png';
const FILE_META={id:'id:AAAAAAAAAAAAAAAAAAAAAA',path_display:TARGET,size:BYTES.length,content_hash:HASH,name:'new.png'};
const ASSET_ID='00112233-4455-6677-8899-aabbccddeeff';

function uploadMocks(gatewayCalls,gatewayBehavior={}){
 return {
  '@aws-sdk/client-secrets-manager':secretsMock,
  '@/lib/brand-config':{brandConfigs:brands},
  '@/lib/asset-ai-enrichment':{enrichAfterRegistrationIfEnabled:async()=>{(gatewayCalls.enrich||=[]).push(1);return {attempted:false};}},
  '@/lib/ai-mcp-intake':{validChatFile:f=>f,mediaType:()=> 'image/png',
   verifyIntakePlan:async()=>({brandSlug:'stashbox',folder:FOLDER,filename:'new.png',mimeType:'image/png',
    metadata:{title:'New',tags:['a'],priority:'normal'}})},
  '@/lib/ai-mcp-file-hosts':{approvedChatGptFileHost:()=>true},
  '@/lib/ai-mcp-dropbox-identity':identityModule,
  '@/lib/ai-mcp-upload-result':results,
  '@/lib/ai-gateway':{GatewayError:class extends Error{constructor(s,m){super(m);this.status=s;}},
   executeAiGateway:async args=>{
    (gatewayCalls.list||=[]).push(args.action);
    const behave=gatewayBehavior[args.action];
    if(behave==='throw')throw new Error('gateway failure');
    if(args.action==='inspect_global_dropbox_id')return {ok:true,globalLookupVerified:behave!=='unverified'};
    if(args.action==='inspect_registered_asset')return {ok:true,verificationStatus:behave==='unverified'?'source_missing':'registered_in_dropbox'};
    return {ok:true};
   }}
 };
}
// Scripted Dropbox + registry. `dropbox` options choose the scenario.
function upload({duplicate=null,targetExists=null,uploadResponse=FILE_META,storedResponse=FILE_META,registry={ok:true,asset:{id:ASSET_ID}},gatewayBehavior={}}={}){
 const calls={dropboxUploads:[],registry:[]};
 const module=load('apps/web/lib/ai-mcp-upload.ts',uploadMocks(calls,gatewayBehavior),{fetch:async(url,options={})=>{
  if(url.startsWith('https://files.chatgpt.test/'))return new Response(BYTES);
  if(url.endsWith('/oauth2/token'))return json({access_token:'t'});
  if(url.includes('/files/list_folder'))return json({entries:duplicate?[{'.tag':'file',...duplicate}]:[],has_more:false,cursor:'c'});
  if(url.endsWith('/files/get_metadata')){
   const asked=JSON.parse(options.body).path;
   if(asked.startsWith('id:'))return json(storedResponse);
   return targetExists?json(targetExists):json({error:{'.tag':'path',path:{'.tag':'not_found'}}},409);
  }
  if(url.endsWith('/files/upload')){calls.dropboxUploads.push(JSON.parse(options.headers['dropbox-api-arg']));return json(uploadResponse);}
  if(url.endsWith('/assets/bulk-update')){calls.registry.push(JSON.parse(options.body));return registry?json(registry):json({ok:false},500);}
  throw new Error('unexpected fetch '+url);
 }});
 const args={confirmed:true,planToken:'plan.sig',file:{download_url:'https://files.chatgpt.test/file',file_id:'f'}};
 const identity={clientId:'chatgpt_oauth',brandSlugs:['stashbox','elettro'],permissions:['assets:upload']};
 return {calls,run:()=>module.uploadApprovedChatFile(args,identity)};
}
function assertNotSuccess(result){
 assert.equal(result.ok,false);
 assert.equal(result.transferComplete,false);
 assert.equal(result.identityVerified,false);
 assert.match(result.message,/^UPLOAD NOT (COMPLETE|VERIFIED)\./);
 assert.match(result.message,/Do not report this upload as successful/);
 assert.doesNotMatch(result.message,/registration completed/i);
}

test('successful registration is reported only after every verification passes',async()=>{
 const {calls,run}=upload();
 const result=await run();
 assert.equal(result.ok,true);assert.equal(result.status,'uploaded');assert.equal(result.transferComplete,true);
 assert.equal(result.registered,true);assert.equal(result.identityVerified,true);
 assert.equal(result.assetId,ASSET_ID);assert.equal(result.reusedExistingFile,false);assert.equal(result.alreadyRegistered,false);
 assert.deepEqual(calls.list,['list_folders','update_asset_metadata','inspect_global_dropbox_id','inspect_registered_asset']);
 const put=calls.dropboxUploads[0];
 assert.equal(put.mode,'add');assert.equal(put.autorename,false);assert.equal(put.strict_conflict,true);
 assert.equal(calls.registry[0].action,'complete-dropbox-upload');assert.equal(calls.registry[0].brandSlug,'stashbox');
});
test('Dropbox upload FileMetadata without .tag is accepted (02:27 UTC failure regression)',async()=>{
 assert.equal('.tag' in FILE_META,false);
 const result=await upload({uploadResponse:FILE_META,storedResponse:FILE_META}).run();
 assert.equal(result.ok,true);
});
test('a Dropbox response that does not match the bytes stops before any registry record',async()=>{
 const {calls,run}=upload({uploadResponse:{...FILE_META,content_hash:'b'.repeat(64)}});
 await assert.rejects(run(),/did not match the requested file/);
 assert.equal(calls.registry.length,0);
});
test('a stored-file check mismatch after upload also stops before registration',async()=>{
 const {calls,run}=upload({storedResponse:{...FILE_META,size:1}});
 await assert.rejects(run(),/stored file verification failed/);
 assert.equal(calls.registry.length,0);
});
test('duplicate bytes already in the brand are reused, never uploaded twice',async()=>{
 const existing={...FILE_META,id:'id:BBBBBBBBBBBBBBBBBBBBBB',path_display:FOLDER+'/older-copy.png'};
 const {calls,run}=upload({duplicate:existing,registry:{ok:true,alreadyRegistered:true,asset:{id:ASSET_ID}}});
 const result=await run();
 assert.equal(calls.dropboxUploads.length,0);
 assert.equal(result.ok,true);assert.equal(result.reusedExistingFile,true);assert.equal(result.alreadyRegistered,true);
 assert.equal(result.dropboxFileId,existing.id);assert.equal(calls.registry[0].path,existing.path_display);
});
test('an existing target filename with different bytes is refused without overwrite or registration',async()=>{
 const {calls,run}=upload({targetExists:{...FILE_META,content_hash:'c'.repeat(64)}});
 await assert.rejects(run(),/different bytes; no overwrite/);
 assert.equal(calls.dropboxUploads.length,0);assert.equal(calls.registry.length,0);
});
test('registry failure after Dropbox storage is reported as not registered',async()=>{
 for(const registry of [null,{ok:true,asset:{}}]){
  const result=await upload({registry}).run();
  assertNotSuccess(result);
  assert.equal(result.status,'registration_pending');assert.equal(result.registered,false);
  assert.equal(result.dropboxFileId,FILE_META.id);
 }
});
for(const [label,behavior,step] of [
 ['metadata update throws',{update_asset_metadata:'throw'},'metadata'],
 ['global Dropbox ID unverified',{inspect_global_dropbox_id:'unverified'},'global_identity'],
 ['global Dropbox ID check throws',{inspect_global_dropbox_id:'throw'},'global_identity'],
 ['Dropbox location unverified',{inspect_registered_asset:'unverified'},'dropbox_location'],
]){
 test(`verification failure (${label}) is never reported as success`,async()=>{
  const {calls,run}=upload({gatewayBehavior:behavior});
  const result=await run();
  assertNotSuccess(result);
  assert.equal(result.status,'verification_failed');assert.equal(result.failedStep,step);
  assert.equal(result.registered,true);assert.equal(result.assetId,ASSET_ID);
  assert.equal(calls.enrich,undefined,'no enrichment after a failed verification');
 });
}
test('result builders: only uploadComplete is ok, and failures carry no success wording',()=>{
 const file={brandSlug:'stashbox',dropboxFileId:'id:x',dropboxPath:'/p'};
 assert.equal(results.uploadComplete(file,ASSET_ID,false,{}).ok,true);
 assertNotSuccess(results.registrationPending(file));
 for(const step of ['metadata','global_identity','dropbox_location'])
  assertNotSuccess(results.verificationFailed(file,ASSET_ID,step));
});
