import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MCP_TOOLS,toolsForClient,findAuthorizedTool} from "../apps/web/lib/ai-mcp-tools.ts";

const all={
 clientId:"chatgpt",
 brandSlugs:["stashbox","elettro"],
 permissions:["assets:read","assets:write","assets:register","folders:read","folders:write"]
};

test("brand-only tools are exposed, without stock, deletion, moving or publishing",()=>{
 const names=MCP_TOOLS.map(t=>t.name);
 assert.equal(names.length,new Set(names).size);
 assert.equal(names.length,12);
 assert.ok(!names.some(name=>/stock|delete|move|publish/.test(name)));
});

test("two AI clients with matching scopes see equivalent operations",()=>{
 const chatgpt=toolsForClient(all);
 const claude=toolsForClient({...all,clientId:"claude"});
 assert.deepEqual(chatgpt,claude);
 assert.equal(chatgpt.length,10);
});

test("each tool exposes only the caller's allowed brand slugs",()=>{
 for(const tool of toolsForClient(all)){
  assert.deepEqual(tool.inputSchema.properties.brandSlug.enum,["stashbox","elettro"]);
  assert.ok(tool.inputSchema.required.includes("brandSlug"));
  assert.equal(tool.inputSchema.additionalProperties,false);
 }
});

test("read-only clients cannot discover mutation tools",()=>{
 const reader={...all,brandSlugs:["stashbox"],permissions:["assets:read","folders:read"]};
 const listed=toolsForClient(reader).map(item=>item.name);
 assert.deepEqual(listed,["elettro_search_assets","elettro_get_asset","elettro_verify_brand_asset","elettro_verify_global_dropbox_id","elettro_check_brand_file","elettro_list_brand_folders"]);
 assert.equal(findAuthorizedTool("elettro_update_asset_metadata",reader),undefined);
 assert.equal(findAuthorizedTool("elettro_create_brand_folder",reader),undefined);
});

test("read-only MCP credentials advertise precisely scoped, non-mutating tools",()=>{
 const reader={...all,clientId:"claude_code",brandSlugs:["stashbox","elettro"],
  permissions:["assets:read","folders:read"]};
 const tools=toolsForClient(reader);
 assert.equal(tools.length,6);
 assert.ok(tools.every(tool=>tool.annotations.readOnlyHint===true));
 assert.ok(tools.every(tool=>tool.annotations.destructiveHint===false));
 assert.ok(tools.every(tool=>tool.annotations.idempotentHint===true));
 assert.ok(tools.every(tool=>tool.inputSchema.properties.brandSlug.enum.length===2));
 for(const tool of MCP_TOOLS.filter(t=>!["assets:read","folders:read"].includes(t.permission)))
  assert.equal(findAuthorizedTool(tool.name,reader),undefined);
});

test("MCP tools declare mutating operations as not read-only",()=>{
 const writable=toolsForClient(all).filter(t=>!t.annotations.readOnlyHint);
 assert.equal(writable.length,4);
 assert.ok(writable.every(t=>t.annotations.destructiveHint));
});

test("write tools declare explicit human confirmation",()=>{
 for(const tool of MCP_TOOLS.filter(t=>t.permission.endsWith(":write")||t.permission==="assets:register")){
  assert.equal(tool.inputSchema.properties.confirmed.const,true);
  assert.ok(tool.inputSchema.required.includes("confirmed"));
 }
});

test("MCP route forces brand scope independent of agent-supplied fields",()=>{
 const source=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 assert.match(source,/scope:"brand"/);
 assert.match(source,/requireMcpScope\(identity,tool.permission,args.brandSlug\)/);
});

test("remote MCP origin allowlist never bypasses the mandatory bearer credential",()=>{
 const route=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 assert.match(route,/allowedMcpOrigins=new Set\(\[DEV_ORIGIN,"https:\/\/claude\.ai","https:\/\/chatgpt\.com"\]\)/);
 assert.match(route,/if\(origin&&!allowedMcpOrigins\.has\(origin\)\)/);
 assert.match(route,/await authorizeMcp\(bearer\)/);
 assert.match(route,/await authorizeChatGptOauth\(bearer\)/);
});

