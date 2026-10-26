// Pure helpers for the AR viewer. No DOM, so node can test them.

/** /<brand>/<qrSlug> -> { brand, slug }. slug is "" when the visitor used the bare brand URL (use the main QR). */
export function parsePath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (!parts.length) return { brand: "", slug: "" };
  return { brand: parts[0].toLowerCase(), slug: (parts[1] || "").toLowerCase() };
}

/**
 * Which brand and QR slug does this address mean? `domains` is /domains.json: { "<host>": { brand, shared? } }.
 *  - a brand-owned host (ar.stashbox.com): the brand comes from the host, the first path part is the QR slug;
 *  - the shared host (ar.elettro.com, shared:true): the first path part is the brand, the second the slug, and the bare address opens the host's own brand;
 *  - unknown host (localhost, a preview address): the plain /<brand>/<slug> form.
 */
export function resolveRoute(hostname, pathname, domains) {
  const parts = String(pathname || "").split("/").filter(Boolean).map((p) => p.toLowerCase());
  const d = domains && domains[String(hostname || "").toLowerCase()];
  if (d && !d.shared) return { brand: d.brand, slug: parts[0] || "" };
  if (parts.length) return { brand: parts[0], slug: parts[1] || "" };
  // the bare shared address can scan several brands at once: d.scan = ["<brand>/<qr slug>", ...], in priority order
  if (d && Array.isArray(d.scan) && d.scan.length) return { brand: d.brand, slug: "", scan: d.scan };
  return { brand: d ? d.brand : "", slug: "" };
}

/**
 * One scanner out of several brands' scanner sets. `parts` is [{ brand, set }] in priority order.
 * Trigger ids and target names get the brand as a prefix so two brands can use the same names; when two triggers
 * share an original target name it is the same cover, and the earlier brand wins.
 */
export function mergeSets(parts) {
  const seen = new Set(), triggers = [];
  for (const { brand, set } of parts) {
    for (const t of (set && set.triggers) || []) {
      if (seen.has(t.target.name)) continue;
      seen.add(t.target.name);
      triggers.push({ ...t, id: brand + "--" + t.id, brand, target: { ...t.target, name: brand + "--" + t.target.name } });
    }
  }
  return { triggers };
}

/** Decide what the visitor sees from the brand manifest. */
export function resolveEntry(brandManifest, slug) {
  if (!brandManifest || brandManifest.enabled === false) return { kind: "inactive" };
  const key = slug || brandManifest.main;
  const entry = key && brandManifest.qrs ? brandManifest.qrs[key] : null;
  if (!entry) return { kind: "unknown" };
  if (entry.mode === "url") return { kind: "redirect", url: entry.url };
  if (entry.mode === "scanner") return { kind: "scanner", manifestUrl: entry.manifest };
  if (entry.mode === "experience") return { kind: "experience", action: entry.action };
  return { kind: "unknown" };
}

/** UV repeat/offset that crop a video to fill a square without stretching (crop mode). */
export function cropUv(videoAspect) {
  const a = videoAspect > 0 ? videoAspect : 1;
  if (a < 1) return { repeat: [1, a], offset: [0, (1 - a) / 2] };
  return { repeat: [1 / a, 1], offset: [(1 - 1 / a) / 2, 0] };
}

/** Plane size and depth for each fit mode, in target units (the full square cover is 1 x 1). */
export function planeFor(fit, videoAspect, scale = 1) {
  const a = videoAspect > 0 ? videoAspect : 1;
  const s = scale > 0 ? scale : 1;
  if (fit === "float") return { width: 1.6 * a * s, height: 1.6 * s, z: 0.02, repeat: [1, 1], offset: [0, 0] };
  if (fit === "fill") return { width: s, height: s, z: 0.01, repeat: [1, 1], offset: [0, 0] };
  return { width: s, height: s, z: 0.01, ...cropUv(a) };
}

export function pickVideo(actions) {
  return (actions || []).find((a) => a.type === "video") || null;
}

/** Link actions become buttons; utm_source=ar is added so Shopify and the Radio can see where the click came from. */
export function linkButtons(actions) {
  return (actions || [])
    .filter((a) => a.type === "link")
    .map((a) => ({ label: a.label, url: withUtm(a.url) }));
}

export function withUtm(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "ar");
    return u.toString();
  } catch {
    return url;
  }
}

/** The 8th Wall engine wants every target's json with an absolute imagePath. */
export function targetData(triggers) {
  return triggers.map((t) => ({ ...t.target.json, name: t.target.name }));
}

/** Splits a trigger's actions by what the viewer does with them. Only the first of each AR kind is used. */
export function sortActions(actions) {
  const list = actions || [];
  const first = (type) => list.find((a) => a.type === type) || null;
  return { video: first("video"), gallery: first("gallery"), model: first("model"), card: first("card"), links: linkButtons(list) };
}

/** Which gallery picture is showing after `elapsedSeconds`. */
export function galleryIndex(count, seconds, elapsedSeconds) {
  if (count <= 1 || !(seconds > 0)) return 0;
  return Math.floor(Math.max(0, elapsedSeconds) / seconds) % count;
}
