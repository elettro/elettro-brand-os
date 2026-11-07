/**
 * Post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A "Collect", YouTube first).
 *
 * A worker that can reach the network (the YouTube upload Lambda; this one runs in the VPC with no internet) asks
 * `list-post-metrics-due-20261107` which published posts still lack a snapshot, fetches the numbers, and hands them back
 * with `record-post-metrics-20261107`. One row per published post and age bucket (1h, 24h, 7d, 30d after publishing).
 * Read-only toward the network: nothing here posts, edits or deletes anything on a platform.
 *
 * All three actions are IAM-only. The setup action is a dry run unless mode is "apply".
 */

export const AGE_BUCKETS = [
  { id: "1h", ms: 60 * 60 * 1000 },
  { id: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000 }
];
const BUCKET_IDS = AGE_BUCKETS.map((b) => b.id);
// A post older than this stops being collected (its 30d snapshot is the last one that matters).
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
// Brands that exist only for testing; never collected (google-review is the demo brand for Google's API reviewer).
export const EXCLUDED_BRANDS = ["google-review"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const POST_METRIC_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "PostMetric" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "ledgerId" UUID NOT NULL REFERENCES "PublicationLedger"("id") ON DELETE CASCADE,
    "ageBucket" TEXT NOT NULL CHECK ("ageBucket" IN ('1h','24h','7d','30d')),
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "watchTimeSeconds" BIGINT,
    "avgViewDurationSeconds" NUMERIC,
    "followsGained" INTEGER,
    "raw" JSONB,
    UNIQUE ("ledgerId", "ageBucket")
  )`,
  `CREATE INDEX IF NOT EXISTS "PostMetric_ledgerId_idx" ON "PostMetric"("ledgerId")`
];

/** The age buckets a post has reached by `now` and has no snapshot for yet. Oldest first. */
export function dueBuckets(publishedAt, captured = [], now = Date.now()) {
  const age = now - new Date(publishedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return [];
  const have = new Set(captured);
  return AGE_BUCKETS.filter((b) => age >= b.ms && !have.has(b.id)).map((b) => b.id);
}

const whole = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value)) : null);
const decimal = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

/** Validates one metrics item from a worker into the row fields, or throws with a readable reason. */
export function cleanMetricItem(item) {
  const ledgerId = String(item?.ledgerId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ledgerId)) throw new Error("ledgerId must be a uuid");
  const ageBucket = String(item?.ageBucket || "");
  if (!BUCKET_IDS.includes(ageBucket)) throw new Error(`ageBucket must be one of ${BUCKET_IDS.join(", ")}`);
  const source = String(item?.source || "").slice(0, 40);
  if (!source) throw new Error("source is required");
  const m = item?.metrics || {};
  return {
    ledgerId, ageBucket, source,
    views: whole(m.views), likes: whole(m.likes), comments: whole(m.comments), shares: whole(m.shares),
    watchTimeSeconds: whole(m.watchTimeSeconds), avgViewDurationSeconds: decimal(m.avgViewDurationSeconds),
    followsGained: whole(m.followsGained),
    raw: item?.raw && typeof item.raw === "object" ? item.raw : null
  };
}

function iamOnly(event) {
  return !(event.requestContext || event.rawPath || event.path);
}

/** { mode?: "apply" } — creates PostMetric. Dry run unless mode is "apply". */
export async function runPostMetricsSetup(event, connectDatabase, json) {
  if (!iamOnly(event)) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const exists = (await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='PostMetric'`)).rows.length > 0;
    if (mode !== "apply") return json(200, { ok: true, mode, note: "Dry run; nothing changed", tableExists: exists, statements: POST_METRIC_TABLES_SQL.length });
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    for (const sql of POST_METRIC_TABLES_SQL) await client.query(sql);
    await client.query("COMMIT");
    return json(200, { ok: true, mode, created: exists ? [] : ["PostMetric"] });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    console.error("[post-metrics-setup] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "setup failed" });
  } finally {
    if (client) await client.end?.();
  }
}

