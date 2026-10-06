export type AssetAnalysisInput = {
  filename: string;
  sourcePath?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
};

export type AssetAnalysisResult = {
  description: string;
  suggestedTopic?: string;
  suggestedContentGroup?: string;
  suggestedTags: string[];
  suggestedCreativeFamily?: string;
};

export interface AiProvider {
  analyzeAsset(input: AssetAnalysisInput): Promise<AssetAnalysisResult>;
}

export class UnconfiguredAiProvider implements AiProvider {
  async analyzeAsset(): Promise<AssetAnalysisResult> {
    throw new Error("AI provider is not configured. Add OpenAI credentials and provider implementation.");
  }
}
