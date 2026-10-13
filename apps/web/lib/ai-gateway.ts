import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { brandConfigs } from "@/lib/brand-config";

/**
 * Elettro AI Gateway V1: shared, provider-neutral actions.
 * This module owns validation and operations. Transport authentication is handled
 * by the Next.js route; a future OAuth/MCP adapter can invoke the SAME actions.
 * Nothing here makes stock source files publishable.
 */
const API_BASE = process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const STOCK_ROOT = "/1---elettro-brand-os/creative-assets";
const secrets = new SecretsManagerClient({ region: "us-east-1" });
type Dict = Record<string, unknown>;
type Scope = "brand" | "stock";

export class GatewayError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "GatewayError"; }
}
function record(value: unknown): Dict {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(400, "Expected an object");
  return value as Dict;
}
function str(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new GatewayError(400, "Invalid " + label);
  return value.trim();
}
function brandConfig(slug: unknown) {
  const name = str(slug, "brandSlug", 100);
  const config = brandConfigs.find(item => item.id === name);
  if (!config) throw new GatewayError(400, "Unknown brand");
  return config;
}
function folderPath(value: unknown, root: string, allowRoot = true): string {
  if (typeof value !== "string" || value.length > 2048) throw new GatewayError(400, "Invalid Dropbox path");
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = path.split("/");
  if (segments.some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    throw new GatewayError(400, "Unsafe Dropbox path");
  }
  const within = path.toLowerCase() === root.toLowerCase() ||
    path.toLowerCase().startsWith(root.toLowerCase() + "/");
  if (!within || (!allowRoot && path.toLowerCase() === root.toLowerCase())) {
    throw new GatewayError(403, "Path outside selected library");
  }
  return path;
}
function rootFor(scope: Scope, brandSlug: unknown): string {
  return scope === "stock" ? STOCK_ROOT : brandConfig(brandSlug).dropboxRoot;
}
function scopeFor(value: unknown): Scope {
  if (value !== "brand" && value !== "stock") throw new GatewayError(400, "scope must be brand or stock");
  return value;
}
function metadataPatch(value: unknown): Dict {
  const input = record(value);
  const permitted = new Set(["title", "topic", "contentGroup", "creativeFamily", "creativeNotes", "tags", "priority"]);
  if (!Object.keys(input).length) throw new GatewayError(400, "Metadata cannot be empty");
  for (const [key, val] of Object.entries(input)) {
    if (!permitted.has(key)) throw new GatewayError(400, "Unsupported metadata field: " + key);
    if (key === "tags") {
      if (!Array.isArray(val) || val.length > 50 ||
        val.some(t => typeof t !== "string" || !t.trim() || t.length > 100) ||
        val.join(", ").length > 500) throw new GatewayError(400, "Invalid tags");
    } else if (key === "priority") {
      if (!["low", "normal", "high"].includes(String(val))) throw new GatewayError(400, "Invalid priority");
    } else if (val !== null && (typeof val !== "string" || val.length > 2000)) {
      throw new GatewayError(400, "Invalid metadata value: " + key);
    }
  }
  return input;
}
function assetId(value: unknown): string {
  const id = str(value, "assetId", 60);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new GatewayError(400, "Invalid asset ID");
  return id;
}
async function api(path: string, body?: Dict): Promise<Dict> {
  const response = await fetch(API_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store"
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.ok === false)
    throw new GatewayError(response.ok ? 502 : 502, "Elettro registry request failed");
  return record(result);
}
type AssetSummary = {
  id: string; brandSlug: string; filename: string; sourcePath?: string;
  title?: string; topic?: string; contentGroup?: string;
  creativeFamily?: string; creativeNotes?: string; tags?: string[];
  ingestStatus?: string; approvalStatus?: string;
};
function sanitizedAsset(value: unknown): AssetSummary {
  const a = record(value);
  return {
    id: String(a.id || ""), brandSlug: String(a.brandSlug || ""), filename: String(a.filename || ""),
    ...(typeof a.sourcePath === "string" ? { sourcePath: a.sourcePath } : {}),
    ...(typeof a.title === "string" ? { title: a.title } : {}),
    ...(typeof a.topic === "string" ? { topic: a.topic } : {}),
    ...(typeof a.contentGroup === "string" ? { contentGroup: a.contentGroup } : {}),
    ...(typeof a.creativeFamily === "string" ? { creativeFamily: a.creativeFamily } : {}),
    ...(typeof a.creativeNotes === "string" ? { creativeNotes: a.creativeNotes } : {}),
    ...(Array.isArray(a.tags) ? { tags: a.tags.filter(t => typeof t === "string") as string[] } : {}),
    ...(typeof a.ingestStatus === "string" ? { ingestStatus: a.ingestStatus } : {}),
    ...(typeof a.approvalStatus === "string" ? { approvalStatus: a.approvalStatus } : {})
  };
}
async function ownedAsset(id: string, slug: string): Promise<AssetSummary> {
  const response = await api("/assets?id=" + encodeURIComponent(id));
  const asset = sanitizedAsset(response.asset);
  if (!asset.id || asset.brandSlug !== slug) throw new GatewayError(404, "Asset not found in selected brand");
  return asset;
}

