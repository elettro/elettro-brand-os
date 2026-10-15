// Known ChatGPT fileParam transfer hosts observed from owner-authorized
// uploads. Keep Azure account names explicit: *.blob.core.windows.net is NOT
// an acceptable trust boundary. Add a new host only after observing and
// verifying it in a real attachment handoff.
const CHATGPT_AZURE_BLOB_HOSTS=new Set([
 "oaisdmntprcentralus.blob.core.windows.net",
 "oaisdmntprnorthcentralus.blob.core.windows.net"
]);

export function approvedChatGptFileHost(host:string):boolean{
 const h=host.toLowerCase();
 return CHATGPT_AZURE_BLOB_HOSTS.has(h)||
  h==="chatgpt.com"||h==="files.oaiusercontent.com"||
  (h.endsWith(".oaiusercontent.com")&&h.length>(".oaiusercontent.com").length);
}
