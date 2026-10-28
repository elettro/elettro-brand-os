/**
 * AR admin API. `createApp` takes its dependencies (store, files, cdn, config) so tests run with fakes;
 * `adapters.mjs` provides the real DynamoDB / S3 / CloudFront versions.
 *
 * Every route needs the connect key except the two public count routes (POST /ar/event, GET /ar/stats). Writes (other than the entitlement switch) are refused for brands that
 * don't have AR enabled. Slugs for sets and QR codes are never reused after deletion (tombstones).
 */
import { gate } from "./api-gate.mjs";
import * as v from "./validate.mjs";
import { HttpError, newId } from "./validate.mjs";
import { brandManifestKey, setManifestKey, buildBrandManifest, buildSetManifest, stubManifest } from "./manifest.mjs";
import { createStats } from "./stats.mjs";

const COLLECTIONS = {
  triggers: { prefix: "TRIGGER#", validate: v.trigger },
  actions: { prefix: "ACTION#", validate: v.action },
  rules: { prefix: "RULE#", validate: v.rule },
  sets: { prefix: "SET#", validate: v.set, slugged: true },
  qrs: { prefix: "QR#", validate: v.qr, slugged: true }
};

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
const strip = (item) => {
  const { PK, SK, ...rest } = item; // eslint-disable-line no-unused-vars
  return rest;
};
const actorOf = (event) => String(event?.headers?.["x-elettro-actor"] ?? event?.headers?.["X-Elettro-Actor"] ?? "").slice(0, 120);

// The cover compiler pulls in sharp, so it loads only when a cover is actually compiled.
const defaultCompile = async (input) => (await import("./compile.mjs")).compileTarget(input);

const slugOf = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "cover";

