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

## [linkedin] LinkedIn

- **Placements:** text, image, video, document carousels, articles.
- **Viewer:** business decision-makers. Reads for usefulness, credibility and
  outcomes.
- **Copy:** lead with the business problem or result, then how it was done,
  then the invitation to talk. Short paragraphs, plain language, no fan-speak.
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

## [gbp] Google Business Profile

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
