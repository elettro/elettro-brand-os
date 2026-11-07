/**
 * Tracked links (2026-11-07, Stashbox first; runbook docs/admin/link-tracking.md).
 *
 * When a publisher claims a post, a link to one of the brand's own sites (the Shopify store, the website) gets a code:
 *   - caption networks (Threads, Bluesky, Mastodon, Facebook, YouTube, LinkedIn): the link in the caption becomes the
 *     brand's short link, https://<host>/<code>, which counts the click and forwards to the real page;
 *   - Pinterest and GMB (they distrust redirects, and GMB's SHOP button must point at /products/…): the real link keeps
 *     its address and only gains ?eo=<code>&utm_… so the store still knows which post sent the visitor.
 * Either way the store's Shopify custom pixel reports page / product / cart / checkout / purchase events with that code.
 *
 * Counts only: no IP address, no user agent and nothing about a person is stored. Link-preview robots (Mastodon servers,
 * Facebook, Slack, Bluesky cards …) are counted as `preview`, never as a click.
 *
 * Everything here is best effort: a tracking failure never stops a post from publishing.
 */
import { randomInt } from "node:crypto";

// No 0/O, 1/l/I: a code may be read aloud or retyped.
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 7;
export const CODE_PATTERN = /^[2-9a-km-zA-HJ-NP-Z]{7}$/;

// The link stays the store's own address on these networks (see the header).
export const DIRECT_LINK_DESTINATIONS = new Set(["pinterest", "gmb"]);
// Store events the pixel may report, in funnel order. `click` and `preview` come from the short link itself.
export const PIXEL_KINDS = ["page_view", "product_view", "add_to_cart", "checkout_started", "purchase"];
export const FUNNEL_KINDS = ["click", ...PIXEL_KINDS];

const BOT_UA = /bot|crawl|spider|preview|facebookexternalhit|meta-externalagent|slack|discord|telegram|whatsapp|skype|embedly|mastodon|pleroma|misskey|akkoma|bluesky|cardyb|headless|python|curl|wget|go-http|node-fetch|axios|okhttp|java\/|libwww|httpclient|vkshare|pinterest|linkedin|tumblr|redditbot|applebot|google-inspectiontool|bingpreview/i;

export function newCode(random = randomInt) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[random(ALPHABET.length)];
  return code;
}

export function isBot(userAgent) {
  const ua = String(userAgent || "");
  return !ua.trim() || BOT_UA.test(ua);
}

const originOf = (url) => { try { return new URL(String(url)).origin.toLowerCase(); } catch { return null; } };
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; } };

/**
 * The brand's tracking setup from Brand.settings, or null when it is off.
 * `origins` are the sites whose links get tracked; unset, the planner's store and website links.
 */