export function createApp({ store, files, cdn, config, compile = defaultCompile }) {
  const stats = createStats({ store, files, now: () => (config.now ? config.now() : new Date()) });
  const baseUrl = config.publicBaseUrl.replace(/\/$/, "");
  const now = () => (config.now ? config.now() : new Date());

  async function load(brand) {
    const items = await store.list(brand);
    const by = (prefix) => items.filter((i) => i.SK.startsWith(prefix)).map(strip);
    const ent = items.find((i) => i.SK === "ENTITLEMENT");
    return {
      items,
      entitlement: ent ? strip(ent) : { arEnabled: false },
      triggers: by("TRIGGER#"),
      actions: by("ACTION#"),
      rules: by("RULE#"),
      sets: by("SET#"),
      qrs: by("QR#")
    };
  }

  const requireEnabled = (data) => {
    if (!data.entitlement.arEnabled) throw new HttpError(403, "AR is not enabled for this brand");
  };

  // Media keys must live under this brand's own folder.
  const ownBrandKey = (brand, key) => {
    if (key && !key.startsWith(`${brand}/`)) throw new HttpError(400, `storage key must start with "${brand}/"`);
  };
  function checkKeys(brand, body) {
    ownBrandKey(brand, body.imageKey);
    ownBrandKey(brand, body.videoKey);
    ownBrandKey(brand, body.target?.luminanceKey);
    for (const k of Array.isArray(body.imageKeys) ? body.imageKeys : []) ownBrandKey(brand, k);
    for (const it of Array.isArray(body.items) ? body.items : []) ownBrandKey(brand, it?.imageKey);
  }

  async function republishIndex(brand) {
    const d = await load(brand);
    const manifest = buildBrandManifest({ brand, enabled: !!d.entitlement.arEnabled, qrs: d.qrs, sets: d.sets, actions: d.actions, baseUrl, now: now() });
    await files.putJson(brandManifestKey(brand), manifest);
    await cdn.invalidate([`/${brandManifestKey(brand)}`]);
    return manifest;
  }

  async function checkReferences(coll, data, d) {
    const has = (list, id) => list.some((x) => x.id === id);
    if (coll === "rules") {
      if (!has(d.triggers, data.triggerId)) throw new HttpError(400, "triggerId does not exist");
      for (const a of data.actionIds) if (!has(d.actions, a)) throw new HttpError(400, `action ${a} does not exist`);
    }
    if (coll === "sets") for (const t of data.triggerIds) if (!has(d.triggers, t)) throw new HttpError(400, `trigger ${t} does not exist`);
    if (coll === "qrs") {
      if (data.mode === "scanner" && !has(d.sets, data.setId)) throw new HttpError(400, "setId does not exist");
      if (data.mode === "experience" && !has(d.actions, data.actionId)) throw new HttpError(400, "actionId does not exist");
    }
  }

  async function create(brand, coll, body, event) {
    const d = await load(brand);
    requireEnabled(d);
    const def = COLLECTIONS[coll];
    checkKeys(brand, body);
    const data = def.validate(body);
    await checkReferences(coll, data, d);
    if (def.slugged) {
      const taken = d.items.some((i) => i.SK === `SLUG#${coll}#${data.slug}`);
      if (taken) throw new HttpError(409, `${coll === "qrs" ? "QR" : "set"} slug "${data.slug}" is taken (slugs are never reused)`);
    }
    const id = newId();
    const stamp = now().toISOString();
    const item = { id, ...data, createdAt: stamp, updatedAt: stamp };
    if (def.slugged) await store.put(brand, `SLUG#${coll}#${data.slug}`, { id, slug: data.slug });
    await store.put(brand, `${def.prefix}${id}`, item);
    if (coll === "qrs") await afterQrWrite(brand, item, d, event, "created");
    return item;
  }

  async function update(brand, coll, id, body, event) {
    const d = await load(brand);
    requireEnabled(d);
    const def = COLLECTIONS[coll];
    const existing = d[coll].find((x) => x.id === id);
    if (!existing) throw new HttpError(404, "not found");
    checkKeys(brand, body);
    const merged = def.validate({ ...body, slug: existing.slug }, existing); // slugs are immutable
    await checkReferences(coll, merged, d);
    const item = { ...existing, ...merged, id, updatedAt: now().toISOString() };
    await store.put(brand, `${def.prefix}${id}`, item);
    if (coll === "qrs") await afterQrWrite(brand, item, d, event, "updated");
    return item;
  }

  // Only one QR per brand is "main"; every QR change is logged and the brand manifest is rewritten.
  async function afterQrWrite(brand, item, d, event, what) {
    if (item.isMain) {
      for (const other of d.qrs.filter((q) => q.id !== item.id && q.isMain)) {
        await store.put(brand, `QR#${other.id}`, { ...other, isMain: false, updatedAt: now().toISOString() });
      }
    }
    await store.put(brand, `QRLOG#${now().toISOString()}#${newId()}`, { qrId: item.id, slug: item.slug, what, by: actorOf(event), after: strip(item) });
    await republishIndex(brand);
  }

  async function remove(brand, coll, id) {
    const d = await load(brand);
    requireEnabled(d);
    const def = COLLECTIONS[coll];
    const existing = d[coll].find((x) => x.id === id);
    if (!existing) throw new HttpError(404, "not found");
    if (coll === "actions") {
      const usedBy = d.rules.some((r) => r.actionIds.includes(id)) || d.qrs.some((q) => q.actionId === id);
      if (usedBy) throw new HttpError(409, "this action is still used by a rule or a QR code");
    }
    if (coll === "sets" && d.qrs.some((q) => q.setId === id)) throw new HttpError(409, "this set is still used by a QR code");
    if (coll === "triggers") {
      for (const r of d.rules.filter((r) => r.triggerId === id)) await store.del(brand, `RULE#${r.id}`);
      for (const s of d.sets.filter((s) => s.triggerIds.includes(id))) {
        await store.put(brand, `SET#${s.id}`, { ...s, triggerIds: s.triggerIds.filter((t) => t !== id), updatedAt: now().toISOString() });
      }
    }
    await store.del(brand, `${def.prefix}${id}`);
    if (coll === "qrs") await republishIndex(brand);
    return { ok: true };
  }

  async function setEntitlement(brand, body, event) {
    if (typeof body.arEnabled !== "boolean") throw new HttpError(400, "arEnabled must be true or false");
    const prev = (await store.get(brand, "ENTITLEMENT")) || {};
    const ent = {
      arEnabled: body.arEnabled,
      plan: body.plan ? v.text(body.plan, "plan", { max: 40 }) : prev.plan || "standard",
      enabledAt: body.arEnabled ? prev.enabledAt || now().toISOString() : prev.enabledAt,
      enabledBy: body.arEnabled ? prev.enabledBy || actorOf(event) : prev.enabledBy,
      updatedAt: now().toISOString()
    };
    await store.put(brand, "ENTITLEMENT", ent);
    await republishIndex(brand);
    return ent;
  }

  async function upload(brand, body) {
    const d = await load(brand);
    requireEnabled(d);
    const req = v.uploadRequest(body);
    const key = `${brand}/${req.folder}/${newId()}.${req.ext}`;
    const signed = await files.presignPut({ key, contentType: req.contentType, maxBytes: req.max });
    return { key, url: signed.url, method: "PUT", headers: { "content-type": req.contentType }, maxBytes: req.max, publicUrl: `${baseUrl}/${key}` };
  }

  // Cover image (already uploaded with POST .../uploads, kind "image") -> tracking files + a draft trigger that can scan.
  async function compileTrigger(brand, body, event) {
    const d = await load(brand);
    requireEnabled(d);
    const name = v.text(body.name, "name");
    if (typeof body.imageKey !== "string" || !body.imageKey) throw new HttpError(400, "imageKey is required (upload the cover first)");
    ownBrandKey(brand, body.imageKey);
    const head = await files.head(body.imageKey);
    if (!head) throw new HttpError(404, "that cover was never uploaded");
    if (head.size > v.LIMITS.imageBytes) throw new HttpError(413, "that cover is too large");
    let crop;
    if (body.crop != null) {
      const c = body.crop;
      crop = { left: Number(c?.left), top: Number(c?.top), width: Number(c?.width), height: Number(c?.height) };
    }
    const targetName = `${slugOf(name)}-${newId().slice(0, 6)}`;
    const result = await compile({ buffer: await files.getBuffer(body.imageKey), name: targetName, crop });
    const base = `${brand}/targets/${targetName}`;
    await Promise.all([
      files.putBuffer(`${base}_luminance.jpg`, result.files.luminance, "image/jpeg"),
      files.putBuffer(`${base}_thumbnail.jpg`, result.files.thumbnail, "image/jpeg"),
      files.putBuffer(`${base}_cropped.jpg`, result.files.cropped, "image/jpeg")
    ]);
    const item = await create(brand, "triggers", {
      name, status: "draft", imageKey: body.imageKey, placement: body.placement,
      target: { name: targetName, luminanceKey: `${base}_luminance.jpg`, json: result.json }
    }, event);
    return { item, crop: result.crop, source: result.source };
  }

  async function publishSet(brand, setId) {
    const d = await load(brand);
    requireEnabled(d);
    const set = d.sets.find((s) => s.id === setId);
    if (!set) throw new HttpError(404, "set not found");
    const { manifest, problems } = buildSetManifest({ brand, set, triggers: d.triggers, rules: d.rules, actions: d.actions, baseUrl, now: now() });
    // The files must really be in the bucket, and videos must be MP4 under the size cap.
    const usedTriggers = d.triggers.filter((t) => set.triggerIds.includes(t.id));
    for (const t of usedTriggers) {
      if (t.target && !(await files.head(t.target.luminanceKey))) problems.push(`trigger "${t.name}": tracking image was never uploaded`);
    }
    const usedVideos = new Set(d.rules.filter((r) => set.triggerIds.includes(r.triggerId)).flatMap((r) => r.actionIds));
    for (const a of d.actions.filter((a) => usedVideos.has(a.id) && a.type === "video")) {
      const h = await files.head(a.videoKey);
      if (!h) problems.push(`video "${a.name}" was never uploaded`);
      else if (h.contentType && h.contentType !== "video/mp4") problems.push(`video "${a.name}" is not an MP4`);
      else if (h.size > v.LIMITS.videoBytes) problems.push(`video "${a.name}" is too large`);
    }
    const picture = async (key, what) => { if (key && !(await files.head(key))) problems.push(`${what} was never uploaded`); };
    for (const a of d.actions.filter((a) => usedVideos.has(a.id))) {
      for (const k of a.type === "gallery" ? a.imageKeys : []) await picture(k, `gallery "${a.name}" picture`);
      for (const it of a.type === "card" ? a.items : []) await picture(it.imageKey, `card "${a.name}" picture`);
    }
    if (problems.length) throw Object.assign(new HttpError(422, "set is not ready to publish"), { problems });
    const key = setManifestKey(brand, set.slug);
    await files.putJson(key, manifest);
    await republishIndex(brand);
    await cdn.invalidate([`/${key}`]);
    return { ok: true, manifestUrl: `${baseUrl}/${key}`, triggers: manifest.triggers.length };
  }

  async function handle(event) {
    try {
      // Two public routes, counts only (see stats.mjs): record a scan or tap, and read the totals. Everything else needs the connect key.
      const rawMethod = event?.requestContext?.http?.method || event?.httpMethod || "GET";
      const rawPath = (event.rawPath || event.path || "/").replace(/\/+$/, "") || "/";
      if (rawPath === "/ar/stats" && rawMethod === "GET") {
        return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=30" }, body: JSON.stringify(await stats.read()) };
      }
      if (rawPath === "/ar/event" && rawMethod === "POST") {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
        if (raw.length > 600) throw new HttpError(413, "event too large");
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "body must be JSON"); }
        await stats.record(parsed);
        return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
      }
      const denied = gate(event, json, config.apiKey);
      if (denied) return denied;
      const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
      if (method === "OPTIONS") return { statusCode: 204, headers: {}, body: "" };
      const path = (event.rawPath || event.path || "/").replace(/\/+$/, "") || "/";
      let body = {};
      if (event.body) {
        try {
          body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
        } catch {
          throw new HttpError(400, "body must be JSON");
        }
      }
      const seg = path.split("/").filter(Boolean); // ["ar","brands",":brand",...]
      if (seg[0] !== "ar") throw new HttpError(404, "not found");
      if (seg[1] === "health" && method === "GET") return json(200, { ok: true, service: "elettro-ar-api" });
      if (seg[1] !== "brands" || !seg[2]) throw new HttpError(404, "not found");
      const brand = v.slug(seg[2], "brand");
      const rest = seg.slice(3);

      if (!rest.length && method === "GET") {
        const d = await load(brand);
        return json(200, { ok: true, brand, entitlement: d.entitlement, triggers: d.triggers, actions: d.actions, rules: d.rules, sets: d.sets, qrs: d.qrs });
      }
      if (rest[0] === "entitlement" && method === "PUT") return json(200, { ok: true, entitlement: await setEntitlement(brand, body, event) });
      if (rest[0] === "uploads" && method === "POST") return json(200, { ok: true, ...(await upload(brand, body)) });

      if (rest[0] === "sets" && rest[2] === "publish" && method === "POST") return json(200, await publishSet(brand, rest[1]));

      if (rest[0] === "triggers" && rest[1] === "compile" && rest.length === 2 && method === "POST") return json(201, { ok: true, ...(await compileTrigger(brand, body, event)) });

      if (COLLECTIONS[rest[0]]) {
        const coll = rest[0];
        if (rest.length === 1 && method === "POST") return json(201, { ok: true, item: await create(brand, coll, body, event) });
        if (rest.length === 2 && method === "PATCH") return json(200, { ok: true, item: await update(brand, coll, rest[1], body, event) });
        if (rest.length === 2 && method === "DELETE") return json(200, await remove(brand, coll, rest[1]));
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { ok: false, error: e.message, ...(e.problems ? { problems: e.problems } : {}) });
      console.error("ar-api error", e);
      return json(500, { ok: false, error: "Internal error" });
    }
  }

  return { handle, stubManifest };
}
