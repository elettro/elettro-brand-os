export type MediaInspectionInput = {
  filename: string;
  mimeType?: string | null;
  localPath?: string | null;
  temporaryUrl?: string | null;
};

export type MediaInspectionResult = {
  mediaType: "image" | "video" | "unknown";
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  aspectRatio?: number | null;
  aspectRatioLabel?: string | null;
  orientation?: "portrait" | "landscape" | "square" | null;
  durationMs?: number | null;
  hasAudio?: boolean | null;
  fileSizeBytes?: number | null;
  warnings: string[];
};

export interface MediaInspector {
  inspect(input: MediaInspectionInput): Promise<MediaInspectionResult>;
}

export function ratioLabel(width?: number | null, height?: number | null) {
  if (!width || !height) return null;

  const ratio = width / height;
  const known = [
    ["9x16", 9 / 16],
    ["16x9", 16 / 9],
    ["1x1", 1],
    ["4x5", 4 / 5],
    ["3x4", 3 / 4],
    ["2x3", 2 / 3]
  ] as const;

  const match = known
    .map(([label, value]) => ({ label, distance: Math.abs(ratio - value) }))
    .sort((a, b) => a.distance - b.distance)[0];

  return match && match.distance <= 0.03 ? match.label : `${width}x${height}`;
}

export function ratioMismatchWarning(expected?: string | null, actual?: string | null) {
  if (!expected || !actual || expected === actual) return null;
  return `Folder expects ${expected}, but technical analysis detected ${actual}.`;
}
