import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {withDropboxIdentityTransaction,assertDropboxFileId,DropboxIdentityConflict} from "../services/dev-api-lambda/dropbox-identity.mjs";

const ID="id:UM9GhyUcVDgAAAAAAAMB-g";
const BRAND="stashbox-uuid";
function client(rows=[],lockError=false){
 const queries=[];
 return {queries,async query(sql,values=[]){
  queries.push({sql:String(sql),values});
  if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return {rows:[]};
  if(String(sql).includes("pg_advisory_xact_lock")){
   if(lockError)throw Error("lock unavailable");
   return {rows:[{}]};
  }
  if(String(sql).includes('FROM "Asset"'))return {rows:rows.slice(0,2)};
  throw Error("Unexpected SQL");
 }};
}
const item=(patch={})=>({
 id:"asset-1",brandId:BRAND,filename:"video.mp4",
 ingestStatus:"ready",approvalStatus:"approved",retiredAt:null,
 sourceFileId:null,sourceExternalId:ID,...patch
});

test("stable Dropbox ID validation rejects missing, path and malformed IDs",()=>{
 assert.equal(assertDropboxFileId(ID),ID);
 for(const bad of ["",null,"/path/file.mp4","id:abc","id:abc+123456"]){
  assert.throws(()=>assertDropboxFileId(bad),DropboxIdentityConflict);
 }
});

test("existing direct-upload Ready/Approved record is reused without a metadata write",async()=>{
 const c=client([item()]);
 const result=await withDropboxIdentityTransaction(c,ID,BRAND,async(existing)=>({sameId:existing.id,ready:existing.ingestStatus,approved:existing.approvalStatus}));
 assert.deepEqual(result,{sameId:"asset-1",ready:"ready",approved:"approved"});
 assert.deepEqual(c.queries.filter(x=>["BEGIN","COMMIT","ROLLBACK"].includes(x.sql)).map(x=>x.sql),["BEGIN","COMMIT"]);
 assert.ok(!c.queries.some(x=>/^\s*(UPDATE|INSERT)\b/i.test(x.sql)));
});

test("existing sync-source Dropbox ID matches direct-upload registry checks",async()=>{
 const c=client([item({sourceFileId:ID,sourceExternalId:null})]);
 const r=await withDropboxIdentityTransaction(c,ID,BRAND,async(existing)=>existing.id);
 assert.equal(r,"asset-1");
});

test("new ID enters callback under transaction-level advisory lock",async()=>{
 const c=client([]);
 await withDropboxIdentityTransaction(c,ID,BRAND,async(existing)=>{
  assert.equal(existing,null);
  assert.match(c.queries[1].sql,/pg_advisory_xact_lock/);
  assert.match(c.queries[2].sql,/sourceFileId/);
  assert.match(c.queries[2].sql,/sourceExternalId/);
 });
 assert.equal(c.queries.at(-1).sql,"COMMIT");
});

for(const [name,row] of [
 ["cross-brand ownership",item({brandId:"other-brand"})],
 ["retired record",item({retiredAt:"2026-01-01"})],
 ["conflicting source IDs",item({sourceFileId:"id:otherIDENTITY123"})]
])test("blocks "+name+" and rolls back",async()=>{
 const c=client([row]); let executed=false;
 await assert.rejects(
  withDropboxIdentityTransaction(c,ID,BRAND,async()=>{executed=true;}),
  DropboxIdentityConflict
 );
 assert.equal(executed,false);
 assert.equal(c.queries.at(-1).sql,"ROLLBACK");
});

test("cross-column duplicate rows cause review rather than silent selection",async()=>{
 const c=client([item({id:"asset-a"}),item({id:"asset-b"})]);
 await assert.rejects(withDropboxIdentityTransaction(c,ID,BRAND,async()=>{}),/Duplicate Dropbox ID/);
 assert.equal(c.queries.at(-1).sql,"ROLLBACK");
});

test("operation or advisory lock failure rolls back",async()=>{
 for(const locked of [false,true]){
  const c=client([],locked);
  await assert.rejects(withDropboxIdentityTransaction(c,ID,BRAND,async()=>{throw Error("create unavailable")}));
  assert.equal(c.queries.at(-1).sql,"ROLLBACK");
 }
});

test("DEV sync writer invokes identity transaction rather than old brand-only ID lookup",()=>{
 const src=readFileSync(new URL("../services/dev-api-lambda/db-main.mjs",import.meta.url),"utf8");
 assert.match(src,/withDropboxIdentityTransaction\(client,entry\.id,brandId/);
 assert.match(src,/ON CONFLICT DO NOTHING RETURNING "id"/);
 assert.match(src,/if\(error instanceof DropboxIdentityConflict\)/);
 assert.match(src,/findDropboxAsset\(client,entry\.id,brandId\)/);
});
