# Elettro Brand OS — Analytics & Attribution Specification V1

**Status:** Draft v1
**Depends on:** `SYSTEM-SPEC-V1.md`, `DATABASE-SCHEMA.md`
**Module:** Analytics (feeds the Publishing Engine and Production)

---

## 1. Purpose

Analytics exists to drive two decision loops:

| Loop | Question | Consumer |
|---|---|---|
| **Distribution** | What should we post next, where, and when? | Auto Planner scoring |
| **Production** | What should the creator make next? | Weekly Production Brief |

Reporting is a side effect. The goal is better decisions, and the core question is **where the heat is coming from**: which networks, products, content types, creative families, and individual assets actually produce attention, actions, and revenue.

---

## 2. Principles

1. **Measure business outcomes, not just engagement.** Views and likes matter. Clicks, carts, orders, sign-ups, and ticket purchases matter more.
2. **One ID ties everything together.** Every scheduled post has a short post ID that travels in links and UTMs. All other context (asset, family, product, campaign, social account, caption) is looked up from the ledger.
3. **Compare against baselines, not absolutes.** A post is judged against its own account's normal performance for that placement and age.
4. **Analytics adjusts scoring, never eligibility.** Approval, eligibility windows, and cooldowns stay deterministic.
5. **Don't overreact to small samples.** Use shrinkage toward brand averages.
6. **Keep exploring.** Reserve slots for untested assets so new content gets a fair shot.
7. **Suggest, don't silently change.** Timing, cadence, and production recommendations are presented for approval. Creative intent stays with the human.
8. **Everything is explainable.** Every performance factor used in a decision is recorded on the scheduled post.
9. **Organic social attribution is directional.** It will always undercount. Treat it as a strong signal, not exact accounting.

---

## 3. Data Collection

### 3.1 Platform metrics

Pulled per published post at **1h, 24h, 7d, and 30d** after publication.

| Platform | Source | Typical metrics |
|---|---|---|
| YouTube | YouTube Analytics API | views, watch time, average view duration, retention, likes, comments, shares, subscribers gained |
| Instagram | Graph API media insights | views/plays, reach, saves, shares, comments, likes, total interactions |
| Facebook | Graph API post/video insights | views, reach, reactions, comments, shares, link clicks |
| TikTok | API for authorized accounts | views, likes, comments, shares |
| LinkedIn | Organization post statistics | impressions, clicks, reactions, comments, reposts |
| X | Depends on paid API tier | impressions, engagements, link clicks |
| Website | GA4 + own logs | sessions, engagement time, conversions |

Platforms rename and deprecate metrics regularly. Each connector maps raw metrics into the **normalized internal model** below and stores the raw payload for reprocessing.

**Normalized metrics:** `views`, `reach`, `impressions`, `engagements`, `likes`, `comments`, `shares`, `saves`, `watch_time_s`, `avg_view_duration_s`, `link_clicks`, `follows_gained`.

### 3.2 Handoff posts

When a user confirms a Handoff post, **pasting the live URL is required**. The connector resolves the external post ID from the URL and collects metrics from then on. Without the URL there is no data.

### 3.3 Owned tracking

The engine's own tracked links and conversion data are described in §7.

---

## 4. Normalization: the Performance Index

Raw numbers are not comparable across accounts, platforms, or post ages.

### 4.1 Baselines

For each **social account × placement × age bucket**, maintain a rolling baseline: the median of each normalized metric over the last 90 days, with a minimum of 10 posts.

Until the minimum is met, fall back in order to the brand's baseline for that destination and placement, then to a global default per destination.

### 4.2 Relative scores

Each metric becomes a ratio to baseline: `views_rel = views / baseline_views`. A post at 1.8× has 80% more views than that account normally gets at that age.

### 4.3 Objective weighting

Each brand sets an **objective profile** that weights the relative scores into one **Performance Index** per post and age bucket:

