# Smart Batch Folder Learning

The first learning algorithm is deterministic and intentionally conservative.

- Asset similarity key: brand, campaign, purpose, aspect ratio.
- Learn from individually assigned destinations and Dropbox-discovered paths.
- Treat files as unique by Dropbox file ID. Renames and moves update the latest destination rather than adding duplicate votes.
- Exclude entire-batch override events from future learned preferences.
- Refuse automatic choice until at least 5 comparable assets exist, 80% agree, and confidence reaches 75.
- Never mistake suggested folder paths for actual Dropbox folders. Server-side validation is required before upload.
- Enforce brand root boundaries for destination browsing, creating folders and saving files.
- Keep approvals separate from metadata completeness. New files discovered in an approved brand root are approved by default.
- Persist path changes and timestamps as audit events in the production data layer.

## Manual test scenarios

1. New campaign with zero examples: no confident recommendation.
2. Record five matching files in one folder: expected strong recommendation.
3. Move several files to a different folder: preference shifts only as the balance of unique current file destinations changes.
4. Rename a file without changing path: latest state persists; no duplicate votes.
5. Apply an entire-batch override: visible in history, not counted as a new folder preference.
6. Mix source images, finished images and 9:16/16:9 videos: independent keys and recommendations.

## Pending wiring

The demo uses in-memory simulated history. A full Dropbox integration requires OAuth file/folder operations, persistent file ID mapping, cursored delta sync and a backend event store. The existing connector only exposes read/list operations; no upload/create-folder capability is wired yet.
