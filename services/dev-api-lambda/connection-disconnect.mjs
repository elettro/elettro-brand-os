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
  pinterest: ["pinterest"], meta: ["facebook", "instagram"], mastodon: ["mastodon"], x: ["x"]
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
