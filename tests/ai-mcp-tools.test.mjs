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
 assert.equal(names.length,9);
 assert.ok(!names.some(name=>/stock|delete|move|publish/.test(name)));
});

test("two AI clients with matching scopes see equivalent operations",()=>{
 const chatgpt=toolsForClient(all);
 const claude=toolsForClient({...all,clientId:"claude"});
 assert.deepEqual(chatgpt,claude);
 assert.equal(chatgpt.length,9);
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
 assert.deepEqual(listed,["elettro_search_assets","elettro_get_asset","elettro_verify_brand_asset","elettro_check_brand_file","elettro_list_brand_folders"]);
 assert.equal(findAuthorizedTool("elettro_update_asset_metadata",reader),undefined);
 assert.equal(findAuthorizedTool("elettro_create_brand_folder",reader),undefined);
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

test("gateway registration uses Raw and metadata edits cannot mark Ready",()=>{
 const source=readFileSync(new URL("../apps/web/lib/ai-gateway.ts",import.meta.url),"utf8");
 assert.match(source,/mode: "raw"/);
 assert.match(source,/markReady: false/);
 assert.match(source,/allowedDestinations: \[\]/);
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
 assert.match(src,/Too many potential registration matches/);
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
 assert.match(detail,/a\."sourcePath"/);
 assert.match(detail,/b\."slug" AS "brandSlug"/);
});
