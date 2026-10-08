export type ShopifyProductRef = {
  id: string;
  title: string;
  handle?: string;
  vendor?: string;
  productType?: string;
  status?: string;
  tags: string[];
  productUrl?: string;
};

export type ShopifyMediaRef = {
  id: string;
  productId: string;
  mediaType: "image" | "video" | "external_video" | "model3d";
  url?: string;
  previewUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  mimeType?: string;
};

export interface ShopifyAssetConnector {
  listProducts(): Promise<ShopifyProductRef[]>;
  listProductMedia(productId: string): Promise<ShopifyMediaRef[]>;
  syncProduct(productId: string): Promise<void>;
}

export const SHOPIFY_ASSET_SOURCE_RULES = {
  copyToDropbox: false,
  sourceOfTruth: "shopify",
  behavior: "index-and-reference"
} as const;
