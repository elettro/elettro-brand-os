# EPE Intelligence

The knowledge the Elettro Publishing Engine (EPE) uses when an AI model makes a
creative decision. Everything here is loaded at runtime by a specific AI task.
If no task loads a file, the file does not belong here.

Status: **authored, not yet wired.** See [Rollout](#rollout) for how each file
becomes active and how we verify it is used.

---

## 1. The one rule

> **Code enforces. Intelligence advises. Data informs.**

| Layer | Holds | Lives in | Can the AI override it? |
|---|---|---|---|
| **Rules** | Cooldowns, cadence, daily maximums, sector shares, exploration %, eligibility windows, approval, usage rights, platform size/duration/character specs | Database + code (`CooldownRule`, `CadenceRule`, `Brand.settings`, platform spec config). Seeded from `brands/<slug>/policy.json`. | **No.** Code filters before the AI sees candidates and re-checks after. |
| **Shared intelligence** | How EPE judges assets, picks content, writes copy, treats each platform | `intelligence/shared/*.md` | Brand files may refine soft guidance, never the hard rules in `operating-principles.md`. |
| **Brand intelligence** | Identity, voice, audience, sectors, restrictions, brand-specific platform tactics | `intelligence/brands/<slug>/*.md` | Wins over shared guidance where they conflict. |
| **Live facts** | Assets, songs, shows, products, blog posts, campaigns, recent captions, publication history | Database, queried per decision | Facts are facts. If a fact is missing, the AI says so. It never fills the gap. |
| **Performance** | Metrics, performance index, fatigue, winners | Metrics tables, computed scores | Feeds **scoring** only. Never written into Markdown. |

A posting limit written only in Markdown is a suggestion. The same limit in
`CadenceRule` is a guarantee. Numbers live in config. Judgment lives here.

---

## 2. Structure

```
intelligence/
  README.md                     this file: architecture, loading, rollout
  manifest.json                 machine-readable: which task loads which files, budgets, precedence
  shared/
    operating-principles.md     ALWAYS loaded: role, precedence, honesty, missing info, output discipline
    asset-analysis.md           task: enrich_asset (understand an image/video)
    creative-selection.md       task: select_content (pick 1 of the planner's top candidates)
    copywriting.md              task: write_copy (caption, title, hook, CTA, hashtags)
    platforms.md                reference: creative norms per destination, loaded by section
  brands/
    stashbox/
      brand.md                  identity, audience, the 7 sectors, restrictions (voice: pending Dean's notes)
      platforms.md              Stashbox-specific tactics per platform, loaded by section
      policy.json               Dean's approved numbers: seed for DB rules, versioned here
```

### Why these files and not more

Each shared task file maps to exactly one runtime AI call. `operating-principles`
is shared by all of them. `platforms` is reference material, split by section so
a TikTok decision never pays for the LinkedIn section.

| File | Consumer (code) | Loaded when |
|---|---|---|
| operating-principles | every AI call via the context builder | always |
| asset-analysis | enrichment worker (`apps/web/lib/asset-ai-enrichment.ts` → to be moved behind `packages/ai`) | asset ingested / re-enriched |
| creative-selection | Planner V1 step 4 (`services/dev-api-lambda/index.mjs` `runPlannerV1`) | a slot has ≥2 candidates after hard filters |
| copywriting | copy generation → `ScheduledPost.generatedCaption/Title/Hashtags` | a slot has a selected asset |
| platforms (section) | selection + copy | the slot's destination |
| brands/<slug>/brand.md (section) | every task | the brand is resolved; sector section when the slot has a sector |
| brands/<slug>/platforms.md (section) | selection + copy | that brand + destination, if a section exists |

### Deliberately NOT here

| Not here | Where instead | Why |
|---|---|---|
| Posting frequencies, daily caps | `CadenceRule` + daily max per account | Must be enforced, not suggested |
| Cooldowns (30d asset / 1d song / 15d product) | `CooldownRule` | Enforced in planner hard filters |
| Sector shares (28/20/14/13/11/8/6), exploration (40% TikTok / 25% others) | `Brand.settings` | Planner balance math |
| Aspect ratios, durations, character limits | `platform-specs` code config | Machine-checked; a wrong spec silently blocks assets, so values are verified against official platform docs before enforcement |
| Song links, show dates, product prices | Song / Show / ShopifyProduct records | Facts change; prices are read live at publish time |
| Analytics, "what worked" | Metrics tables → scores | Raw data in prose rots and bloats context |
| Tag vocabulary | Per-brand vocabulary table, passed to the model as a list | Must be exact strings, not prose |

### Deferred files (written when their consumer exists)

| File | Consumer | Phase |
|---|---|---|
| `shared/campaign-planning.md` | campaign builder + gap briefs ("what new content to make") | 5 |
| `shared/performance-review.md` | weekly performance narrative + paid-media (Google Ads) candidate review | 5 |
| `shared/creative-production.md` | production tasks: reframes, branded templates, clip edits, generative | 6 |

Writing these before their consumer exists would produce exactly what this
folder must never be: documents that influence nothing. Their planned content
is outlined in [§8](#8-later-phases-planned-content).

---

## 3. How a decision loads intelligence

The **context builder** (`packages/ai`, to be built) assembles each AI call:

```
system  = shared/operating-principles.md
        + shared/<task>.md
        + shared/platforms.md#<destination>            (selection, copy)
        + brands/<brand>/brand.md#core
        + brands/<brand>/brand.md#<sector>             (when the slot has a sector)
        + brands/<brand>/platforms.md#<destination>    (if that section exists)
user    = live JSON: slot, candidates or asset, subject facts (song/show/product/post),
          campaign, last N captions on this account, vocabulary lists
```

### Sections

Files that are loaded in parts use level-2 headings with a slug in brackets:

```
## [tiktok] TikTok
```

The loader extracts from that heading to the next level-2 heading. Content
before the first bracketed heading is the file's **core** and is always included
with any section.

### Precedence (highest wins)

1. Code-enforced rules. The AI never sees candidates that break them, and output is re-validated.
2. `operating-principles.md` → **Hard rules** section. Not overridable by any brand.
3. Brand restrictions (`brand.md` → Restrictions).
4. Brand + platform section.
5. Brand sector/core guidance.
6. Shared task file and shared platform section.

When two instructions at the same level conflict, the model picks the more
conservative option and reports the conflict in `notes` so a human can fix the file.

### Budgets

Target guidance size per call (excluding live JSON), enforced by a CI check:

| Task | Max guidance tokens |
|---|---|
| enrich_asset | 4,000 (frames dominate this call's cost, not guidance) |
| select_content | 5,500 (one call sequences an account's whole week, so it carries every active sector's section) |
| write_copy | 4,500 |

### Versioning and provenance

- Files live in git. Changes go through PRs like code.
- On deploy, the build computes a SHA-256 per file and a bundle version.
- Every AI decision stores `intelligenceVersion` and the list of files + hashes
  it loaded (in `ScheduledPost.scoreBreakdown` / the asset's `aiSuggestions`).
- A change becomes active on the next deploy. Rollback = revert the commit.

### Missing intelligence

- Missing brand file for a brand → the task **fails loudly**. No silent generic fallback for brand voice.
- Missing platform section → shared section only, flagged in output `notes`.
- Missing facts (no song link, no booking URL) → the AI must not invent them. Copy
  tasks return `status: "blocked"` with the missing field named. That becomes a dashboard item.

---

## 4. Runtime decision flow (one slot)

```
Planner (code)
  1. Slots from CadenceRule for the horizon (default 14 days)
  2. Assign a sector to the slot: furthest below its share this week,
     after exploration slots (40% TikTok / 25% others) are reserved
  3. Hard filters: approved · ready · source present · eligibility window ·
     destination allowed · format fits platform spec · CooldownRule
     (asset 30d · song 1d · product 15d · session none) · daily max
  4. Score: new-batch boost · time since last use · priority · campaign (60/40) ·
     subject balance · (later) performance
  5. Top N (default 5) per slot → AI select_content, one call per account-week
     (the curator sequences the week like a DJ)     ← creative-selection.md
     Code re-runs steps 3–4 with the curator's picks; any pick that is no
     longer valid falls back to the rules' #1. 0 candidates → empty slot + gap logged
AI write_copy                                       ← copywriting.md
Validation (code): schema · length per platform · link is a real record URL ·
  no price unless from live Shopify data · banned claims · cooldown re-check
ScheduledPost (status planned) with selectionReason, scoreBreakdown, intelligenceVersion
  → publishing mode: auto | approval | handoff
  → PublicationLedger on publish (append-only)
  → metrics at 1h / 24h / 7d / 30d → performance index → scoring (never hard filters)
```

---

## 5. Post templates: approve a style once, replicate it across the catalog

Dean's direction (2026-10-17): EPE proposes a **variety of post styles** for a
kind of subject (a Shopify product, a radio song, a streaming release). Dean
approves the styles he likes. Each approved style becomes a **template** that
EPE then cycles through the whole catalog: 600 products, every song.

A template is **structure, not intelligence**, so it lives in config and code,
not in this folder:

| Part | What it is | Lives in |
|---|---|---|
| Template record | id, name, brand, sector, subject type (product / song / show / blog post), destinations + placements, status (`draft` / `approved` / `retired`), version | Database (`PostTemplate`) |
| Visual layout | the render composition: image or video layout, typography, brand kit, motion | HyperFrames/Remotion composition in the repo, versioned |
| Data bindings | which subject fields fill which slots: product title/image/price/collection; song artwork/title/radio link/streaming links | Template record |
| Copy structure | the slots the AI fills (hook, line, CTA) and their length targets | Template record |

The cycle:

1. **Style lab:** EPE renders 6–10 distinct styles for one sample subject
   (e.g. one t-shirt, one song) across placements. Dean approves, edits or
   rejects each.
2. **Approved style → template.** Locked layout and brand kit; only the data
   bindings and copy slots vary.
3. **Replicate:** the planner picks a subject (respecting cooldowns: product
   15 days, song 1 day) and a template; the renderer fills it from live data;
   `write_copy` fills the copy slots. Output enters the pool as a pending asset
   linked to its template and subject.
4. **Variety by rotation:** subject × template × angle combinations rotate, so
   600 products × several approved templates never feels repeated.
5. **Earned autonomy:** a template whose outputs are approved unedited over a
   sustained run can be switched to auto-approve. Dean can retire a template anytime.

This pulls level B of creative production ([§8](#8-later-phases-planned-content))
forward: it's deterministic and brand-safe, and it fills the merch, radio and
streaming sectors at scale from structured data alone.

---

## 6. How this folder learns

Persistent strategy (this folder) and changing performance (database) stay apart.

- Metrics adjust **scores** automatically (winner boost, group boost, fatigue,
  cross-platform promotion), as specified in `docs/ANALYTICS-SPEC.md` §6.
- When a pattern holds over time (e.g. "Sublime clips with crowd shots convert
  bookings on Facebook"), it is proposed as a PR to the relevant brand file,
  with the evidence window and metric in the PR description. A human merges it.
- Nothing appends analytics to Markdown automatically.

---

## 7. Rollout

Each step ends with a check proving the file is used, not just present.

| # | Step | Proof it works |
|---|---|---|
| 1 | **Rules into config.** `CooldownRule` table, sectors + shares + exploration in `Brand.settings`, `song` subject type, Stashbox `SocialAccount` + `CadenceRule` seeded from `policy.json`. Planner reads them instead of hard-coded 45/21/5. | Change a value in `policy.json`, re-seed, planner output changes. |
| 2 | **Context builder + loader** in `packages/ai`: section extraction, precedence assembly, budgets, hashes. | Unit tests; deleting a referenced file fails the task loudly; CI budget check. |
| 3 | **asset-analysis live.** Multi-frame + transcript video analysis on Haiku 5.5 (Bedrock). Re-enrich Stashbox videos. | Before/after on 20 assets; output carries the file hash. |
| 4 | **Data sources:** radio `songs` → Song records with `?song=key` links; song parsed from the shorts filename convention (`YYMMDD-stashbox-does-<show>-<song>-<ratio>-…`); blog posts; Shopify sync; streaming links; booking link. | Copy tasks stop returning `blocked` for missing links. |
| 5 | **creative-selection live** at planner step 4, shadowing rules-only picks for one week. | Side-by-side picks reviewed by Dean. |
| 6 | **copywriting + platforms live.** Captions on every ScheduledPost, handoff mode first. | Dean's edit rate on captions is the quality metric. |
| 7 | **Post templates (§5):** style lab for one product and one song; Dean approves styles; replicate across the Shopify catalog and the song catalog. | Approved templates render correctly for 20 random subjects; Dean's approval rate per template. |
| 8 | **Publishing:** YouTube Shorts API first, then Meta, others; UTM/post codes; radio registration attribution. | Ledger rows with external URLs; registrations traced to posts. |
| 9 | **Learning:** performance index, `performance-review.md`, `campaign-planning.md`. | Scores shift with results; paid-media candidates listed. |
| 10 | **Creative production:** `creative-production.md` (reframes, smart edits, generative). | Pending generated assets with provenance pass review. |
| 11 | **Nice to have: Who / What / When / Where.** Session records (date, location, type, roster), Person and Location records, capture-date/GPS extraction, a session page, and a Who/What/When/Where panel on the asset page. Also fixes the intake form's Genre / Session Date / Session Type / tags / collection / campaign, which `complete-dropbox-upload` currently drops. Until then, `asset-analysis` output for session, location and people is kept in `Asset.aiSuggestions` only. | Editing a session's roster updates every linked clip on the asset page. |

---

## 8. Later phases: planned content

**campaign-planning.md**: turning a campaign brief (goal, dates, sector, offer,
CTA, links) into a coordinated multi-platform plan; writing gap briefs when the
pool can't fill slots ("need 6 vertical Sublime clips with crowd energy").

**performance-review.md**: reading the performance index without over-reading
small samples; separating content, timing and platform effects; naming organic
winners as paid-media candidates (Google Ads, Meta) with the reason and the
audience it won with.

**creative-production.md**: making new assets from approved assets, safest first:

| Level | What | Guardrail |
|---|---|---|
| A. Reformat | 16:9 → 9:16 / 1:1 reframes, trims, per-platform resizes | Brand video rules (level cameras, head-check, no pulsing) |
| B. Branded templates | Song cards, show cards, merch cards, radio "On Air", blog quote cards | Locked brand-kit templates; AI supplies inputs + text only |
| C. Smart edits | Best-moment cuts from long performances, compilations, captions | Uses analyzed usable moments; human review |
| D. Generative | AI B-roll, backgrounds, concept visuals (Runway, Seedance, image models) | Strictest: no fake performers, no invented product claims, platform AI labels, sensitive-content check |

All generated assets enter as **pending** with provenance (source asset IDs,
template or model, prompt), inherit their sources' restrictions, and earn
auto-approval per template only after a sustained run of unedited approvals.
