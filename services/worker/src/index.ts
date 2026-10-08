export type Job =
  | {
      type: "dropbox.sync";
      organizationId: string;
      storageConnectionId: string;
    }
  | {
      type: "shopify.sync";
      brandId: string;
      shopifyStoreId: string;
    }
  | {
      type: "asset.inspect";
      assetId: string;
    }
  | {
      type: "asset.analyze";
      assetId: string;
    }
  | {
      type: "asset.refresh-source";
      assetId: string;
    };

export type JobResult = {
  status: "completed" | "deferred";
  message: string;
};

export async function runJob(job: Job): Promise<JobResult> {
  switch (job.type) {
    case "dropbox.sync":
      return {
        status: "deferred",
        message: "Dropbox sync is ready for live connector credentials and queue wiring."
      };
    case "shopify.sync":
      return {
        status: "deferred",
        message: "Shopify sync is ready for live store credentials and queue wiring."
      };
    case "asset.inspect":
      return {
        status: "deferred",
        message: "Asset inspection is ready for the AWS media-inspection runtime."
      };
    case "asset.analyze":
      return {
        status: "deferred",
        message: "AI enrichment is ready for the configured V1 AI provider."
      };
    case "asset.refresh-source":
      return {
        status: "deferred",
        message: "Source validation is ready for live connector wiring."
      };
  }
}

if (process.env.NODE_ENV !== "test") {
  console.log("Elettro Brand OS worker contracts ready.");
}
