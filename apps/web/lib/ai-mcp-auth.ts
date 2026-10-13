import {createHash,timingSafeEqual} from "node:crypto";
import {SSMClient,GetParameterCommand} from "@aws-sdk/client-ssm";
import {brandConfigs} from "@/lib/brand-config";

const KEY="/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON";
const ssm=new SSMClient({region:"us-east-1"});
const permissions=["assets:read","assets:write","assets:register","folders:read","folders:write"] as const;
export type McpPermission=typeof permissions[number];
export type McpIdentity={clientId:string;brandSlugs:string[];permissions:McpPermission[]};
type Client={id:string;tokenSha256:string;brandSlugs:string[];permissions:McpPermission[];enabled?:boolean};
export class McpAuthorizationError extends Error {
 constructor(public status:number,message:string){super(message);this.name="McpAuthorizationError";}
}
async function clientConfig():Promise<Client[]>{
 if(process.env.AWS_BRANCH&&process.env.AWS_BRANCH!=="develop")
  throw new McpAuthorizationError(404,"DEV only");
 let raw=process.env.ELETTRO_AI_MCP_CLIENTS_JSON;
 if(!raw){
  try{raw=(await ssm.send(new GetParameterCommand({Name:KEY,WithDecryption:true}))).Parameter?.Value;}
  catch{throw new McpAuthorizationError(503,"MCP credentials not provisioned");}
 }
 if(!raw)throw new McpAuthorizationError(503,"MCP credentials not provisioned");
 try{
  const data=JSON.parse(raw) as {clients?:unknown};
  if(!Array.isArray(data.clients))throw Error("Invalid");
  return data.clients as Client[];
 }catch{throw new McpAuthorizationError(503,"Invalid MCP credential configuration");}
}
export async function authorizeMcp(header:string|null):Promise<McpIdentity>{
 if(!header||!/^Bearer [A-Za-z0-9_-]{43,256}$/.test(header))
  throw new McpAuthorizationError(401,"Bearer token required");
 const hashed=createHash("sha256").update(header.slice(7)).digest();
 const clients=await clientConfig();
 const brands=new Set(brandConfigs.map(x=>x.id));
 let chosen:Client|undefined;
 for(const client of clients){
  if(!client||typeof client.tokenSha256!=="string"||!/^[a-f0-9]{64}$/i.test(client.tokenSha256))continue;
  if(timingSafeEqual(hashed,Buffer.from(client.tokenSha256,"hex"))&&client.enabled!==false)chosen=client;
 }
 if(!chosen)throw new McpAuthorizationError(401,"Invalid MCP credentials");
 if(!/^[a-z0-9_-]{2,64}$/i.test(chosen.id||"")||!Array.isArray(chosen.brandSlugs)||
    !Array.isArray(chosen.permissions)||!chosen.brandSlugs.length||!chosen.permissions.length||
    chosen.brandSlugs.some(x=>!brands.has(x))||chosen.permissions.some(x=>!permissions.includes(x)))
  throw new McpAuthorizationError(503,"Invalid MCP client scope");
 return {clientId:chosen.id,brandSlugs:[...new Set(chosen.brandSlugs)],permissions:[...new Set(chosen.permissions)]};
}
export function requireMcpScope(identity:McpIdentity,permission:McpPermission,brand:unknown){
 if(!identity.permissions.includes(permission))throw new McpAuthorizationError(403,"MCP operation denied");
 if(typeof brand!=="string"||!identity.brandSlugs.includes(brand))
  throw new McpAuthorizationError(403,"MCP brand denied");
}
