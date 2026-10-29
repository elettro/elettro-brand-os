// PDF documents are a first-class asset kind: Dropbox/upload classify them, the enum has the value,
// and the planner never picks one for a placement that does not ask for documents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { poolRejection, resolvePlannerSettings } from "../services/dev-api-lambda/planner-v2.mjs";
import { runDocumentAssetKindSetup } from "../services/dev-api-lambda/document-asset-kind.mjs";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(base, p), "utf8");
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

test("every kind classifier and allowlist knows .pdf", () => {
  for (const file of ["services/dev-api-lambda/index.mjs", "services/dev-api-lambda/db-main.mjs"]) {
    assert.match(read(file), /\\\.pdf\$\/i\.test\(lower\)\) return "document"/, file);
  }
  assert.ok(read("services/dev-api-lambda/index.mjs").includes('kind==="document"?"application/pdf"'));
  assert.ok(read("apps/web/lib/ai-mcp-intake.ts").includes('".pdf":"application/pdf"'));
  assert.match(read("apps/web/lib/ai-gateway.ts"), /mp4\|mov\|m4v\|webm\|pdf\)\$\/i\.test\(path\)/);
});

test("the document kind exists in init.sql, Prisma and a migration", () => {
  assert.ok(read("services/dev-api-lambda/init.sql").includes("'carousel','audio','document'"));
  assert.match(read("packages/database/prisma/schema.prisma"), /enum AssetKind \{[^}]*\bdocument\b/);
  assert.ok(read("packages/database/prisma/migrations/20261029_document_asset_kind/migration.sql")
    .includes(`ADD VALUE IF NOT EXISTS 'document'`));
});

test("setup action is IAM-only, wired, and packaged in both zip lists", () => {
  const api = read("services/dev-api-lambda/index.mjs");
  assert.match(api, /setup-document-asset-kind-20261029" && !event\.requestContext && !event\.rawPath && !event\.path/);
  assert.ok(read("services/dev-api-lambda/package.json").includes("document-asset-kind.mjs init.sql"));
  const workflow = read(".github/workflows/build-dev-api-lambda.yml");
  assert.ok(workflow.includes("node --check document-asset-kind.mjs"));
  assert.ok(workflow.includes("document-asset-kind.mjs init.sql"));
});

test("setup refuses HTTP callers, dry-runs by default, and only adds the value on apply", async () => {
  const queries = [];
  const connect = async () => ({
    query: async (sql) => { queries.push(sql); return { rows: sql.includes("pg_enum") ? [{ enumlabel: "video" }, { enumlabel: "image" }] : [] }; },
    end: async () => {}
  });
  assert.equal((await runDocumentAssetKindSetup({ rawPath: "/x" }, connect, json)).statusCode, 403);
  const dry = await runDocumentAssetKindSetup({}, connect, json);
  assert.equal(JSON.parse(dry.body).mode, "dry-run");
  assert.ok(!queries.some((q) => q.includes("ADD VALUE")));
  const applied = await runDocumentAssetKindSetup({ mode: "apply" }, connect, json);
  assert.equal(JSON.parse(applied.body).added, true);
  assert.ok(queries.some((q) => q.includes("ADD VALUE IF NOT EXISTS 'document'")));
});

test("a PDF is only plannable by a placement that lists document", () => {
  const settings = resolvePlannerSettings({});
  const pdf = { kind: "document", filename: "deck.pdf", tags: [] };
  const reel = { destination: "instagram", placement: "reel" };
  assert.equal(poolRejection(pdf, reel, settings), "kind");
  const withDocs = { ...settings, placements: { ...settings.placements, "linkedin:document": { kinds: ["document"], aspectRatios: [] } } };
  assert.equal(poolRejection(pdf, { destination: "linkedin", placement: "document" }, withDocs), null);
  assert.equal(poolRejection({ kind: "video", filename: "a.mp4", tags: [] }, reel, settings), null);
});
