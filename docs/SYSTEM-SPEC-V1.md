# Elettro Brand OS — System Specification V1

**Status:** Draft v1
**Owner:** Dean Palermo / Elettro Interactive
**Repo:** `elettro/elettro-brand-os`
**First module:** Publishing Engine

> Earlier explorations ("Stashbox Content Pools + Auto Planner", "Elettro Publishing Engine") are superseded by this document. Stashbox is a brand inside the system, not the product name.

---

## 1. Product Statement

Elettro Brand OS lets creators and brands focus on **producing and approving content**, while the intelligence layer handles **selection, platform-specific optimization, scheduling, distribution, reuse, and publication history** across connected channels.

**Create. Approve. The engine distributes.**

Most brands don't lack content. What they lack is the operational bandwidth to distribute it properly, so good creative sits unused. Brand OS turns an approved creative library into an always-on, rules-aware publishing system.

---

## 2. Core Principles

1. **Folders are for humans. Metadata powers the automation.** Folder paths may *suggest* metadata at ingestion. The planner never selects by folder name.
2. **Only approved assets can publish.** Newly loaded assets are approved by default. If the user checks **Send to approval queue** during import, the asset enters `needs_review` instead.
3. **Rules decide eligibility. AI decides among the eligible.** Eligibility windows, cooldowns, and spacing are deterministic and auditable (SQL and code). AI handles ranking, copy, titles, and gap analysis.
4. **One asset, many executions.** One master asset produces several platform-optimized posts. Copy is never pasted across platforms unchanged.
5. **The Ledger is the memory.** Every publication is recorded. Cooldowns, history, and performance all read from it.
6. **Preserve creative intent.** The engine behaves like a strategist working from an approved library with rules, priorities, and history. It does not behave like a randomizer.
7. **Multi-brand from day one.** Every record belongs to a brand, and every brand belongs to an organization.
8. **One backend, many interfaces.** The dashboard, the MCP server (Claude, ChatGPT, others), and future APIs all call the same service layer and the same permission checks.

---

## 3. Glossary

| Term | Definition |
|---|---|
| **Organization** | Billing and tenancy root (Elettro, an agency, a client company). |
| **Brand** | A workspace inside an org (SolarMeister, Stashbox, Elettro). Switching brands switches everything. |
| **Asset** | A master creative file: video, image, or carousel (a group of images or videos). |
| **Asset Variant** | A derived version of an asset for a specific destination and placement (a crop, a cut, a re-encode). |
| **Creative Family** | A group of assets from the same shoot or concept. Used for spacing so near-duplicates don't run back to back. |
| **Product** | A product, service, or topic the asset represents. |
| **Campaign** | A named marketing effort (Holiday, Black Friday 2026, Spring Launch). |
| **Content Pool** | The set of assets that are approved, not retired, and currently inside their eligibility window. |
| **Destination** | A channel: YouTube, TikTok, Instagram, Facebook, X, LinkedIn, Website. |
| **Placement** | A format within a destination: Feed Post, Reel/Short, Story. |
| **Social Account** | A connected account for one destination, owned by a brand. |
| **Scheduled Post** | A planned execution, meaning a specific asset or variant going to a specific account and placement at a specific time with its own copy. |
| **Publication Ledger** | An append-only record of what was published, where, when, and how. |
| **Publishing Mode** | Auto, Approval Required, or Handoff (see §9). |

---

## 4. End-to-End Workflow

```
Dropbox (brand root + subfolders)
  ↓ detect
Ingestion → asset record
  ↓
Media analysis (dimensions, ratio, duration, format, hash)
  ↓
AI analysis (description, suggested topic/product/family, tags)
  ↓
Metadata review (human edits/confirms)
  ↓
Approval (creator and/or client)
  ↓
Content Pool (approved ∩ eligible ∩ not retired)
  ↓
Auto Planner (slots → hard filters → scoring → selection)
  ↓
Platform treatment (variant + copy per destination/placement)
  ↓
Review (per publishing mode)
  ↓
Publish (API) or Handoff (native app)
  ↓
Publication Ledger
  ↓
Analytics feedback → informs future scoring
```

---

## 5. Ingestion

### 5.1 Source

