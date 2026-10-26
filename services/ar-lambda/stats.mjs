/**
 * Scan counters for the public stats (elettro.com/dash) and the per-brand numbers later. Counts only: no IP address,
 * no device id, no cookie, nothing that points at a person. An event says "this marker was scanned" or "a button on
 * it was tapped", and nothing else. Markers are checked against the published manifests, so only real markers count
 * and the names shown come from the manifest, never from the request.
 *
 * Rows (all under the pseudo-brand "_stats" in the same table):
 *   TOTAL                 { scans, taps, since }
 *   B#<brand>             { scans, taps }
 *   T#<brand>#<trigger>   { scans, taps, name, last }
 *   D#<yyyy-mm-dd>        { scans, taps }          (UTC day)
 */
import { HttpError } from "./validate.mjs";

const STATS = "_stats";
const KINDS = { scan: "scans", tap: "taps" };
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const TRIGGER_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const CACHE_MS = 10 * 60 * 1000;
const DAYS = 30;

export const dayKey = (d) => d.toISOString().slice(0, 10);

export function createStats({ store, files, now = () => new Date() }) {
  const cache = new Map(); // brand -> { at, markers: Map(id -> name) }

  /** The markers a brand has published, from its brand manifest and each scanner set it points at. */
  async function markers(brand) {
    const hit = cache.get(brand);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.markers;
    const found = new Map();
    const bm = await files.getJson(`${brand}/manifest.json`);
    if (bm && bm.enabled !== false) {
      for (const q of Object.values(bm.qrs || {})) {
        if (q.mode !== "scanner" || !q.set) continue;
        const sm = await files.getJson(`${brand}/sets/${q.set}/manifest.json`);
        for (const t of (sm && sm.triggers) || []) found.set(t.id, t.name || t.id);
      }
    }
    cache.set(brand, { at: Date.now(), markers: found });
    return found;
  }

  let registryCache = null;
  /** Every marker on the master scanner's list: brand, id, name and a small picture. Cached for 10 minutes. */
  async function registry() {
    if (registryCache && Date.now() - registryCache.at < CACHE_MS) return registryCache.list;
    const list = [], seen = new Set(); // same artwork on two brands: the first one on the list wins, as in the scanner
    const dom = await files.getJson("domains.json");
    for (const ref of (dom && dom._scan) || []) {
      const [b, q = ""] = String(ref).split("/");
      const bm = await files.getJson(`${b}/manifest.json`);
      const entry = bm && bm.qrs && bm.qrs[q];
      if (!entry || entry.mode !== "scanner" || !entry.set) continue;
      const sm = await files.getJson(`${b}/sets/${entry.set}/manifest.json`);
      for (const tr of (sm && sm.triggers) || []) {
        const key = tr.target && tr.target.name;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        list.push({ brand: b, id: tr.id, name: tr.name || tr.id, thumb: (tr.target && tr.target.json && tr.target.json.imagePath) || null });
      }
    }
    registryCache = { at: Date.now(), list };
    return list;
  }

  async function record(body) {
    const brand = body && body.brand, trigger = body && body.trigger, field = KINDS[body && body.kind];
    if (typeof brand !== "string" || !SLUG.test(brand) || typeof trigger !== "string" || !TRIGGER_ID.test(trigger) || !field) {
      throw new HttpError(400, "an event needs brand, trigger and kind (scan or tap)");
    }
    const name = (await markers(brand)).get(trigger);
    if (!name) throw new HttpError(404, "unknown marker");
    const t = now(), stamp = t.toISOString();
    const inc = { [field]: 1 };
    await Promise.all([
      store.add(STATS, "TOTAL", { inc, setIfMissing: { since: stamp } }),
      store.add(STATS, `B#${brand}`, { inc }),
      store.add(STATS, `T#${brand}#${trigger}`, { inc, set: field === "scans" ? { name, last: stamp } : { name } }), // only a scan moves "last scan"
      store.add(STATS, `D#${dayKey(t)}`, { inc })
    ]);
    return { ok: true };
  }

  /** Everything the dash needs in one small answer. */
  async function read() {
    const rows = await store.list(STATS);
    const n = (r, f) => Number((r && r[f]) || 0);
    const total = rows.find((r) => r.SK === "TOTAL") || {};
    const byDay = new Map(rows.filter((r) => r.SK.startsWith("D#")).map((r) => [r.SK.slice(2), r]));
    const today = new Date(now());
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const r = byDay.get(dayKey(d));
      days.push({ d: dayKey(d), scans: n(r, "scans"), taps: n(r, "taps") });
    }
    const brands = rows.filter((r) => r.SK.startsWith("B#")).map((r) => ({ brand: r.SK.slice(2), scans: n(r, "scans"), taps: n(r, "taps") }));
    const counted = new Map(rows.filter((r) => r.SK.startsWith("T#")).map((r) => {
      const [, brand, id] = r.SK.split("#");
      return [brand + "#" + id, { brand, id, name: r.name || id, scans: n(r, "scans"), taps: n(r, "taps"), last: r.last || null }];
    }));
    const triggers = [];
    for (const m of await registry()) {
      const c = counted.get(m.brand + "#" + m.id);
      triggers.push({ brand: m.brand, id: m.id, name: m.name, thumb: m.thumb, scans: c ? c.scans : 0, taps: c ? c.taps : 0, last: c ? c.last : null });
      counted.delete(m.brand + "#" + m.id);
    }
    for (const c of counted.values()) triggers.push({ ...c, thumb: null }); // counted before it left the list
    for (const tr of triggers) if (!brands.some((b) => b.brand === tr.brand)) brands.push({ brand: tr.brand, scans: 0, taps: 0 });
    brands.sort((a, b) => b.scans - a.scans || a.brand.localeCompare(b.brand));
    triggers.sort((a, b) => b.scans - a.scans);
    const last = triggers.reduce((m, t) => (t.last && (!m || t.last > m.last) ? t : m), null);
    return {
      ok: true,
      since: total.since || null,
      total: { scans: n(total, "scans"), taps: n(total, "taps") },
      today: { scans: days[days.length - 1].scans, taps: days[days.length - 1].taps },
      days, brands, markers: triggers,
      lastScan: last ? { brand: last.brand, id: last.id, name: last.name, at: last.last } : null,
      updatedAt: now().toISOString()
    };
  }

  return { record, read };
}
