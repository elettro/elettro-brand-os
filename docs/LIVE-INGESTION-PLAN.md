# Live Ingestion Plan

## First end-to-end DEV milestone

A real source asset should be able to travel through:

1. Dropbox detects a new file.
2. Brand OS resolves its brand root.
3. Brand OS creates a Raw asset record.
4. Technical media inspection runs.
5. Folder hints are parsed.
6. AI enrichment runs.
7. Asset becomes Needs Metadata or Ready.
8. If "Send to approval queue" is unchecked, approval status is Approved.
9. Deterministic eligibility decides whether it may enter the Content Pool.

## Source handling

### Dropbox
The file stays in Dropbox.

Brand OS stores:
- Dropbox file ID
- source path
- content hash
- technical metadata
- semantic metadata
- usage history

### Shopify
The file stays in Shopify.

Brand OS stores:
- store/product/media references
- source URL/reference
- commerce metadata
- semantic metadata
- usage history

No source is duplicated into another source merely for cataloging.

## Technical analysis

A media inspector implementation will use the best runtime tool available in the chosen AWS worker environment.

For images:
- width
- height
- ratio
- orientation
- MIME / format
- file size

For video:
- width
- height
- ratio
- orientation
- duration
- audio presence
- MIME / format
- file size

The inspection layer is provider-independent so the AWS implementation can change without changing planner or UI logic.

## Eligibility UX

Users see:
- Evergreen
- or Start Date + Stop Date
- Repeat every year checkbox

Internally this maps to:
- evergreen
- one_time
- annual

## Approval UX

Default:
- Approved

Optional:
- Send to approval queue

This allows creator-owned brands to move quickly while preserving client review workflows.
