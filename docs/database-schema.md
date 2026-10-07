# Elettro Brand OS — Database Schema V1

**Database:** PostgreSQL 15+
**Conventions:**
- `uuid` primary keys (`gen_random_uuid()`)
- `timestamptz` everywhere, stored UTC; brand timezone is applied in the app
- Every brand-scoped table carries `brand_id` (and is filtered by it in every query)
- Soft lifecycle via status fields; hard deletes are rare
- `created_at` / `updated_at` on all mutable tables (omitted below for brevity)

Tables marked **(later)** are defined now so relationships are right, but are unused in Sprint 1.

---

## 1. Relationship Overview

```
organizations ─┬─< organization_members >── users
               ├─< subscriptions >── plans                (later)
               └─< brands ─┬─< brand_members >── users
                           ├─< storage_connections
                           ├─< products
                           ├─< campaigns
                           ├─< creative_families
                           ├─< assets ─┬─< asset_variants
                           │           ├─< asset_items (carousel children)
                           │           ├─< asset_ai_analyses
                           │           └─< asset_tags >── tags
                           ├─< social_accounts ─< cadence_rules
                           ├─< cooldown_rules
                           ├─< planner_runs ─< scheduled_posts
                           ├─< scheduled_posts ─── publication_ledger ─< post_metrics
                           ├─< pool_gaps
                           └─< activity_log
```

---

## 2. Enums

```sql
CREATE TYPE org_role          AS ENUM ('owner','admin','member');
CREATE TYPE brand_role        AS ENUM ('owner','admin','editor','approver','viewer');
CREATE TYPE asset_kind        AS ENUM ('video','image','carousel');
CREATE TYPE ingest_status     AS ENUM ('ingesting','needs_review','ready','failed','source_missing');
CREATE TYPE approval_status   AS ENUM ('needs_review','approved','rejected');
CREATE TYPE eligibility_type  AS ENUM ('evergreen','annual','one_time');
CREATE TYPE priority_level    AS ENUM ('low','normal','high','hero');
CREATE TYPE destination       AS ENUM ('youtube','tiktok','instagram','facebook','x','linkedin','website');
CREATE TYPE placement         AS ENUM ('feed','reel_short','story');
CREATE TYPE publishing_mode   AS ENUM ('auto','approval_required','handoff');
CREATE TYPE cooldown_type     AS ENUM ('exact_asset','creative_family','product','campaign_consecutive');
CREATE TYPE post_status       AS ENUM ('planned','pending_approval','approved','handoff_ready',
                                       'publishing','published','failed','cancelled','skipped');
CREATE TYPE publish_method    AS ENUM ('api','handoff','manual');
CREATE TYPE actor_type        AS ENUM ('user','system','ai');
```

---

## 3. Tenancy & Users

```sql
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text,
  auth_provider_id text UNIQUE            -- id from Clerk/Cognito/etc.
);

CREATE TABLE organization_members (
  organization_id uuid REFERENCES organizations ON DELETE CASCADE,
  user_id         uuid REFERENCES users ON DELETE CASCADE,
  role            org_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE brands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'America/New_York',
  approval_policy text NOT NULL DEFAULT 'creator'   -- creator | client | creator_and_client
                  CHECK (approval_policy IN ('creator','client','creator_and_client')),
  allow_auto_variants boolean NOT NULL DEFAULT false,
  brand_voice     text,                              -- interim until Knowledge module
  settings        jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active',
  UNIQUE (organization_id, slug)
);

CREATE TABLE brand_members (
  brand_id uuid REFERENCES brands ON DELETE CASCADE,
  user_id  uuid REFERENCES users ON DELETE CASCADE,
  role     brand_role NOT NULL,
  PRIMARY KEY (brand_id, user_id)
);
```

---

## 4. Storage & Taxonomy

```sql
CREATE TABLE storage_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'dropbox',
  account_ref   text NOT NULL,            -- Dropbox account id
  secret_ref    text NOT NULL,            -- pointer to secrets manager, never raw tokens
  root_path     text NOT NULL,            -- e.g. /Elettro Brand OS/SolarMeister
  sync_cursor   text,                     -- Dropbox list_folder cursor
  last_synced_at timestamptz,
  status        text NOT NULL DEFAULT 'active'
);

CREATE TABLE products (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id  uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  name      text NOT NULL,
  handle    text,                         -- Shopify handle / SKU
  url       text,
  description text,
  UNIQUE (brand_id, name)
);

CREATE TABLE campaigns (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id  uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  name      text NOT NULL,
  brief     text,                         -- fed to AI copy
  starts_on date,
  ends_on   date,
  coverage_weight numeric NOT NULL DEFAULT 1.0,
  status    text NOT NULL DEFAULT 'active'
);

CREATE TABLE creative_families (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id  uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  name      text NOT NULL,
  description text
);

CREATE TABLE tags (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  name     text NOT NULL,
  UNIQUE (brand_id, name)
);
```

