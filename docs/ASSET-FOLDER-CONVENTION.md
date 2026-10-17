# Asset Folder Convention

All brand assets live under `/1---elettro-brand-os/brands/{brand}/` in Dropbox. Shared assets stay under `/1---elettro-brand-os/creative-assets/`; Brand Brain documents stay under `/1---elettro-brand-os/intelligence/`.

Dropbox stays human-browsable. Metadata provides the machine intelligence.

## Recommended structure

```
/1---elettro-brand-os/brands/<brand>/<media-type>/<subject-topic-or-collection>/<aspect-ratio>/<files>
```

Examples:

```
/1---elettro-brand-os/brands/stashbox/video/josh-dean/9x16/file.mp4
/1---elettro-brand-os/brands/stashbox/video/stashbox-does-sublime/16x9/file.mp4
/1---elettro-brand-os/brands/stashbox/images/dean/1x1/file.png
```

There is no year folder.

Production/intake year is stored as metadata instead of being encoded into the physical Dropbox path.

## Folder semantics

- **brand**: workspace ownership
- **media-type**: normally `video` or `images`
- **subject-topic-or-collection**: human-readable grouping such as a person, pair of people, show, campaign, product, topic, or collection
- **aspect-ratio**: expected output shape such as `9x16`, `16x9`, `1x1`, `4x5`
- **files**: source assets

Folder names are context hints, not authoritative metadata.

Brand OS verifies technical properties and may suggest semantic metadata from the path.
