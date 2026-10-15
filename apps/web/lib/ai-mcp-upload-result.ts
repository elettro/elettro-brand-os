// Upload outcomes reported to AI clients. Only uploadComplete() may describe a
// finished transfer. Every other outcome is ok:false with transferComplete:false,
// names what is missing, and tells the assistant not to report success.
type StoredFile={brandSlug:string;dropboxFileId:string;dropboxPath:string;reusedExistingFile?:boolean};
export type VerificationStep="metadata"|"global_identity"|"dropbox_location";
const STEP_LABEL:Record<VerificationStep,string>={
 metadata:"metadata update",
 global_identity:"global Dropbox ID check",
 dropbox_location:"Dropbox location check"
};

export function registrationPending(file:StoredFile){
 return {ok:false as const,status:"registration_pending" as const,transferComplete:false,
  registered:false,identityVerified:false,...file,
  message:"UPLOAD NOT COMPLETE. The file is stored in Dropbox but is not registered in Elettro. "+
   "Do not report this upload as successful and do not upload it again; retry registration or reconcile this Dropbox ID and path."};
}
export function verificationFailed(file:StoredFile,assetId:string,failedStep:VerificationStep){
 return {ok:false as const,status:"verification_failed" as const,transferComplete:false,
  registered:true,identityVerified:false,assetId,failedStep,...file,
  message:"UPLOAD NOT VERIFIED. The file is stored in Dropbox and Elettro asset "+assetId+
   " exists, but the "+STEP_LABEL[failedStep]+" failed. Do not report this upload as successful "+
   "and do not upload it again; inspect asset "+assetId+" before using it."};
}
export function uploadComplete<T extends Record<string,unknown>>(file:StoredFile,assetId:string,alreadyRegistered:boolean,extra:T){
 return {ok:true as const,status:"uploaded" as const,transferComplete:true,
  registered:true,identityVerified:true,assetId,alreadyRegistered,...file,...extra};
}
