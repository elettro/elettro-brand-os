# Platforms

Creative norms per destination. Loaded **by section**: a decision for TikTok
receives only the `[tiktok]` section plus this core.

Hard technical specs (aspect ratios, durations, file sizes, character limits)
live in the platform-spec config and are enforced by code. Numbers below are
practical writing targets, not limits. Brand-specific tactics live in
`brands/<slug>/platforms.md` and win over this file.

Link behavior matters for every CTA: where a platform has no clickable caption
links, the CTA must point to where the link actually is (bio, sticker, button,
pinned comment, description) and that location must exist for the account.

## [instagram] Instagram

- **Placements:** Reels (primary reach), feed images/carousels (saves and
  depth), Stories (existing followers; link stickers; handoff unless API allows).
- **Viewer:** scrolling fast, sound often on for Reels, off for feed.
- **Reels:** hook in the first second, visually. On-screen text optional, short.
  Loops well when the end flows back into the start.
- **Carousels:** first slide is the hook; each slide earns the swipe; last
  slide carries the CTA.
- **Caption:** hook line visible before "more" (~125 chars), then 1–3 short
  lines. Caption links are not clickable: CTA says "link in bio" or uses a
  Story link sticker.
- **Hashtags:** 3–5 specific ones. No walls of tags.
- **Alt text** on every image.

## [facebook] Facebook

- **Placements:** Reels, feed video, feed images, link posts, Stories, Events.
- **Viewer:** older and more local than Instagram on average; shares to
  friends and groups; responds to community, events and place.
- **Caption:** can run longer and more conversational than Instagram; a
  question or local reference works. Links are clickable; put the link in the
  post when the goal is a click.
- **Events:** event dates/venues only from records.
- **Hashtags:** 0–2, rarely matter.

## [tiktok] TikTok

- **Placements:** short video (primary), photo carousel.
- **Viewer:** For You feed; judges in under 2 seconds; native, unpolished energy
  often beats polish.
- **Video:** start mid-action. No logos or title cards up front. Real sound
  matters: the music is the hook for a band.
- **Caption:** short, hook-first, plain-spoken; a line that adds context or
  invites the comment the content naturally earns.
- **Links:** not clickable in captions. CTA points to profile link.
- **Hashtags:** 3–5, mix of specific (song, artist, genre, place) and niche
  community.
- **Exploration:** TikTok rewards testing; exploration slots here are
  deliberate experiments. Vary hooks, lengths and angles.

## [youtube] YouTube

- **Placements:** Shorts (discovery), long-form videos (depth, search),
  Community posts.
- **Shorts:** hook-first like TikTok; the title is searchable and should name
  the song/artist/subject plainly.
- **Title:** clear and specific over clever; front-load the searchable words.
  Practical target ≤ 70 chars.
- **Description:** first two lines matter most (they show above the fold);
  then context, credits, links.
- **Synthetic media:** set the altered/synthetic content disclosure when AI
  meaningfully altered or generated realistic content.
- **CTA:** subscribe / watch the full video / listen via link in description.

## [x] X

- **Placements:** text posts, image, video, threads.
- **Viewer:** fast, conversational, reacts to opinion and moment.
- **Copy:** one sharp idea. Practical target ≤ 240 chars. A short thread only
  when the content truly has steps or a story.
- **Links:** clickable. The brand + platform section decides whether links go
  in the post or a reply.
- **Hashtags:** 0–2.

## [threads] Threads

- **Placements:** text posts, images, video, carousels.
- **Viewer:** conversational, community-minded, reacts against hard selling.
- **Copy:** sounds like a person talking, not an ad. Questions, observations,
  behind-the-scenes thoughts. Practical target ≤ 300 chars.
- **Promotion:** keep promotional posts a minority (the brand's cap is
  enforced by config); originals and conversation carry the account.
- **Replies:** EPE suggests replies; a human sends them.

## [bluesky] Bluesky

Rules below marked **(rule)** come from Bluesky's Community Guidelines and
Developer Guidelines (checked 2026-10-29, see `docs/BLUESKY-RUNBOOK.md`); code
enforces them. The rest is advice.

- **Placements:** photo post (1 image), multi-photo post (2–4 images), video
  (one clip, ≤ 3 min). No stories or reels.
- **Viewer:** early-adopter, creator- and community-minded, quick to call out
  hard selling and engagement bait. Rewards a human voice and a useful link.
