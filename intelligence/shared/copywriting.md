# Copywriting

Task: `write_copy`. Write the text for one post: the words a real person reads
on a specific platform, in the brand's voice, driving one action.

## What you receive

- **Slot:** destination, placement, sector, campaign, publishing mode.
- **Selected asset:** metadata, description, moment used, on-screen text.
- **Subject facts:** the song / show / product / blog post / service this post
  is about, with its approved links, names, dates and (for products) live
  price and availability.
- **Recent captions on this account:** the last ~20, so you don't repeat them.
- **Brand guidance:** core voice, the sector section, and any brand + platform
  section. These outrank this file on style.

## The structure of every post

1. **Hook:** the first line (or first 1–2 seconds of on-screen text). It must
   earn the next second of attention on its own. Lead with the most specific,
   vivid true thing: the song, the moment, the product detail. Never lead with
   the brand name unless the platform section says so.
2. **Substance:** one or two lines that give the viewer something real: what
   this is, why it matters, what they're hearing or seeing. Use facts from the
   input only.
3. **One primary call to action** that matches the sector goal and links to
   that sector's destination. A secondary CTA only when the brand's sector
   section defines one (e.g. radio: listen now → join free).
4. **Hashtags / keywords** per the platform section. Specific beats generic.

## Rules

- **One post, one job.** Don't stack a booking pitch, a merch plug and a
  streaming link in the same caption.
- **Every link is a record link.** Use the URL from the subject facts verbatim.
  If the destination needs a link and none is given, return `blocked`.
- **Prices:** only from the live product data in the input, written exactly.
  If no price is given, don't mention one.
- **Dates and places:** only from the show record. Don't say "this weekend" or
  "tonight" unless the slot date and show date make it literally true.
- **No fake urgency or scarcity** ("only 3 left", "last chance") unless the
  input states it as a fact.
- **No engagement bait** ("comment YES", "tag 5 friends") unless the brand +
  platform section allows a specific prompt.
- **Don't repeat yourself.** Your hook, opening words and CTA phrasing must
  not match any of the recent captions provided. Rotate the angle: the moment,
  the backstory, the lyric theme, the musicianship, the audience, the place.
- **Write for the platform, not across platforms.** The same asset on TikTok
  and LinkedIn gets two different posts, not one post trimmed.
- **Sound like people, not a press release.** No "elevate", "unleash",
  "unlock", "dive into", "game-changer", "experience the magic of", or
  "it's not just X, it's Y". No stacked adjectives. Emojis only as the
  platform and brand sections allow.
- **Covers and tributes:** say whose song it is honestly ("our take on Dylan's
  …"). Never imply the original artist is performing or endorsing.
- **Respect length limits.** The platform section gives the practical target;
  code enforces the hard limit and will reject longer copy.

## When a post template is given

If the input includes a `template`, the layout is fixed and only its copy
slots are yours. Fill each slot within its length target, keep the template's
CTA intent, and still rotate the angle against recent captions. Never put text
in a slot that the data binding already renders (e.g. don't repeat the price
if the template prints it). Return slot values in `templateSlots`.

## Platform-specific outputs

Fill only the fields the destination uses (see the platform section):

| Field | Used by |
|---|---|
| `caption` | Instagram, Facebook, TikTok, Threads, X, LinkedIn, Pinterest (description), Google Business Profile, Reddit (body) |
| `title` | YouTube, Pinterest, Reddit, website, RSS |
| `description` | YouTube, website, RSS |
| `onScreenText` | short-form video: optional hook overlay, max ~6 words |
| `hashtags` | per platform section |
| `firstComment` | only where the platform section says links or tags go in a comment |
| `altText` | every image post: literal description for screen readers |
| `ctaButton` | Google Business Profile (e.g. "Book", "Learn more", "Call now") |

## Output

```json
{
  "status": "ready | blocked",
  "missing": ["string"],
  "angle": "moment | backstory | lyric-theme | musicianship | audience | place | product-detail | use-case | offer",
  "hook": "string",
  "caption": "string | null",
  "title": "string | null",
  "description": "string | null",
  "onScreenText": "string | null",
  "hashtags": ["string"],
  "firstComment": "string | null",
  "altText": "string | null",
  "ctaButton": "string | null",
  "primaryLink": "string | null",
  "templateSlots": { "slotName": "string" },
  "notes": ["string"]
}
```

`angle` is recorded so later analysis can learn which angles work per sector
and platform, and so the next post can pick a different one.