| Objective | Weighted toward |
|---|---|
| Awareness | views, reach, watch time, follows |
| Engagement | saves, shares, comments, average view duration |
| Conversion | link clicks, carts, orders, revenue (from §7) |
| Custom | brand-defined weights |

Examples: SolarMeister leans **conversion**; Stashbox leans **awareness and engagement**, with conversion defined as streams, tickets, sign-ups, and merch.

The **7d index** is the primary score. The 24h index is an early signal. The 30d index is used for long-tail formats (YouTube, website).

---

## 5. Roll-ups & Creative Features

A single post's result is noise. Signal appears in aggregates.

### 5.1 Roll-up dimensions

- asset
- creative family
- product
- campaign
- content group (educational, product, testimonial, behind-the-scenes, promo…)
- topic
- format: kind, duration bucket, aspect ratio, placement
- destination and social account
- timing: day of week, hour (brand-local)
- copy style (see §5.3)
- creative features (see §5.2)

### 5.2 AI-extracted creative features

Tagged at ingestion (or backfilled) from frames, audio, and on-screen text:

- hook type (question, bold claim, reveal, problem/solution, humor, none)
- face on screen in the first 2 seconds
- text overlay present / in the first 2 seconds
- audio: music, voiceover, original sound, none
- pacing (cuts per 10s)
- shot type (product close-up, people, landscape, screen recording, timelapse)
- people present / count
- brand or logo visible early

These turn statistics into production instructions. For example: *"Educational battery videos under 20s with a text hook in the first 2 seconds outperform everything else on Reels."*

### 5.3 Copy features

For generated captions and titles: length bucket, hook style, CTA type, hashtag count, emoji use, question present.

### 5.4 Small-sample protection

Roll-up scores use **shrinkage (empirical Bayes)**: groups with few posts are pulled toward the brand average. Every roll-up shows its sample size and a confidence level. The brief and the dashboard do not present low-confidence findings as conclusions.

---

## 6. Feedback into the Auto Planner

Performance affects **scoring only** (SYSTEM-SPEC §8.2, step 3). Hard filters are unchanged.

| Mechanism | Behavior |
|---|---|
| **Winner boost** | Assets with a high asset-level index get a priority boost and may run at their minimum cooldown. |
| **Group boost** | Content groups, families, products, and features that perform well for this account get a boost. |
| **Fatigue detection** | If each rerun of an asset scores worse than the last, lengthen its effective cooldown. Below a threshold, suggest retirement. |
| **Cross-platform promotion** | An asset that performs strongly on one social account gets a scoring boost on other accounts it hasn't run on yet. This is a boost only. Cooldowns remain per social account. |
| **Exploration slots** | Default 25% of slots per account are reserved for assets with no or little history (bandit-style, e.g. Thompson sampling). Configurable per brand. |
| **Diversity floor** | Cap any one content group's share of an account's slots in a rolling window (default 40%). |
| **Copy learning** | Winning caption patterns for an account are fed back into copy-generation prompts as examples. |
| **Timing suggestions** | Learn best posting windows per account. Presented as suggested changes to `cadence_rules.preferred_windows`, which the user approves. |
| **Cadence suggestions** | Detect diminishing returns from extra weekly posts per account. Presented as suggestions. |

All factors used are written into `scheduled_posts.selection_reason`.

**Activation:** performance scoring is off for an account until it has enough history (default 30 published posts with 7d data). Until then, rules-only scoring plus exploration applies.

---

## 7. Attribution: Where the Heat Comes From

### 7.1 Post ID and UTM convention

Every scheduled post gets a short, URL-safe **post code** (e.g. `p_7f3k9a`). It travels in `utm_content`. Everything else is joined server-side from the ledger.

```
?utm_source=instagram          ← destination
&utm_medium=social_organic     ← social_organic | social_handoff | bio_page
&utm_campaign=holiday-2026     ← campaign slug, or "always-on"
&utm_content=p_7f3k9a          ← post code (the join key)
```

Rules: lowercase, hyphenated, no spaces, no personal data. `utm_term` is unused by default.