- **Copy:** **(rule)** at most 300 characters, and a link counts in full (it is
  not shortened), so a long URL eats the budget. Practical target ≤ 240 with a
  link, ≤ 280 without. One idea, plain words.
- **Links:** clickable. At most **one** link per post **(rule in code)**, placed
  where it reads naturally, ideally the last line. Use the shortest real URL
  from the records; never invent or shorten with third-party shorteners.
- **Hashtags:** 0–1, real topic tags only. Hashtag spam reads as spam.
- **Alt text:** every image gets a plain description of what is actually in it.
- **Promotion:** **(rule)** commercial content must be clearly identifiable as
  such: a brand account promoting its own shop, show or release is fine when the
  post plainly is the brand talking; anything sponsored, affiliate or paid must
  say so. Keep promotional posts a minority (the brand's cap is enforced by
  config; the default for Bluesky is 25%); the rest is originals: behind the
  scenes, a clip with context, a question.
- **Never:** **(rule)** repeat or near-duplicate a post, or post the same line
  to the account on a loop; @mention, reply to, like, follow or repost other
  accounts from automation (notifications from automated accounts count as
  spam, EPE suggests replies and a human sends them); promise reach or ask
  for likes/reposts/follows to "unlock" anything; link to adult, gambling,
  tobacco, alcohol or regulated goods.
- **Language:** the brand's own (SolarMeister posts in German).

## [linkedin] LinkedIn

- **Placements:** text, image, video, document carousels, articles.
- **Viewer:** business decision-makers. Reads for usefulness, credibility and
  outcomes.
- **Copy:** every post is **problem → solution → facts/estimates** (Dean,
  2026-10-19):
  1. **Problem:** the specific business problem, in the reader's words
     (e.g. "posting to 6 networks by hand eats a day a week").
  2. **Solution:** what was built or done about it, concretely: the system,
     the steps, the tool. Not a pitch; show how it works.
  3. **Facts and estimates:** the numbers that prove it. Facts come only from
     the input (records, metrics, the asset's notes). An estimate is allowed
     when the input gives its basis, and it must say so: "about", "an
     estimated", "roughly", with the basis in a few words ("based on 4 posts
     a day across 6 networks"). No number without a source in the input; if
     there is none, describe the result in words or return `blocked` with
     `missing: ["facts"]`.
  Then one invitation to talk or read more. Short paragraphs (1–2 sentences),
  plain language, no fan-speak, no hype.
- **Fit:** only business-audience sectors belong here (services, case studies,
  the business behind the brand), unless the brand section says otherwise.
- **Hashtags:** 0–3, professional.

## [pinterest] Pinterest

- **Placements:** standard pins (images), video pins, product pins, carousels.
- **Viewer:** searching and planning; saves for later. Pins live for months.
- **Title:** descriptive and searchable (what it is + for whom/occasion).
  Practical target ≤ 60 chars.
- **Description:** natural keywords, 1–3 sentences. Every pin carries a
  destination link, so it must be the most relevant record URL.
- **Best fit:** products, visual collections, artwork, gift ideas, evergreen
  content. Weak fit: time-bound announcements.

## [gmb] Google Business Profile

- **Placements:** updates, offers, events, photos, products.
- **Viewer:** people searching locally on Google Search and Maps, often ready to act.
- **Copy:** what, where, when, how to act, in the first lines. Local place
  names only from records. Practical target ≤ 750 chars.
- **CTA button:** always set (Book, Learn more, Call, Order) with a record URL.
- **No hashtags.** No phone numbers in the text if the profile has them already.

## [reddit] Reddit

- **Viewer:** communities with their own rules; hostile to obvious marketing.
- **Default mode: handoff.** EPE drafts; a human chooses the subreddit, checks
  its rules and posts.
- **Copy:** the title is the post. Plain, specific, honest about who you are
  ("We're a band from South Florida; here's our take on …"). The body adds
  context and invites discussion. No marketing language, no hashtags.
- **Promotion:** rare and only where the community explicitly allows it.
  Value first: performances, process, behind-the-scenes, answering questions.

## [website] Brand website

- **Placements:** blog/news posts, media pages, embedded social posts.
- **Copy:** title + summary + body that stands alone without the social post;
  structured, scannable, with descriptive headings and alt text. Search
  engines and AI assistants read this: state names, places and facts plainly.
- **After publication:** embed or link the social versions.

## [rss] RSS feed

- **Fields:** title, summary/description, link, media enclosure where supported.
- **Copy:** the title and first sentence must make sense out of context in a
  reader app. No platform-specific phrasing ("link in bio").
