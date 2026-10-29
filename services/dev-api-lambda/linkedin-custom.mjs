/**
 * Hand-written LinkedIn posts that carry no media of their own: text posts, link posts and polls.
 * They are queued from the Review page (action "queue-custom") instead of being planned.
 *
 * Every ScheduledPost must point at an Asset, so each of these carries a "carrier" asset: the brand's most recent ready
 * image, or one the user names. The carrier is bookkeeping only for text posts and polls (nothing from it is published);
 * for a link post it is the link card's thumbnail (LinkedIn does not scrape URLs, so the thumbnail is uploaded with the post).
 * The post starts as "planned": it goes out only after the normal Approve on its card.
 */

export const CUSTOM_KINDS = ["text", "link", "poll"];
export const POLL_DURATIONS = ["ONE_DAY", "THREE_DAYS", "SEVEN_DAYS", "FOURTEEN_DAYS"];
// LinkedIn's limits: commentary 3,000; poll question 140, 2-4 options of 30; link title and description.
const LIMITS = { commentary: 3000, question: 140, option: 30, title: 200, description: 255, url: 2000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

/** Checks a request and returns the pieces to store, or throws an Error whose message is for the user. */
export function validateCustom(body, now = new Date()) {
  const kind = String(body?.kind || "");
  if (!CUSTOM_KINDS.includes(kind)) throw new Error("Choose text, link or poll");
  const text = clean(body.text);
  if (text.length > LIMITS.commentary) throw new Error(`The post text is limited to ${LIMITS.commentary} characters`);
  const at = new Date(String(body.scheduledFor || ""));
  if (Number.isNaN(at.getTime())) throw new Error("Pick a date and time");
  if (at.getTime() < now.getTime() - 3600_000 || at.getTime() > now.getTime() + 400 * 86_400_000) throw new Error("Pick a time from an hour ago to a year ahead");

  let custom;
  if (kind === "text") {
    if (!text) throw new Error("Write the post text");
    custom = { kind };
  } else if (kind === "link") {
    const url = clean(body.url);
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Enter the full link, starting with https://"); }
    if (!/^https?:$/.test(parsed.protocol) || url.length > LIMITS.url) throw new Error("Enter the full link, starting with https://");
    const title = clean(body.title);
    if (!title || title.length > LIMITS.title) throw new Error(`Give the link a title of 1-${LIMITS.title} characters`);
    const description = clean(body.description);
    if (description.length > LIMITS.description) throw new Error(`The link description is limited to ${LIMITS.description} characters`);
    custom = { kind, url: parsed.toString(), title, description };
  } else {
    const question = clean(body.question);
    if (!question || question.length > LIMITS.question) throw new Error(`The poll question needs 1-${LIMITS.question} characters`);
    const options = (Array.isArray(body.options) ? body.options : []).map(clean).filter(Boolean);
    if (options.length < 2 || options.length > 4) throw new Error("A poll needs 2 to 4 options");
    if (options.some((o) => o.length > LIMITS.option)) throw new Error(`Each poll option is limited to ${LIMITS.option} characters`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new Error("Poll options must be different");
    const duration = String(body.duration || "SEVEN_DAYS");
    if (!POLL_DURATIONS.includes(duration)) throw new Error("Pick how long the poll stays open");
    custom = { kind, question, options, duration };
  }
  return { kind, text, custom, scheduledFor: at.toISOString() };
}

/** The Review action: validates, finds the brand's LinkedIn account and a carrier image, and stores a planned post. */
export async function queueCustomPost(client, brand, body, now = new Date()) {
  let parsed;
  try { parsed = validateCustom(body, now); } catch (error) { return { code: 400, body: { ok: false, error: error.message } }; }

  const account = (await client.query(
    `SELECT "id" FROM "SocialAccount" WHERE "brandId"=$1 AND "destination"='linkedin' AND "status"='active' AND "externalAccountId" IS NOT NULL
     ORDER BY "updatedAt" DESC LIMIT 1`, [brand.id])).rows[0];
  if (!account) return { code: 409, body: { ok: false, error: "Connect this brand's LinkedIn page on Connections first" } };

  const wanted = String(body.assetId || "");
  if (wanted && !UUID.test(wanted)) return { code: 400, body: { ok: false, error: "assetId is not valid" } };
  const carrier = (await client.query(
    `SELECT "id" FROM "Asset" WHERE "brandId"=$1 AND "kind"='image' AND "approvalStatus"='approved' AND "ingestStatus"='ready' AND "retiredAt" IS NULL
       AND ($2::text = '' OR "id"::text = $2) ORDER BY "createdAt" DESC LIMIT 1`, [brand.id, wanted])).rows[0];
  if (!carrier) {
    return { code: 404, body: { ok: false, error: wanted ? "That image is not an approved, ready image of this brand" : "This brand needs at least one approved image first (it is used as the link thumbnail)" } };
  }

  const { kind, text, custom, scheduledFor } = parsed;
  const inserted = await client.query(
    `INSERT INTO "ScheduledPost" ("brandId","socialAccountId","assetId","placement","scheduledFor","status","selectionReason","scoreBreakdown",
        "publishingMode","generatedTitle","generatedCaption","generatedHashtags","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'planned',$6,$7::jsonb,'approval',$8,$9,'{}',CURRENT_TIMESTAMP) RETURNING "id"`,
    [brand.id, account.id, carrier.id, kind, scheduledFor, "Written by hand on Review",
     JSON.stringify({ manual: true, custom }), kind === "link" ? custom.title : null, text || null]);
  return { code: 200, body: { ok: true, id: inserted.rows[0].id, kind, scheduledFor, status: "planned" } };
}
