/** Input validation and id helpers for the AR admin API. Pure functions: no AWS, easy to test. */
import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
// Top-level paths the viewer and CloudFront use on ar.elettro.com, so a brand can't be called these.
export const RESERVED_SLUGS = new Set(["viewer", "external", "api", "assets", "admin", "static", "e", "favicon", "robots", "ar", "www"]);
export const LIMITS = {
  triggersPerSet: 50,
  urlBytes: 2048,
  nameChars: 120,
  videoBytes: 200 * 1024 * 1024,
  imageBytes: 15 * 1024 * 1024,
  targetBytes: 5 * 1024 * 1024
};
export const ACTION_TYPES = ["video", "link", "card", "gallery", "model", "form", "calculator", "scratch"]; // radio / audio / uploaded 3D models arrive in later PRs
export const MODEL_BUILTINS = ["vinyl", "solarpanel"];
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

/** Like httpsUrl, but a button may also place a call (tel:+49...) or start an email (mailto:...). */
export function linkUrl(value, what = "url") {
  if (typeof value === "string") {
    const v = value.trim();
    if (/^tel:\+?[0-9 ()-]{6,24}$/.test(v)) return "tel:" + v.slice(4).replace(/[ ()-]/g, "");
    if (v.length <= 200 && /^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) return v;
  }
  return httpsUrl(value, what);
}

