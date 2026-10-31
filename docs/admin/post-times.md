# When posts are scheduled (post times)

Written 2026-10-31 from Dean's decisions. Code: `TIME_PROFILES`, `spreadMinutes`, `buildSlots`, `slotsToPlan`
and `separateSlots` in `services/dev-api-lambda/planner-v2.mjs`. Tests: `tests/posting-times.test.mjs`.
The `/planner` page does not set these; the times come from **Plan week / Replan** on the Review page.

## Windows (local time of the account)

| Network | Days | Window | Why (Dean) |
|---|---|---|---|
| LinkedIn | Mon-Fri only | 08:00-20:00 | Business network. Changed from 08:00-12:00 on 2026-10-31 (PR #286). |
| Bluesky | every day | 08:00-20:00, 70% of posts between 09:00 and 17:00 | Business-hours heavy, but not only. |
| Mastodon | every day | 08:00-20:00, 70% of posts between 09:00 and 17:00 | Same as Bluesky. |
| Instagram, Facebook, Threads, TikTok, YouTube Shorts, Pinterest, everything else | every day | 09:00-21:00 | Mornings through the evening, pretty evenly. |

A rule's own stored window (on `CadenceRule`) is ignored; the network's window above is used.

## How the exact times are chosen

1. **Equal distance.** Each format's posts for a day (for example Instagram reels, Instagram stories, Instagram
   posts are three formats) sit at equal gaps inside the window. Add or remove a post and the gaps change, so the
   space between posts is always as large as it can be.
2. **Not round.** Any minute of the hour is allowed except :00 :15 :30 :45. Each day's row of gaps slides by a seeded
   amount, then each post moves a few minutes (5-9) to a seeded minute, so the minutes spread around the whole hour.
   It does not have to be perfectly balanced (Dean: that would be over-engineering). The same inputs give the same
   times every replan (sha256 seed), so there is no randomness between replans.
3. **Different formats of one network** are pulled at least 7 minutes apart, and no two posts of one brand share a minute
   (`separateSlots`).
4. **Replanning part-way through a day** fills only the rest of today, starting 20 minutes from now.

## Overrides

Per brand and network: `Brand.settings.planner.postingTimes.<destination>` = `{ start, end, days, peak }`
(for example `{ "start": "10:00", "end": "18:00", "days": ["mon","tue"] }`). `peak` is `{ start, end, share }`.

## What actually happens at the time

The worker Lambdas run every 15 minutes (EventBridge `rate(15 minutes)`). A post goes out at the first run after its
time, so up to 15 minutes late. Changing the schedules to 5 minutes needs Dean's OK and is not done.

## Not built yet (Dean's wishes, Section 1)

Timing by type of post. Not coded; all posts of a network share its window today.
- Live shows and booking: weekday daytime.
- Streaming and radio: evenings every day, plus midweek later in the day.
- Merch: late at night (this also needs the 10:00-22:00 hard window in `posting-window.mjs` to be extended; Dean has
  not decided whether for merch only or for everything. Recommendation: merch only).

## After changing times

Deploy the dev-api Lambda (`docs/admin/deploy-dev-api-lambda.md`), then on Review press **Reset** for the week and **Plan**.
Posts already planned keep their old times until replanned.
