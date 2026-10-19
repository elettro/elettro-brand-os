// Connection status feed for the elettro.com/dash race: how far each brand profile is from
// "connected and posting on its own". Public GET /status/connections (counts only, no secrets),
// plus IAM-only actions to set the milestones the database can't see yet (app review, OAuth).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defaultIntelligenceRoot } from "./intelligence.mjs";
import { LIBRARY_SLUG } from "./shared-audio-library.mjs";

export const CHECKPOINTS = [
  { key: "strategy", label: "Playbook written", w: 5 },
  { key: "account", label: "Account + handle confirmed", w: 5 },
  { key: "planner", label: "In the planner with a cadence", w: 10 },
  { key: "content", label: "Content pool tagged + ready", w: 10 },
  { key: "copy", label: "Captions engine", w: 10 },
  { key: "plan", label: "Month plan approved", w: 10 },
  { key: "api", label: "Developer app + API access", w: 15 },
  { key: "oauth", label: "OAuth connected to Elettro OS", w: 15 },
  { key: "test", label: "First test post via API", w: 10 },
  { key: "live", label: "Auto-publishing + metrics live", w: 10 }
];

export const DESTINATIONS = ["youtube", "instagram", "facebook", "tiktok", "x", "linkedin", "threads", "pinterest", "gmb", "reddit"];

// One developer app per platform family, shared by every brand (app review happens once).
export const PLATFORM_APP = { instagram: "meta", facebook: "meta", threads: "meta", youtube: "google", gmb: "google" };
export const appOf = (destination) => PLATFORM_APP[destination] || destination;

const MIN_READY_ASSETS = 30;
const LIVE_WINDOW_DAYS = 7;
const CACHE_MS = 60_000;

export function scoreOf(done) {
  return Math.round(CHECKPOINTS.reduce((sum, c) => sum + c.w * Math.max(0, Math.min(1, done[c.key] || 0)), 0));
}

// Pure: facts in, checkpoints out. Manual milestones fill only what the data can't prove.
export function profileStatus(facts, now = new Date()) {
  const m = facts.milestones || {};
  const liveSince = new Date(now.getTime() - LIVE_WINDOW_DAYS * 86_400_000);
  const done = {
    strategy: facts.hasPlaybook ? 1 : 0,
    account: facts.accountName ? 1 : m.account || 0,
    planner: facts.postsPerWeek > 0 ? 1 : 0,
    content: facts.readyAssets >= MIN_READY_ASSETS ? 1 : facts.readyAssets > 0 ? 0.5 : 0,
    copy: facts.captionedPosts > 0 ? 1 : 0,
    plan: facts.approvedPosts > 0 ? 1 : 0,
    // A linked channel/page proves the app works in testing mode; full api credit still needs the platform's review milestone.
    api: Math.max(m.api || 0, facts.connected ? 0.5 : 0),
    oauth: facts.connected ? 1 : m.oauth || 0,
    test: facts.apiPublishCount > 0 ? 1 : 0,
    live: facts.publishingMode === "auto" && facts.lastApiPublishAt && new Date(facts.lastApiPublishAt) >= liveSince ? 1 : 0
  };
  return { done, pct: scoreOf(done) };
}

