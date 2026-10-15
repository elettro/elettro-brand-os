/**
 * Normalizes an OpenAI-authorized fileParam. The MCP descriptor advertises
 * a canonical {download_url,file_id,mime_type?,file_name?} object. Some
 * intermediaries serialize that same object as JSON text.
 *
 * File IDs, local sandbox paths and plain URLs alone are NOT a substitute
 * for the host-provided download URL. We never fetch a string reference.
 */
export type ChatFile={
 download_url:string;file_id:string;file_name?:string;mime_type?:string;
};

export function parseChatFileParam(value:unknown):ChatFile{
 let raw:unknown=value;
 if(typeof value==="string"){
  if(value.length>8192)
   throw new Error("ChatGPT file reference is too large");
  try{raw=JSON.parse(value);}
  catch{
   throw new Error("ChatGPT supplied a file reference, not an authorized download URL. Attach/select the file through ChatGPT and retry.");
  }
 }
 if(!raw||typeof raw!=="object"||Array.isArray(raw))
  throw new Error("Use a ChatGPT-authorized file input");
 const obj=raw as Record<string,unknown>;
 const fileId=obj.file_id, url=obj.download_url;
 // OpenAI file IDs are opaque. The ID binds the signed preview to the
 // subsequent upload; URL host validation remains mandatory at download.
 if(typeof fileId!=="string"||fileId.length<6||fileId.length>256||
    /[\\\x00-\x20<>]/.test(fileId)||
    typeof url!=="string"||!url.startsWith("https://")||url.length>6000)
  throw new Error("ChatGPT did not provide an authorized file ID and HTTPS download URL");
 if(obj.file_name!==undefined&&
    (typeof obj.file_name!=="string"||obj.file_name.length>180))
  throw new Error("Invalid source filename");
 if(obj.mime_type!==undefined&&
    (typeof obj.mime_type!=="string"||obj.mime_type.length>100))
  throw new Error("Invalid source MIME type");
 return {
  file_id:fileId,
  download_url:url,
  ...(typeof obj.file_name==="string"?{file_name:obj.file_name}:{}),
  ...(typeof obj.mime_type==="string"?{mime_type:obj.mime_type}:{})
 };
}
