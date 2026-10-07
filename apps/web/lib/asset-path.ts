export type ParsedAssetPath = {
  brand?: string;
  mediaType?: "video" | "images";
  subjectOrCollection?: string;
  ratio?: string;
};

const KNOWN_RATIOS = new Set(["9x16", "16x9", "1x1", "4x5", "3x4", "2x3"]);

export function parseAssetPath(path: string): ParsedAssetPath {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 4) return {};

  const brandIndex = parts.findIndex((part) => part === "video" || part === "images");
  if (brandIndex <= 0) return {};

  const mediaType = parts[brandIndex] as "video" | "images";
  const brand = parts[brandIndex - 1];
  const subjectOrCollection = parts[brandIndex + 1];
  const ratioCandidate = parts[brandIndex + 2];

  return {
    brand,
    mediaType,
    subjectOrCollection,
    ratio: KNOWN_RATIOS.has(ratioCandidate) ? ratioCandidate : undefined
  };
}

export function subjectTokens(subjectOrCollection?: string) {
  if (!subjectOrCollection) return [];
  return subjectOrCollection
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
}
