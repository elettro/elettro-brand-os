import type { McpIdentity, McpPermission } from "@/lib/ai-mcp-auth";

type ToolDefinition={name:string;description:string;permission:McpPermission;action:string;chatgptOnly?:boolean;claudeOnly?:boolean;_meta?:{"openai/fileParams":string[]};inputSchema:{type:"object";properties:Record<string,unknown>;required:string[];additionalProperties:false}};
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
 {name:"elettro_prepare_upload_page",description:"Prepare a private 30-minute upload page for Claude web when it cannot send attachment bytes. User selects the real image/video on that page; the approved brand folder and metadata are fixed. Up to 20 MiB. No upload occurs until the user selects and saves the file.",permission:"assets:upload",action:"prepare_claude_upload_page",claudeOnly:true,
  inputSchema:schema({filename:{type:"string"},folder:{type:"string"},metadata:{type:"object"},confirmed:approval},["filename","folder","confirmed"])},
 {name:"elettro_prepare_file_transfer",description:"Claude file transfer: after approval, check an image/video's actual Dropbox content hash and return a temporary upload URL for an existing brand folder. Requires access to actual bytes. Up to 20 MiB, no overwrite, no publishing.",permission:"assets:upload",action:"prepare_claude_transfer",claudeOnly:true,
  inputSchema:schema({filename:{type:"string"},folder:{type:"string"},size:{type:"integer",minimum:1,maximum:20971520},contentHash:{type:"string",pattern:"^[a-f0-9]{64}$"},metadata:{type:"object"},confirmed:approval},["filename","folder","size","contentHash","confirmed"])},
 {name:"elettro_complete_file_transfer",description:"Verify the signed transfer's exact file size and content hash in Dropbox, register/reuse its immutable ID and fill metadata. Retry completion after a partial failure instead of uploading again. Does not publish.",permission:"assets:upload",action:"complete_claude_transfer",claudeOnly:true,
  inputSchema:schema({transferToken:{type:"string"},confirmed:approval},["transferToken","confirmed"])},
 {name:"elettro_rename_brand_folder",description:"Rename a folder within one brand, preserving Dropbox IDs and synchronizing registered asset paths. Requires approval; brand root cannot be renamed.",permission:"folders:write",action:"rename_folder",claudeOnly:true,
  inputSchema:schema({path:{type:"string"},name:{type:"string"},confirmed:approval},["path","name","confirmed"])},
 {name:"elettro_move_brand_folder",description:"Move a folder into an existing folder within the same brand, preserving Dropbox IDs and synchronizing registered asset paths. No overwrite, brand root/cross-brand/self moves blocked. Requires approval.",permission:"folders:write",action:"move_folder",claudeOnly:true,
  inputSchema:schema({path:{type:"string"},parentPath:{type:"string"},confirmed:approval},["path","parentPath","confirmed"])},
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
 return MCP_TOOLS.filter(t=>(!t.claudeOnly||["claude_code","claude_web"].includes(identity.clientId))&&identity.permissions.includes(t.permission)&&(!t.chatgptOnly||(identity.clientId==="chatgpt_oauth"||identity.clientId==="chatgpt_private"))).map(t=>{
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
 return MCP_TOOLS.find(t=>t.name===name&&(!t.claudeOnly||["claude_code","claude_web"].includes(identity.clientId))&&identity.permissions.includes(t.permission)&&(!t.chatgptOnly||(identity.clientId==="chatgpt_oauth"||identity.clientId==="chatgpt_private")));
}

