# Elettro MultiCam — spec

Every phone in the room, one multi-cam video. Dean's concept (2026-11-01), first for Stashbox rehearsal sessions
(4-5 band phones plus the GoPro and the Sony), then generic for bands, speakers and live events.

## The loop

1. **Start** — the host (Dean, signed in) opens `/multicam`, picks the brand, taps *Start session*: where, date, optional
   title and song list. Elettro OS shows a QR code for `os.elettro.com/mc/<code>`. Only the host can open that page.
2. **Shoot** — every phone records the song in its own camera app (best quality; the camera roll is the safety copy).
   Fixed and roaming phones; partial shots count. Landscape, start before the count-in.
3. **Upload** — the band stops; everyone scans the QR (no login), types their name once (remembered on the phone),
   picks the song and their angle, picks the clip(s). Clips go straight to S3 in 16 MiB+ parts, three at a time, each part
   retried on weak signal; the screen is kept awake. The host page shows the angles arriving (refreshes every 5 s).
   **One file can cover several songs** (Dean, 2026-11-01): the phone picks *Several songs in one take*; those clips sit under a
   session-level "Several songs (long take)" entry, count toward every song's *Make it*, and Phase 3 cuts each song out of them by audio.
4. **Make it** — the host taps *Make it* on a song once at least one clip is in. **Phase 1 records the request**; the
   automatic edit is Phase 3. Until then the editor (Claude) pulls the clips (download links on the host page).
5. **Post** — Phase 4: outputs land in Elettro OS as Stashbox assets and draft posts in Review; nothing posts without approval.

Decisions (Dean, 2026-11-01): start at **1080p**, move to **4K30** if the wait is acceptable; band **stops and waits** after
each song; data in the **main Postgres** (own tables), reached only through a narrow MultiCam route; **host-held QR**
instead of band logins; S3 for raw clips and rendering, Dropbox + Elettro OS Assets for finished work.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 Intake | Sessions, host QR, band upload page, host console, Make-it request, clip downloads | **this PR** |
| 2 Archive | Copy raw clips to Dropbox `brands/<brand>/videos/sessions/<YYMMDD>-<location>-<names>/<song>/` and register them as assets | next |
| 3 Auto-edit | Worker (Fargate + ffmpeg): normalize VFR, align every clip by audio to an anchor (full-length clip or board audio), drop bad clips, cut with Dean's camera rules, B-roll from the creative-assets library and brand folders, render 16:9, 9:16 shorts, stills; 1080p fast pass, 4K follow-up | later |
| 4 Deliver | Register outputs as brand assets, create draft posts in Review, link to the host's phone | later |

## Phase 1 design

- **Web** (`apps/web`): `/multicam` (owner only, in the left rail under Workspace), `/mc/[code]` (public, frameless, mobile).
  Server-side proxies `/api/multicam/host` (owner session, host ops, brands in `MULTICAM_BRANDS`) and
  `/api/multicam/band` (public, same-origin, band ops only, field allow-list). The browser never sees the connect key.
- **dev-api**: one route `POST /multicam` (`multicam.mjs`), gated by the connect key like every route. `op` selects:
  host ops `create-session, list-sessions, get-session, add-song, end-session, reopen-session, request-make, clip-download`
  (always scoped to the brand passed by the host proxy); band ops `join, band-add-song, start-upload, complete-upload,
  abort-upload` (every one checks the session code: exists, `open`, not past `expiresAt`). The band never receives the code,
  brand ids or other sessions.
- **Session code**: 10 characters from a 31-letter alphabet without 0/O/1/I/L (~49 bits), unique, expires after 18 h by
  default (1-72), or when the host taps *End session*.
- **Tables** (created by IAM-only `setup-multicam-tables-20261101`, dry run unless `mode:"apply"`): `MultiCamSession`
  (brand, code, location, date, status, expiresAt), `MultiCamSong` (title, slug, status `collecting|requested|rendering|done`),
  `MultiCamClip` (contributor, angle, kind video/audio, filename, size, part plan, bucket, key, uploadId, status
  `uploading|uploaded|aborted`).
- **Storage**: bucket `MULTICAM_BUCKET`, falling back to `ASSET_UPLOAD_BUCKET` (`elettro-brand-os-dev-assets`), prefix
  `multicam/<brand>/<YYMMDD>-<location>-<id8>/<song>/`. File names `261108_studio-one_simple-twist_michael_drums_ab12cd.mp4`.
  Limits: 20 GiB per clip, 500 clips and 60 songs per session; video `mp4 mov m4v webm 3gp mkv`, audio `wav m4a mp3 aac aif aiff flac`
  (board audio can be the anchor).
- **Not in Phase 1**: resuming an upload after the page is closed (a failed clip is retried from the start with *Try again*),
  client (non-owner) hosts, the edit itself.

AWS steps: `docs/admin/multicam-setup.md`.
