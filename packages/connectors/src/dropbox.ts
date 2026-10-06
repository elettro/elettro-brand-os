export type DropboxAssetRef = {
  id: string;
  name: string;
  path: string;
  size: number;
  contentHash?: string;
  serverModified?: string;
};

export type DropboxDelta = {
  files: DropboxAssetRef[];
  deletedPaths: string[];
  cursor: string;
  hasMore: boolean;
};

export interface DropboxConnector {
  listInitial(rootPath: string): Promise<DropboxDelta>;
  continue(cursor: string): Promise<DropboxDelta>;
  getTemporaryLink(fileId: string): Promise<string>;
}

export const DROPBOX_REQUIRED_SCOPES = [
  "files.metadata.read",
  "files.content.read"
] as const;