- **V1: Dropbox.** Each brand has one or more connected root folders, for example `/Elettro Brand OS/SolarMeister/`.
- Use the Dropbox delta cursor (`list_folder/continue`) plus webhooks for change detection. Polling is a fallback only.
- **Later:** Google Drive, direct upload, S3.

### 5.2 Per-file processing

1. Create an asset record with status `ingesting`.
2. Store the Dropbox file ID, path, size, and content hash. The hash enables duplicate detection across folders.
3. Run media inspection (ffprobe or sharp): width, height, aspect ratio, orientation, duration, codec, and format.
4. Run AI analysis on a representative frame or image plus the filename and path. It returns a description, suggested topic, suggested product, suggested creative family, and tags.
5. Apply **folder-suggested metadata**. Path segments map to campaign, product, or season hints. These are suggestions only and are flagged as such.
6. Set approval status to `approved` by default. If **Send to approval queue** is checked during import, set approval status to `needs_review`.

### 5.3 Moves, renames, deletes

- A move or rename updates the path and keeps the asset ID, history, and ledger entries.
- A deletion in Dropbox sets the asset to `source_missing` and removes it from the pool. Ledger history is kept.

---

## 6. Asset Metadata Model

### 6.1 Fields

| Field | Notes |
|---|---|
| Asset kind | video / image / carousel (detected) |
| Aspect ratio, orientation, duration | detected |
| Product | FK |
| Topic | free text and/or controlled list |
| Campaign | FK, optional |
| Creative Family | FK, optional but strongly encouraged |
| Content Group | e.g. educational, product, testimonial, behind-the-scenes, promo |
| Eligibility Type | `evergreen` / `annual` / `one_time` |
| Eligible From / Until | dates (one_time) or month-day (annual) |
| Contains specific pricing/offer | boolean; forces `one_time` |
| Priority | low / normal / high / hero |
| Allowed destinations | defaults to all compatible; can exclude |
| Cooldown override | optional per-asset override of the exact-asset cooldown |
| Approval status | see §7 |
| Notes / creative intent | free text, fed to AI copywriting |

### 6.2 Eligibility types

| Type | Behavior | Example |
|---|---|---|
| **Evergreen** | Always eligible until retired. | Panel install explainer |
| **Annual** | Eligible every year between month-day bounds. Windows may wrap the year (Nov 15 → Jan 5). | Christmas Video 17: Sep 15 → Dec 25, repeats |
| **One-time** | Eligible between absolute dates, then auto-retires. | Black Friday 2026 Offer: Nov 20 → Nov 30, 2026 |

Rule: if `contains_specific_pricing = true`, the eligibility type is forced to `one_time`, so that expired prices never resurface.

---

## 7. Approval

**States:** `needs_review` → `approved` | `rejected` → (`retired`)

- An approval is recorded with approver, timestamp, and role.
- Brand setting `approval_policy`:
  - `creator` — any brand editor can approve.
  - `client` — requires a user with the `approver` role (the client).
  - `creator_and_client` — both required.
- Asset import includes a **Send to approval queue** checkbox. It is **unchecked by default**. Unchecked imports enter as `approved`; checked imports enter as `needs_review`.
- Bulk approval is supported for client/review workflows.
- **Retire** removes an asset from the pool permanently but keeps its history. One-time assets auto-retire after `eligible_until`.

---

## 8. Auto Planner

### 8.1 Inputs

- **Cadence rules** per social account and placement (e.g. SolarMeister IG Reels: 4/week, preferred windows Tue–Sat 11:00–13:00 brand time).
- **Content Pool** for the brand.
- **Publication Ledger** history.
- **Cooldown rules** (§8.4).
- **Campaign weighting** (active campaigns needing coverage).
- **Performance data** (later sprints).

### 8.2 Process (per planner run, rolling horizon, default 14 days)

1. **Generate slots** from cadence rules for the horizon.
2. For each slot, **hard-filter** the Content Pool. All of these are deterministic:
   - approved, not retired, source present
   - inside eligibility window on the slot date
   - compatible with the destination and placement (kind, aspect ratio, duration limits), or a valid variant exists or can be generated
   - not excluded for this destination
   - passes all cooldown rules relative to the ledger and to already-planned posts in this run
