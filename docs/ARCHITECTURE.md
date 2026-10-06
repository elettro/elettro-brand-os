# Elettro Brand OS — Application Architecture

## Runtime shape

```
Browser
  ↓
Next.js / React web app
  ↓
Service layer / permissions
  ├─ PostgreSQL
  ├─ Dropbox connector
  ├─ AI provider
  ├─ future social connectors
  └─ job queue
       ↓
     worker
       ├─ Dropbox sync
       ├─ media inspection
       ├─ AI analysis
       ├─ future planners
       └─ future publishers
```

## Core rule

The dashboard and future MCP server must use the same service layer.

MCP must never bypass permissions or write directly to the database.

## V1 ownership of responsibilities

### Web app
- authentication/session
- brand selection
- asset browsing and editing
- approvals
- Content Pool
- later calendar and review queue

### Database
- organization/brand tenancy
- users and roles
- storage connections
- assets and lifecycle
- future planner, publishing and ledger records

### Worker
- Dropbox change ingestion
- media inspection
- AI analysis
- future social publishing

### AI
- asset understanding
- copy generation
- later ranking rationale and chat commands

### Deterministic code
- eligibility
- annual windows
- pricing safety
- cooldowns
- permissions
- publication state
- entitlements

## Deployment target

AWS remains the intended production target.

A lean V1 should keep persistent services minimal. Large source media can remain in Dropbox, with AWS used for temporary processing, metadata, queues, app runtime, logs, and secrets.
