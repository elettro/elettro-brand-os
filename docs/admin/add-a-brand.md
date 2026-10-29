# Add a brand

Worked example: **Dean Palermo** (slug `deanpalermo`, PR #242, 2026-10-29), a one-profile brand with no company page.
Earlier template: Piano Music Soothing (PR #175).

Slug rule: lowercase letters, digits and hyphens, 2-40 characters (the connect routes check `^[a-z0-9-]{2,40}$`).

## 1. Code: the brand lists (verified: PR #242)

Add the brand next to `pianomusicsoothing` in these 14 files. Run `grep -rn pianomusicsoothing` to find any list added since.

- Web: `apps/web/lib/brand-config.ts` (id, name, timezone, `dropboxRoot`), `apps/web/app/ai-gateway/client.tsx`,
  `apps/web/app/assets/add/intake-client.tsx` (two places: the `brandChoices` array and a `<option>`).
- Database seed: `packages/database/prisma/seed.ts`, `services/dev-api-lambda/init.sql`.
- dev-api: `db-main.mjs` and `index.mjs` (Dropbox root tables), `dropbox-upload-session.mjs`, `brand-media-reset.mjs`, `claude-folder-ops.mjs`.
- Other Lambdas: `services/dropbox-sync-lambda/index.mjs` (three lists), `services/dropbox-sync-lambda/claude-folder-relay.mjs`,
  `services/dropbox-upload-lambda/index.mjs`.
- Test: `tests/brand-root-routing.test.cjs`.

## 2. Code: per-network brand lists (opt-in; only for networks the brand uses)

Seen in the code: `YOUTUBE_BRANDS` (`apps/web/lib/youtube-connect.ts`), `META_BRANDS` plus a pinned Page id
(`apps/web/lib/meta-connect.ts`), `LINKEDIN_BRANDS` (`apps/web/lib/linkedin-connect.ts`), and brand mentions in
`threads-connect.ts` and `gbp-connect.ts`. Check each `*-connect.ts` for a list when connecting a new network.
A brand with no company page connects LinkedIn as a personal profile (the existing member flow).

## 3. Database row (NOT verified how it was done before)

Merging the code does not create the brand in the database; `init.sql` is not applied automatically. Until the row exists,
connecting a network fails with "Unknown brand". The statement `init.sql` uses (idempotent):

```sql
WITH org AS (SELECT "id" FROM "Organization" WHERE "slug"='elettro')
INSERT INTO "Brand" ("organizationId","name","slug","timezone","updatedAt")
SELECT org."id", '<Display Name>', '<slug>', 'America/New_York', CURRENT_TIMESTAMP FROM org
ON CONFLICT ("organizationId","slug") DO NOTHING;
```

## 4. After merge

1. Web redeploys itself (Amplify on merge to `develop`).
2. Lambda files changed, so deploy dev-api: [deploy-dev-api-lambda.md](deploy-dev-api-lambda.md). The Dropbox Lambdas have their
   own build artifacts and are updated the same way (`update-function-code`); check which functions the PR touched.
3. Create the database row (step 3).
4. Create the brand's Dropbox folder under `/1---elettro-brand-os/brands/<slug>`.
5. Connect networks on `/connections`.

## Unknown / ask Dean

- How the database row has been inserted for earlier brands (no code path inserts brands; no database access was available
  from the `stashbox-audit` profile that was checked).
- Whether a brand needs a Cognito group or other access setup for non-owner users.
- Whether the `elettro_create_brand_folder` MCP tool is the intended way to create a brand's root Dropbox folder.
- Whether Dropbox-side or CadenceRule setup is needed before the planner includes the brand.
