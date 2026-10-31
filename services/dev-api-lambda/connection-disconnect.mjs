/**
 * "Disconnect" for every network on Connections. The web app has already checked that the signed-in user may
 * manage this brand (and, for TikTok, asked TikTok to drop the grant); this route unlinks the brand's account
 * rows and takes already-approved posts for them back to "planned", so nothing is sent to an account the brand
 * no longer has linked. Tokens in Secrets Manager are left alone: they belong to the account, not the brand,
 * and reconnecting overwrites them.
 */
import { keyMatches } from "./youtube-connect.mjs";
import { ensureTokenExpiryColumn } from "./connection-status.mjs";

// The network name on the Connections page → the SocialAccount destinations it unlinks.
export const DISCONNECT_NETWORKS = {
  youtube: ["youtube"], gmb: ["gmb"], linkedin: ["linkedin"], threads: ["threads"], bluesky: ["bluesky"], tiktok: ["tiktok"],
  pinterest: ["pinterest"], meta: ["facebook", "instagram"], mastodon: ["mastodon"]
};

export async function disconnectNetwork(event, body, connectDatabase, json) {
  if (!keyMatches((event?.headers || {})["x-elettro-connect-key"])) return json(401, { ok: false, error: "Connect key required" });
  const brand = String(body?.brand || "");
  const destinations = DISCONNECT_NETWORKS[String(body?.network || "")];
  if (!/^[a-z0-9-]{2,40}$/.test(brand) || !destinations) return json(400, { ok: false, error: "brand and a known network are required" });
  let client;
  try {
    client = await connectDatabase();
    await ensureTokenExpiryColumn(client);
    const unlinked = await client.query(`
      UPDATE "SocialAccount" sa SET "externalAccountId"=NULL, "tokenExpiresAt"=NULL, "updatedAt"=CURRENT_TIMESTAMP
      FROM "Brand" b WHERE b."id"=sa."brandId" AND b."slug"=$1 AND sa."destination" = ANY($2) AND sa."externalAccountId" IS NOT NULL
      RETURNING sa."id"`, [brand, destinations]);
    // Approved but unsent: back to planned, so the brand approves them again after it reconnects.
    const held = await client.query(`
      UPDATE "ScheduledPost" sp SET "status"='planned', "updatedAt"=CURRENT_TIMESTAMP
      FROM "SocialAccount" sa, "Brand" b
      WHERE sa."id"=sp."socialAccountId" AND b."id"=sa."brandId" AND b."slug"=$1 AND sa."destination" = ANY($2) AND sp."status"='approved'
      RETURNING sp."id"`, [brand, destinations]);
    return json(200, { ok: true, brand, disconnected: unlinked.rowCount, postsHeld: held.rowCount });
  } catch (error) {
    console.error("[disconnect] failed", error?.name, error?.message);
    return json(500, { ok: false, error: "Disconnect failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

/**
 * IAM-invoke only (never HTTP). Folds duplicate connected rows of one login into one: a brand + network + handle with
 * more than one SocialAccount that has an externalAccountId (a reconnect that got a new id used to insert a second row,
 * so Review showed two blocks and the planner planned both). The keeper is the row with the newest token expiry
 * (or the `keep` id you pass); each other row hands over its cadence rules (kept as they are, or switched off where
 * the keeper already has that format) and its unsent planned/approved posts, then is unlinked. Dry run unless mode:"apply".
 * Optional filters: brand (slug), destination, keep (SocialAccount id).
 */
export async function mergeDuplicateAccounts(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    await ensureTokenExpiryColumn(client);
    const rows = (await client.query(`
      SELECT sa."id", b."slug" AS "brand", sa."destination", sa."accountName", sa."externalAccountId", sa."tokenExpiresAt", sa."updatedAt",
             (SELECT COALESCE(json_agg(json_build_object('placement', cr."placement", 'postsPerWeek', cr."postsPerWeek", 'active', cr."active")), '[]'::json)
                FROM "CadenceRule" cr WHERE cr."socialAccountId" = sa."id") AS "rules",
             (SELECT COUNT(*)::int FROM "ScheduledPost" sp WHERE sp."socialAccountId" = sa."id" AND sp."status" IN ('planned','approved')) AS "unsent"
      FROM "SocialAccount" sa JOIN "Brand" b ON b."id" = sa."brandId"
      WHERE sa."status" = 'active' AND sa."externalAccountId" IS NOT NULL
        AND ($1::text IS NULL OR b."slug" = $1) AND ($2::text IS NULL OR sa."destination" = $2)`,
      [event.brand ? String(event.brand) : null, event.destination ? String(event.destination) : null])).rows;
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.brand}|${r.destination}|${String(r.accountName || "").toLowerCase()}`;
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    const stamp = (r) => (r.tokenExpiresAt ? new Date(r.tokenExpiresAt).getTime() : 0);
    const plan = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      const ranked = [...list].sort((a, b) => stamp(b) - stamp(a) || new Date(b.updatedAt) - new Date(a.updatedAt));
      const keeper = (event.keep && list.find((r) => r.id === event.keep)) || ranked[0];
      plan.push({ group: key, keeper: keeper.id, merge: list.filter((r) => r.id !== keeper.id).map((r) => r.id), rows: list });
    }
    if (mode !== "apply" || !plan.length) return json(200, { ok: true, mode, note: mode === "apply" ? "Nothing to merge" : "Dry run; nothing changed", plan });
    const done = [];
    await client.query("BEGIN");
    try {
      for (const p of plan) {
        const keeperRules = new Set((await client.query('SELECT "placement" FROM "CadenceRule" WHERE "socialAccountId" = $1', [p.keeper])).rows.map((r) => r.placement));
        for (const loser of p.merge) {
          const moved = [], off = [];
          for (const rule of (await client.query('SELECT "id","placement" FROM "CadenceRule" WHERE "socialAccountId" = $1', [loser])).rows) {
            if (keeperRules.has(rule.placement)) { await client.query('UPDATE "CadenceRule" SET "active" = FALSE, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [rule.id]); off.push(rule.placement); }
            else { await client.query('UPDATE "CadenceRule" SET "socialAccountId" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [rule.id, p.keeper]); keeperRules.add(rule.placement); moved.push(rule.placement); }
          }
          const posts = await client.query(`UPDATE "ScheduledPost" SET "socialAccountId" = $2, "updatedAt" = CURRENT_TIMESTAMP
            WHERE "socialAccountId" = $1 AND "status" IN ('planned','approved')`, [loser, p.keeper]);
          await client.query('UPDATE "SocialAccount" SET "externalAccountId" = NULL, "tokenExpiresAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1', [loser]);
          done.push({ keeper: p.keeper, unlinked: loser, rulesMoved: moved, rulesSwitchedOff: off, postsMoved: posts.rowCount });
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    return json(200, { ok: true, mode, merged: done });
  } catch (error) {
    console.error("[merge-duplicate-accounts] failed", error?.name, error?.message);
    return json(500, { ok: false, error: "Merge failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
