# Scroll relay (phone remote for elettro.com/scroll)

`elettro.com/scroll` is a demo page where a phone scans a QR code and becomes the remote for the page on a big screen.
It used to connect the two with the free public PeerJS service. That was slow and unreliable: registering with its broker took
1 to 7 seconds per side (measured 2026-11-02), a full connect took 10 to 30 seconds, and sometimes the broker's WebSocket never
answered at all, which left a dead QR code. This relay replaces it. The page still falls back to PeerJS if the relay is unreachable.

It is **fully separate from the Publishing Engine**: no Postgres, no dev-api, no secrets, no schedules. One Lambda, one DynamoDB
table, one WebSocket API.

## What it is

- `services/scroll-relay-lambda/relay.mjs`: the switchboard logic (pure, tested in `tests/scroll-relay.test.mjs`).
- `services/scroll-relay-lambda/index.mjs`: wires it to DynamoDB and the API Gateway WebSocket management API.
- API Gateway **WebSocket** API `elettro-scroll-dev-ws`, stage `dev`; routes `$connect`, `$disconnect`, `$default` all go to the one Lambda.
- Lambda `elettro-scroll-dev-relay` (nodejs24.x, 128 MB, 10 s, no zip dependencies: the runtime provides the AWS SDK).
- DynamoDB table `elettro-scroll-dev` (pk + sk, pay per request, TTL on `ttl`), role `elettro-scroll-dev-relay-role`.

How it works: a screen connects with `?s=<session>&r=display`, a phone with `?s=<session>&r=phone`. The relay forwards every message
to the other side of the same session and never reads it. The screen sends `{"t":"_hi"}` once its socket is open; if a phone is
already waiting (the screen just moved to the next page) the relay answers `{"t":"_join"}`. `{"t":"_leave"}` tells a side the other left.
Rules: a session is an 4-32 character lowercase code; one display (a new one replaces the old); one phone (**the newest wins**, the
older one is sent `{"t":"busy"}`); messages over 8 KB are dropped; browsers must come from `elettro.com`, `www.elettro.com` or localhost.
The session code is the only credential, the same as before (it is in the QR code).

## Setup (done 2026-11-03, root profile; re-run only to update)

`stashbox-audit` cannot create any of this (checked 2026-11-02: `CreateFunction`, `CreateRole`, `PassRole`, `CreateTable` and API
Gateway writes are all implicit deny). Run once with the root profile `elettro`:

```
aws login --profile elettro        # Dean, browser sign-in
bash scripts/scroll-relay-setup.sh
```

It creates the table, role, Lambda, WebSocket API, routes, permission and a throttled stage (50 req/s, burst 100), then prints
`wss://<api-id>.execute-api.us-east-1.amazonaws.com/dev`. Safe to re-run (it updates the Lambda code if it already exists).

Then put that address into `elettro.com/scroll` (`var RELAY_URL = '...'` near the top of `scroll/index.html` in the
`elettro/elettro` repo, branch `scroll-relay-client` until merged) and publish. While `RELAY_URL` is empty the page uses PeerJS only.

## Updating the Lambda

Re-run `scripts/scroll-relay-setup.sh` (root), or zip `index.mjs relay.mjs package.json` with `scripts/scroll-relay-zip.py` and
`aws lambda update-function-code --function-name elettro-scroll-dev-relay --zip-file fileb://<zip>`.

## Checks

- Tests: `node --test tests/scroll-relay.test.mjs` (also in CI).
- Verified 2026-11-02 against a local stand-in server that runs the real `relay.mjs` with an in-memory table (not against AWS):
  a simulated phone connected in about 0.5 s, and moving the screen to the next page reconnected in about 0.5 s.
- With `?debug=1` on the scroll page, a green box shows fps, scroll position, phone target, connection and how many messages arrived.

## Lessons (2026-11-03)

- **Random "dies at #N" was not the page.** The screen still ran PeerJS beside the relay; a PeerJS broker blip led to
  `unavailable-id`, the page picked a NEW session code and moved its relay link there, orphaning the phone on the old code
  (relay log: `mwyf7m` -> `mv2xyi`). With `RELAY_URL` set the screen no longer starts PeerJS and the phone has no PeerJS fallback.
- **Heartbeat:** pages send `{"t":"_ping"}` every 5 s and the relay answers `{"t":"_pong"}` to the sender only; 12 s of silence
  makes the page replace its socket (a browser can miss a dropped socket). Verified by deleting the screen's connection
  server-side mid-scroll: same session code, scrolling resumed in about 4 s.
- **Lambda concurrency:** this account allows only 10 concurrent Lambda runs. At 25 phone messages/s the relay hit 10 and
  dropped messages; the phone now sends about 8/s over the relay (peak since: 5).
- **Logs:** every connect / disconnect / drop / no-peer writes one JSON line; filter CloudWatch by the lowercase session code.

## Unknown / ask Dean

- Verified on real API Gateway 2026-11-03: the `$connect` origin check (foreign origin gets 403), two-way messages, `_join`/`_leave`, and a real phone. Still not verified: the 10-minute idle timeout (the page sends a
  keep-alive every 4 minutes) and the 2-hour maximum connection length (the page reconnects by itself).
- Whether the demo should get its own domain (for example `relay.elettro.com`) instead of the default `execute-api` address.
- Cost: pay-per-request DynamoDB, WebSocket messages and Lambda invocations; expected to be pennies a month at demo traffic. Not measured.
