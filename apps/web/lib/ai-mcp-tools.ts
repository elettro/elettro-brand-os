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
 {name:"elettro_verify_brand_asset",description:"Check that an indexed brand asset still points to its Dropbox source file. Read-only; cannot register or alter status.",permission:"assets:read",action:"inspect_registered_asset",
  inputSchema:schema({assetId},["assetId"])},
 {name:"elettro_check_brand_file",description:"Check whether an existing Dropbox file is registered in Elettro, using Dropbox ID and path. Read-only.",permission:"assets:read",action:"inspect_brand_registration",
  inputSchema:schema({path:{type:"string",description:"Full Dropbox file path inside the selected brand"}},["path"])},
 {name:"elettro_update_asset_metadata",description:"Edit a brand asset's title, tags, topic or notes with approval; does not publish",permission:"assets:write",action:"update_asset_metadata",
  inputSchema:schema({assetId,metadata:{type:"object"},confirmed:approval},["assetId","metadata","confirmed"])},
 {name:"elettro_batch_update_metadata",description:"Update different titles, tags and creative notes for up to 25 existing brand assets after approval; reports each result separately",permission:"assets:write",action:"batch_update_asset_metadata",
  inputSchema:schema({items:{type:"array",minItems:1,maxItems:25,items:{type:"object",properties:{assetId,metadata:{type:"object"}},required:["assetId","metadata"],additionalProperties:false}},confirmed:approval},["items","confirmed"])},
 {name:"elettro_register_brand_asset",description:"Reuse a brand Dropbox file already indexed by its immutable Dropbox ID; new AI registrations are temporarily paused. Requires confirmation.",permission:"assets:register",action:"register_existing_asset",
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
