// Mastodon post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only, and no login needed: the counts of a public post are
// on GET /api/v1/statuses/:id of the instance that holds it. Mastodon has no views or reach numbers, only favourites, replies and
// boosts, so those are all a snapshot holds. The instance comes from the post's own URL (every account here is on mastodon.social
// today, but a status id only means something on its own instance).

const num = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value));

export function instanceOf(externalUrl) {
  try { return new URL(String(externalUrl)).origin; } catch { return null; }
}

export function statusUrl(origin, id) {
  return `${origin}/api/v1/statuses/${encodeURIComponent(id)}`;
}

export function metricsFromStatus(status) {
  return {
    views: null, reach: null, saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null,
    likes: num(status?.favourites_count),
    comments: num(status?.replies_count),
    shares: num(status?.reblogs_count)
  };
}

/** Snapshots for one due status; throws when the instance says no (deleted or hidden: retried next tick, never saved as zeros). */
export async function collectForStatus(item, fetchImpl = fetch) {
  const origin = instanceOf(item.externalUrl);
  if (!origin) throw new Error(`no instance address on the post ${item.postId}`);
  const response = await fetchImpl(statusUrl(origin, item.postId), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mastodon status ${item.postId} failed: ${body?.error || response.status}`);
  const metrics = metricsFromStatus(body);
  const raw = { favourites_count: body.favourites_count ?? null, reblogs_count: body.reblogs_count ?? null, replies_count: body.replies_count ?? null };
  return item.buckets.map((ageBucket) => ({ ledgerId: item.ledgerId, ageBucket, source: "mastodon-api", metrics, raw }));
}
