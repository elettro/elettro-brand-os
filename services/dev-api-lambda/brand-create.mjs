// Creates a brand row (DEV). IAM-invoke only; dry run unless mode:"apply". Idempotent: an existing slug is left alone.
// Event: { action: "create-brand-20261031", slug, name, timezone?, mode? }. The code lists (Dropbox roots, web brand list)
// are a separate PR step; see docs/admin/add-a-brand.md.

const SLUG = /^[a-z0-9-]{2,40}$/;

const validZone = (zone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
};

export async function createBrand(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  const slug = String(event.slug || "");
  const name = String(event.name || "").trim();
  const timezone = String(event.timezone || "America/New_York");
  if (!SLUG.test(slug)) return json(400, { ok: false, error: "slug must be 2-40 lowercase letters, digits or hyphens" });
  if (!name || name.length > 60) return json(400, { ok: false, error: "name is required (up to 60 characters)" });
  if (!validZone(timezone)) return json(400, { ok: false, error: "timezone must be an IANA name such as America/New_York" });
  let client;
  try {
    client = await connectDatabase();
    const org = (await client.query('SELECT "id" FROM "Organization" WHERE "slug" = $1 LIMIT 1', ["elettro"])).rows[0];
    if (!org) return json(409, { ok: false, error: "Organization 'elettro' not found" });
    const existing = (await client.query('SELECT "id","name","slug","timezone","status" FROM "Brand" WHERE "organizationId" = $1 AND "slug" = $2 LIMIT 1', [org.id, slug])).rows[0];
    if (existing) return json(200, { ok: true, mode, created: false, note: "Brand already exists; nothing changed", brand: existing });
    if (mode !== "apply") return json(200, { ok: true, mode, created: false, note: "Dry run; nothing changed", would: { slug, name, timezone } });
    const made = (await client.query(
      `INSERT INTO "Brand" ("organizationId","name","slug","timezone","updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
       ON CONFLICT ("organizationId","slug") DO NOTHING RETURNING "id","name","slug","timezone","status"`, [org.id, name, slug, timezone])).rows[0];
    return json(200, { ok: true, mode, created: Boolean(made), brand: made || null });
  } catch (error) {
    console.error("[create-brand] failed", error?.name, error?.message);
    return json(500, { ok: false, error: "Create brand failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}