export function trackingConfig(rawSettings) {
  const t = rawSettings?.linkTracking;
  if (!t || t.enabled !== true) return null;
  const host = String(t.host || "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const links = rawSettings?.planner?.links || {};
  const listed = Array.isArray(t.origins) && t.origins.length ? t.origins : [links.merchStore, links.site];
  const origins = [...new Set(listed.map(originOf).filter(Boolean))];
  return origins.length ? { host, origins } : null;
}

// A URL in running text, minus the punctuation that usually ends a sentence after it.
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
const trimUrl = (u) => u.replace(/[).,!?:;'"\]]+$/, "");

/** The real address a tracked link sends people to: the page plus ?eo=<code> and the utm_ fields Shopify keeps on an order. */
export function taggedUrl(url, { code, destination, campaign }) {
  const u = new URL(url);
  u.searchParams.set("eo", code);
  u.searchParams.set("utm_source", destination || "social");
  u.searchParams.set("utm_medium", "social");
  if (campaign) u.searchParams.set("utm_campaign", String(campaign).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60));
  u.searchParams.set("utm_content", code);
  return u.toString();
}

/**
 * Pure: what tracking does to one claimed post. Returns null when there is nothing to track,
 * else { targetUrl, caption?, primaryLink?, gmbUrl?, shortUrl? } — the fields that change.
 */
export function planPostLink(post, config, code) {
  if (!config || !post) return null;
  const owned = (url) => config.origins.includes(originOf(url));
  const already = (url) => hostOf(url) === config.host || /[?&]eo=/.test(String(url));
  const campaign = post.sector || post.placement || null;

  if (post.destination === "gmb") {
    const url = post.gmb?.cta?.url;
    if (!url || !owned(url) || already(url)) return null;
    return { targetUrl: url, gmbUrl: taggedUrl(url, { code, destination: "gmb", campaign }) };
  }
  if (DIRECT_LINK_DESTINATIONS.has(post.destination)) {
    const url = post.primaryLink;
    if (!url || !owned(url) || already(url)) return null;
    const tagged = taggedUrl(url, { code, destination: post.destination, campaign });
    return { targetUrl: url, primaryLink: tagged };
  }
  const caption = String(post.caption || "");
  const found = (caption.match(URL_IN_TEXT) || []).map(trimUrl).find((u) => owned(u) && !already(u));
  if (!found) return null;
  const shortUrl = `https://${config.host}/${code}`;
  const nextCaption = caption.split(found).join(shortUrl);
  // Never make a caption longer than the one that was checked against the network's limit.
  if (nextCaption.length > caption.length) return null;
  return {
    targetUrl: found, shortUrl, caption: nextCaption,
    ...(post.primaryLink === found ? { primaryLink: shortUrl } : {})
  };
}

/**
 * Called by claim-due-posts for every claimed post. Mutates and returns the posts it tracked; never throws.
 * `posts` carry id, brandId, destination, placement, sector, caption, primaryLink, gmb; `rawSettingsByBrand` maps brandId → Brand.settings.
 */
export async function trackClaimedPosts(client, posts, rawSettingsByBrand, { makeCode = newCode, log = console } = {}) {
  let tracked = 0;
  for (const post of posts) {
    const config = trackingConfig(rawSettingsByBrand.get(post.brandId));
    if (!config) continue;
    try {
      // A post claimed again (one retry) keeps the code it got the first time.
      const existing = (await client.query(`SELECT "code" FROM "TrackedLink" WHERE "scheduledPostId" = $1 LIMIT 1`, [post.id])).rows[0];
      const code = existing?.code || makeCode();
      const change = planPostLink(post, config, code);
      if (!change) continue;
      if (!existing) {
        await client.query(
          `INSERT INTO "TrackedLink" ("code", "brandId", "scheduledPostId", "destination", "placement", "targetUrl", "mode")
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("code") DO NOTHING`,
          [code, post.brandId, post.id, post.destination, post.placement || null, change.targetUrl, change.shortUrl ? "short" : "direct"]);
      }
      const tracking = { code, mode: change.shortUrl ? "short" : "direct", targetUrl: change.targetUrl, ...(change.shortUrl ? { shortUrl: change.shortUrl } : {}) };
      await client.query(
        `UPDATE "ScheduledPost" SET
           "generatedCaption" = COALESCE($2, "generatedCaption"),
           "scoreBreakdown" = jsonb_set(
             CASE WHEN $4::text IS NULL THEN COALESCE("scoreBreakdown", '{}'::jsonb)
                  ELSE jsonb_set(COALESCE("scoreBreakdown", '{}'::jsonb), '{gmb,cta,url}', to_jsonb($4::text), false) END,
             '{tracking}', $3::jsonb, true),
           "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1`,
        [post.id, change.caption ?? null, JSON.stringify(tracking), change.gmbUrl ?? null]);
      if (change.caption !== undefined) post.caption = change.caption;
      if (change.primaryLink !== undefined) post.primaryLink = change.primaryLink;
      if (change.gmbUrl) post.gmb = { ...post.gmb, cta: { ...post.gmb.cta, url: change.gmbUrl } };
      post.trackingCode = code;
      tracked++;
    } catch (error) {
      log.error?.("[link-tracking] skipped a post", post.id, error instanceof Error ? error.message : error);
    }
  }
  return tracked;
}

// ---------- HTTP: POST /links (shared connect key; called by the web app's /api/l and /api/link-events) ----------

const cleanText = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function handleLinks(body, connectDatabase, json) {
  const action = body?.action;
  if (!["click", "event", "stats"].includes(action)) return json(400, { ok: false, error: "Unknown action" });
  let client;
  try {
    client = await connectDatabase();
    if (action === "click") return json(...await recordClick(client, body));
    if (action === "event") return json(...await recordEvent(client, body));
    return json(...await linkStats(client, body));
  } catch (error) {
    console.error("[links] failed", action, error);
    return json(500, { ok: false, error: "Link tracking failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

/** A short link was opened: count it (or a preview robot) and answer where to send the visitor. */
export async function recordClick(client, body) {
  const code = String(body?.code || "");
  if (!CODE_PATTERN.test(code)) return [404, { ok: false, error: "Unknown link" }];
  const link = (await client.query(
    `SELECT tl."id", tl."brandId", tl."destination", tl."targetUrl", sp."scoreBreakdown"->>'sector' AS "sector", sp."placement"
     FROM "TrackedLink" tl LEFT JOIN "ScheduledPost" sp ON sp."id" = tl."scheduledPostId" WHERE tl."code" = $1`, [code])).rows[0];
  if (!link) return [404, { ok: false, error: "Unknown link" }];
  const kind = isBot(body?.userAgent) ? "preview" : "click";
  await client.query(
    `INSERT INTO "LinkEvent" ("linkId", "brandId", "kind", "referrerHost") VALUES ($1, $2, $3, $4)`,
    [link.id, link.brandId, kind, hostOf(body?.referrer)]);
  return [200, { ok: true, kind, location: taggedUrl(link.targetUrl, { code, destination: link.destination, campaign: link.sector || link.placement }) }];
}

/** A store event from the Shopify pixel. Unknown codes are ignored; the pixel's event id stops double counting. */
export async function recordEvent(client, body) {
  const code = String(body?.code || "");
  const kind = String(body?.kind || "");
  if (!CODE_PATTERN.test(code) || !PIXEL_KINDS.includes(kind)) return [400, { ok: false, error: "Bad event" }];
  const link = (await client.query(`SELECT "id", "brandId" FROM "TrackedLink" WHERE "code" = $1`, [code])).rows[0];
  if (!link) return [202, { ok: true, ignored: "unknown code" }];
  const value = Number(body?.value);
  const amount = Number.isFinite(value) && value >= 0 && value < 1e6 ? Math.round(value * 100) / 100 : null;
  const currency = /^[A-Z]{3}$/.test(String(body?.currency || "")) ? body.currency : null;
  const result = await client.query(
    `INSERT INTO "LinkEvent" ("linkId", "brandId", "kind", "product", "value", "currency", "eventKey")
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("eventKey") DO NOTHING`,
    [link.id, link.brandId, kind, cleanText(body?.product, 200), amount, currency, cleanText(body?.eventId, 120)]);
  return [200, { ok: true, recorded: result.rowCount === 1 }];
}

/** Per-post funnel for one brand over a date range (newest posts first). */
export async function linkStats(client, body) {
  const slug = String(body?.brandSlug || "");
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return [400, { ok: false, error: "brandSlug is required" }];
  const days = Math.min(365, Math.max(1, Number(body?.days) || 28));
  const rows = (await client.query(
    `SELECT tl."code", tl."destination", tl."placement", tl."mode", tl."targetUrl", tl."createdAt",
            sp."id" AS "postId", sp."scheduledFor", a."title" AS "assetTitle", COALESCE(a."sourcePath", a."sourceUrl") AS "assetPath",
            COUNT(e.*) FILTER (WHERE e."kind" = 'click') AS "click",
            COUNT(e.*) FILTER (WHERE e."kind" = 'preview') AS "preview",
            COUNT(e.*) FILTER (WHERE e."kind" = 'page_view') AS "page_view",
            COUNT(e.*) FILTER (WHERE e."kind" = 'product_view') AS "product_view",
            COUNT(e.*) FILTER (WHERE e."kind" = 'add_to_cart') AS "add_to_cart",
            COUNT(e.*) FILTER (WHERE e."kind" = 'checkout_started') AS "checkout_started",
            COUNT(e.*) FILTER (WHERE e."kind" = 'purchase') AS "purchase",
            COALESCE(SUM(e."value") FILTER (WHERE e."kind" = 'purchase'), 0) AS "revenue"
     FROM "TrackedLink" tl
     JOIN "Brand" b ON b."id" = tl."brandId"
     LEFT JOIN "ScheduledPost" sp ON sp."id" = tl."scheduledPostId"
     LEFT JOIN "Asset" a ON a."id" = sp."assetId"
     LEFT JOIN "LinkEvent" e ON e."linkId" = tl."id"
     WHERE b."slug" = $1 AND tl."createdAt" >= CURRENT_TIMESTAMP - make_interval(days => $2)
     GROUP BY tl."id", sp."id", a."id"
     ORDER BY tl."createdAt" DESC LIMIT 500`, [slug, days])).rows;
  const posts = rows.map((r) => ({ ...r, ...Object.fromEntries([...FUNNEL_KINDS, "preview"].map((k) => [k, Number(r[k])])), revenue: Number(r.revenue) }));
  const totals = Object.fromEntries([...FUNNEL_KINDS, "preview", "revenue"].map((k) => [k, posts.reduce((s, p) => s + p[k], 0)]));
  return [200, { ok: true, brand: slug, days, links: posts.length, totals, posts }];
}

// ---------- database setup (IAM only): setup-link-tracking-20261107 ----------

export const LINK_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "TrackedLink" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL UNIQUE,
    "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
    "scheduledPostId" UUID REFERENCES "ScheduledPost"("id") ON DELETE SET NULL,
    "destination" TEXT,
    "placement" TEXT,
    "targetUrl" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'short',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "TrackedLink_scheduledPostId_idx" ON "TrackedLink"("scheduledPostId")`,
  `CREATE INDEX IF NOT EXISTS "TrackedLink_brandId_createdAt_idx" ON "TrackedLink"("brandId","createdAt")`,
  `CREATE TABLE IF NOT EXISTS "LinkEvent" (
    "id" BIGSERIAL PRIMARY KEY,
    "linkId" UUID NOT NULL REFERENCES "TrackedLink"("id") ON DELETE CASCADE,
    "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
    "kind" TEXT NOT NULL,
    "product" TEXT,
    "value" NUMERIC(12,2),
    "currency" TEXT,
    "eventKey" TEXT UNIQUE,
    "referrerHost" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "LinkEvent_linkId_kind_idx" ON "LinkEvent"("linkId","kind")`,
  `CREATE INDEX IF NOT EXISTS "LinkEvent_brandId_createdAt_idx" ON "LinkEvent"("brandId","createdAt")`
];

/**
 * { mode?: "apply", brandSlug?, host?, origins?, enabled? } — creates the two tables, and with brandSlug + host
 * turns tracking on for that brand (Brand.settings.linkTracking). Dry run unless mode is "apply".
 */
export async function runLinkTrackingSetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const slug = event.brandSlug ? String(event.brandSlug) : null;
  const host = event.host ? String(event.host).toLowerCase() : null;
  if (slug && (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))) return json(400, { ok: false, error: "host (e.g. go.stashbox.ai) is required with brandSlug" });
  const origins = Array.isArray(event.origins) ? event.origins.map(originOf).filter(Boolean) : null;
  const setting = slug ? { enabled: event.enabled !== false, host, ...(origins?.length ? { origins } : {}) } : null;
  let client;
  try {
    client = await connectDatabase();
    const existing = (await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TrackedLink','LinkEvent')`)).rows.map((r) => r.table_name).sort();
    const brand = slug ? (await client.query(`SELECT "id", "settings" FROM "Brand" WHERE "slug" = $1`, [slug])).rows[0] : null;
    if (slug && !brand) return json(404, { ok: false, error: `No brand ${slug}` });
    const before = brand ? brand.settings?.linkTracking ?? null : undefined;
    const effective = brand ? trackingConfig({ ...brand.settings, linkTracking: setting }) : undefined;
    if (mode !== "apply") return json(200, { ok: true, mode, note: "Dry run; nothing changed", existing, statements: LINK_TABLES_SQL.length, brand: slug, before, after: setting, effective });
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    for (const sql of LINK_TABLES_SQL) await client.query(sql);
    if (brand) {
      await client.query(
        `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{linkTracking}', $2::jsonb, true), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [brand.id, JSON.stringify(setting)]);
    }
    await client.query("COMMIT");
    return json(200, { ok: true, mode, created: ["TrackedLink", "LinkEvent"].filter((t) => !existing.includes(t)), brand: slug, before, after: setting, effective });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    console.error("[link-tracking-setup] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "setup failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
