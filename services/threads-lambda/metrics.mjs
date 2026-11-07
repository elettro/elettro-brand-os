// Threads post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only. Scope: threads_manage_insights.
// One request per post for the whole list; Threads answers { data: [{ name, values: [{ value }] }] }.

export const THREADS_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];
const num = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value));

export function snapshotFrom(body) {
  const got = {};
  for (const entry of body?.data || []) got[entry.name] = num(entry.values?.[0]?.value ?? entry.total_value?.value);
  const anyShare = got.shares !== undefined || got.reposts !== undefined || got.quotes !== undefined;
  const metrics = {
    views: got.views ?? null,
    likes: got.likes ?? null,
    // A reply is the Threads word for a comment.
    comments: got.replies ?? null,
    // Reposts and quotes are both ways of passing the post on; use `shares` when Threads gives it.
    shares: !anyShare ? null : (got.shares ?? (got.reposts ?? 0) + (got.quotes ?? 0)),
    reach: null, saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null
  };
  return { metrics, raw: { insights: got } };
}

/** Snapshots for one due Threads post; `threads(path, token, opts)` is the worker's own Graph call. */
export async function collectForPost(item, accessToken, threads) {
  const body = await threads(`${item.postId}/insights`, accessToken, { params: { metric: THREADS_METRICS.join(",") } });
  const { metrics, raw } = snapshotFrom(body);
  if (!Object.values(metrics).some((v) => v !== null)) throw new Error(`no Threads number came back for ${item.postId}`);
  return item.buckets.map((ageBucket) => ({ ledgerId: item.ledgerId, ageBucket, source: "threads-insights", metrics, raw }));
}