### 7.2 Branded short links

The engine creates a short link per post that 302-redirects to the UTM'd destination, for example `go.solarmeister-shop.de/7f3k9a`.

Benefits:
- **Clicks are counted server-side**, even when browsers block analytics scripts or visitors decline cookie consent. This is important for German traffic.
- **Destinations can be changed after posting** if a URL changes.
- **Clean, branded links** in captions and bios.

**Privacy:** click logs store no raw IP addresses and no personal data: timestamp, short code, referrer domain, coarse country, device class, and a daily-rotating salted hash for de-duplication. GDPR review is required before launch for EU brands.

**Domains:** each brand can use its own short-link subdomain (CNAME to Brand OS). Fallback is a shared Elettro short domain.

### 7.3 Platforms without clickable post links

| Platform / placement | Reality | Approach |
|---|---|---|
| Instagram feed / Reels | Caption links aren't clickable | Smart bio page (§7.4) |
| Instagram / Facebook Stories | Link sticker available | Tracked short link in the sticker |
| TikTok | Bio link only | Smart bio page |
| YouTube Shorts | Description links not clickable in Shorts | Pinned comment, related-video link, or channel link to the smart bio page |
| Facebook, LinkedIn, X | Links are clickable | Tracked short link directly in the post |
| Website | Owned | Internal tracking plus UTMs on outbound links |

### 7.4 Smart bio page

A Brand OS–hosted link-in-bio page per social account (or per brand), for example `go.solarmeister-shop.de/ig`.

- Updates automatically as posts publish: newest posts first, each tile using that post's tracked link.
- Pinned tiles for evergreen destinations (shop, contact, tickets).
- Visits carry `utm_medium=bio_page` and the post code of the tile clicked.
- Works with the brand's design tokens. Lightweight and fast.

This preserves attribution for "link in bio" traffic, which most tools lose.

### 7.5 Traffic that never clicks

Many people see a post and later type the URL or search the brand. To recover some of that:

- **Promo codes per channel or campaign** (e.g. `SOLAR-IG10`), created through the Shopify connection. A code used on an order attributes it.
- **Post-purchase survey** on the Shopify thank-you page: "How did you hear about us?" with options per network.
- **Branded search lift** (later): correlate branded search volume with posting activity.

### 7.6 Conversions

| Source | Data | Join |
|---|---|---|
| Shopify orders | order value, currency, products, landing page, referrer, discount codes | UTMs in landing page → post code; discount code → promo code |
| GA4 | view_item, add_to_cart, begin_checkout, purchase, sign-up, custom events | `utm_content` (session) → post code |
| Short-link clicks | click events | short code → post |
| Website forms | email sign-ups, contact forms | UTMs captured in hidden fields |

### 7.7 Attribution model

- **Primary: last social touch.** A conversion is credited to the last tracked social click within the brand's window (default 7 days).
- **Assisted credit:** earlier tracked social clicks inside a 30-day window get assisted credit, reported separately and not added to primary revenue.
- **Promo code** attribution overrides click attribution when both exist.
- Survey answers are reported alongside, not merged.

### 7.8 Brands without a shop

Conversion events are defined per brand in `attribution_settings`. For Stashbox: clicks to streaming services, ticket purchases (click-outs, or ticketing data if available), email sign-ups, and merch orders. Short links track click-outs even when the destination is Spotify or a ticketing site.

### 7.9 Attribution heat map

