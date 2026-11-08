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
