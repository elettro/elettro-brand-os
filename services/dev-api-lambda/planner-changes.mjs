/**
 * Changes for next week (2026-11-08; plan: Claude Doc "How results should shape next week's posts", section 5). Owner-approved only.
 *
 * A change is proposed from a finding and does nothing until Dean approves it. Approving writes it into a numbered version of the
 * brand's planner weights (`Brand.settings.plannerWeights`: { version, boosts: [...] }); the planner adds the boost as a capped
 * "performance" part of the score (planner-v2.mjs, boostFor) and stores the weights version on every post it places. Undo writes a new
 * version without it; nothing is erased (PlannerChange keeps the history).
 *
 * This first slice proposes WINNER BOOSTS only: an asset whose shrunk 7-day (else 24-hour) lift on an account is at least 1.25x earns
 * points on that account (a rerun after its cooldown) and slightly fewer on the brand's other accounts (cross-post; cooldowns and every
 * hard rule unchanged). Two-week rule: a candidate is first stored as "watching" and only becomes "proposed" if it still qualifies at a
 * later weekly check. Pillar-share, timing and cadence changes are shown as findings, not proposed, until their own PRs.
 */
import { brandPerformance } from "./performance.mjs";

export const MAX_BOOST = 20;
export const MAX_PROPOSALS = 8;
const WINNER_LIFT = 1.25;
const MUTE_AFTER_SKIPS = 3;
const MUTE_DAYS = 30;

export const PLANNER_CHANGE_SQL = [
  `CREATE TABLE IF NOT EXISTS "PlannerChange" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "evidence" JSONB,
    "status" TEXT NOT NULL CHECK ("status" IN ('watching','proposed','approved','skipped','undone')),
    "weekKey" TEXT NOT NULL,
    "seenWeeks" INTEGER NOT NULL DEFAULT 1,
    "skips" INTEGER NOT NULL DEFAULT 0,
    "mutedUntil" TIMESTAMP(3),
    "weightsVersion" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("brandId", "key")
  )`,
  `CREATE INDEX IF NOT EXISTS "PlannerChange_brand_status_idx" ON "PlannerChange"("brandId", "status")`
];

/** ISO week key (Monday) for a date, e.g. 2026-11-09. */
export function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** 10 points per doubling of the shrunk lift, at least 1, at most MAX_BOOST; cross-post gets 80%. */
export function boostPoints(lift) {
  const points = Math.max(1, Math.min(MAX_BOOST, Math.round(10 * Math.log2(lift))));
  return { points, crossPoints: Math.max(1, Math.round(points * 0.8)) };
}

/** Winner candidates from computed performance: one per (account, asset), strongest bucket first (7d, else 24h). */
export function winnerCandidates(accounts) {
  const out = [];
  for (const acc of accounts) {
    for (const bucket of ["7d", "24h"]) {
      for (const g of acc.groups.filter((x) => x.dim === "asset" && x.bucket === bucket && x.lift >= WINNER_LIFT)) {
        const key = `winner:${acc.socialAccountId}:${g.key}`;
        if (out.some((c) => c.key === key)) continue;
        const { points, crossPoints } = boostPoints(g.lift);
        out.push({
          key, kind: "winner-boost",
          title: `Boost "${g.label}"`,
          detail: `Ran ${g.rawLift}x ${acc.account}'s normal at ${bucket} (${g.posts} post${g.posts === 1 ? "" : "s"}; counted as ${g.lift}x after shrinking). +${points} on ${acc.account} once its cooldown ends, +${crossPoints} on the brand's other accounts. Cooldowns and rules unchanged.`,
          payload: { assetId: g.key, homeAccountId: acc.socialAccountId, points, crossPoints },
          evidence: { account: acc.account, destination: acc.destination, bucket, posts: g.posts, lift: g.lift, rawLift: g.rawLift }
        });
      }
    }
  }
  return out.sort((a, b) => b.evidence.lift - a.evidence.lift);
}

/** The weights block with one boost added or removed, version bumped. */
export function withBoost(weights, change) {
  const w = weights && typeof weights === "object" ? weights : {};
  const boosts = (Array.isArray(w.boosts) ? w.boosts : []).filter((b) => b.changeId !== change.id);
  boosts.push({ changeId: change.id, ...change.payload });
  return { version: (Number(w.version) || 1) + 1, boosts };
}
export function withoutBoost(weights, changeId) {
  const w = weights && typeof weights === "object" ? weights : {};
  return { version: (Number(w.version) || 1) + 1, boosts: (Array.isArray(w.boosts) ? w.boosts : []).filter((b) => b.changeId !== changeId) };
}

/**
 * Weekly check (idempotent per week): new candidates are stored as "watching"; a "watching" one that qualifies again in a later week
 * becomes "proposed". Approved, undone and muted ones are left alone. At most MAX_PROPOSALS open proposals per brand.
 */
