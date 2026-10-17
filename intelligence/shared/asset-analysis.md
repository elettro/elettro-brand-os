# Asset Analysis

Task: `enrich_asset`. Understand one image or video so the planner can find,
judge and reuse it without a human opening the file.

Your output fills metadata **suggestions**. Code writes them only into empty
fields and never overwrites human-entered metadata. Approval status is never
yours to change.

## What you receive

- **Technical facts** (from code, trust these): kind, width, height, aspect
  ratio, duration, has-audio, file size, Dropbox path.
- **Visual evidence:**
  - Image: the image.
  - Video: several frames, each labelled with its timestamp. Treat them as a
    sequence, not separate pictures. What changes between frames is
    information (a crowd building, a solo starting, a camera move).
- **Audio evidence (video):** a timestamped transcript and/or audio
  description, when available. Lyrics in a transcript are evidence of which
  song is playing only when they match a song in the known-subjects list.
- **Brand vocabulary:** the allowed sectors, content families and tags for
  this brand. Use these exact strings.
- **Known subjects:** songs, shows, products and people this brand has on
  record, with their IDs. Match against these; never create new ones.
- **Brand core:** who the brand is (from its brand file), so you know what
  matters to it.

## How to analyze

1. **Describe what is actually there.** Setting, action, people (count, role,
   e.g. "singer at mic", "drummer"), instruments, products, visible text,
   mood, lighting, camera framing. Note what is *not* clear.
2. **Match to known subjects.** Song (from lyrics, on-screen title, filename
   hint corroborated by audio), show/session (from folder, filename, set
   dressing), product (from visible merch vs. product images), named people
   (only those listed in known subjects). Every match gets a confidence and
   the evidence it rests on.
3. **Assign a sector** from the brand's sector list: what would a post using
   this asset be promoting? If it plausibly serves two, give the primary and
   list the other in `secondarySectors`.
4. **Find usable moments (video).** Segments that would work as a standalone
   clip: a strong hook in the first seconds, a chorus, a solo, a crowd
   reaction, a clean ending. Give start/end in seconds and what makes it work.
   Avoid segments that start mid-word, show a false start, or end on a cut-off.
5. **Judge production quality** honestly: framing, focus, exposure, stability,
   whether the camera horizon is tilted, audio clarity, whether faces are
   cropped or covered by text. A poor asset described as great breaks the
   planner.
6. **Judge platform fit** from the technical facts and the composition: does it
   work vertical without a reframe? Is the subject centered enough for a 1:1
   crop? Is there safe space for captions?
7. **Flag risks.** Nudity or partial nudity (check every frame), minors,
   alcohol/drugs, weapons, third-party logos or brands, copyrighted artwork on
   screen, recognizable members of the public in focus, on-screen text with
   prices or dates that could go stale.

## Writing the fields

- **title:** short, factual, specific. "Sublime show: 'Santeria' crowd
  singalong, 9:16" beats "Amazing live moment". Max ~80 characters.
- **topic:** what the asset is about in a phrase.
- **creativeFamily:** from the brand's family list (e.g. a session or a recurring
  format). `null` if none fits.
- **description:** 2–4 sentences of visible/audible evidence a copywriter can
  use. No hype, no claims.
- **tags:** 3–8 from the brand's tag vocabulary, lowercase. Propose missing
  tags in `notes`, not in `tags`.

## Output

```json
{
  "title": "string",
  "topic": "string",
  "creativeFamily": "string | null",
  "description": "string",
  "tags": ["string"],
  "sector": "string | null",
  "secondarySectors": ["string"],
  "subjects": [
    { "type": "song | show | product | person", "id": "string", "confidence": 0.0, "evidence": "string" }
  ],
  "moments": [
    { "start": 0.0, "end": 0.0, "kind": "hook | chorus | solo | crowd | intro | outro | product | other", "why": "string" }
  ],
  "quality": {
    "overall": 0.0,
    "framing": "good | ok | poor",
    "exposure": "good | ok | poor",
    "stability": "good | ok | poor",
    "horizonTilted": false,
    "audio": "good | ok | poor | none",
    "issues": ["string"]
  },
  "platformFit": {
    "vertical916": "native | crop-ok | reframe-needed | unsuitable",
    "square11": "native | crop-ok | reframe-needed | unsuitable",
    "landscape169": "native | crop-ok | reframe-needed | unsuitable",
    "captionSafeSpace": true
  },
  "onScreenText": ["string"],
  "flags": {
    "nudity": false,
    "minors": false,
    "substances": false,
    "weapons": false,
    "thirdPartyBranding": false,
    "staleText": false,
    "details": ["string"]
  },
  "notes": ["string"]
}
```

`quality.overall` is a 0–1 judgment of how strong this asset is *as social
content*, independent of topic. Calibrate: 0.5 is usable, 0.8+ is a lead post,
below 0.3 should rarely be published.
