# Asset Intake V1

## Goal

Make asset handoff fast enough that a creator can dump files now and enrich them later without blocking ingestion.

## Dropbox convention

```
/<brand>/<video-or-images>/<subject-topic-or-collection>/<ratio>/<files>
```

Example:

```
/stashbox/video/josh-dean/9x16/file.mp4
```

The path is useful human context, not authoritative metadata.

## Intake states

### Raw
The file exists in Brand OS and technical analysis can proceed. Human metadata may be almost empty.

### Needs Metadata
Technical analysis is complete and AI/folder suggestions may exist, but the asset still needs human context or review.

### Ready
Required publishing metadata has been reviewed and the asset is eligible for approval / Content Pool entry.

## Automatic technical analysis

The system should derive, not ask the user to type:

- media type
- MIME/format
- width
- height
- orientation
- aspect ratio
- duration
- file size
- audio presence where practical
- technical mismatch warnings

Example: a file stored under `9x16` that analyzes as `16x9` should be flagged.

## Folder hints

From:

```
/stashbox/video/josh-dean/9x16/file.mp4
```

the system may suggest:

- brand: Stashbox
- type: video
- subject/group hint: josh-dean
- ratio: 9x16

Hyphenated names are suggestions, not guaranteed person parsing.

## Batch-first workflow

A batch can share:

- collection
- campaign
- topic/product
- content group
- creative family
- eligibility
- seasonal window
- priority
- allowed/excluded destinations
- creator note

Each asset keeps independent:

- filename/title
- technical specs
- exact AI description
- exact visible subjects
- text/offer warnings
- per-asset overrides

## Inheritance

V1 supports three concepts:

1. folder hints
2. batch defaults
3. per-asset overrides

Shared values are copied to asset records when applied so historical behavior is predictable. The system should remember the source batch/preset for traceability.

## Metadata presets

Users can save reusable metadata presets such as:

- Stashbox Does Sublime · Evergreen Performance
- SolarMeister Holiday · Annual Sep 15–Dec 25

Presets accelerate intake but never prevent asset-specific overrides.

## AI

V1 uses one primary AI provider behind the `AiProvider` interface.

AI may suggest:

- description/title
- subjects
- topic
- collection
- content group
- creative family
- tags
- platform fit
- warnings

AI suggestions do not override deterministic eligibility or publishing safety rules.

## Core principle

**Dump now. Enrich later. Set shared meaning once. Touch only the exceptions.**