---

## 5. Assets

```sql
CREATE TABLE assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  storage_connection_id uuid REFERENCES storage_connections,

  -- source
  source_file_id   text,                  -- Dropbox id (stable across moves)
  source_path      text,
  content_hash     text,                  -- duplicate detection
  filename         text NOT NULL,
  mime_type        text,
  file_size_bytes  bigint,

  -- detected
  kind             asset_kind NOT NULL,
  width            int,
  height           int,
  aspect_ratio     numeric(6,4),          -- width/height, e.g. 0.5625 for 9:16
  duration_ms      int,
  ingest_status    ingest_status NOT NULL DEFAULT 'ingesting',

  -- human / AI-confirmed metadata
  title            text,
  topic            text,
  content_group    text,                  -- educational | product | testimonial | bts | promo ...
  product_id         uuid REFERENCES products,
  campaign_id        uuid REFERENCES campaigns,
  creative_family_id uuid REFERENCES creative_families,
  priority         priority_level NOT NULL DEFAULT 'normal',
  creative_notes   text,                  -- creative intent, fed to AI copy
  folder_suggestions jsonb NOT NULL DEFAULT '{}',  -- metadata hints from path, unconfirmed

  -- eligibility
  eligibility_type eligibility_type NOT NULL DEFAULT 'evergreen',
  eligible_from    date,                  -- one_time
  eligible_until   date,                  -- one_time
  annual_from_mmdd smallint,              -- annual, e.g. 915  = Sep 15
  annual_until_mmdd smallint,             -- annual, e.g. 1225 = Dec 25 (may be < from: wraps year)
  contains_specific_pricing boolean NOT NULL DEFAULT false,
  excluded_destinations destination[] NOT NULL DEFAULT '{}',
  cooldown_override_days int,

  -- approval / lifecycle
  approval_status  approval_status NOT NULL DEFAULT 'approved',
  approved_by      uuid REFERENCES users,
  approved_at      timestamptz,
  client_approved_by uuid REFERENCES users,
  client_approved_at timestamptz,
  retired_at       timestamptz,

  CONSTRAINT pricing_forces_one_time
    CHECK (NOT contains_specific_pricing OR eligibility_type = 'one_time'),
  CONSTRAINT one_time_has_dates
    CHECK (eligibility_type <> 'one_time' OR (eligible_from IS NOT NULL AND eligible_until IS NOT NULL)),
  CONSTRAINT annual_has_bounds
    CHECK (eligibility_type <> 'annual' OR (annual_from_mmdd IS NOT NULL AND annual_until_mmdd IS NOT NULL))
);

CREATE UNIQUE INDEX assets_source_uq ON assets (storage_connection_id, source_file_id);
CREATE INDEX assets_pool_idx ON assets (brand_id, approval_status, ingest_status) WHERE retired_at IS NULL;
CREATE INDEX assets_hash_idx ON assets (brand_id, content_hash);

-- carousel children (a carousel asset groups image/video assets)
CREATE TABLE asset_items (
  parent_asset_id uuid REFERENCES assets ON DELETE CASCADE,
  child_asset_id  uuid REFERENCES assets ON DELETE CASCADE,
  position        smallint NOT NULL,
  PRIMARY KEY (parent_asset_id, child_asset_id)
);

CREATE TABLE asset_tags (
  asset_id uuid REFERENCES assets ON DELETE CASCADE,
  tag_id   uuid REFERENCES tags ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);

CREATE TABLE asset_variants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      uuid NOT NULL REFERENCES assets ON DELETE CASCADE,
  destination   destination,              -- null = generic
  placement     placement,
  width         int,
  height        int,
  aspect_ratio  numeric(6,4),
  duration_ms   int,
  storage_uri   text NOT NULL,            -- s3://... or dropbox path
  generated_by  text,                     -- 'human' | 'auto_crop' | model name
  approval_status approval_status NOT NULL DEFAULT 'needs_review'
);

CREATE TABLE asset_ai_analyses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES assets ON DELETE CASCADE,
  provider    text NOT NULL,
  model       text NOT NULL,
  description text,
  suggested   jsonb NOT NULL DEFAULT '{}', -- topic, product, family, content_group, tags
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

---

## 6. Accounts, Cadence & Rules

```sql
CREATE TABLE social_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  destination   destination NOT NULL,
  external_id   text,
  handle        text,
  secret_ref    text,                     -- token pointer in secrets manager
  scopes        text[],
  api_can_publish boolean NOT NULL DEFAULT false,  -- false => handoff only
  default_mode  publishing_mode NOT NULL DEFAULT 'approval_required',
  status        text NOT NULL DEFAULT 'active'
);

