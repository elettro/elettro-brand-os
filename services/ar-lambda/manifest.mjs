/**
 * Builds the public JSON that the phone viewer loads. Pure functions: no AWS.
 *
 *   <brand>/manifest.json                 brand manifest: is AR on, which QR slug goes where
 *   <brand>/sets/<setSlug>/manifest.json  one scan set: its triggers (8th Wall targets), placement, actions
 *
 * Everything in a manifest is public once published, so only fields the viewer needs go in.
 */

export const MANIFEST_VERSION = 1;
export const ENGINE = "8thwall";

const mediaUrl = (baseUrl, key) => `${baseUrl}/${key}`;

export const brandManifestKey = (brand) => `${brand}/manifest.json`;
export const setManifestKey = (brand, setSlug) => `${brand}/sets/${setSlug}/manifest.json`;

/** What a disabled (or never-enabled) brand serves: no cost, no leak. */
export function stubManifest(brand, now = new Date()) {
  return { v: MANIFEST_VERSION, brand, enabled: false, generatedAt: now.toISOString() };
}

function publicAction(action, baseUrl) {
  if (action.type === "video") {
    return { type: "video", id: action.id, name: action.name, url: mediaUrl(baseUrl, action.videoKey), fit: action.fit, loop: action.loop, scale: action.scale };
  }
  if (action.type === "card") {
    return {
      type: "card", id: action.id, title: action.title, subtitle: action.subtitle,
      items: action.items.map((it) => ({ kind: it.kind, label: it.label, url: it.url, price: it.price, cta: it.cta, image: it.imageKey ? mediaUrl(baseUrl, it.imageKey) : undefined }))
    };
  }
  if (action.type === "form") {
    return { type: "form", id: action.id, name: action.name, title: action.title, subtitle: action.subtitle, toggle: action.toggle, fields: action.fields, cta: action.cta, note: action.note, accent: action.accent };
  }
  if (action.type === "gallery") {
    return { type: "gallery", id: action.id, name: action.name, images: action.imageKeys.map((k) => mediaUrl(baseUrl, k)), seconds: action.seconds, scale: action.scale };
  }
  if (action.type === "model") return { type: "model", id: action.id, name: action.name, builtin: action.builtin, scale: action.scale };
  return { type: "link", id: action.id, label: action.label, url: action.url };
}

/**
 * Returns { manifest, problems }. `problems` is a list of human-readable reasons the set can't be published yet;
 * the manifest is only meaningful when it's empty.
 */
export function buildSetManifest({ brand, set, triggers, rules, actions, baseUrl, now = new Date() }) {
  const problems = [];
  const triggerById = new Map(triggers.map((t) => [t.id, t]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  if (!set.triggerIds.length) problems.push("the set has no triggers");

  const out = [];
  for (const id of set.triggerIds) {
    const t = triggerById.get(id);
    if (!t) { problems.push(`trigger ${id} no longer exists`); continue; }
    if (!t.target) { problems.push(`trigger "${t.name}" has no tracking target yet`); continue; }
    const mine = rules.filter((r) => r.triggerId === id).sort((a, b) => a.order - b.order);
    const acts = [];
    for (const r of mine) {
      for (const aid of r.actionIds) {
        const a = actionById.get(aid);
        if (!a) problems.push(`trigger "${t.name}" points at an action that no longer exists`);
        else acts.push(publicAction(a, baseUrl));
      }
    }
    if (!acts.length) problems.push(`trigger "${t.name}" has no actions`);
    out.push({
      id: t.id,
      name: t.name,
      target: { name: t.target.name, json: { ...t.target.json, imagePath: mediaUrl(baseUrl, t.target.luminanceKey) } },
      placement: t.placement,
      actions: acts
    });
  }
  return {
    manifest: { v: MANIFEST_VERSION, brand, enabled: true, engine: ENGINE, set: { slug: set.slug, name: set.name }, generatedAt: now.toISOString(), triggers: out },
    problems
  };
}

/** The brand index: AR on/off and where each QR slug sends the visitor. */
export function buildBrandManifest({ brand, enabled, qrs, sets, actions, baseUrl, now = new Date() }) {
  if (!enabled) return stubManifest(brand, now);
  const setById = new Map(sets.map((s) => [s.id, s]));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const entries = {};
  let main = null;
  for (const q of qrs) {
    if (q.isMain) main = q.slug;
    if (q.mode === "url") entries[q.slug] = { mode: "url", url: q.url };
    else if (q.mode === "scanner") {
      const s = setById.get(q.setId);
      if (s) entries[q.slug] = { mode: "scanner", set: s.slug, manifest: mediaUrl(baseUrl, setManifestKey(brand, s.slug)) };
    } else if (q.mode === "experience") {
      const a = actionById.get(q.actionId);
      if (a) entries[q.slug] = { mode: "experience", action: publicAction(a, baseUrl) };
    }
  }
  return { v: MANIFEST_VERSION, brand, enabled: true, engine: ENGINE, main, qrs: entries, generatedAt: now.toISOString() };
}
