import {executeAiGateway,GatewayError} from "@/lib/ai-gateway";

/**
 * Provider-neutral metadata batch processor.
 * Updates independently; partial failures are reported per asset.
 * Never changes publishing status, source files or Dropbox folders.
 */
type Input={brandSlug?:unknown;items?:unknown;confirmed?:unknown};
type Item={assetId:string;metadata:Record<string,unknown>};
type Outcome={assetId:string;ok:boolean;error?:string};
export async function batchUpdateAssetMetadata(input:unknown){
 if(!input||typeof input!=="object"||Array.isArray(input))
  throw new GatewayError(400,"Expected a batch request");
 const request=input as Input;
 if(request.confirmed!==true)
  throw new GatewayError(400,"Explicit confirmation required before batch metadata updates");
 if(typeof request.brandSlug!=="string"||!request.brandSlug)
  throw new GatewayError(400,"Brand required");
 if(!Array.isArray(request.items)||request.items.length<1||request.items.length>25)
  throw new GatewayError(400,"Provide 1–25 assets per metadata batch");
 const items:Item[]=[];
 const seen=new Set<string>();
 for(const value of request.items){
  if(!value||typeof value!=="object"||Array.isArray(value))
   throw new GatewayError(400,"Invalid batch item");
  const entry=value as Record<string,unknown>;
  const assetId=entry.assetId;
  if(typeof assetId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId))
   throw new GatewayError(400,"Invalid asset ID in metadata batch");
  if(seen.has(assetId))throw new GatewayError(400,"Duplicate asset ID in metadata batch");
  seen.add(assetId);
  if(!entry.metadata||typeof entry.metadata!=="object"||Array.isArray(entry.metadata)||
    !Object.keys(entry.metadata).length)
   throw new GatewayError(400,"Each asset requires metadata");
  items.push({assetId,metadata:entry.metadata as Record<string,unknown>});
 }

 const outcomes:Outcome[]=[];
 // Bounded concurrency avoids flooding the existing Lambda/database.
 for(let start=0;start<items.length;start+=3){
  const group=await Promise.all(items.slice(start,start+3).map(async(item):Promise<Outcome>=>{
   try{
    const result=await executeAiGateway({
     action:"update_asset_metadata",brandSlug:request.brandSlug,
     assetId:item.assetId,metadata:item.metadata,confirmed:true
    });
    return result.ok===true?{assetId:item.assetId,ok:true}:
     {assetId:item.assetId,ok:false,error:"Asset update was not confirmed"};
   }catch(error){
    const message=error instanceof GatewayError?error.message:"Asset update unavailable";
    return {assetId:item.assetId,ok:false,error:message};
   }
  }));
  outcomes.push(...group);
 }
 const updated=outcomes.filter(item=>item.ok).length;
 return {ok:updated===items.length,brandSlug:request.brandSlug,
  requested:items.length,updated,failed:items.length-updated,outcomes,
  note:"Metadata only. Publishing status and Dropbox locations were not changed."};
}