A per-brand view of **clicks → carts → orders → revenue** (or the brand's own conversion events), broken down by:

- destination and social account
- product
- content group
- creative family
- individual asset and post
- creative features

This is the "where the heat comes from" view. For conversion-objective brands it also feeds the Performance Index (§4.3).

---

## 8. Production Brief

A weekly, per-brand report that combines **supply** (what is in the pool) with **demand** (what performs).

### 8.1 Inputs

- pool inventory by content group, format, product, and destination fit
- pool gaps logged by the planner
- upcoming eligibility windows (annual and one-time) against expected cadence
- performance roll-ups and creative features
- fatigue signals
- attribution heat map

### 8.2 Sections

1. **What's working:** top content groups, formats, and features by index and by revenue, with confidence.
2. **Make more of this:** high performers with low remaining eligible inventory. *"Battery storage explainers (9:16, under 20s) run 2.3× baseline. You have 3 eligible and all are in cooldown until the 18th. Make 4–6 more."*
3. **Upcoming windows:** *"Holiday window opens Sep 15. You have 4 holiday assets; last year's cadence needs about 15."*
4. **Format gaps:** *"Instagram carousels: zero in the pool. Carousels are your best format on Facebook and LinkedIn."*
5. **Remix candidates:** fatiguing winners worth re-cutting. *"Panel Install Timelapse is fatiguing. Suggest a re-cut with a new hook in the first 3 seconds."*
6. **Where the money came from:** top revenue-driving posts, assets, and products for the period.

### 8.3 Delivery

Shown on the dashboard, optionally emailed, and available through the MCP server (`get_production_brief`). Briefs are stored so recommendations can later be checked against results.

The brief only suggests. The creator decides.

---

## 9. Dashboard Views

| View | Contents |
|---|---|
| Overview | Performance Index trend, top posts, revenue/conversions, pool health |
| Heat map | §7.9 |
| Assets | per-asset history across accounts, reruns, fatigue curve |
| Content insights | roll-ups by group, product, family, features |
| Accounts | per-account baselines, best times, cadence response |
| Production Brief | current and past briefs |

---

## 10. Guardrails

- No eligibility or cooldown decisions are made from analytics.
- Low-confidence findings are labeled and never auto-applied.
- Exploration and diversity floors cannot be set to zero without an explicit brand-level override.
- Timing and cadence changes require user approval.
- Every automated decision stores its performance inputs.
- Raw platform payloads are retained so scores can be recomputed when formulas change.

---

## 11. Schema Additions

Adds to `DATABASE-SCHEMA.md`. Replaces the `(later)` placeholder `post_metrics` definition.

### 11.1 Enums

```sql
CREATE TYPE age_bucket        AS ENUM ('1h','24h','7d','30d');
CREATE TYPE brand_objective   AS ENUM ('awareness','engagement','conversion','custom');
CREATE TYPE link_medium       AS ENUM ('social_organic','social_handoff','bio_page');
CREATE TYPE conversion_source AS ENUM ('shopify','ga4','short_link','form','manual');
CREATE TYPE attribution_type  AS ENUM ('last_social_touch','assisted','promo_code','survey');
```

### 11.2 Brand settings

```sql
CREATE TABLE attribution_settings (
  brand_id              uuid PRIMARY KEY REFERENCES brands ON DELETE CASCADE,
  objective             brand_objective NOT NULL DEFAULT 'engagement',
  objective_weights     jsonb NOT NULL DEFAULT '{}',   -- metric → weight, used when objective = custom
  primary_window_days   int NOT NULL DEFAULT 7,
  assisted_window_days  int NOT NULL DEFAULT 30,
  conversion_events     jsonb NOT NULL DEFAULT '[]',   -- e.g. ["purchase","sign_up","ticket_click"]
  short_link_domain     text,                          -- e.g. go.solarmeister-shop.de
  exploration_share     numeric NOT NULL DEFAULT 0.25,
  diversity_cap         numeric NOT NULL DEFAULT 0.40,
  min_posts_for_scoring int NOT NULL DEFAULT 30
);
```

### 11.3 Post codes

```sql
ALTER TABLE scheduled_posts ADD COLUMN post_code text UNIQUE;   -- e.g. p_7f3k9a
ALTER TABLE publication_ledger ADD COLUMN post_code text;       -- snapshot
CREATE INDEX ledger_post_code_idx ON publication_ledger (post_code);
```

### 11.4 Metrics & performance

```sql
CREATE TABLE post_metrics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id      uuid NOT NULL REFERENCES publication_ledger ON DELETE CASCADE,
  age_bucket     age_bucket NOT NULL,
  captured_at    timestamptz NOT NULL,
  views int, reach int, impressions int, engagements int,
  likes int, comments int, shares int, saves int,
  watch_time_s bigint, avg_view_duration_s numeric,
  link_clicks int, follows_gained int,
  raw            jsonb,
  UNIQUE (ledger_id, age_bucket)
);

CREATE TABLE account_baselines (
  social_account_id uuid REFERENCES social_accounts ON DELETE CASCADE,
  placement         placement,
  age_bucket        age_bucket,
  computed_at       timestamptz NOT NULL,
  sample_size       int NOT NULL,
  medians           jsonb NOT NULL,        -- metric → median
  source            text NOT NULL,         -- account | brand_fallback | global_default
  PRIMARY KEY (social_account_id, placement, age_bucket)
);

CREATE TABLE post_performance (
  ledger_id         uuid REFERENCES publication_ledger ON DELETE CASCADE,
  age_bucket        age_bucket,
  relative_scores   jsonb NOT NULL,        -- metric → ratio to baseline
  performance_index numeric NOT NULL,
  objective         brand_objective NOT NULL,
  formula_version   int NOT NULL,
  computed_at       timestamptz NOT NULL,
  PRIMARY KEY (ledger_id, age_bucket)
);

CREATE TABLE performance_rollups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  social_account_id uuid REFERENCES social_accounts,   -- null = brand-wide
  dimension         text NOT NULL,          -- asset | creative_family | product | content_group | feature:hook_type ...
  dimension_value   text NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  sample_size       int NOT NULL,
  raw_mean_index    numeric,
  shrunk_index      numeric,                -- empirical Bayes estimate
  confidence        text,                   -- low | medium | high
  conversions       int,
  revenue           numeric(12,2),
  computed_at       timestamptz NOT NULL
);
CREATE INDEX rollups_lookup_idx ON performance_rollups (brand_id, dimension, period_end DESC);
```

### 11.5 Creative & copy features

```sql
CREATE TABLE asset_features (
  asset_id         uuid PRIMARY KEY REFERENCES assets ON DELETE CASCADE,
  hook_type        text,
  face_first_2s    boolean,
  text_overlay     boolean,
  text_first_2s    boolean,
  audio_type       text,                   -- music | voiceover | original | none
  cuts_per_10s     numeric,
  shot_types       text[],
  people_count     smallint,
  logo_early       boolean,
  extra            jsonb NOT NULL DEFAULT '{}',
  model            text NOT NULL,
  extracted_at     timestamptz NOT NULL
);

ALTER TABLE scheduled_posts ADD COLUMN copy_features jsonb;   -- length bucket, hook style, CTA type, hashtag count...
```

### 11.6 Links, clicks & bio pages

```sql
CREATE TABLE tracked_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  short_code        text NOT NULL UNIQUE,   -- e.g. 7f3k9a
  scheduled_post_id uuid REFERENCES scheduled_posts,
  post_code         text,
  medium            link_medium NOT NULL,
  destination_url   text NOT NULL,          -- final URL without UTMs
  utm               jsonb NOT NULL,         -- source, medium, campaign, content
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE link_clicks (                 -- privacy-minimal, see §7.2
  id              bigserial PRIMARY KEY,
  tracked_link_id uuid NOT NULL REFERENCES tracked_links ON DELETE CASCADE,
  clicked_at      timestamptz NOT NULL DEFAULT now(),
  referrer_domain text,
  country         char(2),
  device_class    text,                   -- mobile | desktop | tablet | bot
  visitor_hash    text                    -- daily-rotating salted hash, de-dup only
);
CREATE INDEX link_clicks_link_idx ON link_clicks (tracked_link_id, clicked_at DESC);

CREATE TABLE bio_pages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  social_account_id uuid REFERENCES social_accounts,   -- null = brand-wide
  slug              text NOT NULL,          -- e.g. ig
  pinned_links      jsonb NOT NULL DEFAULT '[]',
  max_post_tiles    int NOT NULL DEFAULT 12,
  theme             jsonb NOT NULL DEFAULT '{}',
  UNIQUE (brand_id, slug)
);
```

### 11.7 Promo codes, conversions & surveys

```sql
CREATE TABLE promo_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  code              text NOT NULL,
  destination       destination,
  social_account_id uuid REFERENCES social_accounts,
  campaign_id       uuid REFERENCES campaigns,
  external_id       text,                   -- Shopify discount id
  active            boolean NOT NULL DEFAULT true,
  UNIQUE (brand_id, code)
);

CREATE TABLE conversions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  source            conversion_source NOT NULL,
  event_name        text NOT NULL,          -- purchase | add_to_cart | sign_up | ticket_click ...
  external_id       text,                   -- order id, GA4 event id
  occurred_at       timestamptz NOT NULL,
  value             numeric(12,2),
  currency          char(3),
  products          jsonb,                  -- product ids / handles / quantities
  utm               jsonb,
  discount_codes    text[],
  raw               jsonb,
  UNIQUE (brand_id, source, external_id, event_name)
);

CREATE TABLE conversion_attributions (
  conversion_id     uuid REFERENCES conversions ON DELETE CASCADE,
  ledger_id         uuid REFERENCES publication_ledger,
  tracked_link_id   uuid REFERENCES tracked_links,
  promo_code_id     uuid REFERENCES promo_codes,
  attribution       attribution_type NOT NULL,
  credit            numeric NOT NULL DEFAULT 1.0,
  PRIMARY KEY (conversion_id, attribution, ledger_id)
);

CREATE TABLE survey_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  conversion_id  uuid REFERENCES conversions,
  answer         text NOT NULL,           -- instagram | tiktok | youtube | friend | search | other
  free_text      text,
  answered_at    timestamptz NOT NULL
);
```

### 11.8 Production briefs

```sql
CREATE TABLE production_briefs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  sections      jsonb NOT NULL,           -- structured recommendations with evidence + confidence
  summary_md    text,
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 12. Jobs

| Job | Frequency |
|---|---|
| Metrics capture | scheduled per post at 1h / 24h / 7d / 30d |
| Baseline recompute | nightly |
| Performance index | after each metrics capture |
| Roll-ups | nightly |
| Shopify order sync | webhook (`orders/create`) + nightly reconciliation |
| GA4 import | daily |
| Attribution | on new conversion + nightly backfill |
| Asset feature extraction | at ingestion; backfill job for existing assets |
| Production Brief | weekly per brand (default Monday 06:00 brand time) |

---

## 13. Sequencing

| Phase | Timing | Scope |
|---|---|---|
| **A. Collect** | Sprint 2, with the first publisher | post codes, UTMs, short links, link clicks, metrics capture, Shopify order sync. Start immediately, because learning needs history. |
| **B. See** | after ~6–8 weeks of data | baselines, Performance Index, heat map, roll-ups, first Production Brief, smart bio page |
| **C. Act** | after B is trusted | planner scoring with winner boost, fatigue, exploration slots, diversity floor |
| **D. Optimize** | with enough volume per account | timing and cadence suggestions, copy learning, GA4 funnel steps, assisted attribution |

Asset feature extraction can start in Sprint 1 at ingestion, since it costs little and gives the features time to accumulate.

---

## 14. Open Decisions

1. Short-link domain strategy: per-brand subdomains from day one, or the shared Elettro domain first.
2. GA4 integration depth: Data API import vs. BigQuery export.
3. Exploration algorithm: Thompson sampling vs. a simple fixed-share rotation for V1.
4. Formula version management for the Performance Index (recompute history or forward-only).
5. GDPR review for click logging and the smart bio page (EU brands).
6. Whether Stashbox ticketing data is available via API or click-outs only.
