# YouTube post metrics (phase A of docs/ANALYTICS-SPEC.md)

Read-only collection of YouTube numbers per published video. Nothing here posts, edits or deletes anything on YouTube.

## How it works
- Table `PostMetric` (one row per `PublicationLedger` row and age bucket `1h` / `24h` / `7d` / `30d`; the first snapshot wins, a rerun never overwrites).
- The `elettro-brand-os-dev-youtube-upload` worker (outside the VPC) runs `collectMetrics()` at the end of every 15-minute tick, up to 10 videos per tick:
  1. dev-api `list-post-metrics-due-20261107` lists published YouTube posts that reached a bucket without a snapshot (posts older than 45 days are ignored);
  2. per video: Data API `videos.list?part=statistics` (views, likes, comments; scope `youtube.readonly`) and Analytics API `reports` (watch time, average view
     duration, shares, subscribers gained; scope `yt-analytics.readonly`). Analytics lags about two days, so 1h and 24h snapshots usually hold the Data API numbers only (`source` = `statistics`);
  3. dev-api `record-post-metrics-20261107` saves them. A metrics failure never stops publishing (the tick reports `metrics: {ok:false}` and carries on).
- Direct invokes of the worker: `{"action":"metrics"}` collects now; `{"action":"metrics-check"}` asks every connected channel's token whether the Analytics API answers and
  returns a status per channel (never the data). Use it after reconnecting channels: a channel that connected before the scope was requested answers 403.
- All three dev-api actions are IAM-only; `setup-post-metrics-20261107` is a dry run unless `{"mode":"apply"}`.

## AWS steps after merge (not done by the merge)
1. Upload the dev-api zip (`Build DEV API Lambda` artifact) with `aws lambda update-function-code`.
2. Create the table: invoke dev-api `{"action":"setup-post-metrics-20261107"}` (dry run), then with `"mode":"apply"`.
3. Upload the youtube-upload zip (`Build YouTube Upload Lambda` artifact; it now contains `metrics.mjs`) through the console: `claude-audit-only` cannot update that function.
4. Invoke the worker with `{"action":"metrics-check"}` and read the per-channel result before trusting the tick.
- No new IAM is expected: the worker already reads the YouTube token secrets and invokes the dev-api. Not verified; if `metrics-check` reports a secrets error, that is the place to look.

## Not built
Other networks, baselines / Performance Index, the Calendar stats slot, the "What we learned" card and planner feedback (spec sections 4-6).


## Instagram, Facebook and Threads (2026-11-07, not verified against live APIs)

Same table and loop; the meta and threads workers collect in their ticks (8 posts per network per tick).

1. Merge, then run `setup-post-metrics-20261107` on the dev-api with `"mode":"apply"` **first**: it adds the `reach` and `saves` columns. Deploying the dev-api before this makes the Calendar query fail and every Stats panel go empty (it is wrapped, so nothing else breaks).
2. Deploy the dev-api and the meta and threads workers from their Build artifacts.
3. Check the metric names on real posts without saving: invoke each worker with `{"action":"metrics"}` (dry run). `samples[]` holds the numbers and Meta's raw answers per metric; an `{error}` in `raw.insights.<metric>` means Meta refused that metric for that kind of post (Meta renames and withdraws metrics often; fix the lists at the top of `services/meta-lambda/metrics.mjs`). Then `{"action":"metrics","mode":"apply"}` saves, or just wait for the tick.
4. Stories are never collected (their insights vanish after 24 hours). A post none of whose numbers came back is retried every tick, not saved as zeros.
