/**
 * Dropbox files/upload and files/get_metadata return FileMetadata and do not
 * necessarily include a ".tag" discriminant. Folder-list entries do.
 *
 * Validate the immutable ID, full expected path and exact uploaded bytes
 * rather than relying on the optional union discriminant.
 */
export type DropboxFileResponse={
 ".tag"?:unknown;id?:unknown;path_display?:unknown;size?:unknown;content_hash?:unknown
};
export type VerifiedDropboxFile={id:string;path:string;size:number;contentHash:string};

export function verifyDropboxFileResponse(
 raw:unknown, expectedPath:string, expectedSize:number, expectedHash:string
):VerifiedDropboxFile{
 if(!raw||typeof raw!=="object"||Array.isArray(raw))
  throw new Error("Dropbox did not return file metadata");
 const data=raw as DropboxFileResponse;
 if(data[".tag"]!==undefined&&data[".tag"]!=="file")
  throw new Error("Dropbox response is not a file");
 if(typeof data.id!=="string"||!/^id:[A-Za-z0-9_-]+$/.test(data.id)||
    typeof data.path_display!=="string"||
    data.path_display.toLowerCase()!==expectedPath.toLowerCase())
  throw new Error("Dropbox file ID or destination path mismatch");
 if(!Number.isSafeInteger(expectedSize)||expectedSize<1||
    data.size!==expectedSize||typeof data.content_hash!=="string"||
    !/^[a-f0-9]{64}$/i.test(data.content_hash)||
    data.content_hash.toLowerCase()!==expectedHash.toLowerCase())
  throw new Error("Dropbox file size or content hash mismatch");
 return {id:data.id,path:data.path_display,size:data.size,contentHash:data.content_hash};
}
