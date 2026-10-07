export type AssetAnalysisInput = {
  filename: string;
  sourcePath?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  hasAudio?: boolean | null;
  creatorNote?: string | null;
  folderHints?: {
    brand?: string;
    mediaType?: string;
    subjectOrCollection?: string;
    ratio?: string;
  };
};

export type AssetAnalysisResult = {
  description: string;
  suggestedTitle?: string;
  suggestedTopic?: string;
  suggestedContentGroup?: string;
  suggestedTags: string[];
  suggestedCreativeFamily?: string;
  suggestedCollection?: string;
  suggestedSubjects?: Array<{
    name: string;
    type?: "person" | "group" | "product" | "topic" | "event" | "show" | "other";
    confidence?: number;
  }>;
  platformFit?: string[];
  warnings?: string[];
};

export interface AiProvider {
  analyzeAsset(input: AssetAnalysisInput): Promise<AssetAnalysisResult>;
}

export class UnconfiguredAiProvider implements AiProvider {
  async analyzeAsset(): Promise<AssetAnalysisResult> {
    throw new Error(
      "AI provider is not configured. V1 uses one primary provider behind this interface; credentials are supplied per environment."
    );
  }
}
