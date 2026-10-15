import test from "node:test";
import assert from "node:assert/strict";
import {verifyDropboxFileResponse} from "../apps/web/lib/ai-mcp-dropbox-identity.ts";

const path="/1---elettro-brand-os/stashbox/band/image/stashbox-brand/graphics/1x1/envato-labs-image-edit (36).png";
const hash="a".repeat(64);
const size=1787864;
const metadata={
 id:"id:UM9GhyUcVDgAAAAAAAMEIA",
 path_display:path,
 size,
 content_hash:hash,
 name:"envato-labs-image-edit (36).png",
 rev:"65dd7cb6a1be40021637b"
};

test("Dropbox upload FileMetadata without .tag is a valid persisted file identity",()=>{
 const result=verifyDropboxFileResponse(metadata,path,size,hash);
 assert.deepEqual(result,{id:metadata.id,path,size,contentHash:hash});
});

test("Dropbox get_metadata or listing response accepts the optional file tag",()=>{
 assert.deepEqual(verifyDropboxFileResponse({...metadata,".tag":"file"},path,size,hash),
  {id:metadata.id,path,size,contentHash:hash});
 assert.equal(verifyDropboxFileResponse(metadata,path.toUpperCase(),size,hash).id,metadata.id);
});

test("Reject mismatched Dropbox ID, folder tag, destination and bytes before EPE registration",()=>{
 for(const bad of [
  {...metadata,".tag":"folder"},
  {...metadata,id:"not-a-dropbox-id"},
  {...metadata,id:undefined},
  {...metadata,path_display:"/other-brand/file.png"},
  {...metadata,path_display:"/1---elettro-brand-os/stashbox/band/image/stashbox-brand/graphics/1x1/other.png"},
  {...metadata,size:0},
  {...metadata,size:size-1},
  {...metadata,content_hash:"b".repeat(64)},
  {...metadata,content_hash:undefined},
  {...metadata,content_hash:"invalid"},
  null,[],{}
 ]){
  assert.throws(()=>verifyDropboxFileResponse(bad,path,size,hash),/Dropbox/);
 }
});

test("Recognize exact byte identity, not merely matching filename",()=>{
 assert.throws(()=>verifyDropboxFileResponse(metadata,path,size+1,hash),/Dropbox/);
 assert.throws(()=>verifyDropboxFileResponse(metadata,path,size,"b".repeat(64)),/Dropbox/);
});
