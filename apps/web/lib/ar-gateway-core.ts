// The AR tools for the AI gateway (ChatGPT / Claude Code / Claude web). Pure logic with injected I/O, so plain Node tests can run
// it with no web framework: `deps.call` talks to the AR API, `deps.fetchFile` / `deps.putFile` move cover bytes.
//
// Everything a tool writes starts as a DRAFT. Only `ar_publish_set` (public media) and `ar_set_qr` (a live printed code) change
// what visitors see, and every write needs `confirmed: true` like the other gateway mutations.

type Dict = Record<string, unknown>;

export const AR_ACTIONS = ["ar_overview", "ar_prepare_upload", "ar_add_cover", "ar_add_action", "ar_connect", "ar_add_to_set", "ar_publish_set", "ar_set_qr"] as const;
export type ArAction = (typeof AR_ACTIONS)[number];

export class ArToolError extends Error {
  status: number;
  problems?: string[];
  constructor(status: number, message: string, problems?: string[]) {
    super(message);
    this.name = "ArToolError";
    this.status = status;
    this.problems = problems;
  }
}

export type ArDeps = {
  brands: readonly string[];
  publicBase: string;
  call: <T = Dict>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  allowedFileHost: (url: URL) => boolean;
  fetchFile: (url: string, maxBytes: number) => Promise<Uint8Array>;
  putFile: (url: string, headers: Record<string, string>, bytes: Uint8Array) => Promise<void>;
};

const MAX_COVER_BYTES = 15 * 1024 * 1024;
const text = (v: unknown, what: string, max = 120): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new ArToolError(400, `Invalid ${what}`);
  return v.trim();
};
const optText = (v: unknown, what: string, max = 120): string | undefined => (v === undefined || v === null || v === "" ? undefined : text(v, what, max));
const list = (v: unknown, what: string, max = 10): string[] => {
  if (!Array.isArray(v) || !v.length || v.length > max || v.some((x) => typeof x !== "string" || !x)) throw new ArToolError(400, `${what} must be a list of 1-${max} ids`);
  return [...new Set(v as string[])];
};
const requireConfirmed = (c: Dict) => { if (c.confirmed !== true) throw new ArToolError(400, "Explicit confirmation (confirmed: true) is required"); };
const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Magic bytes decide the type, never the filename or a header the sender chose.
export function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

type Brand = { entitlement?: { arEnabled?: boolean }; triggers?: Dict[]; actions?: Dict[]; rules?: Dict[]; sets?: Dict[]; qrs?: Dict[] };

export function summarize(brand: string, doc: Brand, publicBase: string): Dict {
  const triggers = doc.triggers || [], actions = doc.actions || [], rules = doc.rules || [], sets = doc.sets || [], qrs = doc.qrs || [];
  const actionName = new Map(actions.map((a) => [a.id, a.type === "link" ? (a.label || a.name) : a.name]));
  return {
    ok: true,
    brandSlug: brand,
    arEnabled: doc.entitlement?.arEnabled === true,
    covers: triggers.map((t) => ({
      id: t.id, name: t.name, status: t.status,
      scannable: !!t.target,
      actions: rules.filter((r) => r.triggerId === t.id).flatMap((r) => (r.actionIds as string[]) || []).map((id) => ({ id, name: actionName.get(id) ?? "missing" })),
      sets: sets.filter((s) => ((s.triggerIds as string[]) || []).includes(t.id as string)).map((s) => s.name)
    })),
    actions: actions.map((a) => ({ id: a.id, name: a.name, type: a.type, ...(a.url ? { url: a.url } : {}) })),
    sets: sets.map((s) => ({ id: s.id, name: s.name, slug: s.slug, covers: ((s.triggerIds as string[]) || []).length })),
    qrs: qrs.map((q) => ({ id: q.id, name: q.name, slug: q.slug, mode: q.mode, isMain: q.isMain === true, address: q.isMain ? `${publicBase}/${brand}` : `${publicBase}/${brand}/${q.slug}`, ...(q.url ? { url: q.url } : {}) }))
  };
}

