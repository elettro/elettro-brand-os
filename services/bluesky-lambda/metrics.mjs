// Bluesky post metrics (2026-11-07, docs/ANALYTICS-SPEC.md phase A). Read only, and no login needed: the counts of a public post come
// from Bluesky's public AppView (app.bsky.feed.getPosts, up to 25 posts per request). Bluesky has no views or reach numbers, only
// likes, replies, reposts and quotes, so those are all a snapshot holds.

const APPVIEW = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";
const BATCH = 25;
const num = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? null : Number(value));

export function postsUrl(uris) {
  const query = new URLSearchParams();
  for (const uri of uris) query.append("uris", uri);
  return `${APPVIEW}?${query}`;
}

/** The normalized numbers of one post view from getPosts. Reposts and quotes are both ways of passing the post on. */
export function metricsFromPost(post) {
  const reposts = num(post?.repostCount);
  const quotes = num(post?.quoteCount);
  return {
    views: null, reach: null, saves: null, watchTimeSeconds: null, avgViewDurationSeconds: null, followsGained: null,
    likes: num(post?.likeCount),
    comments: num(post?.replyCount),
    shares: reposts === null && quotes === null ? null : (reposts ?? 0) + (quotes ?? 0)
  };
}

/**
 * Snapshots for the due posts (items carry `postId`, the post's at:// uri). A post Bluesky no longer returns (deleted) is left out, so it
 * is looked for again on the next tick rather than saved as zeros. A failed request throws.
 */
export async function collectForPosts(items, fetchImpl = fetch) {
  const snapshots = [];
  const missing = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const response = await fetchImpl(postsUrl(chunk.map((item) => item.postId)), { signal: AbortSignal.timeout(20000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Bluesky getPosts failed: ${body?.message || body?.error || response.status}`);
    const byUri = new Map((body.posts || []).map((post) => [post.uri, post]));
    for (const item of chunk) {
      const post = byUri.get(item.postId);
      if (!post) { missing.push(item.postId); continue; }
      const metrics = metricsFromPost(post);
      const raw = { likeCount: post.likeCount ?? null, repostCount: post.repostCount ?? null, quoteCount: post.quoteCount ?? null, replyCount: post.replyCount ?? null };
      for (const ageBucket of item.buckets) snapshots.push({ ledgerId: item.ledgerId, ageBucket, source: "bluesky-appview", metrics, raw });
    }
  }
  return { snapshots, missing };
}