export function playbookDestinations(brandSlug, root = defaultIntelligenceRoot()) {
  const file = join(root, "brands", brandSlug, "platforms.md");
  if (!existsSync(file)) return new Set();
  return new Set([...readFileSync(file, "utf8").matchAll(/^## \[([a-z]+)\]/gm)].map((match) => match[1]));
}

export async function ensureMilestoneTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "PlatformMilestone" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "brandId" UUID REFERENCES "Brand"("id") ON DELETE CASCADE,
      "destination" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "value" NUMERIC NOT NULL DEFAULT 0,
      "note" TEXT,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "PlatformMilestone_scope_key"
    ON "PlatformMilestone"(COALESCE("brandId", '00000000-0000-0000-0000-000000000000'::uuid), "destination", "key")`);
}

// Networks without refresh tokens (LinkedIn members, Meta long-lived tokens) expire; the feed carries the
// date so Elettro OS can count down and remind Dean to reconnect in time.
// ALTER locks the table even when the column exists, so run it once per Lambda container.
let tokenExpiryColumnReady = false;
export async function ensureTokenExpiryColumn(client) {
  if (tokenExpiryColumnReady) return;
  await client.query('ALTER TABLE "SocialAccount" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP(3)');
  tokenExpiryColumnReady = true;
}

async function loadBrandFacts(client, brand, root) {
  const playbook = playbookDestinations(brand.slug, root);
  const accounts = (await client.query(
    `SELECT sa."id", sa."destination", sa."accountName", sa."publishingMode", sa."externalAccountId", sa."tokenExpiresAt",
            COALESCE((SELECT SUM(cr."postsPerWeek") FROM "CadenceRule" cr WHERE cr."socialAccountId" = sa."id" AND cr."active"), 0)::int AS "postsPerWeek",
            (SELECT COUNT(*) FROM "ScheduledPost" sp WHERE sp."socialAccountId" = sa."id" AND sp."generatedCaption" IS NOT NULL)::int AS "captionedPosts",
            (SELECT COUNT(*) FROM "ScheduledPost" sp WHERE sp."socialAccountId" = sa."id" AND sp."status" IN ('approved','queued','publishing','processing','published'))::int AS "approvedPosts",
            (SELECT COUNT(*) FROM "PublicationLedger" pl WHERE pl."socialAccountId" = sa."id" AND pl."method" = 'api')::int AS "apiPublishCount",
            (SELECT MAX(pl."publishedAt") FROM "PublicationLedger" pl WHERE pl."socialAccountId" = sa."id" AND pl."method" = 'api') AS "lastApiPublishAt"
       FROM "SocialAccount" sa WHERE sa."brandId" = $1 AND sa."status" = 'active'`, [brand.id])).rows;
  const ready = (await client.query(
    `SELECT d AS "destination", COUNT(*)::int AS n
       FROM "Asset" a CROSS JOIN LATERAL unnest(CASE WHEN cardinality(a."allowedDestinations") = 0 THEN $2::text[] ELSE a."allowedDestinations" END) d
      WHERE a."brandId" = $1 AND a."approvalStatus" = 'approved' AND a."ingestStatus" = 'ready' AND a."retiredAt" IS NULL
      GROUP BY d`, [brand.id, DESTINATIONS])).rows;
  const readyBy = Object.fromEntries(ready.map((r) => [r.destination, r.n]));
  const milestones = (await client.query(
    `SELECT "brandId", "destination", "key", "value"::float AS "value", "note" FROM "PlatformMilestone"
      WHERE "brandId" = $1 OR "brandId" IS NULL`, [brand.id])).rows;

  return DESTINATIONS.map((destination) => {
    const account = accounts.find((a) => a.destination === destination) || {};
    const mine = {};
    const notes = [];
    for (const row of milestones) {
      // System rows are keyed by platform app (meta, google...), brand rows by destination.
      const applies = row.brandId ? row.destination === destination : row.destination === appOf(destination);
      if (!applies) continue;
      mine[row.key] = Math.max(mine[row.key] || 0, row.value);
      if (row.note) notes.push(row.note);
    }
    const facts = {
      hasPlaybook: playbook.has(destination), accountName: account.accountName || null,
      connected: Boolean(account.externalAccountId),
      postsPerWeek: account.postsPerWeek || 0, readyAssets: readyBy[destination] || 0,
      captionedPosts: account.captionedPosts || 0, approvedPosts: account.approvedPosts || 0,
      apiPublishCount: account.apiPublishCount || 0, lastApiPublishAt: account.lastApiPublishAt || null,
      publishingMode: account.publishingMode || "handoff", milestones: mine
    };
    const tokenExpiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).toISOString() : null;
    return { destination, handle: facts.accountName, publishingMode: facts.publishingMode, readyAssets: facts.readyAssets,
      tokenExpiresAt, ...profileStatus(facts), note: notes.join(" ") || null };
  });
}

let cache = null;

export async function connectionStatusFeed(connectDatabase, { root = defaultIntelligenceRoot(), now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_MS) return cache.body;
  const client = await connectDatabase();
  try {
    await ensureMilestoneTable(client);
    await ensureTokenExpiryColumn(client);
    const brands = (await client.query(`SELECT "id", "slug", "name" FROM "Brand" WHERE "status" = 'active' AND "slug" <> $1 ORDER BY "name"`, [LIBRARY_SLUG])).rows;
    const out = [];
    for (const brand of brands) {
      const profiles = await loadBrandFacts(client, brand, root);
      out.push({ slug: brand.slug, name: brand.name, pct: Math.round(profiles.reduce((s, p) => s + p.pct, 0) / profiles.length), profiles });
    }
    const body = { ok: true, generatedAt: new Date(now).toISOString(), refreshSeconds: CACHE_MS / 1000, checkpoints: CHECKPOINTS, brands: out };
    cache = { at: now, body };
    return body;
  } finally {
    try { await client.end(); } catch {}
  }
}

export function feedResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60"
    },
    body: JSON.stringify(body)
  };
}

export async function handleConnectionStatus(connectDatabase) {
  try {
    return feedResponse(200, await connectionStatusFeed(connectDatabase));
  } catch (error) {
    console.error("[connection-status] failed", error);
    return feedResponse(500, { ok: false, error: "Status feed unavailable" });
  }
}

// IAM-only. System milestone: { destination: "meta"|"google"|"tiktok"|..., key: "api", value }.
// Brand milestone: { brand: "stashbox", destination: "instagram", key: "oauth", value }.
export async function setPlatformMilestone(event, connectDatabase, json) {
  const key = String(event.key || "");
  const destination = String(event.destination || "").toLowerCase();
  const value = Number(event.value);
  if (!CHECKPOINTS.some((c) => c.key === key) || !destination || !(value >= 0 && value <= 1)) {
    return json(400, { ok: false, error: "Need key (a checkpoint), destination and value 0..1" });
  }
  const client = await connectDatabase();
  try {
    await ensureMilestoneTable(client);
    let brandId = null;
    if (event.brand) {
      brandId = (await client.query(`SELECT "id" FROM "Brand" WHERE "slug" = $1 LIMIT 1`, [event.brand])).rows[0]?.id;
      if (!brandId) return json(404, { ok: false, error: "Brand not found" });
    }
    await client.query(
      `INSERT INTO "PlatformMilestone" ("brandId","destination","key","value","note","updatedAt")
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (COALESCE("brandId", '00000000-0000-0000-0000-000000000000'::uuid), "destination", "key")
       DO UPDATE SET "value" = EXCLUDED."value", "note" = EXCLUDED."note", "updatedAt" = CURRENT_TIMESTAMP`,
      [brandId, destination, key, value, event.note ? String(event.note) : null]);
    cache = null;
    return json(200, { ok: true, brand: event.brand || null, destination, key, value });
  } finally {
    try { await client.end(); } catch {}
  }
}