CREATE TABLE cadence_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES social_accounts ON DELETE CASCADE,
  placement         placement NOT NULL,
  posts_per_week    numeric NOT NULL,
  preferred_windows jsonb NOT NULL DEFAULT '[]',  -- [{dow:2,start:"11:00",end:"13:00"}, ...]
  mode_override     publishing_mode,
  active            boolean NOT NULL DEFAULT true
);

CREATE TABLE cooldown_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id  uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  rule_type cooldown_type NOT NULL,
  days      int,                          -- null for campaign_consecutive
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (brand_id, rule_type)
);
-- Cooldowns are always evaluated per social account. No cross-network rules in V1.
-- Seed per brand: exact_asset 45, creative_family 21, product 5, campaign_consecutive
```

---

## 7. Planning, Posts & Ledger

```sql
CREATE TABLE planner_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  triggered_by  actor_type NOT NULL,
  triggered_by_user uuid REFERENCES users,
  horizon_start timestamptz NOT NULL,
  horizon_end   timestamptz NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}',
  summary       jsonb,                    -- slots filled, gaps, counts
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  planner_run_id    uuid REFERENCES planner_runs,
  social_account_id uuid NOT NULL REFERENCES social_accounts,
  asset_id          uuid NOT NULL REFERENCES assets,
  asset_variant_id  uuid REFERENCES asset_variants,
  destination       destination NOT NULL,
  placement         placement NOT NULL,
  scheduled_at      timestamptz NOT NULL,
  mode              publishing_mode NOT NULL,
  status            post_status NOT NULL DEFAULT 'planned',

  -- platform treatment
  title             text,
  caption           text,
  description       text,
  hashtags          text[],
  platform_options  jsonb NOT NULL DEFAULT '{}',  -- e.g. synthetic media flag, cover frame
  copy_model        text,

  -- explainability
  selection_reason  jsonb,                -- filters passed, score breakdown, AI rationale

  approved_by       uuid REFERENCES users,
  approved_at       timestamptz,
  error             text
);
CREATE INDEX scheduled_posts_queue_idx ON scheduled_posts (status, scheduled_at);
CREATE INDEX scheduled_posts_brand_cal_idx ON scheduled_posts (brand_id, scheduled_at);

-- Append-only. Denormalized at publish time for fast cooldown checks.
CREATE TABLE publication_ledger (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands,
  scheduled_post_id  uuid REFERENCES scheduled_posts,
  social_account_id  uuid NOT NULL REFERENCES social_accounts,  -- cooldown key
  asset_id           uuid NOT NULL REFERENCES assets,
  asset_variant_id   uuid REFERENCES asset_variants,
  creative_family_id uuid,                -- snapshot, no FK on purpose
  product_id         uuid,                -- snapshot
  campaign_id        uuid,                -- snapshot
  destination        destination NOT NULL,
  placement          placement NOT NULL,
  published_at       timestamptz NOT NULL,
  method             publish_method NOT NULL,
  published_by       actor_type NOT NULL,
  published_by_user  uuid REFERENCES users,
  external_post_id   text,
  external_url       text,
  caption_snapshot   text
);
CREATE INDEX ledger_cooldown_asset_idx   ON publication_ledger (social_account_id, asset_id, published_at DESC);
CREATE INDEX ledger_cooldown_family_idx  ON publication_ledger (social_account_id, creative_family_id, published_at DESC);
CREATE INDEX ledger_cooldown_product_idx ON publication_ledger (social_account_id, product_id, published_at DESC);
CREATE INDEX ledger_recent_idx           ON publication_ledger (social_account_id, published_at DESC);

-- post_metrics and all analytics/attribution tables: see ANALYTICS-SPEC.md §11

