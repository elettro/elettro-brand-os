# Sprint 01 — Foundation + First Working Content Flow

## Sprint goal

Prove the first real vertical slice:

**Login → select brand → connect Dropbox → ingest one asset → inspect → review metadata → approve → Content Pool**

Social publishing is intentionally out of scope until this flow is reliable.

## Definition of done

### Foundation
- [x] Monorepo application scaffold
- [x] Next.js / React dashboard shell
- [x] Initial brand switcher UI
- [x] PostgreSQL / Prisma package scaffold
- [x] Role-permission package scaffold
- [x] AI provider abstraction
- [x] Dropbox connector contract
- [x] Background worker scaffold
- [ ] Cloud deployment
- [ ] Live PostgreSQL instance
- [ ] Auth provider
- [ ] Secrets manager

### Brands
- [x] SolarMeister defined
- [x] Stashbox defined
- [x] Elettro defined
- [ ] Seed brands into live database
- [ ] Brand switcher backed by database and session state

### Dropbox
- [ ] Create Dropbox OAuth application
- [ ] OAuth connect flow
- [ ] Choose brand root folder
- [ ] Store token reference in secrets manager
- [ ] Initial recursive sync
- [ ] Delta cursor sync
- [ ] Webhook receiver

### Asset ingestion
- [ ] Create asset record
- [ ] Track stable Dropbox file ID
- [ ] SHA/content-hash duplicate detection
- [ ] Detect move/rename/delete
- [ ] ffprobe video inspection
- [ ] image dimension inspection
- [ ] status transitions and error handling

### Intelligence
- [ ] OpenAI provider implementation
- [ ] Representative frame/image analysis
- [ ] Suggested description
- [ ] Suggested topic
- [ ] Suggested content group
- [ ] Suggested creative family
- [ ] Suggested tags
- [ ] Initial platform-copy generation

### Review + pool
- [ ] Asset Library page
- [ ] Asset detail/edit page
- [ ] Annual / evergreen / one-time eligibility controls
- [ ] Specific-pricing safety rule
- [ ] Approval workflow
- [ ] Bulk approval
- [ ] Content Pool query and page

## Current completion

The repository now has the application foundation and contracts. The next blocking dependencies are:

1. live PostgreSQL
2. authentication choice
3. Dropbox OAuth credentials
4. OpenAI API key
5. AWS deployment target / secrets

## First live acceptance test

Drop one 9:16 SolarMeister video into the configured Dropbox root and verify that:

1. it appears in Asset Library
2. technical metadata is detected
3. AI suggestions appear
4. a user can edit eligibility
5. a user approves it
6. it appears in Content Pool