export async function refreshChanges(client, brand, now = new Date()) {
  const week = weekKey(now);
  const accounts = await brandPerformance(client, brand, now);
  const candidates = winnerCandidates(accounts);
  const existing = new Map((await client.query(`SELECT * FROM "PlannerChange" WHERE "brandId" = $1`, [brand.id])).rows.map((r) => [r.key, r]));
  let open = [...existing.values()].filter((r) => r.status === "proposed").length;
  const result = { week, candidates: candidates.length, watching: 0, proposed: 0 };
  for (const c of candidates) {
    const row = existing.get(c.key);
    if (!row) {
      await client.query(
        `INSERT INTO "PlannerChange" ("brandId","key","kind","title","detail","payload","evidence","status","weekKey")
         VALUES ($1,$2,$3,$4,$5,$6,$7,'watching',$8) ON CONFLICT ("brandId","key") DO NOTHING`,
        [brand.id, c.key, c.kind, c.title, c.detail, JSON.stringify(c.payload), JSON.stringify(c.evidence), week]);
      result.watching += 1;
      continue;
    }
    if (row.weekKey === week || ["approved", "undone", "proposed"].includes(row.status)) continue;
    if (row.mutedUntil && new Date(row.mutedUntil) > now) continue;
    // Seen again in a later week: it held up. Watching or skipped → proposed (skipped ones only if the finding got stronger).
    const stronger = Number(c.evidence.lift) > Number(row.evidence?.lift || 0);
    if (row.status === "skipped" && !stronger) continue;
    if (open >= MAX_PROPOSALS) continue;
    await client.query(
      `UPDATE "PlannerChange" SET "status" = 'proposed', "title" = $2, "detail" = $3, "payload" = $4, "evidence" = $5, "weekKey" = $6,
         "seenWeeks" = "seenWeeks" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [row.id, c.title, c.detail, JSON.stringify(c.payload), JSON.stringify(c.evidence), week]);
    open += 1;
    result.proposed += 1;
  }
  return result;
}

/** Review action "changes": the brand's changes (newest first) and its current weights version. */
export async function listChanges(client, brand) {
  const rows = (await client.query(
    `SELECT "id","kind","title","detail","evidence","status","weekKey","seenWeeks","skips","mutedUntil","weightsVersion","decidedAt","createdAt"
     FROM "PlannerChange" WHERE "brandId" = $1 ORDER BY CASE "status" WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 WHEN 'watching' THEN 2 ELSE 3 END, "updatedAt" DESC LIMIT 100`,
    [brand.id])).rows;
  const weights = brand.settings?.plannerWeights || {};
  return { code: 200, body: { ok: true, brand: brand.slug, weightsVersion: Number(weights.version) || 1, activeBoosts: (weights.boosts || []).length, changes: rows } };
}

/** Review action "change-decide": { id, decision: "approve" | "skip" | "undo", by? }. */
export async function decideChange(client, brand, body, now = new Date()) {
  const decision = String(body.decision || "");
  if (!["approve", "skip", "undo"].includes(decision)) return { code: 400, body: { ok: false, error: "decision must be approve, skip or undo" } };
  const by = String(body.by || "owner").slice(0, 120);
  await client.query("BEGIN");
  try {
    const row = (await client.query(`SELECT * FROM "PlannerChange" WHERE "id"::text = $1 AND "brandId" = $2 FOR UPDATE`, [String(body.id || ""), brand.id])).rows[0];
    if (!row) { await client.query("ROLLBACK"); return { code: 404, body: { ok: false, error: "Change not found" } }; }
    const allowed = { approve: ["proposed", "skipped"], skip: ["proposed"], undo: ["approved"] }[decision];
    if (!allowed.includes(row.status)) { await client.query("ROLLBACK"); return { code: 409, body: { ok: false, error: `A ${row.status} change can't be ${decision === "undo" ? "undone" : decision + "d"}` } }; }
    const settings = (await client.query(`SELECT "settings" FROM "Brand" WHERE "id" = $1 FOR UPDATE`, [brand.id])).rows[0]?.settings || {};
    let version = null;
    if (decision === "approve" || decision === "undo") {
      const weights = decision === "approve" ? withBoost(settings.plannerWeights, row) : withoutBoost(settings.plannerWeights, row.id);
      version = weights.version;
      await client.query(`UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{plannerWeights}', $2::jsonb), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        [brand.id, JSON.stringify(weights)]);
    }
    const status = { approve: "approved", skip: "skipped", undo: "undone" }[decision];
    const skips = decision === "skip" ? Number(row.skips) + 1 : Number(row.skips);
    const mutedUntil = decision === "skip" && skips >= MUTE_AFTER_SKIPS ? new Date(now.getTime() + MUTE_DAYS * 864e5).toISOString() : row.mutedUntil;
    await client.query(
      `UPDATE "PlannerChange" SET "status" = $2, "skips" = $3, "mutedUntil" = $4, "weightsVersion" = COALESCE($5, "weightsVersion"),
         "decidedAt" = CURRENT_TIMESTAMP, "decidedBy" = $6, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [row.id, status, skips, mutedUntil, version, by]);
    await client.query("COMMIT");
    return { code: 200, body: { ok: true, id: row.id, status, weightsVersion: version } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** IAM-only { mode?: "apply" }: creates PlannerChange. Dry run unless mode is "apply". */
export async function runPlannerChangesSetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const exists = (await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='PlannerChange'`)).rows.length > 0;
    if (mode !== "apply") return json(200, { ok: true, mode, tableExists: exists, statements: PLANNER_CHANGE_SQL.length });
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    for (const sql of PLANNER_CHANGE_SQL) await client.query(sql);
    await client.query("COMMIT");
    return json(200, { ok: true, mode, created: exists ? [] : ["PlannerChange"] });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    console.error("[planner-changes-setup] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "setup failed" });
  } finally {
    if (client) await client.end?.();
  }
}

/** IAM-only { brandSlug }: the weekly check by hand (the same thing the page's "Check now" button runs). */
export async function runRefreshChanges(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  let client;
  try {
    client = await connectDatabase();
    const brand = (await client.query('SELECT "id","slug","timezone","settings" FROM "Brand" WHERE "slug" = $1 LIMIT 1', [String(event.brandSlug || "")])).rows[0];
    if (!brand) return json(404, { ok: false, error: "brand not found" });
    return json(200, { ok: true, brand: brand.slug, ...(await refreshChanges(client, brand)) });
  } catch (error) {
    console.error("[planner-changes-refresh] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "refresh failed" });
  } finally {
    if (client) await client.end?.();
  }
}
