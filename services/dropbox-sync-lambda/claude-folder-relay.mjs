const BRANDS=new Set(['stashbox','elettro','solarmeister','weightlossdavie','neckermann-strom','therasbox','pianomusicsoothing']);
const ENDPOINTS=new Set(['get_metadata','list_folder','list_folder/continue','move_v2']);
export async function handleFolderRelay(event,getToken){
 let mutationSent=false;
 try{
  if(event.requestContext||event.rawPath||event.path)throw new Error('Direct IAM invocation required');
  if(!BRANDS.has(event.brandSlug)||!ENDPOINTS.has(event.endpoint))throw new Error('Invalid folder relay operation');
  const root='/1---elettro-brand-os/brands/'+event.brandSlug;
  function checkedPath(value,allowRoot=false){
   if(typeof value!=='string'||value.length>2048||/[\\\x00-\x1f]/.test(value)||
    value.split('/').some((part,i)=>i>0&&(!part||part==='.'||part==='..'))||
    !(allowRoot&&value.toLowerCase()===root||value.toLowerCase().startsWith(root+'/')))
    throw new Error('Folder relay path outside brand');
   return value;
  }
  const body=event.body||{};
  // Reject public calls and invalid input before requesting a credential.
  if(['get_metadata','list_folder'].includes(event.endpoint))checkedPath(body.path,true);
  if(event.endpoint==='list_folder/continue'&&(typeof body.cursor!=='string'||!body.cursor||body.cursor.length>20000))
   throw new Error('Invalid folder cursor');
  if(event.endpoint==='move_v2'){
   if(typeof body.from_path!=='string'||!body.from_path.startsWith('id:'))throw new Error('Folder ID required');
   checkedPath(body.to_path);
  }
  const token=await getToken();
  async function request(endpoint,payload){
   let response;
   if(endpoint==='move_v2')mutationSent=true;
   response=await fetch('https://api.dropboxapi.com/2/files/'+endpoint,{method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
   if(!response.ok){
    // A conflict response definitively rejects the move. Other failures remain ambiguous.
    if(endpoint==='move_v2'&&response.status===409)mutationSent=false;
    throw new Error('Dropbox folder request failed (HTTP '+response.status+')');
   }
   return response.json();
  }
  let result;
  if(event.endpoint==='move_v2'){
   const folder=await request('get_metadata',{path:body.from_path});
   if(folder['.tag']!=='folder'||folder.id!==body.from_path)throw new Error('Folder identity mismatch');
   const source=checkedPath(folder.path_display);
   if(body.to_path.toLowerCase()===source.toLowerCase()||body.to_path.toLowerCase().startsWith(source.toLowerCase()+'/'))
    throw new Error('Self or descendant move blocked');
   result=await request('move_v2',{from_path:folder.id,to_path:body.to_path,autorename:false,
    allow_shared_folder:false,allow_ownership_transfer:false});
  }else if(event.endpoint==='get_metadata'){
   result=await request('get_metadata',{path:body.path});
   checkedPath(result.path_display,true);
  }else{
   result=await request(event.endpoint,event.endpoint==='list_folder'?{path:body.path,recursive:true,include_deleted:false,limit:2000}:{cursor:body.cursor});
   for(const entry of result.entries||[])checkedPath(entry.path_display,true);
  }
  return {ok:true,result};
 }catch(error){
  console.error('[claude-folder-relay]',{message:error.message,uncertainMove:mutationSent});
  return {ok:false,error:error.message,uncertainMove:mutationSent};
 }
}
