type Job =
  | { type: "dropbox.sync"; brandId: string; storageConnectionId: string }
  | { type: "asset.inspect"; assetId: string }
  | { type: "asset.analyze"; assetId: string };

export async function runJob(job: Job) {
  switch (job.type) {
    case "dropbox.sync":
      throw new Error("Dropbox sync worker not wired yet.");
    case "asset.inspect":
      throw new Error("Media inspection worker not wired yet.");
    case "asset.analyze":
      throw new Error("AI analysis worker not wired yet.");
  }
}

if (process.env.NODE_ENV !== "test") {
  console.log("Elettro Brand OS worker scaffold ready.");
}
