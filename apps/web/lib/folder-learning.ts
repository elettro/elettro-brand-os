export type AssetSignal = { brand: string; campaign: string; purpose: string; shape: string };
export type FolderObservation = { fileId: string; signal: AssetSignal; path: string; event: "file_discovered" | "manual_choice" | "file_moved" | "file_renamed" | "batch_override"; at: number };
export type FolderSuggestion = { path: string | null; confidence: number; sampleSize: number; reason: string };
const norm = (s:string)=>s.trim().toLowerCase();
export const signalKey = (s:AssetSignal)=>[s.brand,s.campaign,s.purpose,s.shape].map(norm).join("|");
export const brandRoot = (brand:string)=>`/1---elettro-brand-os/${brand}/`;
export function recommendFolder(signal:AssetSignal, history:FolderObservation[]):FolderSuggestion {
 const relevant=history.filter(h=>signalKey(h.signal)===signalKey(signal) && h.event!=="batch_override");
 // Only each Dropbox file's latest known destination counts. A rename or move supersedes an old path.
 const latest=new Map<string,FolderObservation>();
 relevant.sort((a,b)=>a.at-b.at).forEach(h=>latest.set(h.fileId,h));
 const observations=Array.from(latest.values());
 const counts=new Map<string,number>();
 observations.forEach(h=>counts.set(h.path,(counts.get(h.path)||0)+1));
 const winning=Array.from(counts.entries()).sort((a,b)=>b[1]-a[1])[0];
 if(!winning) return {path:null,confidence:0,sampleSize:0,reason:"No matching history. Choose a folder to begin learning."};
 const [path,count]=winning;
 const share=count/observations.length;
 // Sample evidence and consensus both matter. Never auto-select on a single example.
 const confidence=Math.round(Math.min(97,share*100*(1-Math.exp(-observations.length/3))));
 const auto=observations.length>=5 && share>=.8 && confidence>=75;
 return {path,confidence,sampleSize:observations.length,reason:auto?`Consistent preference across ${count} of ${observations.length} matching assets. Auto-select eligible.`:`Based on ${count} of ${observations.length} matching assets. Manual review recommended.`};
}
export function applyDropboxChange(history:FolderObservation[],change:FolderObservation):FolderObservation[]{
 if(change.event==="batch_override") return [...history,change]; // Auditable, excluded from learning.
 return [...history,change];
}
