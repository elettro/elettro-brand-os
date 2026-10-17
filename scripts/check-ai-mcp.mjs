#!/usr/bin/env node
/**
 * Elettro brand-only MCP smoke test.
 * Pass the token ONLY in an environment variable; never in arguments or source.
 *
 * ELETTRO_MCP_TOKEN=... node scripts/check-ai-mcp.mjs
 * ELETTRO_MCP_BRAND=elettro ... (optional)
 */
const endpoint=process.env.ELETTRO_MCP_URL ||
  "https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp";
const token=process.env.ELETTRO_MCP_TOKEN;
const brand=process.env.ELETTRO_MCP_BRAND || "stashbox";

if(!token){
 console.error("Missing ELETTRO_MCP_TOKEN. Set an authorized provider token in your local environment.");
 process.exit(2);
}
let serial=0;
async function call(method,params={}){
 const id=++serial;
 const response=await fetch(endpoint,{
  method:"POST",
  headers:{
   Authorization:"Bearer "+token,
   "Content-Type":"application/json",
   Accept:"application/json, text/event-stream"
  },
  body:JSON.stringify({jsonrpc:"2.0",id,method,params}),
  redirect:"error",
  signal:AbortSignal.timeout(20000)
 });
 const text=await response.text();
 if(!response.ok)throw Error(method+" HTTP "+response.status+" (check deployment, credentials and scopes)");
 let data;
 try{data=JSON.parse(text);}catch{throw Error(method+" response was not JSON");}
 if(data.id!==id||data.error)throw Error(method+" failed: "+JSON.stringify(data.error||"unexpected id"));
 return data.result;
}
try{
 const initialized=await call("initialize",{
  protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"elettro-smoke",version:"1.0"}
 });
 if(!initialized?.serverInfo?.name?.startsWith("elettro-"))throw Error("Wrong MCP server");
 console.log("OK: MCP initialization",initialized.serverInfo.name);

 const catalog=await call("tools/list");
 const tools=catalog.tools||[];
 const names=tools.map(t=>t.name);
 console.log("OK: Available tools",names.length);
 if(!names.includes("elettro_search_assets")||!names.includes("elettro_list_brand_folders"))
  throw Error("Required read-only brand tools missing");
 if(names.some(name=>/stock|delete|move|publish/.test(name)))
  throw Error("Unexpected paused/unsafe tool exposed");

 const search=await call("tools/call",{
  name:"elettro_search_assets",arguments:{brandSlug:brand,limit:2}
 });
 if(search.isError)throw Error("Asset search failed: "+search.content?.[0]?.text);
 console.log("OK: Brand asset search");

 const list=await call("tools/call",{
  name:"elettro_list_brand_folders",arguments:{brandSlug:brand}
 });
 if(list.isError)throw Error("Brand folders failed: "+list.content?.[0]?.text);
 const scoped=list.structuredContent;
 if(scoped?.path?.toLowerCase()!==("/1---elettro-brand-os/brands/"+brand).toLowerCase())
  throw Error("Unexpected Dropbox brand root");
 console.log("OK: Folder scoped to",scoped.path);

 console.log("PASS: Read-only MCP smoke test complete.");
}catch(error){
 console.error("FAIL:",error instanceof Error?error.message:String(error));
 process.exitCode=1;
}
