// Read-only Dropbox folder listing action for the existing DEV API Lambda.
// Integrate into the API Lambda dispatcher as GET /dropbox/folders or an equivalent action.
// Uses the existing DROPBOX_SECRET_NAME secret. Never expose tokens in responses or logs.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
const secrets = new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
const roots:Record<string,string>={stashbox:"/1---elettro-brand-os/stashbox",solarmeister:"/1---elettro-brand-os/solarmeister",weightlossdavie:"/1---elettro-brand-os/weightlossdavie","neckermann-strom":"/1---elettro-brand-os/neckermann-strom",therasbox:"/1---elettro-brand-os/therasbox",elettro:"/1---elettro-brand-os/elettro"};
type Entry={".tag":string;id?:string;name:string;path_display?:string;path_lower?:string};
function response(statusCode:number,body:unknown){return {statusCode,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify(body)};}
export async function listDropboxFolders(brand:string,requestedPath?:string) {
 const root=roots[brand];if(!root)return response(400,{error:"Unknown brand"});
 const path=(requestedPath||root).replace(/\\/g,"/").replace(/\/+$/,"");
 if(path.toLowerCase()!==root.toLowerCase()&&!path.toLowerCase().startsWith(root.toLowerCase()+"/"))return response(403,{error:"Outside brand root"});
 const secretName=process.env.DROPBOX_SECRET_NAME;
 if(!secretName)return response(503,{error:"Dropbox secret is not configured"});
 try {
  const secret=await secrets.send(new GetSecretValueCommand({SecretId:secretName}));
  if(!secret.SecretString)throw Error("Dropbox secret has no string value");
  const value=JSON.parse(secret.SecretString) as Record<string,string>;
  // Support the deployed sync worker's possible secret naming variants. Confirm actual schema before deploying.
  let accessToken=value.access_token||value.accessToken||value.token||value.DROPBOX_ACCESS_TOKEN;
  const refreshToken=value.refresh_token||value.refreshToken;
  const clientId=value.app_key||value.client_id||value.clientId;
  const clientSecret=value.app_secret||value.client_secret||value.clientSecret;
  if(refreshToken&&clientId&&clientSecret){
   const auth=await fetch("https://api.dropbox.com/oauth2/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken,client_id:clientId,client_secret:clientSecret})});
   if(!auth.ok)throw Error("Dropbox authorization failed");
   accessToken=(await auth.json()).access_token;
  }
  if(!accessToken)throw Error("Dropbox access token not found in secret");
  const headers={authorization:"Bearer "+accessToken,"content-type":"application/json"};
  let cursor:string|undefined;const folders:Entry[]=[];
  do{
   const isContinue=!!cursor;
   const url="https://api.dropboxapi.com/2/files/list_folder"+(isContinue?"/continue":"");
   const result=await fetch(url,{method:"POST",headers,body:JSON.stringify(isContinue?{cursor}:{path,recursive:false,include_deleted:false,limit:1000})});
   if(!result.ok)throw Error("Dropbox list_folder failed: "+result.status);
   const data=await result.json();
   folders.push(...((data.entries||[]) as Entry[]).filter(x=>x[".tag"]==="folder"));
   cursor=data.has_more?data.cursor:undefined;
  }while(cursor);
  return response(200,{brand,root,path,readOnly:true,folders:folders.map(x=>({id:x.id,name:x.name,path:x.path_display||x.path_lower})).sort((a,b)=>a.name.localeCompare(b.name))});
 }catch(e){return response(502,{error:e instanceof Error?e.message:"Dropbox folder listing failed"});}
}
// Dispatcher integration sketch:
// if (method === "GET" && path === "/dropbox/folders")
//   return listDropboxFolders(event.queryStringParameters?.brand || "", event.queryStringParameters?.path);