async function dropboxToken(): Promise<string> {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: "elettro-brand-os-dev/dropbox" }));
  const cfg = JSON.parse(secret.SecretString || "{}") as Record<string, string>;
  const refresh = cfg.refresh_token || cfg.refreshToken;
  const key = cfg.app_key || cfg.appKey;
  const password = cfg.app_secret || cfg.appSecret;
  if (!refresh || !key || !password) throw new GatewayError(503, "Dropbox connection unavailable");
  const result = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key, client_secret: password }),
    cache: "no-store"
  });
  if (!result.ok) throw new GatewayError(503, "Dropbox authorization failed");
  const token = await result.json() as { access_token?: string };
  if (!token.access_token) throw new GatewayError(503, "Dropbox authorization unavailable");
  return token.access_token;
}
async function dropboxCall<T>(token: string, endpoint: string, body: Dict): Promise<T> {
  const result = await fetch("https://api.dropboxapi.com/2/files/" + endpoint, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  if (!result.ok) {
    if (result.status === 409) throw new GatewayError(409, "Dropbox path not found or conflicts with an existing item");
    throw new GatewayError(502, "Dropbox operation failed");
  }
  return result.json() as Promise<T>;
}


/**
 * Confirm duplicate status against the registry BEFORE calling its upload
 * completion action. Registration by an existing Dropbox ID must not reset
 * a previously Ready or Approved asset back to Raw.
 */
type RegistrationRecord = {
  id: string; brandSlug: string; filename: string;
  sourcePath?: string; sourceFileId?: string; sourceExternalId?: string;
  ingestStatus?: string; approvalStatus?: string;
};
async function registrationCandidates(
  brandSlug: string, path: string, dropboxFileId: string
): Promise<{existing?: RegistrationRecord; uncertain: RegistrationRecord[]}> {
  const response = await api("/assets");
  if (!Array.isArray(response.assets)) throw new GatewayError(502,"Unable to inspect asset registry");
  const filename=path.slice(path.lastIndexOf("/")+1).toLowerCase();
  const rows=response.assets.filter((value):value is Dict=>!!value&&typeof value==="object"&&!Array.isArray(value));
  const candidateRows=rows.filter(row=>
    row.sourceFileId===dropboxFileId||row.sourceExternalId===dropboxFileId||
    (typeof row.sourcePath==="string"&&row.sourcePath.toLowerCase()===path.toLowerCase())||
    (String(row.filename||"").toLowerCase()===filename&&row.brandSlug===brandSlug)
  );
  if(candidateRows.length>40)
    throw new GatewayError(409,"Too many potential registration matches for safe automatic deduplication");
  const shortlist=candidateRows;
  const detailed:RegistrationRecord[]=[];
  for(const entry of shortlist){
    const identifier=typeof entry.id==="string"?entry.id:"";
    if(!identifier)continue;
    // The list API may omit source identifiers. Fetch detailed candidates.
    let data:Dict=entry;
    if(!entry.sourceFileId&&!entry.sourceExternalId&&!entry.sourcePath){
      const detail=await api("/assets?id="+encodeURIComponent(identifier));
      data=record(detail.asset);
    }
    detailed.push({
      id:identifier,brandSlug:String(data.brandSlug||entry.brandSlug||""),
      filename:String(data.filename||entry.filename||""),
      ...(typeof data.sourceFileId==="string"?{sourceFileId:data.sourceFileId}:{}),
      ...(typeof data.sourceExternalId==="string"?{sourceExternalId:data.sourceExternalId}:{}),
      ...(typeof data.sourcePath==="string"?{sourcePath:data.sourcePath}:{}),
      ...(typeof data.ingestStatus==="string"?{ingestStatus:data.ingestStatus}:{}),
      ...(typeof data.approvalStatus==="string"?{approvalStatus:data.approvalStatus}:{})
    });
  }
  const exact=detailed.filter(a=>
    a.sourceFileId===dropboxFileId||a.sourceExternalId===dropboxFileId||
    a.sourcePath?.toLowerCase()===path.toLowerCase()
  );
  if(exact.some(a=>a.brandSlug!==brandSlug))
    throw new GatewayError(409,"Dropbox file is already indexed under a different brand");
  if(exact.length>1)
    throw new GatewayError(409,"Multiple asset records reference this Dropbox file; registration blocked");
  // Same-name records that cannot be conclusively matched by Dropbox ID/path
  // stay in review; never submit them to the Raw registration path blindly.
  const uncertain=detailed.filter(a=>a.brandSlug===brandSlug&&
    a.filename.toLowerCase()===filename&&!exact.some(b=>b.id===a.id));
  return {existing:exact[0],uncertain};
}

export const AI_GATEWAY_ACTIONS = [
  "capabilities", "search_assets", "get_asset", "update_asset_metadata",
  "register_existing_asset", "inspect_brand_registration", "inspect_registered_asset", "list_folders", "create_folder"
] as const;

export async function executeAiGateway(input: unknown): Promise<Dict> {
  const command = record(input);
  const action = str(command.action, "action", 60);

  if (action === "capabilities") return {
    ok: true, version: "v1",
    actions: [...AI_GATEWAY_ACTIONS],
    limitations: ["Session-authenticated only; external MCP/OAuth adapter not connected",
      "Shared stock registration and folder/file moves are not enabled",
      "Registration is raw only; cannot publish directly"]
  };

  if (action === "search_assets") {
    const slug = brandConfig(command.brandSlug).id;
    const q = typeof command.query === "string" ? command.query.trim().toLowerCase() : "";
    if (q.length > 160) throw new GatewayError(400, "Search query too long");
    const limit = command.limit === undefined ? 25 : Number(command.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new GatewayError(400, "limit must be 1–50");
    const result = await api("/assets");
    const rows = result.assets;
    if (!Array.isArray(rows)) throw new GatewayError(502, "Asset list unavailable");
    const matches = rows.map(sanitizedAsset).filter(item => item.brandSlug === slug &&
      (!q || [item.filename, item.title, item.topic, item.contentGroup, item.creativeFamily, item.creativeNotes,
        item.sourcePath, ...(item.tags || [])].some(v => (v || "").toLowerCase().includes(q))));
    return { ok: true, brandSlug: slug, total: matches.length, assets: matches.slice(0, limit) };
  }

  if (action === "get_asset") {
    const slug = brandConfig(command.brandSlug).id;
    return { ok: true, asset: await ownedAsset(assetId(command.assetId), slug) };
  }

  if (action === "update_asset_metadata") {
    const slug = brandConfig(command.brandSlug).id;
    const id = assetId(command.assetId);
    const patch = metadataPatch(command.metadata);
    if (command.confirmed !== true) throw new GatewayError(400, "Explicit confirmation required to update metadata");
    await ownedAsset(id, slug);
    const result = await api("/assets/bulk-update", { assetIds: [id], metadata: patch, markReady: false });
    if (result.updated !== 1) throw new GatewayError(502, "Metadata update was not confirmed by the registry");
    return { ok: true, updated: 1, assetId: id, brandSlug: slug, changedFields: Object.keys(patch) };
  }

  if(action==="inspect_registered_asset"){
    const config=brandConfig(command.brandSlug);
    const id=assetId(command.assetId);
    const result=await api("/assets?id="+encodeURIComponent(id));
    const asset=record(result.asset);
    if(asset.id!==id||asset.brandSlug!==config.id)
      throw new GatewayError(404,"Asset was not found in selected brand");
    const storedPath=typeof asset.sourcePath==="string"?asset.sourcePath:null;
    const storedFileId=typeof asset.sourceFileId==="string"?asset.sourceFileId:
      typeof asset.sourceExternalId==="string"&&asset.sourceExternalId.startsWith("id:")?asset.sourceExternalId:null;
    const filename=typeof asset.filename==="string"?asset.filename:"";
    const currentState={
      assetId:id,brandSlug:config.id,filename,
      ingestStatus:typeof asset.ingestStatus==="string"?asset.ingestStatus:null,
      approvalStatus:typeof asset.approvalStatus==="string"?asset.approvalStatus:null
    };
    if(!storedPath&&!storedFileId)
      return {ok:true,...currentState,registrationVerified:false,
        verificationStatus:"source_locator_unavailable",
        note:"The registry did not expose a Dropbox file ID or path for this asset. No changes were made."};
    if(storedPath)folderPath(storedPath,config.dropboxRoot,false);
    const token=await dropboxToken();
    let file:{".tag"?:string;id?:string;path_display?:string};
    try{
      file=await dropboxCall<{".tag"?:string;id?:string;path_display?:string}>(token,"get_metadata",{path:storedFileId||storedPath});
    }catch(error){
      if(error instanceof GatewayError&&error.status===409)
        return {ok:true,...currentState,registrationVerified:false,
          verificationStatus:"dropbox_file_not_found",note:"Dropbox could not locate this asset. No changes were made."};
      throw error;
    }
    const actualPath=file.path_display||"";
    const within=actualPath.toLowerCase().startsWith(config.dropboxRoot.toLowerCase()+"/");
    const idMatches=!storedFileId||storedFileId===file.id;
    const pathMatches=!storedPath||storedPath.toLowerCase()===actualPath.toLowerCase();
    const verified=file[".tag"]==="file"&&!!file.id&&within&&idMatches&&pathMatches;
    return {ok:true,...currentState,registrationVerified:verified,
      verificationStatus:verified?"registered_in_dropbox":"source_mismatch",
      dropboxFileId:file.id||null,
      dropboxPath:actualPath||null,
      note:verified?"Existing asset and Dropbox source verified, without re-registering or changing status.":"Registry/Dropbox source mismatch. Do not register again until reviewed."};
  }

  if (action === "inspect_brand_registration" || action === "register_existing_asset") {
    const config=brandConfig(command.brandSlug);
    const path=folderPath(command.path,config.dropboxRoot,false);
    if(!/\.(png|jpe?g|webp|gif|mp4|mov|m4v|webm)$/i.test(path))
      throw new GatewayError(400,"Only image or video files are supported");
    if(action==="register_existing_asset"&&command.confirmed!==true)
      throw new GatewayError(400,"Explicit confirmation required to register an asset");
    const metadata=command.metadata===undefined?{}:metadataPatch(command.metadata);
    const token=await dropboxToken();
    const file=await dropboxCall<{".tag"?:string;id?:string;path_display?:string}>(token,"get_metadata",{path});
    if(file[".tag"]!=="file"||!file.id)
      throw new GatewayError(400,"Selected Dropbox path is not a file");
    const resolved=file.path_display||path;
    const registry=await registrationCandidates(config.id,resolved,file.id);
    const existing=registry.existing;
    if(action==="inspect_brand_registration"){
      return {ok:true,brandSlug:config.id,path:resolved,dropboxFileId:file.id,
        registrationStatus:existing?"registered":registry.uncertain.length?"needs_review":"not_found",
        asset:existing?{
          id:existing.id,filename:existing.filename,
          ingestStatus:existing.ingestStatus,approvalStatus:existing.approvalStatus
        }:null,
        uncertainMatches:registry.uncertain.map(a=>({id:a.id,filename:a.filename})),
        safeToRegister:!existing&&registry.uncertain.length===0,
        note:"Read-only registry/Dropbox comparison. No files or asset records modified."};
    }
    if(registry.uncertain.length)
      throw new GatewayError(409,"Registration blocked: existing asset with this filename cannot be conclusively matched by Dropbox ID");
    if(existing){
      // Important: do NOT call complete-dropbox-upload for an already indexed file.
      // Doing so with mode raw could change eligibility of a Ready asset.
      if(Object.keys(metadata).length){
        await executeAiGateway({action:"update_asset_metadata",brandSlug:config.id,
          assetId:existing.id,metadata,confirmed:true});
      }
      return {ok:true,alreadyRegistered:true,assetId:existing.id,
        dropboxFileId:file.id,brandSlug:config.id,ingestStatus:existing.ingestStatus,
        approvalStatus:existing.approvalStatus,metadataUpdated:Object.keys(metadata).length>0,
        message:"Existing asset reused. Registration was skipped to preserve its publishing state."};
    }
    const result=await api("/assets/bulk-update",{
      action:"complete-dropbox-upload",brandSlug:config.id,path:resolved,
      mode:"raw",metadata:{...metadata,allowedDestinations:[],sendToApprovalQueue:false}
    });
    const asset=record(result.asset);
    if(typeof asset.id!=="string"||!asset.id)
      throw new GatewayError(502,"Asset registration was not confirmed");
    return {ok:true,alreadyRegistered:result.alreadyRegistered===true,
      assetId:asset.id,dropboxFileId:file.id,brandSlug:config.id,
      ingestStatus:asset.ingestStatus,approvalStatus:asset.approvalStatus,
      message:"Dropbox asset registration returned by registry. Verify publishing exclusions before rollout."};
  }

  if (action === "list_folders" || action === "create_folder") {
    const scope = scopeFor(command.scope);
    const root = rootFor(scope, command.brandSlug);
    const path = folderPath(command.path || root, root);
    const token = await dropboxToken();
    if (action === "list_folders") {
      const folders: Array<{ id: string; name: string; path: string }> = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (++pages > 50) throw new GatewayError(502, "Dropbox folder listing exceeded safety limit");
        const page = await dropboxCall<{ entries: Array<{ ".tag": string; id: string; name: string; path_display: string }>; has_more: boolean; cursor: string }>(
          token, cursor ? "list_folder/continue" : "list_folder",
          cursor ? { cursor } : { path, recursive: false, include_deleted: false, limit: 200 }
        );
        for (const item of page.entries) {
          if (item[".tag"] === "folder" && item.path_display &&
            item.path_display.toLowerCase().startsWith(root.toLowerCase() + "/"))
            folders.push({ id: item.id, name: item.name, path: item.path_display });
        }
        cursor = page.has_more ? page.cursor : undefined;
      } while (cursor);
      return { ok: true, scope, path, folders };
    }
    const name = str(command.name, "folder name", 180);
    if (/[\/\\\x00-\x1f]/.test(name) || name === "." || name === "..")
      throw new GatewayError(400, "Unsafe folder name");
    if (command.confirmed !== true) throw new GatewayError(400, "Explicit confirmation required to create folder");
    const created = await dropboxCall<{ metadata: { id: string; path_display: string } }>(
      token, "create_folder_v2", { path: path + "/" + name, autorename: false }
    );
    return { ok: true, scope, path: created.metadata.path_display, dropboxFolderId: created.metadata.id };
  }

  throw new GatewayError(400, "Unsupported AI Gateway action");
}