const accentColor = (v) => {
  if (v == null) return undefined;
  if (!/^#[0-9a-f]{6}$/i.test(String(v))) throw bad("accent must be a color like #43b02a");
  return String(v).toLowerCase();
};

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
  } else if (type === "card") {
    // A sheet over the camera: a title and a short list of links or products (shop items carry an optional price and picture).
    a.title = text(i.title, "title", { max: 80 });
    a.subtitle = i.subtitle ? text(i.subtitle, "subtitle", { max: 140, required: false }) : "";
    if (!Array.isArray(i.items) || !i.items.length || i.items.length > 12) throw bad("a card needs 1-12 items");
    a.items = i.items.map((it, n) => ({
      kind: it.kind === "product" ? "product" : "link",
      label: text(it.label, `items[${n}].label`, { max: 80 }),
      url: linkUrl(it.url),
      price: it.price ? text(it.price, `items[${n}].price`, { max: 20, required: false }) : undefined,
      imageKey: it.imageKey ? ownedKey(it.imageKey, `items[${n}].imageKey`) : undefined,
      cta: it.cta ? text(it.cta, `items[${n}].cta`, { max: 24, required: false }) : undefined
    }));
  } else if (type === "form") {
    // A look-only form on the screen: nothing in it is ever sent anywhere. Fields are labels and placeholders.
    a.title = text(i.title, "title", { max: 80 });
    a.subtitle = i.subtitle ? text(i.subtitle, "subtitle", { max: 140, required: false }) : "";
    if (i.toggle != null) {
      const tg = i.toggle;
      if (!tg || !Array.isArray(tg.options) || tg.options.length < 2 || tg.options.length > 3) throw bad("a toggle needs 2-3 options");
      a.toggle = { label: tg.label ? text(tg.label, "toggle.label", { max: 40, required: false }) : "", options: tg.options.map((o, n) => text(o, `toggle.options[${n}]`, { max: 30 })) };
    }
    if (!Array.isArray(i.fields) || !i.fields.length || i.fields.length > 6) throw bad("a form needs 1-6 fields");
    a.fields = i.fields.map((f, n) => ({
      label: text(f && f.label, `fields[${n}].label`, { max: 40 }),
      placeholder: f.placeholder ? text(f.placeholder, `fields[${n}].placeholder`, { max: 40, required: false }) : "",
      suffix: f.suffix ? text(f.suffix, `fields[${n}].suffix`, { max: 12, required: false }) : "",
      mode: f.mode === "numeric" ? "numeric" : "text"
    }));
    a.cta = text(i.cta, "cta", { max: 40 });
    a.note = i.note ? text(i.note, "note", { max: 200, required: false }) : "";
    a.accent = accentColor(i.accent);
  } else if (type === "calculator") {
    // A savings estimate that runs on the phone. All numbers are the brand's own assumptions; nothing is sent anywhere.
    a.title = text(i.title, "title", { max: 80 });
    a.subtitle = i.subtitle ? text(i.subtitle, "subtitle", { max: 140, required: false }) : "";
    const k = i.kwh || {};
    a.kwh = { min: num(k.min, 1500, 100, 50000, "kwh.min"), max: num(k.max, 6000, 200, 100000, "kwh.max"), step: num(k.step, 100, 10, 1000, "kwh.step"), value: num(k.value, 3200, 100, 100000, "kwh.value") };
    if (a.kwh.max <= a.kwh.min || a.kwh.value < a.kwh.min || a.kwh.value > a.kwh.max) throw bad("kwh needs min < max and a value between them");
    a.pricePerKwh = num(i.pricePerKwh, 0.35, 0.05, 2, "pricePerKwh");
    a.yieldPerKwp = num(i.yieldPerKwp, 900, 300, 1500, "yieldPerKwp");
    if (!Array.isArray(i.systems) || !i.systems.length || i.systems.length > 3) throw bad("a calculator needs 1-3 systems");
    a.systems = i.systems.map((s, n) => ({
      label: text(s && s.label, `systems[${n}].label`, { max: 30 }),
      sub: s.sub ? text(s.sub, `systems[${n}].sub`, { max: 30, required: false }) : "",
      kwp: num(s.kwp, 1, 0.1, 20, `systems[${n}].kwp`),
      selfUse: num(s.selfUse, 0.8, 0.1, 1, `systems[${n}].selfUse`),
      price: num(s.price, 1000, 1, 100000, `systems[${n}].price`),
      url: s.url ? httpsUrl(s.url, `systems[${n}].url`) : undefined
    }));
    a.cta = i.cta ? text(i.cta, "cta", { max: 40, required: false }) : "Dieses System ansehen";
    a.note = i.note ? text(i.note, "note", { max: 200, required: false }) : "";
    a.accent = accentColor(i.accent);
  } else if (type === "scratch") {
    // A scratch card that reveals a prize and a code. It sends nothing; the optional button just opens a link.
    a.title = text(i.title, "title", { max: 80 });
    a.subtitle = i.subtitle ? text(i.subtitle, "subtitle", { max: 140, required: false }) : "";
    a.prize = text(i.prize, "prize", { max: 40 });
    a.code = i.code ? text(i.code, "code", { max: 24, required: false }) : "";
    a.hint = i.hint ? text(i.hint, "hint", { max: 140, required: false }) : "";
    if (i.cta != null) a.cta = { label: text(i.cta && i.cta.label, "cta.label", { max: 40 }), url: httpsUrl(i.cta && i.cta.url, "cta.url") };
    a.note = i.note ? text(i.note, "note", { max: 200, required: false }) : "";
    a.accent = accentColor(i.accent);
  } else if (type === "gallery") {
    if (!Array.isArray(i.imageKeys) || !i.imageKeys.length || i.imageKeys.length > 12) throw bad("a gallery needs 1-12 images");
    a.imageKeys = i.imageKeys.map((k, n) => ownedKey(k, `imageKeys[${n}]`));
    a.seconds = num(i.seconds, 3, 1.5, 10, "seconds");
    a.scale = num(i.scale, 1, 0.2, 3, "scale");
  } else if (type === "model") {
    if (!MODEL_BUILTINS.includes(i.builtin)) throw bad(`model must be one of the built-in shapes: ${MODEL_BUILTINS.join(", ")}`);
    a.builtin = i.builtin;
    a.scale = num(i.scale, 1, 0.2, 3, "scale");
  } else {
    a.label = text(i.label, "label", { max: 40 });
    a.url = linkUrl(i.url);
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
