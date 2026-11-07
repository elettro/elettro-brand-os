# Manual worker tick (Stream Deck)

`POST /ops/tick` on the dev-api fires a platform worker's publishing tick right now, so Dean can release due posts from
a Stream Deck key instead of waiting for the 15-minute schedule. Written 2026-11-07. **Not deployed or run against AWS yet (not verified).**

## What a press does

- Body `{"worker":"<name>"}` or `{"worker":"all"}`. Names: `meta threads tiktok pinterest youtube linkedin bluesky mastodon x snapchat substack gmb`
  (map in `services/dev-api-lambda/ops-tick.mjs`, `TICK_WORKERS`).
- It invokes the worker asynchronously with `{"action":"tick","source":"deck"}`, the same path the EventBridge rule takes
  (every worker handles `event.action === "tick"`). So it publishes **only posts that are already due and approved**. It never pulls
  a future post forward and never skips the planner's rules.
- Safe next to a scheduled tick: workers claim posts through `claim-due-posts`, which marks a post `publishing` first.
- Answer is `sent`, not `published` (video ticks run for minutes). Result per worker: `sent`, `cooldown` (20 s per worker, kept per
  warm Lambda container) or `error`. Each press is one JSON log line `{"ops":"tick",...}` in the dev-api log group.

## Auth

Its own token, header `x-elettro-deck-key`, compared with env `OPS_TICK_TOKEN` on the dev-api Lambda. It is checked inside the
handler, before the shared connect-key gate, so the deck PC never holds the connect key. Empty `OPS_TICK_TOKEN` = route answers 503.

## AWS steps after merge (ask Dean first; none are done yet)

1. Deploy the dev-api (`docs/admin/deploy-dev-api-lambda.md`).
2. Create the gateway route + Lambda permission (`docs/admin/new-api-route.md`) for `POST /ops/tick`.
3. Generate a long random token and set `OPS_TICK_TOKEN` on `elettro-brand-os-dev-api` (merge into the existing environment; do not replace it).
4. The dev-api role needs `lambda:InvokeFunction` on `arn:aws:lambda:us-east-1:656260749296:function:elettro-brand-os-dev-*`
   for the twelve workers (IAM step: root, ask Dean). Until then every press answers `AccessDeniedException`.
5. Put the same token in the deck PC's `%USERPROFILE%\elettrodeck\secrets.json` (never in git).
6. Smoke test: `curl -s -X POST -H "x-elettro-deck-key: <token>" -d '{"worker":"gmb"}' https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com/ops/tick`.
   No header = `401 Deck key required`; 404 = no gateway route; 500 = no Lambda permission.

## Gotchas

- Rotate by changing `OPS_TICK_TOKEN` and `secrets.json`; nothing else holds it.
- `snapchat` is idle until Snap approves its app; its tick finds nothing and does no harm.
