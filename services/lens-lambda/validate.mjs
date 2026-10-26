/** Input validation and id helpers for the Lens admin API. Pure functions: no AWS, easy to test. */
import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
// Top-level paths the viewer and CloudFront use on lens.elettro.com, so a brand can't be called these.
export const RESERVED_SLUGS = new Set(["viewer", "external", "api", "assets", "admin", "static", "e", "favicon", "robots", "lens", "www"]);
export const LIMITS = {
  triggersPerSet: 50,
  urlBytes: 2048,
  nameChars: 120,
  videoBytes: 200 * 1024 * 1024,
  imageBytes: 15 * 1024 * 1024,
  targetBytes: 5 * 1024 * 1024
};
export const ACTION_TYPES = ["video", "link"]; // M1; radio / shop / audio / model3d arrive in later PRs
export const FIT_MODES = ["crop", "fill", "float"];
export const QR_MODES = ["scanner", "experience", "url"];
export const UPLOAD_KINDS = {
  image: { types: { "image/jpeg": "jpg", "image/png": "png" }, max: LIMITS.imageBytes, folder: "images" },
  video: { types: { "video/mp4": "mp4" }, max: LIMITS.videoBytes, folder: "video" },
  target: { types: { "application/json": "json", "image/jpeg": "jpg" }, max: LIMITS.targetBytes, folder: "targets" }
};

export function newId() {
  return randomBytes(8).toString("hex");
}

export function slug(value, what = "slug") {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SLUG_RE.test(s)) throw bad(`${what} must be 1-60 lowercase letters, numbers or dashes`);
  if (RESERVED_SLUGS.has(s)) throw bad(`${what} "${s}" is reserved`);
  return s;
}

export function text(value, what, { max = LIMITS.nameChars, required = true } = {}) {
  if (value == null || value === "") {
    if (required) throw bad(`${what} is required`);
    return "";
  }
  if (typeof value !== "string") throw bad(`${what} must be text`);
  const t = value.trim();
  if (required && !t) throw bad(`${what} is required`);
  if (t.length > max) throw bad(`${what} is too long (max ${max})`);
  return t;
}

/** https only, no credentials, no javascript:/data:, max 2 KB. Returns the normalised URL. */
export function httpsUrl(value, what = "url") {
  if (typeof value !== "string" || !value.trim()) throw bad(`${what} is required`);
  const raw = value.trim();
  if (Buffer.byteLength(raw) > LIMITS.urlBytes) throw bad(`${what} is too long`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad(`${what} is not a valid URL`);
  }
  if (u.protocol !== "https:") throw bad(`${what} must start with https://`);
  if (u.username || u.password) throw bad(`${what} must not contain a login`);
  return u.toString();
}

const num = (v, def, min, max, what) => {
  if (v == null) return def;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(`${what} must be a number between ${min} and ${max}`);
  return Math.round(v * 1000) / 1000;
};

/** Per-trigger placement correction (the "nudge" values): x/y offset and size, in target units. */
export function placement(p) {
  const o = p && typeof p === "object" ? p : {};
  return { x: num(o.x, 0, -1, 1, "placement.x"), y: num(o.y, 0, -1, 1, "placement.y"), s: num(o.s, 1, 0.2, 3, "placement.s") };
}

// Storage keys look like "<brand>/<folder>/<file>"; reject anything that could climb out of that.
export function ownedKey(k, what) {
  if (typeof k !== "string" || k.length > 300 || k.includes("..") || k.startsWith("/") || !/^[a-z0-9][a-z0-9/_.-]*$/i.test(k)) {
    throw bad(`${what} is not a valid storage key`);
  }
  return k;
}

const STATUS = ["draft", "live"];