test("ChatGPT OAuth integration is fail-closed and preserves Claude bearer authentication",()=>{
 const auth=readFileSync(new URL("../apps/web/lib/ai-mcp-auth.ts",import.meta.url),"utf8");
 const oauth=readFileSync(new URL("../apps/web/lib/ai-mcp-oauth.ts",import.meta.url),"utf8");
 const route=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 const meta=readFileSync(new URL("../apps/web/app/.well-known/oauth-protected-resource/route.ts",import.meta.url),"utf8");
 assert.match(auth,/loadMcpAuthSettings/);
 assert.match(auth,/chatgptOauth/);
 assert.match(auth,/timingSafeEqual/);
 assert.match(route,/authorizeChatGptOauth\(bearer\)/);
 assert.match(route,/authorizeMcp\(bearer\)/);
 assert.match(route,/www-authenticate/);
 assert.match(route,/oauthChallenge\(\)/);
 assert.match(oauth,/cfg\.enabled!==true/);
 assert.match(oauth,/claims\.iss!==cfg\.issuer/);
 assert.match(oauth,/claims\.token_use!=="access"/);
 assert.match(oauth,/claims\.client_id!==cfg\.clientId/);
 assert.match(oauth,/claims\.aud!==MCP_OAUTH_RESOURCE/);
 assert.match(oauth,/scope\.split\(" "\)\.includes\(MCP_OAUTH_SCOPE\)/);
 assert.match(oauth,/verify\("RSA-SHA256"/);
 assert.match(oauth,/\.well-known\/jwks\.json/);
 assert.match(oauth,/user\.sub!==claims\.sub/);
 assert.match(oauth,/user\.email_verified!==true/);
 assert.match(oauth,/permissions:claims\.scope\.split/);
 assert.match(oauth,/MCP_OAUTH_WRITE_SCOPE/);
 assert.match(oauth,/"assets:upload"/);
 assert.match(oauth,/brandSlugs:brandConfigs\.map/);
 assert.match(meta,/chatGptOauthConfiguration\(\)/);
 assert.match(meta,/authorization_servers:\[cfg\.issuer\]/);
 assert.match(meta,/scopes_supported:\[MCP_OAUTH_SCOPE\]/);
 assert.match(meta,/ChatGPT OAuth not configured/);
 assert.ok(!route.includes("return toolsForClient({clientId:\"chatgpt_oauth\""));
});

test("ChatGPT discovery supports GET challenge and both RFC 9728 metadata paths",()=>{
 const route=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 const variant=readFileSync(new URL("../apps/web/app/.well-known/oauth-protected-resource/api/mcp/route.ts",import.meta.url),"utf8");
 const metadata=readFileSync(new URL("../apps/web/app/.well-known/oauth-protected-resource/route.ts",import.meta.url),"utf8");
 const body=route.split("export async function GET(request:NextRequest)")[1]?.split("export async function DELETE")[0]||"";
 assert.match(body,/if\(!auth\)/);
 assert.match(body,/status:401,headers:\{\.\.\.headers,"www-authenticate":oauthChallenge\(\)\}/);
 assert.match(body,/await authorizeMcp\(auth\)/);
 assert.match(body,/await authorizeChatGptOauth\(auth\)/);
 assert.match(body,/status:405/);
 assert.match(variant,/export \{GET, runtime, dynamic\} from/);
 assert.match(metadata,/chatGptOauthConfiguration\(\)/);
});

test("ChatGPT file-parameter schemas and read/write scope separation",()=>{
 const reader={clientId:"chatgpt_oauth",brandSlugs:["stashbox","elettro"],permissions:["assets:read","folders:read"]};
 const writer={...reader,permissions:["assets:read","folders:read","assets:write","folders:write","assets:upload"]};
 const readTools=toolsForClient(reader);
 const writeTools=toolsForClient(writer);
 assert.equal(readTools.length,7);
 assert.equal(writeTools.length,11); // arbitrary registration intentionally excluded
 const preview=readTools.find(t=>t.name==="elettro_prepare_file_intake");
 const upload=writeTools.find(t=>t.name==="elettro_save_chat_file_to_dropbox");
 assert.ok(preview);
 assert.ok(upload);
 assert.equal(preview.annotations.readOnlyHint,true);
 assert.equal(upload.annotations.readOnlyHint,false);
 assert.deepEqual(preview._meta["openai/fileParams"],["file"]);
 assert.deepEqual(upload._meta["openai/fileParams"],["file"]);
 for(const tool of [preview,upload]){
   const item=tool.inputSchema.properties.file;
   assert.deepEqual(item.required,["download_url","file_id"]);
   assert.ok(["download_url","file_id","mime_type","file_name"].every(field=>field in item.properties));
   assert.equal(item.additionalProperties,false);
   assert.ok(tool.inputSchema.required.includes("brandSlug"));
 }
 assert.equal(findAuthorizedTool("elettro_save_chat_file_to_dropbox",reader),undefined);
 assert.ok(findAuthorizedTool("elettro_save_chat_file_to_dropbox",writer));
 assert.equal(findAuthorizedTool("elettro_register_brand_asset",writer),undefined);
 const claude={...writer,clientId:"claude_code",permissions:["assets:read","folders:read"]};
 assert.equal(toolsForClient(claude).length,6);
 assert.equal(findAuthorizedTool("elettro_prepare_file_intake",claude),undefined);
});
test("ChatGPT intake guards block unapproved uploads and unsafe destinations",()=>{
 const preview=readFileSync(new URL("../apps/web/lib/ai-mcp-intake.ts",import.meta.url),"utf8");
 const upload=readFileSync(new URL("../apps/web/lib/ai-mcp-upload.ts",import.meta.url),"utf8");
 const route=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 assert.match(preview,/insideBrand/);
 assert.match(preview,/randomBytes\(12\)/);
 assert.match(preview,/timingSafeEqual/);
 assert.match(preview,/verifyExistingFolder/);
 assert.match(preview,/needsConfirmation:true/);
 assert.match(preview,/15\*60\*1000/);
 assert.match(upload,/command\.confirmed!==true/);
 assert.match(upload,/identity\.permissions\.includes\("assets:upload"\)/);
 assert.match(upload,/verifyIntakePlan\(command\.planToken,identity,file\)/);
 assert.match(upload,/strict_conflict:true/);
 assert.match(upload,/matchingBrandFile/);
 assert.match(upload,/dropboxContentHash/);
 assert.match(upload,/redirect:"error"/);
 assert.match(upload,/MAX_BYTES=20\*1024\*1024/);
 assert.match(upload,/action:"complete-dropbox-upload"/);
 assert.match(upload,/action:"inspect_global_dropbox_id"/);
 assert.match(upload,/action:"update_asset_metadata"/);
 assert.ok(!upload.includes("s3.amazonaws.com"));
 assert.match(route,/await prepareChatFileIntake\(args,identity\)/);
 assert.match(route,/await uploadApprovedChatFile\(args,identity\)/);
});

test("Step 9 Windows credential bootstrap protects raw tokens and grants read-only scope",()=>{
 const script=readFileSync(new URL("../scripts/step9-readonly-clients.ps1",import.meta.url),"utf8");
 const auth=readFileSync(new URL("../apps/web/lib/ai-mcp-auth.ts",import.meta.url),"utf8");
 assert.match(script,/RandomNumberGenerator/);
 assert.match(script,/ConvertFrom-SecureString/);
 assert.match(script,/ConvertTo-SecureString/);
 assert.match(script,/tokenSha256=/);
 assert.match(script,/permissions=\$Permissions/);
 assert.match(script,/\$Permissions = @\("assets:read","folders:read"\)/);
 assert.match(script,/\$Brands = @\("stashbox","elettro","solarmeister","weightlossdavie","neckermann-strom","therasbox"\)/);
 assert.match(script,/ExpandBrands/);
 assert.match(script,/aws-readonly-clients\.pre-allbrands\.json/);
 assert.match(script,/Neither bearer token nor either token hash was changed/);
 assert.match(script,/Compare-Object -ReferenceObject \$expectedBrands -DifferenceObject \$grantedBrands/);
 assert.match(script,/brandSlug="outside-elettro"/);
 assert.match(script,/TestClaudeCode/);
 assert.match(script,/TestClaudeWeb/);
 assert.match(script,/headersHelper/);
 assert.match(script,/EmitCodeHeaders/);
 assert.match(script,/add-json elettro-dev/);
 assert.match(script,/Copy-Item -LiteralPath \$PSCommandPath/);
 assert.ok(!script.includes('claude mcp add --transport http'));

 assert.match(auth,/timingSafeEqual/);
 assert.match(auth,/WithDecryption:true/);
 assert.match(auth,/MCP credentials not provisioned/);
});

test("gateway metadata cannot mark Ready; new AI registration remains paused until atomic uniqueness",()=>{
 const source=readFileSync(new URL("../apps/web/lib/ai-gateway.ts",import.meta.url),"utf8");
 assert.match(source,/markReady:\s*false/);
 assert.match(source,/New AI registration is paused until atomic Dropbox-ID uniqueness enforcement/);
 assert.match(source,/safeToRegister:false/);
 assert.match(source,/registrationStatus:existing\?"registered":"not_found"/);
 assert.match(source,/lookup\.lookupComplete !== true/);
 assert.match(source,/lookup\.lookupVersion !== 2/);
 assert.match(source,/count>1/);
 const dedup=source.split("async function registrationCandidates(")[1]?.split("export const AI_GATEWAY_ACTIONS")[0]||"";
 assert.ok(!dedup.includes('await api("/assets")'));
});

test("metadata batch tool uses the same brand grant and confirmation policy",()=>{
 const tool=MCP_TOOLS.find(t=>t.name==="elettro_batch_update_metadata");
 assert.ok(tool);
 assert.equal(tool.permission,"assets:write");
 assert.equal(tool.action,"batch_update_asset_metadata");
 assert.equal(tool.inputSchema.properties.items.maxItems,25);
 assert.ok(tool.inputSchema.required.includes("confirmed"));
});

test("diagnostic metadata write is owner-only, reversible and does not publish",()=>{
 const helper=readFileSync(new URL("../apps/web/lib/ai-gateway-write-test.ts",import.meta.url),"utf8");
 const owner=readFileSync(new URL("../apps/web/app/api/ai-gateway/route.ts",import.meta.url),"utf8");
 const mcp=readFileSync(new URL("../apps/web/app/api/mcp/route.ts",import.meta.url),"utf8");
 assert.match(owner,/runMetadataWriteSmokeTest/);
 assert.match(owner,/authenticated\(\)/);
 assert.match(helper,/brandSlug:"stashbox"/);
 assert.match(helper,/originalTags/);
 assert.match(helper,/cleanupVerified/);
 assert.match(helper,/writeTags\(id,latestTags\.filter\(tag=>tag!==probe\)\)/);
 assert.ok(!MCP_TOOLS.some(tool=>tool.action==="test_metadata_round_trip"));
 assert.ok(!mcp.includes("test_metadata_round_trip"));
});

test("Step 5 identity inspection is read-only, and registration avoids Raw reset of existing files",()=>{
 const src=readFileSync(new URL("../apps/web/lib/ai-gateway.ts",import.meta.url),"utf8");
 assert.match(src,/action==="inspect_registered_asset"/);
 assert.match(src,/action === "inspect_brand_registration"/);
 assert.match(src,/if\(existing\)\{/);
 assert.match(src,/Existing asset reused\. Registration was skipped/);
 assert.match(src,/Conflicting registrations for this Dropbox file ID/);
 const verifyTool=MCP_TOOLS.find(t=>t.name==="elettro_verify_brand_asset");
 assert.equal(verifyTool?.permission,"assets:read");
});

test("Dropbox registration preflight remains read-only",()=>{
 const tool=MCP_TOOLS.find(t=>t.name==="elettro_check_brand_file");
 assert.equal(tool?.permission,"assets:read");
 assert.equal(tool?.action,"inspect_brand_registration");
 assert.ok(tool?.inputSchema.required.includes("path"));
});

test("DEV asset detail query returns Dropbox identity needed for Step 5",()=>{
 const src=readFileSync(new URL("../services/dev-api-lambda/db-main.mjs",import.meta.url),"utf8");
 const detail=src.split('if (assetId) {')[1]?.split('if (!result.rows[0])')[0]||"";
 assert.match(detail,/a\."sourceFileId"/);
 assert.match(detail,/a\."sourceExternalId"/);
 assert.match(detail,/a\."sourcePath"/);
 assert.match(detail,/a\."sourceUrl"/);
 assert.match(detail,/b\."slug" AS "brandSlug"/);
});

test("direct Dropbox uploads resolve via sourceExternalId/sourceUrl while sync uses sourceFileId/sourcePath",()=>{
 const source=readFileSync(new URL("../apps/web/lib/ai-gateway.ts",import.meta.url),"utf8");
 assert.match(source,/asset\.sourceExternalId/);
 assert.match(source,/asset\.sourceUrl/);
 assert.match(source,/recordData\.sourceExternalId/);
 assert.match(source,/recordData\.sourceFileId/);
 assert.match(source,/lookupVersion !== 2/);
 assert.match(source,/enforces global uniqueness across BOTH Dropbox source columns/);
 assert.match(source,/sourceType!=="dropbox"/);
});

test("Step 6 UI verifies the same immutable Dropbox ID without calling registration",()=>{
 const ui=readFileSync(new URL("../apps/web/app/ai-gateway/client.tsx",import.meta.url),"utf8");
 assert.match(ui,/Step 6 · Duplicate registration preflight/);
 assert.match(ui,/action:"inspect_brand_registration"/);
 assert.match(ui,/preflightMatchVerified:matches/);
 assert.match(ui,/result\.safeToRegister===false/);
 assert.ok(!ui.includes('action:"register_existing_asset"'));
});

test("global lookup and read-only duplicate audit are available in DEV Lambda without relying on limit-500 list",()=>{
 const backend=readFileSync(new URL("../services/dev-api-lambda/db-main.mjs",import.meta.url),"utf8");
 const gateway=readFileSync(new URL("../apps/web/lib/ai-gateway.ts",import.meta.url),"utf8");
 assert.match(backend,/requestAction === "audit-dropbox-ids"/);
 assert.match(backend,/WHERE a\."sourceType" = 'dropbox'/);
 assert.match(backend,/a\."sourceFileId" = \$1 OR a\."sourceExternalId" = \$1/);
 assert.match(backend,/COUNT\(\*\) OVER\(\)::int AS "matchCount"/);
 assert.match(backend,/lookupComplete: true, lookupVersion: 2/);
 assert.match(backend,/HAVING COUNT\(DISTINCT "id"\) > 1/);
 assert.match(gateway,/queryBrandSlug !== brandSlug/);
 assert.match(gateway,/action==="inspect_global_dropbox_id"/);
 assert.match(gateway,/globalLookupVerified:verified/);
 assert.match(gateway,/recordData\.retiredAt!==null/);
 assert.match(gateway,/already indexed under another brand/);
});

test("supporting legacy Dropbox file ID index is documented without applying a database migration",()=>{
 const schema=readFileSync(new URL("../packages/database/prisma/schema.prisma",import.meta.url),"utf8");
 const sql=readFileSync(new URL("../services/dev-api-lambda/init.sql",import.meta.url),"utf8");
 assert.match(schema,/@@index\(\[sourceType, sourceFileId\]\)/);
 assert.match(sql,/CREATE INDEX IF NOT EXISTS "Asset_sourceType_sourceFileId_idx"/);
});

test("Step 7 exposes one scoped read-only global ID check in Lab and both assistants",()=>{
 const ui=readFileSync(new URL("../apps/web/app/ai-gateway/client.tsx",import.meta.url),"utf8");
 assert.match(ui,/Step 7 · Database-wide Dropbox ID lookup/);
 assert.match(ui,/action:"inspect_global_dropbox_id"/);
 assert.match(ui,/globalLookupVerified===true/);
 const tool=MCP_TOOLS.find(t=>t.name==="elettro_verify_global_dropbox_id");
 assert.equal(tool?.permission,"assets:read");
 assert.equal(tool?.action,"inspect_global_dropbox_id");
 assert.ok(tool?.inputSchema.required.includes("assetId"));
});
