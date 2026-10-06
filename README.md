# Elettro Brand OS

Elettro Brand OS is a multi-brand operating system for content, publishing, analytics, knowledge, and future brand-management workflows.

## Core product idea

**Create. Approve. The engine distributes.**

The first production module is the Publishing Engine:

Dropbox → ingestion → metadata → approval → Content Pool → planner → platform treatment → publishing → ledger → analytics.

## Sprint 1

Sprint 1 establishes the working application foundation:

- Next.js / React web app
- Multi-brand workspace shell
- PostgreSQL data package
- Auth/permissions package
- AI provider abstraction
- Dropbox connector package
- Background worker package
- First real brands: SolarMeister, Stashbox, Elettro

See `docs/SYSTEM-SPEC-V1.md`, `docs/database-schema.md`, and `docs/SPRINT-01.md`.

## Repository layout

```
apps/web/            # React / Next.js control center
packages/database/   # Prisma + PostgreSQL access
packages/auth/       # roles and permission helpers
packages/ai/         # model abstraction
packages/connectors/ # Dropbox and future destination connectors
services/worker/     # ingestion / publishing background jobs
docs/                # product and architecture specs
```

## Local development

1. Copy `.env.example` to `.env`
2. Add a PostgreSQL connection string
3. Run `npm install`
4. Run `npm run dev`

Database migrations and live integrations are the next implementation step.
