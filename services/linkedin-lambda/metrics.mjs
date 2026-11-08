// LinkedIn company-page post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only. Scope: r_organization_social (the page login
// already asks for it). GET /rest/organizationalEntityShareStatistics returns lifetime organic statistics for a list of a page's posts:
// impressions, unique impressions, clicks, likes, comments, shares. Paid (ad) numbers live in a separate API and are not read here.
// Personal-profile posts have no equivalent and are never collected (the due list leaves them out).

const BATCH = 20;
const num = (value) => (value === undefined || value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

/** A post urn is urn:li:share:N or urn:li:ugcPost:N; the statistics call wants them in different lists. */
export function listParamFor(urns) {
  const kinds = { shares: [], ugcPosts: [] };
  for (const urn of urns) {
    if (/^urn:li:share:\d+$/.test(urn)) kinds.shares.push(urn);
    else if (/^urn:li:ugcPost:\d+$/.test(urn)) kinds.ugcPosts.push(urn);
  }
  return Object.entries(kinds).filter(([, list]) => list.length).map(([name, list]) => `${name}=List(${list.map(encodeURIComponent).join(",")})`).join("&");
}

export function statisticsPath(orgUrn, urns) {
  return `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&${listParamFor(urns)}`;
}

export function metricsFromStatistics(stats) {
  const s = stats || {};
  return {
    views: num(s.impressionCount), reach: num(s.uniqueImpressionsCounter), likes: num(s.likeCount), comments: num(s.commentCount),
    shares: num(s.shareCount), linkClicks: num(s.clickCount),
    saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null
  };
}

/**
 * Snapshots for the due posts of ONE page. `call(path)` answers the parsed JSON. A post LinkedIn does not return is left out (retried next
 * tick, never saved as zeros); a failed request throws.
 */
export async function collectForPage(orgUrn, items, call) {
  const snapshots = [];
  const missing = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).filter((item) => /^urn:li:(share|ugcPost):\d+$/.test(item.postId));
    if (!chunk.length) continue;
    const body = await call(statisticsPath(orgUrn, chunk.map((item) => item.postId)));
    const byUrn = new Map((body?.elements || []).map((element) => [element.share || element.ugcPost, element.totalShareStatistics]));
    for (const item of chunk) {
      const stats = byUrn.get(item.postId);
      if (!stats) { missing.push(item.postId); continue; }
      const metrics = metricsFromStatistics(stats);
      for (const ageBucket of item.buckets) snapshots.push({ ledgerId: item.ledgerId, ageBucket, source: "linkedin-statistics", metrics, raw: { totalShareStatistics: stats } });
    }
  }
  return { snapshots, missing };
}

// Verification (2026-11-08): the stored snapshot next to the live number from the network, for a post that is at least a day old. The fields
// are the normalized ones; only those either side has are listed. Read only.
const COMPARE_FIELDS = ["views", "reach", "likes", "comments", "shares", "saves", "linkClicks"];
export function compareSnapshot(row, live) {
  const stored = {};
  const now = {};
  const differs = [];
  for (const field of COMPARE_FIELDS) {
    const a = row[field] === null || row[field] === undefined ? null : Number(row[field]);
    const b = live?.[field] === null || live?.[field] === undefined ? null : Number(live[field]);
    if (a === null && b === null) continue;
    stored[field] = a;
    now[field] = b;
    if (a !== b) differs.push(field);
  }
  const hours = Math.round((Date.parse(row.capturedAt) - Date.parse(row.publishedAt)) / 360000) / 10;
  return { url: row.externalUrl || row.externalPostId, brand: row.brand, placement: row.placement, publishedAt: row.publishedAt, bucket: row.ageBucket, takenAfterHours: Number.isFinite(hours) ? hours : null, stored, live: now, differs };
}

/** The newest snapshot of each post that is at least a day old, newest posts first, up to `limit`. */
export function postsToVerify(rows, limit = 6, now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (seen.has(row.ledgerId) || row.placement === "story") continue;
    if (now - Date.parse(row.publishedAt) < 24 * 3600000) continue;
    seen.add(row.ledgerId);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