export async function executeArAction(action: string, command: Dict, deps: ArDeps): Promise<Dict> {
  const brand = text(command.brandSlug, "brandSlug", 100);
  if (!deps.brands.includes(brand)) throw new ArToolError(403, "Unknown brand");
  const path = (rest = "") => `/ar/brands/${encodeURIComponent(brand)}${rest}`;
  const get = () => deps.call<Brand>(path());

  if (action === "ar_overview") return summarize(brand, await get(), deps.publicBase);

  requireConfirmed(command);

  if (action === "ar_prepare_upload") {
    const kind = command.kind === "video" ? "video" : command.kind === "image" ? "image" : null;
    if (!kind) throw new ArToolError(400, "kind must be image or video");
    const contentType = kind === "video" ? "video/mp4" : command.contentType === "image/png" ? "image/png" : "image/jpeg";
    const r = await deps.call<{ key: string; url: string; headers: Record<string, string>; maxBytes: number }>(path("/uploads"), { method: "POST", body: { kind, contentType } });
    return { ok: true, key: r.key, uploadUrl: r.url, method: "PUT", headers: r.headers, maxBytes: r.maxBytes, expiresInMinutes: 10, next: kind === "image" ? "PUT the file to uploadUrl, then call ar_add_cover with imageKey" : "PUT the MP4 to uploadUrl, then call ar_add_action with videoKey" };
  }

  if (action === "ar_add_cover") {
    const name = text(command.name, "name");
    let imageKey = optText(command.imageKey, "imageKey", 300);
    if (!imageKey) {
      // ChatGPT path: the attached file arrives as a temporary link on an approved host.
      const file = command.file as Dict | undefined;
      if (!file || typeof file.download_url !== "string") throw new ArToolError(400, "Send either imageKey (after ar_prepare_upload) or the attached cover file");
      let url: URL;
      try { url = new URL(file.download_url); } catch { throw new ArToolError(400, "Invalid file link"); }
      if (url.protocol !== "https:" || !deps.allowedFileHost(url)) throw new ArToolError(403, "That file link is not from an approved host");
      const bytes = await deps.fetchFile(url.toString(), MAX_COVER_BYTES);
      const type = sniffImage(bytes);
      if (!type) throw new ArToolError(422, "Covers must be JPEG or PNG images");
      const up = await deps.call<{ key: string; url: string; headers: Record<string, string> }>(path("/uploads"), { method: "POST", body: { kind: "image", contentType: type } });
      await deps.putFile(up.url, up.headers, bytes);
      imageKey = up.key;
    }
    const crop = command.crop && typeof command.crop === "object" ? command.crop : undefined;
    const r = await deps.call<{ item: Dict; crop: Dict; source: Dict }>(path("/triggers/compile"), { method: "POST", body: { name, imageKey, crop } });
    return { ok: true, draft: true, cover: { id: r.item.id, name: r.item.name, status: r.item.status }, source: r.source, trackedRegion: r.crop,
      next: "Attach what it should do with ar_add_action then ar_connect; check how it lines up in the OS (AR > Experiences) and nudge placement there if needed" };
  }

  if (action === "ar_add_action") {
    const type = command.type === "video" ? "video" : command.type === "link" ? "link" : null;
    if (!type) throw new ArToolError(400, "type must be video or link");
    const name = text(command.name, "name");
    const body: Dict = type === "video"
      ? { type, name, videoKey: text(command.videoKey, "videoKey", 300), fit: ["crop", "fill", "float"].includes(command.fit as string) ? command.fit : "crop", loop: command.loop !== false }
      : { type, name, label: text(command.label ?? command.name, "label", 40), url: text(command.url, "url", 2048) };
    const r = await deps.call<{ item: Dict }>(path("/actions"), { method: "POST", body });
    return { ok: true, draft: true, action: { id: r.item.id, name: r.item.name, type: r.item.type }, next: "Attach it to a cover with ar_connect" };
  }

  if (action === "ar_connect") {
    const triggerId = text(command.triggerId, "triggerId", 80);
    const actionIds = list(command.actionIds, "actionIds");
    const doc = await get();
    const existing = (doc.rules || []).find((r) => r.triggerId === triggerId);
    const r = existing
      ? await deps.call<{ item: Dict }>(path(`/rules/${encodeURIComponent(existing.id as string)}`), { method: "PATCH", body: { triggerId, actionIds } })
      : await deps.call<{ item: Dict }>(path("/rules"), { method: "POST", body: { triggerId, actionIds } });
    return { ok: true, draft: true, replacedExisting: !!existing, rule: { id: r.item.id, triggerId, actionIds: r.item.actionIds } };
  }

  if (action === "ar_add_to_set") {
    const triggerIds = list(command.triggerIds, "triggerIds", 50);
    const doc = await get();
    const sets = doc.sets || [];
    const wanted = optText(command.setId, "setId", 80);
    const name = optText(command.setName, "setName");
    const found = sets.find((s) => (wanted ? s.id === wanted : name ? String(s.name).toLowerCase() === name.toLowerCase() : false));
    if (found) {
      const merged = [...new Set([...((found.triggerIds as string[]) || []), ...triggerIds])];
      const r = await deps.call<{ item: Dict }>(path(`/sets/${encodeURIComponent(found.id as string)}`), { method: "PATCH", body: { triggerIds: merged } });
      return { ok: true, draft: true, created: false, set: { id: r.item.id, name: r.item.name, covers: merged.length } };
    }
    if (wanted) throw new ArToolError(404, "No set with that setId");
    if (!name) throw new ArToolError(400, "Give setId (to add to an existing set) or setName (to create one)");
    const slug = slugOf(name);
    if (!slug) throw new ArToolError(400, "That set name has no letters or numbers");
    const r = await deps.call<{ item: Dict }>(path("/sets"), { method: "POST", body: { name, slug, triggerIds } });
    return { ok: true, draft: true, created: true, set: { id: r.item.id, name: r.item.name, slug: r.item.slug, covers: triggerIds.length }, next: "Publish with ar_publish_set, and point a QR code at it with ar_set_qr" };
  }

  if (action === "ar_publish_set") {
    const setId = text(command.setId, "setId", 80);
    try {
      const r = await deps.call<{ manifestUrl: string; triggers: number }>(path(`/sets/${encodeURIComponent(setId)}/publish`), { method: "POST" });
      return { ok: true, published: true, covers: r.triggers, note: "The cover images and videos in this set are now public at ar.elettro.com", manifestUrl: r.manifestUrl };
    } catch (e) {
      if (e instanceof ArToolError || (e as { problems?: string[] }).problems) {
        const problems = (e as { problems?: string[] }).problems;
        throw new ArToolError(422, "The set is not ready to publish", problems);
      }
      throw e;
    }
  }

  if (action === "ar_set_qr") {
    const mode = command.mode;
    if (mode !== "scanner" && mode !== "experience" && mode !== "url") throw new ArToolError(400, "mode must be scanner, experience or url");
    const fields: Dict = { mode, ...(mode === "scanner" ? { setId: text(command.setId, "setId", 80) } : mode === "experience" ? { actionId: text(command.actionId, "actionId", 80) } : { url: text(command.url, "url", 2048) }) };
    const qrId = optText(command.qrId, "qrId", 80);
    if (qrId) {
      const r = await deps.call<{ item: Dict }>(path(`/qrs/${encodeURIComponent(qrId)}`), { method: "PATCH", body: fields });
      return { ok: true, live: true, qr: { id: r.item.id, name: r.item.name, mode: r.item.mode }, note: "The printed code now opens the new destination" };
    }
    const name = text(command.name, "name");
    const slug = slugOf(optText(command.slug, "slug", 60) ?? name);
    const r = await deps.call<{ item: Dict }>(path("/qrs"), { method: "POST", body: { ...fields, name, slug } });
    return { ok: true, live: true, created: true, qr: { id: r.item.id, name: r.item.name, slug: r.item.slug, mode: r.item.mode }, address: `${deps.publicBase}/${brand}/${r.item.slug}` };
  }

  throw new ArToolError(400, "Unknown AR action");
}