CREATE TABLE pool_gaps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands ON DELETE CASCADE,
  planner_run_id uuid REFERENCES planner_runs,
  destination   destination NOT NULL,
  placement     placement NOT NULL,
  slot_at       timestamptz NOT NULL,
  reason        text NOT NULL,            -- e.g. 'no eligible 9:16 video'
  resolved_at   timestamptz
);
```

---

## 8. AI Usage, Activity & Billing

```sql
CREATE TABLE ai_usage (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations,
  brand_id        uuid REFERENCES brands,
  user_id         uuid REFERENCES users,
  task            text NOT NULL,          -- asset_analysis | post_copy | planner_rationale | mcp_tool
  provider        text NOT NULL,
  model           text NOT NULL,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(10,5),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_log (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations,
  brand_id        uuid REFERENCES brands,
  actor_type      actor_type NOT NULL,
  actor_id        uuid,
  source          text NOT NULL DEFAULT 'dashboard',  -- dashboard | mcp | worker | api
  action          text NOT NULL,          -- asset.approved, post.published, planner.run ...
  entity_type     text,
  entity_id       uuid,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_brand_idx ON activity_log (brand_id, created_at DESC);

CREATE TABLE plans (                       -- (later)
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code    text NOT NULL UNIQUE,           -- free | creator | agency | enterprise
  limits  jsonb NOT NULL                  -- {brands, seats, social_accounts, posts_per_month, ai_budget_usd, modules[]}
);

CREATE TABLE subscriptions (               -- (later)
  organization_id uuid PRIMARY KEY REFERENCES organizations,
  plan_id         uuid NOT NULL REFERENCES plans,
  status          text NOT NULL,
  external_customer_id text,
  external_subscription_id text,
  current_period_end timestamptz,
  limit_overrides jsonb NOT NULL DEFAULT '{}'
);
```

Blog/SEO tables (`articles`, `article_research`, `article_sources`) are deferred to that module's spec.

---

## 9. Reference Queries

### 9.1 Eligibility on a given date (handles annual wrap-around)

```sql
-- :d = slot date (brand-local), :mmdd = EXTRACT(MONTH FROM :d)*100 + EXTRACT(DAY FROM :d)
SELECT a.*
FROM assets a
WHERE a.brand_id = :brand_id
  AND a.approval_status = 'approved'
  AND a.ingest_status = 'ready'
  AND a.retired_at IS NULL
  AND NOT (:destination = ANY (a.excluded_destinations))
  AND (
        a.eligibility_type = 'evergreen'
     OR (a.eligibility_type = 'one_time' AND :d BETWEEN a.eligible_from AND a.eligible_until)
     OR (a.eligibility_type = 'annual' AND (
            (a.annual_from_mmdd <= a.annual_until_mmdd
               AND :mmdd BETWEEN a.annual_from_mmdd AND a.annual_until_mmdd)
         OR (a.annual_from_mmdd >  a.annual_until_mmdd           -- wraps year, e.g. 1115 → 105
               AND (:mmdd >= a.annual_from_mmdd OR :mmdd <= a.annual_until_mmdd))
        ))
  );
```

### 9.2 Exact-asset cooldown (per social account)

```sql
AND NOT EXISTS (
  SELECT 1 FROM publication_ledger l
  WHERE l.social_account_id = :social_account_id
    AND l.asset_id = a.id
    AND l.published_at > :slot_at - make_interval(days => COALESCE(a.cooldown_override_days, :exact_asset_days))
)
```

Creative family and product cooldowns follow the same pattern against the snapshot columns, always keyed on `social_account_id`. The planner must also check posts already planned in the **current run** and in `scheduled_posts` with status in (`planned`, `pending_approval`, `approved`, `handoff_ready`), not only the ledger.

### 9.3 Nightly retirement of expired one-time assets

```sql
UPDATE assets
SET retired_at = now()
WHERE eligibility_type = 'one_time'
  AND eligible_until < (now() AT TIME ZONE 'UTC')::date
  AND retired_at IS NULL;
```

---

## 10. Notes

- **Tokens:** never store OAuth tokens in Postgres. Store `secret_ref` pointers into AWS Secrets Manager (or equivalent).
- **Row-level isolation:** consider Postgres RLS keyed on `brand_id` as defense in depth behind service-layer checks.
- **Migrations:** managed in `/packages/database` (Drizzle or Prisma; decide in Sprint 1, Day 1).
