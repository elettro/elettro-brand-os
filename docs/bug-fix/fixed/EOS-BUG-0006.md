# EOS-BUG-0006 - elettro.com/scroll freezes or "dies at #N" mid-session

Status: Fixed
Severity: High
Area: Scroll Remote
Environment: Both
Date reported: 2026-10 (weeks before the 2026-11-03 diagnosis; exact first report not recorded)
Date fixed: 2026-11-03
Date verified:
Reported by: Dean

## Symptom

The elettro.com/scroll screen stopped following the phone remote at random points ("dies at #6", "#8", "#12"). Later reports after the first fix: the phone dropped moments after connecting.

## Reproduction

1. Open elettro.com/scroll on the screen, pair a phone with the session code.
2. Scroll from the phone. Expected: the screen follows indefinitely.
3. Actual: the screen froze after a few steps, at no consistent spot.

## Affected examples

Screen + phone pairs on elettro.com/scroll, any session. Found by tracing CloudWatch `/aws/lambda/elettro-scroll-dev-relay`, filtered by the lowercase session code.

## Working comparison

After the relay-only rewrite and heartbeat, Dean: "definitely a lot better".

## Root cause

Several causes, found by instrumenting end to end rather than chasing the spot where it died:

1. **Session code switch.** The screen ran PeerJS beside the relay. A PeerJS broker blip returned `unavailable-id`, so the page picked a NEW session code and the phone was orphaned on the old one. This explains the random "dies at #N".
2. **No dead-connection detection.** A silent WebSocket looked alive. Needed a heartbeat.
3. **Handshake race (410).** The relay deleted a peer when a send returned 410 Gone, which dropped a phone 86 ms after it connected.
4. **Unknown senders** got no reply, and replaced phones were not marked busy, so two controller tabs tugged at each other.
5. **Sleeping tab** did not reconnect until the next timer.

Account Lambda concurrency limit is only 10, so the phone is throttled to about 8 messages per second.

## Fix

Own AWS relay (API Gateway WebSocket `elettro-scroll-dev-ws`, Lambda `elettro-scroll-dev-relay`, DynamoDB `elettro-scroll-dev`). Page is relay-only (PeerJS removed). 5 s ping/pong heartbeat, reconnect after 12 s of silence. Relay never deletes a peer on 410, sends `_reset` to unknown senders, keeps replaced phones marked `busy`. Page reconnects immediately on `visibilitychange`.

## Files changed

- `services/scroll-relay-lambda/`
- `scroll/index.html` in repo elettro/elettro
- `docs/admin/scroll-relay.md`

## Commits / PRs

- PR #307 (relay), #309 (logging, heartbeat pong), #310 (runbook), #316 (410 race, reset unknown senders, busy phones)

## Verification

Dean reported it "definitely a lot better" after the relay-only fix. Test rig `_harness.html` (real screen and phone pages in iframes against the real relay) passed. Not yet confirmed over a long real session after PR #316. Stays Fixed until then.

## Regression risk

Heartbeat and reconnect timings (5 s / 12 s) interact with the 10-concurrency Lambda limit. A second controller tab now loses to the first.

## Related bugs

- none

## Future repair procedure

1. Get the session code. Filter CloudWatch `/aws/lambda/elettro-scroll-dev-relay` for it (Git Bash needs `MSYS_NO_PATHCONV=1`).
2. Read the connect / disconnect / drop / no-peer events in order. A code that changes mid-session means the page switched sessions.
3. Reproduce with the harness, simulating hidden with `document.hidden` override plus a `visibilitychange` event (a second Chrome tab does not hide the rig tab).
4. Follow `docs/admin/scroll-relay.md`.

## Notes

Lesson: for an intermittent bug at random spots, instrument end to end, find the mechanism, prove it with fault injection.
