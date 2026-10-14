import type { McpIdentity, McpPermission } from "@/lib/ai-mcp-auth";

type ToolDefinition={name:string;description:string;permission:McpPermission;action:string;chatgptOnly?:boolean;_meta?:{"openai/fileParams":string[]};inputSchema:{type:"object";properties:Record<string,unknown>;required:string[];additionalProperties:false}};
const brandSlug={type:"string",description:"Brand identifier"};
const assetId={type:"string",description:"UUID of the asset"};
const approval={type:"boolean",const:true,description:"Confirmation from the account owner"};
const chatFile={type:"object",properties:{
 download_url:{type:"string",description:"Host-supplied temporary authorized file URL"},
 file_id:{type:"string",description:"ChatGPT file identifier"},
 mime_type:{type:"string"},
 file_name:{type:"string"}
},required:["download_url","file_id"],additionalProperties:false};
function schema(properties:Record<string,unknown>,required:string[]){
 return {type:"object" as const,properties:{brandSlug,...properties},required:["brandSlug",...required],additionalProperties:false as const};
}
export const MCP_TOOLS:ToolDefinition[]=[
 {name:"elettro_search_assets",description:"Search the recent Elettro asset catalog in the named brand (currently limited to latest 500 records)",permission:"assets:read",action:"search_assets",
  inputSchema:schema({query:{type:"string"},limit:{type:"integer",minimum:1,maximum:50}},[])},
 {name:"elettro_get_asset",description:"Get metadata for one brand asset",permission:"assets:read",action:"get_asset",
  inputSchema:schema({assetId},["assetId"])},
 {name:"elettro_verify_brand_asset",description:"Check that an indexed brand asset still points to its Dropbox source file. Read-only; cannot register or alter status.",permission:"assets:read",action:"inspect_registered_asset",
  inputSchema:schema({assetId},["assetId"])},
 {name:"elettro_verify_global_dropbox_id",description:"Verify a brand asset's Dropbox ID against every registered asset, including both legacy and direct-upload IDs. Read-only.",permission:"assets:read",action:"inspect_global_dropbox_id",
  inputSchema:schema({assetId},["assetId"])},
 {name:"elettro_check_brand_file",description:"Check whether an existing Dropbox file is registered in Elettro, using Dropbox ID and path. Read-only.",permission:"assets:read",action:"inspect_brand_registration",
  inputSchema:schema({path:{type:"string",description:"Full Dropbox file path inside the selected brand"}},["path"])},
 {name:"elettro_prepare_file_intake",description:"Read-only preview: recommend an existing brand Dropbox folder and draft metadata for a file the user attached. Never uploads or edits.",permission:"assets:read",action:"prepare_chat_file_intake",chatgptOnly:true,
  _meta:{"openai/fileParams":["file"]},
  inputSchema:schema({file:chatFile,filename:{type:"string"},folder:{type:"string",description:"Exact existing Dropbox destination folder, optional when recommending"},metadata:{type:"object",description:"Proposed title, topic, content group, creative family, creative notes, tags and priority; the model may enrich after inspecting the user-supplied file"}},["file"])},
 {name:"elettro_save_chat_file_to_dropbox",description:"With explicit human approval, upload the file from a signed preview to the selected Dropbox folder, prevent exact duplicates, register in Elettro and fill metadata. Pilot images/video under 20 MB; never publish.",permission:"assets:upload",action:"upload_chat_file",chatgptOnly:true,
  _meta:{"openai/fileParams":["file"]},
  inputSchema:schema({file:chatFile,planToken:{type:"string",description:"Unmodified signed planToken returned by elettro_prepare_file_intake"},confirmed:approval},["file","planToken","confirmed"])},
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
 return MCP_TOOLS.filter(t=>identity.permissions.includes(t.permission)&&(!t.chatgptOnly||identity.clientId==="chatgpt_oauth")).map(t=>{
  const readOnly=t.permission==="assets:read"||t.permission==="folders:read";
  return {
   name:t.name,description:t.description,
   ...(t._meta?{_meta:t._meta}:{}),
   // These MCP annotations accurately identify tools that cannot mutate the
   // registry or Dropbox, making read-only client review more predictable.
   annotations:readOnly
    ? {readOnlyHint:true,destructiveHint:false,idempotentHint:true}
    : {readOnlyHint:false,destructiveHint:true,idempotentHint:false},
   inputSchema:{...t.inputSchema,properties:{...t.inputSchema.properties,brandSlug:{...brandSlug,enum:identity.brandSlugs}}}
  };
 });
}
export function findAuthorizedTool(name:string,identity:McpIdentity){
 return MCP_TOOLS.find(t=>t.name===name&&identity.permissions.includes(t.permission)&&(!t.chatgptOnly||identity.clientId==="chatgpt_oauth"));
}
