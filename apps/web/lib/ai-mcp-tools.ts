import type { McpIdentity, McpPermission } from "@/lib/ai-mcp-auth";

type ToolDefinition={name:string;description:string;permission:McpPermission;action:string;inputSchema:{type:"object";properties:Record<string,unknown>;required:string[];additionalProperties:false}};
const brandSlug={type:"string",description:"Brand identifier"};
const assetId={type:"string",description:"UUID of the asset"};
const approval={type:"boolean",const:true,description:"Confirmation from the account owner"};
function schema(properties:Record<string,unknown>,required:string[]){
 return {type:"object" as const,properties:{brandSlug,...properties},required:["brandSlug",...required],additionalProperties:false as const};
}
export const MCP_TOOLS:ToolDefinition[]=[
 {name:"elettro_search_assets",description:"Search assets within the named brand",permission:"assets:read",action:"search_assets",
  inputSchema:schema({query:{type:"string"},limit:{type:"integer",minimum:1,maximum:50}},[])},
 {name:"elettro_get_asset",description:"Get metadata for one brand asset",permission:"assets:read",action:"get_asset",
  inputSchema:schema({assetId},["assetId"])},
 {name:"elettro_update_asset_metadata",description:"Edit a brand asset's title, tags, topic or notes with approval; does not publish",permission:"assets:write",action:"update_asset_metadata",
  inputSchema:schema({assetId,metadata:{type:"object"},confirmed:approval},["assetId","metadata","confirmed"])},
 {name:"elettro_register_brand_asset",description:"Register an existing Dropbox asset as Raw after approval",permission:"assets:register",action:"register_existing_asset",
  inputSchema:schema({path:{type:"string"},metadata:{type:"object"},confirmed:approval},["path","confirmed"])},
 {name:"elettro_list_brand_folders",description:"List Dropbox directories for the specified brand",permission:"folders:read",action:"list_folders",
  inputSchema:schema({path:{type:"string"}},[])},
 {name:"elettro_create_brand_folder",description:"Create a folder in the selected brand with approval",permission:"folders:write",action:"create_folder",
  inputSchema:schema({path:{type:"string"},name:{type:"string"},confirmed:approval},["name","confirmed"])}
];
export function toolsForClient(identity:McpIdentity){
 return MCP_TOOLS.filter(t=>identity.permissions.includes(t.permission)).map(t=>({
  name:t.name,description:t.description,
  inputSchema:{...t.inputSchema,properties:{...t.inputSchema.properties,brandSlug:{...brandSlug,enum:identity.brandSlugs}}}
 }));
}
export function findAuthorizedTool(name:string,identity:McpIdentity){
 return MCP_TOOLS.find(t=>t.name===name&&identity.permissions.includes(t.permission));
}
