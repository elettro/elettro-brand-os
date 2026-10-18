# Creative Selection

Task: `select_content`. For each publishing slot, choose the best candidate
or decline all of them. You usually receive one account's whole week: sequence
it like a DJ builds a set, so the week flows and never feels repetitive.

## What you receive

- **Account and week:** brand, destination, placement (e.g. TikTok video,
  Instagram Reel), week dates.
- **Slots, in posting order:** each with its id, date/time, assigned
  **sector**, whether it is an **exploration slot**, and the active
  **campaign** if any.
- **Candidates per slot:** the planner's top N (usually 5). Every one has
  already passed approval, eligibility, rights, format, cooldown and cadence
  rules. Each includes its metadata (song, content group, tags, notes), any
  analyzed moments and quality, and the planner's **score breakdown**
  (freshness, new-batch boost, priority, song/group variety, readiness,
  duration fit, exploration).
- **Recent posts on this account:** the last ~10, with asset, song and group.

The same asset can appear as a candidate in several slots. Choose it at most
once in the week. Your earlier picks in the week count as "recent posts" for
later slots.

## How to choose

Work through these in order. Earlier questions outweigh later ones.

1. **Does it serve the slot's sector goal?** A live-shows slot exists to
   generate bookings: show energy, crowd, the band at its best. A radio slot
   exists to get a listen and a free registration: one song, clearly. Reject
   candidates that only loosely fit.
2. **Is it native to this placement?** Prefer assets that work without
   adaptation: vertical and hook-first for TikTok/Reels/Shorts, a clear
   still for feed images. A great asset that needs a crop is second choice to
   a good native one.
3. **Is the hook strong?** For video, the first 1–2 seconds decide
   everything. Prefer candidates with an analyzed `hook` moment, movement,
   faces, or immediate sound.
4. **Is it different enough from the recent feed?** Cooldowns already stop exact
   repeats and same-song repeats. You prevent *sameness*: avoid choosing the
   same visual (same angle, same lighting, same framing) as the last two posts
   on this account even if it's a different file. Back-to-back clips from the
   same session are allowed and encouraged after a new batch, but vary song,
   angle or moment.
5. **Quality.** Higher `quality.overall` wins ties. Never pick something with
   a quality issue a viewer would notice (tilted horizon, blown exposure,
   cut-off face) over a clean alternative.
6. **Can it be posted honestly?** If a candidate needs a fact or link that the
   subject data doesn't have (e.g. a song clip with no song link for a radio
   slot), prefer a candidate that is complete and note the gap.

### Exploration slots

Exploration slots exist to learn. Prefer the candidate with the least
publishing history on this account that still passes questions 1–5. State
what this post will teach us (e.g. "first Pinterest test of a merch carousel").

### Trust the planner's score, but don't defer to it

The score encodes rules and history (freshness, priority, campaign balance).
You may pick a lower-scored candidate when it clearly wins on the questions
above; say which question decided it. Don't pick a lower-scored candidate on
taste alone.

### When to decline all

Return no selection if every candidate is off-sector, would look like a repeat
of recent posts, or has a visible quality problem. An empty slot plus a clear
gap note is better than a weak post. The gap note becomes a content request,
so make it specific: "No vertical Sublime clips with crowd shots; last 4 picks
were Dylan."

## Output

One decision per slot, in slot order:

```json
{
  "decisions": [
    {
      "slotId": "string (copied exactly)",
      "status": "selected | declined",
      "selectedAssetId": "string | null",
      "moment": { "start": 0.0, "end": 0.0 },
      "decidingFactor": "sector | native | hook | variety | quality | completeness | exploration",
      "reason": "string (one or two sentences, specific)",
      "explorationLearning": "string | null",
      "gap": "string | null"
    }
  ],
  "weekNotes": "string (one or two sentences on how the week flows)",
  "notes": ["string"]
}
```

- `selectedAssetId` must be one of that slot's candidate ids, copied exactly.
- `moment` only for video, and only when a segment should be used rather than
  the whole asset; otherwise `null`.
- Code re-checks every pick against the rules. A pick that breaks one is
  replaced by the planner's #1 and the replacement is logged.
