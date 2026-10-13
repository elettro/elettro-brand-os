import {randomBytes} from "node:crypto";
import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";

/**
 * Owner-only DEV diagnostic. Not registered as an assistant/MCP tool.
 * Changes only the tags on one Stashbox asset, verifies the write, removes
 * the diagnostic tag, and independently verifies the cleanup.
 */
type AssetSnapshot={id:string;brandSlug:string;filename:string;tags?:string[];ingestStatus?:string;approvalStatus?:string};
type ReadResult={ok:boolean;asset:AssetSnapshot};
const activeTests=new Set<string>();

async function readAsset(id:string):Promise<AssetSnapshot>{
 const response=await executeAiGateway({action:"get_asset",brandSlug:"stashbox",assetId:id}) as unknown as ReadResult;
 if(!response.ok||response.asset?.id!==id||response.asset?.brandSlug!=="stashbox")
  throw new GatewayError(502,"Could not verify the chosen Stashbox asset");
 return response.asset;
}
async function writeTags(id:string,tags:string[]):Promise<void>{
 await executeAiGateway({
  action:"update_asset_metadata",brandSlug:"stashbox",assetId:id,
  metadata:{tags},confirmed:true
 });
}
function errorText(error:unknown):string{
 return error instanceof GatewayError?error.message:"An unexpected gateway error occurred";
}
function tagsSame(a:string[],b:string[]):boolean{
 return a.length===b.length&&a.every((tag,i)=>tag===b[i]);
}

export async function runMetadataWriteSmokeTest(input:unknown){
 if(!input||typeof input!=="object"||Array.isArray(input))
  throw new GatewayError(400,"Expected a test request");
 const request=input as {assetId?:unknown;confirmed?:unknown};
 if(request.confirmed!==true)
  throw new GatewayError(400,"Confirm the temporary tag test before running");
 const id=request.assetId;
 if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  throw new GatewayError(400,"Select an existing Stashbox asset");
 if(activeTests.has(id))throw new GatewayError(409,"A test is already running for this asset");
 activeTests.add(id);
 try{
  const before=await readAsset(id);
  const originalTags=before.tags||[];
  const probe="elettro-gateway-test-"+randomBytes(5).toString("hex");
  const added=[...originalTags,probe];
  if(added.length>50||added.join(", ").length>500)
   throw new GatewayError(400,"This asset already has too many tags for a safe test");

  let writeAttempted=false;
  let writeVerified=false;
  let cleanupVerified=false;
  let exactRestoration=false;
  let failure:string|undefined;
  let cleanupFailure:string|undefined;
  let after:AssetSnapshot|undefined;

  try{
   writeAttempted=true;
   await writeTags(id,added);
   const stored=await readAsset(id);
   writeVerified=tagsSame(stored.tags||[],added)&&
    stored.ingestStatus===before.ingestStatus&&stored.approvalStatus===before.approvalStatus;
   if(!writeVerified)failure="Metadata write did not verify or asset status changed";
  }catch(error){failure=errorText(error);}
  finally{
   if(writeAttempted){
    try{
     const latest=await readAsset(id);
     const latestTags=latest.tags||[];
     if(latestTags.includes(probe)){
      // Remove only this test's marker, keeping any unrelated concurrent edits.
      await writeTags(id,latestTags.filter(tag=>tag!==probe));
     }
     after=await readAsset(id);
     cleanupVerified=!(after.tags||[]).includes(probe);
     exactRestoration=tagsSame(after.tags||[],originalTags)&&
      after.ingestStatus===before.ingestStatus&&after.approvalStatus===before.approvalStatus;
     if(!cleanupVerified)cleanupFailure="Temporary tag is still present";
    }catch(error){cleanupFailure=errorText(error);}
   }
  }
  return {
   ok:writeVerified&&cleanupVerified&&exactRestoration&&!failure&&!cleanupFailure,
   assetId:id,brandSlug:"stashbox",filename:before.filename,
   writeVerified,cleanupVerified,exactRestoration,
   originalTags,finalTags:after?.tags,
   originalStatus:{ingest:before.ingestStatus,approval:before.approvalStatus},
   finalStatus:after?{ingest:after.ingestStatus,approval:after.approvalStatus}:null,
   ...(failure?{error:failure}:{}),
   ...(cleanupFailure?{cleanupError:cleanupFailure}:{}),
   message:cleanupVerified?
    "Temporary metadata test tag removed. No Dropbox or publishing action was requested.":
    "Cleanup not verified. Do not repeat the test until this asset is inspected."
  };
 }finally{activeTests.delete(id);}
}