/**
 * { destination?: "youtube", limit? } — published posts of that network that reached an age bucket without a snapshot, plus every
 * connected channel (so a worker can also check access). Read only.
 */
export async function runListPostMetricsDue(event, connectDatabase, json, now = Date.now()) {
  if (!iamOnly(event)) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const destination = String(event.destination || "youtube");
  if (destination !== "youtube") return json(400, { ok: false, error: "Only youtube is supported so far" });
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(event.limit) || DEFAULT_LIMIT));
  let client;
  try {
    client = await connectDatabase();
    const channels = (await client.query(
      `SELECT b."slug" AS "brand", sa."accountName", sa."externalAccountId" AS "channelId"
       FROM "SocialAccount" sa JOIN "Brand" b ON b."id" = sa."brandId"
       WHERE sa."destination" = 'youtube' AND sa."externalAccountId" IS NOT NULL AND sa."status" = 'active' AND b."slug" <> ALL($1::text[])
       ORDER BY b."slug"`, [EXCLUDED_BRANDS])).rows;
    const rows = (await client.query(
      `SELECT pl."id" AS "ledgerId", pl."externalPostId" AS "videoId", pl."publishedAt", sa."externalAccountId" AS "channelId", b."slug" AS "brand",
              COALESCE(array_agg(pm."ageBucket") FILTER (WHERE pm."ageBucket" IS NOT NULL), '{}') AS "captured"
       FROM "PublicationLedger" pl
       JOIN "SocialAccount" sa ON sa."id" = pl."socialAccountId"
       JOIN "Brand" b ON b."id" = pl."brandId"
       LEFT JOIN "PostMetric" pm ON pm."ledgerId" = pl."id"
       WHERE pl."destination" = 'youtube' AND pl."externalPostId" IS NOT NULL AND sa."externalAccountId" IS NOT NULL
         AND pl."publishedAt" >= $1::timestamp AND b."slug" <> ALL($2::text[])
       GROUP BY pl."id", sa."externalAccountId", b."slug"
       ORDER BY pl."publishedAt"`, [new Date(now - MAX_AGE_MS).toISOString(), EXCLUDED_BRANDS])).rows;
    const due = [];
    for (const row of rows) {
      const buckets = dueBuckets(row.publishedAt, row.captured, now);
      if (buckets.length) due.push({ ledgerId: row.ledgerId, videoId: row.videoId, channelId: row.channelId, brand: row.brand, publishedAt: new Date(row.publishedAt).toISOString(), buckets });
      if (due.length >= limit) break;
    }
    return json(200, { ok: true, channels, due });
  } catch (error) {
    console.error("[post-metrics-due] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "list failed" });
  } finally {
    if (client) await client.end?.();
  }
}

/** { items: [{ ledgerId, ageBucket, source, metrics, raw? }] } — saves snapshots (up to 100); an existing one is left as it was. */
export async function runRecordPostMetrics(event, connectDatabase, json) {
  if (!iamOnly(event)) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const items = Array.isArray(event.items) ? event.items : [];
  if (!items.length || items.length > 100) return json(400, { ok: false, error: "items must hold 1-100 snapshots" });
  let rows;
  try { rows = items.map(cleanMetricItem); } catch (error) { return json(400, { ok: false, error: error.message }); }
  let client;
  try {
    client = await connectDatabase();
    let saved = 0;
    for (const r of rows) {
      const result = await client.query(
        `INSERT INTO "PostMetric" ("ledgerId","ageBucket","source","views","likes","comments","shares","watchTimeSeconds","avgViewDurationSeconds","followsGained","raw")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT ("ledgerId","ageBucket") DO NOTHING`,
        [r.ledgerId, r.ageBucket, r.source, r.views, r.likes, r.comments, r.shares, r.watchTimeSeconds, r.avgViewDurationSeconds, r.followsGained, r.raw ? JSON.stringify(r.raw) : null]);
      saved += result.rowCount || 0;
    }
    return json(200, { ok: true, saved, skipped: rows.length - saved });
  } catch (error) {
    console.error("[post-metrics-record] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "record failed" });
  } finally {
    if (client) await client.end?.();
  }
}
