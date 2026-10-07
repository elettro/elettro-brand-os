# Elettro Brand OS Environments

## Environment names

Elettro Brand OS uses two deployed application environments:

- **DEV** — `https://dev.app.elettro.com`
- **PRODUCTION** — `https://app.elettro.com`

GitHub Pages at `https://elettro.github.io/elettro-brand-os/` remains a lightweight static UI/prototype surface. It is not the live DEV application once backend services are connected.

## Git branches

- `develop` deploys to DEV.
- `main` deploys to PRODUCTION.
- Feature branches are created from `develop`, merged back into `develop`, tested in DEV, then promoted to `main`.

## Architecture principle

Choose the best service for each workload. Do not copy the Stashbox Radio stack by default.

### Web application
- Next.js
- Production URL: `app.elettro.com`
- Dev URL: `dev.app.elettro.com`

### Durable data
- PostgreSQL
- Separate DEV and PRODUCTION databases.
- Production data is never used as a disposable test database.

### Background jobs
Use a durable queue/worker architecture for:
- Dropbox ingestion
- media inspection
- AI enrichment
- derivative generation
- scheduled publishing
- analytics collection

### Asset storage
- Dropbox remains the human-facing source library.
- Object storage is used only for temporary processing, thumbnails, derivatives, cache, or generated outputs as needed.

### Secrets
DEV and PRODUCTION use separate secrets and credentials wherever possible:
- database
- Dropbox OAuth
- OpenAI
- social-network applications/tokens
- signing/auth secrets

### Safety rule
A DEV deployment must never publish to a real production social account unless a specific connector is explicitly placed in a test-safe mode.

## Promotion flow

1. Build on a feature branch.
2. Merge to `develop`.
3. Automatic DEV deployment.
4. Test against DEV database/services.
5. Promote approved code to `main`.
6. Automatic PRODUCTION deployment.

## DNS

Target DNS layout:

- `dev.app.elettro.com` → DEV application deployment
- `app.elettro.com` → PRODUCTION application deployment

Exact DNS records depend on the selected application hosting provider and should be added only after both deployment targets exist.