3. **Score** the remaining candidates. These are soft preferences:
   - time since last use (longer is better)
   - priority
   - campaign coverage gap
   - product and content-group balance (underrepresented gets a boost)
   - seasonal relevance (closer to the window's peak gets a boost)
   - historical performance (later)
4. **Select** the top candidate, or let AI pick from the top N with a written rationale stored on the post.
5. **Generate the platform treatment** (§10).
6. Create the scheduled post with the brand's publishing mode for that account.

If no candidate passes the hard filters, leave the slot empty and log a **pool gap** ("SolarMeister has no eligible 9:16 assets for TikTok next week"). Pool gaps are a key dashboard signal because they tell the creator what to make next.

### 8.3 Planner outputs are explainable

Every planned post stores *why* it was chosen: filters passed, score breakdown, and AI rationale if used.

### 8.4 Cooldown & spacing rules

**Purpose:** keep each individual social profile from repeating content too often. Cooldowns are evaluated **per social account only**. No cross-network rules exist in V1, so an asset posted to Instagram has no effect on its eligibility for TikTok.

Values are configurable per brand:

| Rule | Default |
|---|---|
| Same exact asset | 45 days |
| Same creative family | 21 days |
| Same product | 5 days |
| Same campaign | no consecutive posts |

- Only ledger entries and planned posts for the **same social account** count toward a cooldown.
- An asset's `cooldown_override_days` replaces the exact-asset value for that asset.
- A brand with two accounts on the same network (e.g. two Instagram profiles) tracks cooldowns separately for each.

---

## 9. Publishing Modes

Set per social account (brand default, overridable).

| Mode | Behavior | Use when |
|---|---|---|
| **Auto** | Publishes at the scheduled time via API. | Destination API allows it and the brand trusts the engine. |
| **Approval Required** | Planner builds the queue; a human approves posts individually or in batch before they can publish. | Client brands, new brands, early trust-building. |
| **Handoff** | Engine prepares everything (media variant plus copy); the human posts in the native app and confirms. | API doesn't allow direct posting (unaudited TikTok, IG Stories, personal accounts), or the human wants native features (music, stickers). |

Handoff means the product works on day one for every destination, regardless of API approval status. Handoff confirmation writes to the ledger with `method = handoff`, and the user can paste the live URL.

---

## 10. Platform Treatment

For each scheduled post, the engine produces:

| Destination | Generated fields |
|---|---|
| Instagram | caption (longer, CTA), hashtags, placement settings |
| TikTok | short hook-first caption, hashtags |
| YouTube Shorts | title, description, keywords, synthetic-media flag if applicable |
| Facebook | caption (different structure from IG) |
| LinkedIn | professional-context caption, if brand allows LinkedIn |
| X | short copy within the character limit |
| Website | title, body or summary, alt text, structured data, social embeds after publication |

AI copy inputs: asset AI description, metadata, creative intent notes, brand voice (from the Knowledge module, initially a brand settings field), product info, campaign brief, and recent captions for that account, to avoid repetitive phrasing.

### 10.1 Variants

If a master asset doesn't fit a placement (16:9 master to a 9:16 Reel), the engine can:
- use an existing variant
- generate one (crop or reframe), which must be approved before use unless the brand allows auto-variants
- skip the asset for that slot

---

## 11. Destinations & Placements (V1 matrix)

| Destination | Feed | Reel/Short | Story | API status notes |
|---|---|---|---|---|
| YouTube | — | ✓ (Shorts) | — | Data API; per-project upload quota is limited by default and must be planned for multi-tenant |
| Instagram | ✓ | ✓ | Handoff | Graph API; requires Business/Creator account and Meta app review |
| Facebook | ✓ | ✓ | Handoff | Graph API; Meta app review |
| TikTok | — | ✓ | — | Content Posting API; unaudited apps limited to private posts, so Handoff until audit passes |
| LinkedIn | ✓ | — | — | Org page posting requires approved API access |
| X | ✓ | — | — | Paid API tier |
| Website | ✓ (post) | — | — | Shopify blog, WordPress, or custom endpoint via connector |

**Action item:** start Meta, TikTok, and LinkedIn app reviews during Sprint 1. They take weeks.

---

## 12. Website as a Destination

- Publish selected assets to the brand's own site as owned content.
- Preserve media, caption, metadata, and campaign context.
- After social publication, attach social URLs or embeds to the website post.
- This builds an owned content stream, not just a social archive, and connects directly to the Blog + SEO and AI Search modules.

---

## 13. Publication Ledger

- Append-only. Entries are never edited after publication; corrections are new entries.
- Denormalizes asset, creative family, product, and campaign at publish time, so cooldown queries stay fast and history stays accurate even if the asset's metadata changes later.
- Stores the external post ID and URL, method (api / handoff / manual), and publisher (system or user).
- Metrics are captured on a schedule after publication (1h, 24h, 7d, 30d) in a separate metrics table.

---

## 14. Intelligence Layer & MCP

### 14.1 Principle

The MCP server is **one client of the service layer**. It never touches the database directly. Every tool call:
1. authenticates the Elettro user (OAuth)
2. resolves org and brand
3. checks role permissions
4. checks plan entitlements and usage limits
5. executes through the same service functions the dashboard uses
6. writes to the activity log

### 14.2 Initial tool set (later sprint)

- `list_brands`, `switch_brand`
- `search_assets`, `get_asset`, `update_asset_metadata`, `approve_assets`
- `get_content_pool_summary`, `get_pool_gaps`
- `run_planner`, `get_calendar`, `approve_scheduled_posts`, `reschedule_post`
- `generate_post_copy`
- `get_publication_history`, `get_performance_summary`

### 14.3 Model abstraction

All AI calls go through `/packages/ai` with a provider interface. The model is chosen per task (vision analysis, copywriting, planning rationale). Every call is logged with tokens and cost for entitlement metering.

---

## 15. Multi-Tenancy, Roles & Entitlements

### 15.1 Roles (per brand)

| Role | Capabilities |
|---|---|
| Owner | everything, including billing and connections |
| Admin | everything except billing |
| Editor | manage assets, metadata, calendar; approve if `approval_policy = creator` |
| Approver | approve assets and posts (client role) |
| Viewer | read only |

### 15.2 Entitlements (plan-driven)

Brand count, user seats, connected social accounts, scheduled posts per month, monthly AI allowance, and enabled modules. These are enforced in the service layer, not the UI.

Pricing tiers are TBD and will be validated against measured AI and storage cost per brand. Exploratory figures: Free / $19 / $79 / Enterprise.

---

## 16. Modules

| Module | Status |
|---|---|
| Assets & Content Pool | Sprint 1 |
| Publishing Engine (planner, calendar, publishers, ledger) | Sprints 2–4 |
| Knowledge (brand voice, products, guidelines) | early, minimal in Sprint 2 |
| Analytics | after first publisher is live |
| Blog + SEO | later |
| AI Search Monitoring (AIO Authority) | later |
| Client Collaboration | later |
| Commerce | later |

---

## 17. Non-Goals for V1

- Public ChatGPT or Claude plugin listing
- Client billing / Stripe
- Full analytics dashboards
- Blog production
- Video editing beyond automated crops and reframes
- Paid ads management

---

## 18. Roadmap

| Sprint | Goal |
|---|---|
| **1** | Foundation: repo, auth, orgs and brands, Dropbox ingestion, media analysis, metadata, approval, Content Pool, first AI analysis and copy. File platform app reviews. |
| **2** | Calendar + Auto Planner + cooldown engine + **YouTube Shorts** publisher end-to-end + Ledger. Handoff mode for all other destinations. |
| **3** | Instagram + Facebook publishers (pending Meta review), approval queue UI, variants. |
| **4** | TikTok (post-audit), LinkedIn, Website destination, metrics capture. |
| **5** | MCP server (internal use first), pool-gap dashboard, performance-informed scoring. |

---

## 19. Open Decisions

1. Hosting: AWS (ECS/Fargate + RDS) vs. a simpler PaaS (Vercel + Neon/Supabase + a worker host) for V1 speed.
2. Auth provider: Clerk / Auth.js / Cognito.
3. Job queue: BullMQ (Redis) vs. Postgres-based (pg-boss / Graphile Worker).
4. Media storage for variants: S3 vs. writing back to Dropbox.
5. Default cooldown values per brand type: validate with SolarMeister data.
6. Should planner AI selection be on by default, or rules-only scoring until performance data exists?
