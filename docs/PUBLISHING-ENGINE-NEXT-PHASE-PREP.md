# Publishing Engine — Next Phase Prep

Status: prepared, not merged into DEV.

This branch intentionally avoids touching live AWS infrastructure or the production database. It prepares the next implementation blocks so they can be reviewed and activated deliberately.

## Immediate next build order

1. Finish the metadata review experience
   - Verify uncropped thumbnails
   - Verify media + aspect-ratio filters
   - Verify upload-date / alphabetical sorting
   - Keep Last Used visible, but only make it authoritative after the publication ledger is live
   - Verify Card gallery view and select-filtered behavior

2. Make Asset Detail live
   - Read the real asset record by id
   - Show the cached Dropbox preview
   - Edit topic, content group, creative family, eligibility, priority, destination rules, pricing flag and notes
   - Save per-asset overrides without disturbing shared batch metadata

3. Upgrade Content Pool from a plain list to a working gallery
   - Card and list views
   - Media filter: video / image / both
   - Aspect-ratio filter
   - Brand filter
   - Sort by newest, oldest, alphabetical and Last Used
   - Click preview modal
   - Display eligibility + priority + last-used state
   - Only approved + ready + eligible + source-present assets are exposed

4. Add publication-history foundations
   - ScheduledPost
   - PublicationLedger
   - SocialAccount
   - CadenceRule
   - Destination + placement
   - publication method: api / handoff / manual
   - external post id / URL
   - publishedAt

5. Make Last Used real
   - Derive Asset.lastUsedAt from the most recent PublicationLedger entry
   - Never ask users to maintain Last Used manually
   - Unused assets sort after used assets when sorting by Last Used
   - Planner scoring uses time-since-last-use as a soft preference

6. Build planner V1
   - Generate a rolling 14-day slot horizon
   - Hard filters first: approval, readiness, eligibility, source presence, destination compatibility, cooldowns
   - Score survivors by time since last use, priority, campaign gaps and content balance
   - Store the reason an asset was selected
   - Leave empty slots when no asset qualifies and record the pool gap

7. First end-to-end publisher
   - YouTube Shorts first
   - Handoff mode for destinations not ready for direct API publication
   - Every successful publish writes to the ledger

## Data-model prep

### SocialAccount
- brandId
- destination
- accountName
- externalAccountId
- publishingMode
- timezone
- status

### CadenceRule
- socialAccountId
- placement
- postsPerWeek
- preferredDays
- preferredStartTime
- preferredEndTime
- active

### ScheduledPost
- brandId
- socialAccountId
- assetId
- placement
- scheduledFor
- status
- generatedTitle
- generatedCaption
- generatedHashtags
- selectionReason
- scoreBreakdown
- publishingMode

### PublicationLedger
Append-only.

- brandId
- socialAccountId
- assetId
- scheduledPostId
- destination
- placement
- publishedAt
- method
- externalPostId
- externalUrl
- assetFilenameSnapshot
- contentGroupSnapshot
- creativeFamilySnapshot
- campaignSnapshot
- topicSnapshot

## Last Used rule

Last Used is not a manually edited asset field.

The value displayed for an asset is:

```
MAX(PublicationLedger.publishedAt)
WHERE PublicationLedger.assetId = Asset.id
```

This keeps the asset library, Content Pool, planner and analytics aligned to the same history.

## Safety rule

Do not merge schema/runtime changes simply because they are prepared here. Database additions should be introduced with an explicit migration and a rollback-safe deployment step.