export function trigger(input, existing = {}) {
  const i = { ...existing, ...input };
  const t = {
    name: text(i.name, "name"),
    status: STATUS.includes(i.status) ? i.status : "draft",
    imageKey: i.imageKey ? ownedKey(i.imageKey, "imageKey") : undefined,
    placement: placement(i.placement),
    quality: i.quality == null ? undefined : num(i.quality, 0, 0, 100, "quality"),
    sourceAssetId: i.sourceAssetId ? text(i.sourceAssetId, "sourceAssetId", { max: 80 }) : undefined
  };
  if (i.target != null) {
    const g = i.target;
    if (!g || typeof g !== "object" || typeof g.name !== "string" || typeof g.luminanceKey !== "string" || !g.json || typeof g.json !== "object") {
      throw bad("target needs { name, luminanceKey, json } from the image-target generator");
    }
    if (JSON.stringify(g.json).length > 20000) throw bad("target json is too large");
    t.target = { name: text(g.name, "target.name", { max: 60 }), luminanceKey: ownedKey(g.luminanceKey, "target.luminanceKey"), json: g.json };
  }
  return t;
}

export function action(input, existing = {}) {
  const i = { ...existing, ...input };
  const type = i.type;
  if (!ACTION_TYPES.includes(type)) throw bad(`action type must be one of: ${ACTION_TYPES.join(", ")}`);
  const a = { type, name: text(i.name, "name") };
  if (type === "video") {
    a.videoKey = ownedKey(i.videoKey, "videoKey");
    a.fit = FIT_MODES.includes(i.fit) ? i.fit : "crop";
    a.loop = i.loop !== false;
    a.scale = num(i.scale, 1, 0.2, 3, "scale");
  } else {
    a.label = text(i.label, "label", { max: 40 });
    a.url = httpsUrl(i.url);
  }
  return a;
}

export function rule(input, existing = {}) {
  const i = { ...existing, ...input };
  if (typeof i.triggerId !== "string" || !i.triggerId) throw bad("triggerId is required");
  if (!Array.isArray(i.actionIds) || !i.actionIds.length || i.actionIds.length > 10 || i.actionIds.some((a) => typeof a !== "string")) {
    throw bad("actionIds must be a list of 1-10 action ids");
  }
  return { triggerId: i.triggerId, actionIds: [...new Set(i.actionIds)], order: num(i.order, 0, 0, 1000, "order") };
}

export function set(input, existing = {}) {
  const i = { ...existing, ...input };
  const triggerIds = Array.isArray(i.triggerIds) ? [...new Set(i.triggerIds)] : [];
  if (triggerIds.length > LIMITS.triggersPerSet) throw bad(`a set can hold at most ${LIMITS.triggersPerSet} triggers`);
  return { name: text(i.name, "name"), slug: slug(i.slug ?? existing.slug, "set slug"), triggerIds };
}

export function qr(input, existing = {}) {
  const i = { ...existing, ...input };
  if (!QR_MODES.includes(i.mode)) throw bad(`mode must be one of: ${QR_MODES.join(", ")}`);
  const q = { name: text(i.name, "name"), slug: slug(i.slug ?? existing.slug, "qr slug"), mode: i.mode, isMain: i.isMain === true };
  if (i.mode === "scanner") {
    if (typeof i.setId !== "string" || !i.setId) throw bad("a scanner QR needs a setId");
    q.setId = i.setId;
  }
  if (i.mode === "experience") {
    if (typeof i.actionId !== "string" || !i.actionId) throw bad("an experience QR needs an actionId");
    q.actionId = i.actionId;
  }
  if (i.mode === "url") q.url = httpsUrl(i.url);
  return q;
}

/** Validates an upload request and returns the folder, contentType, extension and size cap. */
export function uploadRequest(input) {
  const kind = UPLOAD_KINDS[input?.kind];
  if (!kind) throw bad(`kind must be one of: ${Object.keys(UPLOAD_KINDS).join(", ")}`);
  const ext = kind.types[input?.contentType];
  if (!ext) throw bad(`contentType for ${input.kind} must be one of: ${Object.keys(kind.types).join(", ")}`);
  return { folder: kind.folder, contentType: input.contentType, ext, max: kind.max };
}
