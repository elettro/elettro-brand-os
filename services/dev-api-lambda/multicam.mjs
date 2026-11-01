// Elettro MultiCam intake (2026-11-01). Spec: docs/multicam/ELETTRO-MULTICAM-SPEC.md
//
// A host (the owner, signed in to Elettro OS) opens a session for a brand and shows its QR code. Anyone in the room
// scans it and uploads their phone clips for a song straight to S3 (presigned multipart, no AWS keys on the phone).
// The host sees which angles arrived and taps "Make it", which records the request (the auto-edit worker is Phase 3).
//
// One HTTP route, POST /multicam, behind the shared connect key like every other route. The web app calls it from two
// server-side proxies: /api/multicam/host (owner session; host ops) and /api/multicam/band (public; band ops, which
// all need a valid open session code). The session code is the band's only credential, so every band op checks it.
// Tables are created by the IAM-only action setup-multicam-tables-20261101 (dry run unless mode:"apply").

import { randomBytes, randomUUID } from "node:crypto";
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, HeadObjectCommand, GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ---------- pure helpers (unit-tested in tests/multicam.test.mjs) ----------

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const CODE_LENGTH = 10;
export const MAX_CLIP_BYTES = 20 * 1024 ** 3;         // 20 GiB, far above a 4K30 song
export const MIN_PART_BYTES = 16 * 1024 ** 2;         // 16 MiB parts; S3 minimum is 5 MiB
export const MAX_PARTS = 10000;                       // S3 limit
export const MAX_CLIPS_PER_SESSION = 500;
export const MAX_SONGS_PER_SESSION = 60;
export const DEFAULT_SESSION_HOURS = 18;
export const PART_URL_SECONDS = 6 * 3600;
export const DEFAULT_ANGLES = ["Wide", "Drums", "Guitar", "Bass", "Keys", "Singer", "Crowd", "Roaming"];
// One phone may roll through several songs in one file (Dean, 2026-11-01). Those clips go under this session-level
// "song"; every real song counts them as candidates, and the auto-edit (Phase 3) cuts each song out of them by audio.
export const LONG_TAKE_TITLE = "Several songs (long take)";
export const LONG_TAKE_SLUG = "several-songs-long-take";

const VIDEO_EXT = ["mp4", "mov", "m4v", "webm", "3gp", "mkv"];
const AUDIO_EXT = ["wav", "m4a", "mp3", "aac", "aif", "aiff", "flac"];

export function newSessionCode(bytes = randomBytes(CODE_LENGTH)) {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(value) {
  const code = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function slug(value, max = 40) {
  return String(value || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, max).replace(/-+$/g, "");
}

// A person's name or an angle label: printable, trimmed, 1..max chars.
export function cleanLabel(value, max) {
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > max || !slug(text)) return null;
  return text;
}

export function isoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = new Date(text + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text ? null : text;
}

// Dean writes dates as YYMMDD (261108); file and folder names follow him.
export function yymmdd(iso) { return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10); }

export function clipExtension(filename) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename || ""));
  const ext = m ? m[1].toLowerCase() : "";
  if (VIDEO_EXT.includes(ext)) return { ext, kind: "video" };
  if (AUDIO_EXT.includes(ext)) return { ext, kind: "audio" };
  return null;
}

// Part size so the whole file fits in S3's 10,000-part limit, rounded up to a whole MiB.
export function partPlan(size) {
  const mib = 1024 * 1024;
  const partSize = Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS / mib) * mib);
  return { partSize, partCount: Math.ceil(size / partSize) };
}

// <brand>/<YYMMDD>-<location>-<id8>/ is the session folder; one folder per song inside it.
export function sessionFolder(session) {
  return `${yymmdd(session.sessionDate)}-${slug(session.location) || "session"}-${String(session.id).slice(0, 8)}`;
}

// 261108_studio-one_simple-twist_michael_drums_ab12cd.mp4
export function clipFilename({ sessionDate, location, songTitle, contributor, angle, ext, uniq }) {
  return [yymmdd(sessionDate), slug(location, 30) || "session", slug(songTitle, 40) || "song", slug(contributor, 24), slug(angle, 20), uniq].join("_") + "." + ext;
}

export function clipKey({ brandSlug, session, songSlug, filename }) {
  return `multicam/${brandSlug}/${sessionFolder(session)}/${songSlug}/${filename}`;
}

// The folder name Dean asked for once everyone has uploaded: 261108-studio-one-dean-michael-david-ron.
export function deliveryFolderName(session, contributors) {
  const names = [...new Set(contributors.map((c) => slug(c, 24)).filter(Boolean))];
  return [yymmdd(session.sessionDate), slug(session.location) || "session", ...names].join("-");
}

export function sessionIsOpen(session, now = new Date()) {
  return !!session && session.status === "open" && new Date(session.expiresAt).getTime() > now.getTime();
}

export function validParts(parts, partCount) {
  if (!Array.isArray(parts) || parts.length !== partCount) return null;
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]?.partNumber), etag = String(parts[i]?.etag || "");
    if (n !== i + 1 || !/^"?[A-Za-z0-9-]{1,80}"?$/.test(etag)) return null;
    out.push({ PartNumber: n, ETag: etag.startsWith('"') ? etag : `"${etag}"` });
  }
  return out;
}

// ---------- database setup (IAM only) ----------

const TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS "MultiCamSession" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "brandId" UUID NOT NULL REFERENCES "Brand"("id") ON DELETE CASCADE,
    "code" TEXT NOT NULL UNIQUE,
    "title" TEXT,
    "location" TEXT NOT NULL,
    "sessionDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "MultiCamSession_brandId_sessionDate_idx" ON "MultiCamSession"("brandId","sessionDate")`,
  `CREATE TABLE IF NOT EXISTS "MultiCamSong" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL REFERENCES "MultiCamSession"("id") ON DELETE CASCADE,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "makeRequestedAt" TIMESTAMP(3),
    "makeRequestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("sessionId","slug")
  )`,
  `CREATE TABLE IF NOT EXISTS "MultiCamClip" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL REFERENCES "MultiCamSession"("id") ON DELETE CASCADE,
    "songId" UUID NOT NULL REFERENCES "MultiCamSong"("id") ON DELETE CASCADE,
    "contributor" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'video',
    "filename" TEXT NOT NULL,
    "originalName" TEXT,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL UNIQUE,
    "uploadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3)
  )`,
  `CREATE INDEX IF NOT EXISTS "MultiCamClip_songId_status_idx" ON "MultiCamClip"("songId","status")`
];

export async function runMultiCamSetup(event, connectDatabase, json) {
  if (event.requestContext || event.rawPath || event.path) return json(403, { ok: false, error: "Direct IAM invocation required" });
  const mode = event.mode === "apply" ? "apply" : "dry-run";
  let client;
  try {
    client = await connectDatabase();
    const existing = (await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('MultiCamSession','MultiCamSong','MultiCamClip')`
    )).rows.map((r) => r.table_name).sort();
    if (mode !== "apply") return json(200, { ok: true, mode, note: "Dry run; nothing changed", existing, statements: TABLES_SQL.length });
    await client.query("BEGIN");
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    for (const sql of TABLES_SQL) await client.query(sql);
    await client.query("COMMIT");
    return json(200, { ok: true, mode, before: existing, created: ["MultiCamSession", "MultiCamSong", "MultiCamClip"].filter((t) => !existing.includes(t)) });
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    console.error("[multicam-setup] failed", error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : "setup failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

// ---------- HTTP route: POST /multicam ----------

export const HOST_OPS = ["create-session", "list-sessions", "get-session", "add-song", "end-session", "reopen-session", "request-make", "clip-download"];
export const BAND_OPS = ["join", "band-add-song", "start-upload", "complete-upload", "abort-upload"];

let s3Client;
function s3() { return (s3Client ||= new S3Client({})); }
function bucketName() { return process.env.MULTICAM_BUCKET || process.env.ASSET_UPLOAD_BUCKET || ""; }

class Bad extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function handleMultiCam(body, connectDatabase, json, deps = {}) {
  const op = String(body?.op || "");
  if (!HOST_OPS.includes(op) && !BAND_OPS.includes(op)) return json(400, { ok: false, error: "Unknown MultiCam op" });
  const ctx = { s3: deps.s3 || s3(), presign: deps.presign || getSignedUrl, bucket: deps.bucket ?? bucketName(), now: deps.now || (() => new Date()) };
  let client;
  try {
    client = await connectDatabase();
    const result = HOST_OPS.includes(op) ? await hostOp(op, body, client, ctx) : await bandOp(op, body, client, ctx);
    return json(200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof Bad) return json(error.status, { ok: false, error: error.message });
    console.error("[multicam] failed", op, error);
    return json(500, { ok: false, error: "MultiCam request failed" });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

// ----- host ops: the web proxy has already checked the owner session -----

async function brandBySlug(client, brandSlug) {
  const row = (await client.query(`SELECT "id","slug","name" FROM "Brand" WHERE "slug"=$1 AND "status"='active' LIMIT 1`, [String(brandSlug || "")])).rows[0];
  if (!row) throw new Bad(404, "Active brand not found");
  return row;
}

async function hostSession(client, brandId, sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId || ""))) throw new Bad(400, "sessionId is required");
  const row = (await client.query(`SELECT * FROM "MultiCamSession" WHERE "id"=$1 AND "brandId"=$2`, [sessionId, brandId])).rows[0];
  if (!row) throw new Bad(404, "Session not found");
  return row;
}

async function insertSong(client, sessionId, title) {
  const clean = cleanLabel(title, 80);
  if (!clean) throw new Bad(400, "Song title is required (up to 80 characters)");
  const songSlug = slug(clean);
  const count = Number((await client.query(`SELECT COUNT(*)::int AS n FROM "MultiCamSong" WHERE "sessionId"=$1`, [sessionId])).rows[0].n);
  const existing = (await client.query(`SELECT * FROM "MultiCamSong" WHERE "sessionId"=$1 AND "slug"=$2`, [sessionId, songSlug])).rows[0];
  if (existing) return existing;
  if (count >= MAX_SONGS_PER_SESSION) throw new Bad(400, "This session already has the maximum number of songs");
  return (await client.query(
    `INSERT INTO "MultiCamSong" ("sessionId","title","slug","position") VALUES ($1,$2,$3,$4) RETURNING *`,
    [sessionId, clean, songSlug, count]
  )).rows[0];
}

async function sessionDetail(client, session, brand) {
  const songs = (await client.query(`SELECT * FROM "MultiCamSong" WHERE "sessionId"=$1 ORDER BY "position","createdAt"`, [session.id])).rows;
  const clips = (await client.query(
    `SELECT "id","songId","contributor","angle","kind","filename","sizeBytes","status","createdAt","completedAt" FROM "MultiCamClip" WHERE "sessionId"=$1 AND "status"<>'aborted' ORDER BY "createdAt"`,
    [session.id]
  )).rows;
  const contributors = clips.filter((c) => c.status === "uploaded").map((c) => c.contributor);
  return {
    session: {
      id: session.id, brand: brand.slug, brandName: brand.name, code: session.code, title: session.title, location: session.location,
      sessionDate: isoOf(session.sessionDate), status: session.status, expiresAt: session.expiresAt, open: sessionIsOpen({ ...session, sessionDate: isoOf(session.sessionDate) }),
      folder: sessionFolder({ ...session, sessionDate: isoOf(session.sessionDate) }),
      deliveryFolder: deliveryFolderName({ ...session, sessionDate: isoOf(session.sessionDate) }, contributors)
    },
    songs: songs.map((s) => ({
      id: s.id, title: s.title, slug: s.slug, status: s.status, makeRequestedAt: s.makeRequestedAt, longTake: s.slug === LONG_TAKE_SLUG,
      clips: clips.filter((c) => c.songId === s.id).map((c) => ({ ...c, sizeBytes: Number(c.sizeBytes) }))
    }))
  };
}

function isoOf(date) { return date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10); }

async function hostOp(op, body, client, ctx) {
  const brand = await brandBySlug(client, body.brand);
  const who = cleanLabel(body.requestedBy, 200) || null;

  if (op === "create-session") {
    const location = cleanLabel(body.location, 60);
    const sessionDate = isoDate(body.sessionDate);
    if (!location || !sessionDate) throw new Bad(400, "location and sessionDate (YYYY-MM-DD) are required");
    const title = body.title ? cleanLabel(body.title, 80) : null;
    const hours = Math.min(72, Math.max(1, Number(body.hours) || DEFAULT_SESSION_HOURS));
    const expiresAt = new Date(ctx.now().getTime() + hours * 3600 * 1000);
    let session;
    for (let attempt = 0; attempt < 5 && !session; attempt++) {
      const code = newSessionCode();
      session = (await client.query(
        `INSERT INTO "MultiCamSession" ("brandId","code","title","location","sessionDate","expiresAt","createdBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("code") DO NOTHING RETURNING *`,
        [brand.id, code, title, location, sessionDate, expiresAt, who]
      )).rows[0];
    }
    if (!session) throw new Error("could not allocate a session code");
    const songs = Array.isArray(body.songs) ? body.songs.slice(0, MAX_SONGS_PER_SESSION) : [];
    for (const title of songs) if (cleanLabel(title, 80)) await insertSong(client, session.id, title);
    return sessionDetail(client, session, brand);
  }

  if (op === "list-sessions") {
    const rows = (await client.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM "MultiCamSong" g WHERE g."sessionId"=s."id") AS "songCount",
              (SELECT COUNT(*)::int FROM "MultiCamClip" c WHERE c."sessionId"=s."id" AND c."status"='uploaded') AS "clipCount"
       FROM "MultiCamSession" s WHERE s."brandId"=$1 ORDER BY s."sessionDate" DESC, s."createdAt" DESC LIMIT 50`,
      [brand.id]
    )).rows;
    return {
      sessions: rows.map((s) => ({
        id: s.id, title: s.title, location: s.location, sessionDate: isoOf(s.sessionDate), status: s.status,
        open: sessionIsOpen({ ...s, sessionDate: isoOf(s.sessionDate) }, ctx.now()), songCount: s.songCount, clipCount: s.clipCount
      }))
    };
  }

  const session = await hostSession(client, brand.id, body.sessionId);

  if (op === "get-session") return sessionDetail(client, session, brand);

  if (op === "add-song") { await insertSong(client, session.id, body.title); return sessionDetail(client, session, brand); }

  if (op === "end-session" || op === "reopen-session") {
    const status = op === "end-session" ? "closed" : "open";
    const expiresAt = op === "reopen-session" ? new Date(ctx.now().getTime() + DEFAULT_SESSION_HOURS * 3600 * 1000) : session.expiresAt;
    const row = (await client.query(
      `UPDATE "MultiCamSession" SET "status"=$2,"expiresAt"=$3,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 RETURNING *`,
      [session.id, status, expiresAt]
    )).rows[0];
    return sessionDetail(client, row, brand);
  }

  if (op === "request-make") {
    const song = (await client.query(`SELECT * FROM "MultiCamSong" WHERE "id"=$1 AND "sessionId"=$2`, [String(body.songId || ""), session.id])).rows[0];
    if (!song) throw new Bad(404, "Song not found");
    if (song.slug === LONG_TAKE_SLUG) throw new Bad(400, "Long takes are used by every song; tap Make it on a song instead");
    const uploaded = Number((await client.query(
      `SELECT COUNT(*)::int AS n FROM "MultiCamClip" c JOIN "MultiCamSong" g ON g."id"=c."songId"
       WHERE c."status"='uploaded' AND (c."songId"=$1 OR (g."sessionId"=$2 AND g."slug"=$3))`,
      [song.id, session.id, LONG_TAKE_SLUG]
    )).rows[0].n);
    if (!uploaded) throw new Bad(400, "No clips have finished uploading for this song yet");
    await client.query(
      `UPDATE "MultiCamSong" SET "status"='requested',"makeRequestedAt"=CURRENT_TIMESTAMP,"makeRequestedBy"=$2,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`,
      [song.id, who]
    );
    // Phase 3 hands this song to the auto-edit worker; until then the request is recorded for the editor (Claude) to pick up.
    return sessionDetail(client, session, brand);
  }

  if (op === "clip-download") {
    const clip = (await client.query(`SELECT * FROM "MultiCamClip" WHERE "id"=$1 AND "sessionId"=$2 AND "status"='uploaded'`, [String(body.clipId || ""), session.id])).rows[0];
    if (!clip) throw new Bad(404, "Clip not found");
    const url = await ctx.presign(ctx.s3, new GetObjectCommand({
      Bucket: clip.bucket, Key: clip.s3Key, ResponseContentDisposition: `attachment; filename="${clip.filename}"`
    }), { expiresIn: 3600 });
    return { url, filename: clip.filename };
  }
  throw new Bad(400, "Unknown MultiCam op");
}

// ----- band ops: the session code is the only credential -----

async function openSessionByCode(client, code, now) {
  const clean = normalizeCode(code);
  if (!clean) throw new Bad(404, "This MultiCam link is not valid");
  const row = (await client.query(
    `SELECT s.*, b."slug" AS "brandSlug", b."name" AS "brandName" FROM "MultiCamSession" s JOIN "Brand" b ON b."id"=s."brandId" WHERE s."code"=$1`,
    [clean]
  )).rows[0];
  if (!row) throw new Bad(404, "This MultiCam link is not valid");
  const session = { ...row, sessionDate: isoOf(row.sessionDate) };
  if (!sessionIsOpen(session, now)) throw new Bad(410, "This session has ended. Ask the host for a new QR code.");
  return session;
}

async function bandSummary(client, session) {
  const songs = (await client.query(`SELECT "id","title","slug" FROM "MultiCamSong" WHERE "sessionId"=$1 ORDER BY "position","createdAt"`, [session.id])).rows;
  const clips = (await client.query(
    `SELECT "songId","contributor","angle","status" FROM "MultiCamClip" WHERE "sessionId"=$1 AND "status"<>'aborted'`, [session.id]
  )).rows;
  return {
    session: { brandName: session.brandName, title: session.title, location: session.location, sessionDate: session.sessionDate, expiresAt: session.expiresAt },
    angles: DEFAULT_ANGLES,
    longTakeTitle: LONG_TAKE_TITLE,
    songs: songs.map((s) => ({
      id: s.id, title: s.title, longTake: s.slug === LONG_TAKE_SLUG,
      angles: clips.filter((c) => c.songId === s.id).map((c) => ({ contributor: c.contributor, angle: c.angle, status: c.status }))
    }))
  };
}

async function bandOp(op, body, client, ctx) {
  const session = await openSessionByCode(client, body.code, ctx.now());

  if (op === "join") return bandSummary(client, session);

  if (op === "band-add-song") { const song = await insertSong(client, session.id, body.title); return { song: { id: song.id, title: song.title }, ...(await bandSummary(client, session)) }; }

  if (op === "start-upload") {
    if (!ctx.bucket) throw new Error("MULTICAM_BUCKET is not configured");
    const song = (await client.query(`SELECT * FROM "MultiCamSong" WHERE "id"=$1 AND "sessionId"=$2`, [String(body.songId || ""), session.id])).rows[0];
    if (!song) throw new Bad(404, "Pick a song first");
    const contributor = cleanLabel(body.contributor, 40);
    const angle = cleanLabel(body.angle, 30);
    if (!contributor || !angle) throw new Bad(400, "Your name and your angle are required");
    const type = clipExtension(body.filename);
    if (!type) throw new Bad(400, "That file type is not a video (mp4, mov, m4v, webm) or audio file");
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CLIP_BYTES) throw new Bad(400, "File size is not supported");
    const clipCount = Number((await client.query(`SELECT COUNT(*)::int AS n FROM "MultiCamClip" WHERE "sessionId"=$1`, [session.id])).rows[0].n);
    if (clipCount >= MAX_CLIPS_PER_SESSION) throw new Bad(400, "This session has reached its clip limit");

    const uniq = randomUUID().replace(/-/g, "").slice(0, 6);
    const filename = clipFilename({ sessionDate: session.sessionDate, location: session.location, songTitle: song.title, contributor, angle, ext: type.ext, uniq });
    const key = clipKey({ brandSlug: session.brandSlug, session, songSlug: song.slug, filename });
    const contentType = /^(video|audio)\/[\w.+-]{1,60}$/.test(String(body.contentType || "")) ? String(body.contentType) : (type.kind === "video" ? "video/mp4" : "audio/mpeg");
    const { partSize, partCount } = partPlan(size);

    const created = await ctx.s3.send(new CreateMultipartUploadCommand({
      Bucket: ctx.bucket, Key: key, ContentType: contentType,
      Metadata: { "multicam-session": session.id, "multicam-song": song.id, contributor: slug(contributor, 24), angle: slug(angle, 20) }
    }));
    const clip = (await client.query(
      `INSERT INTO "MultiCamClip" ("sessionId","songId","contributor","angle","kind","filename","originalName","contentType","sizeBytes","partSize","partCount","bucket","s3Key","uploadId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING "id"`,
      [session.id, song.id, contributor, angle, type.kind, filename, String(body.filename).slice(0, 200), contentType, size, partSize, partCount, ctx.bucket, key, created.UploadId]
    )).rows[0];
    const parts = [];
    for (let n = 1; n <= partCount; n++) {
      parts.push({ partNumber: n, url: await ctx.presign(ctx.s3, new UploadPartCommand({ Bucket: ctx.bucket, Key: key, UploadId: created.UploadId, PartNumber: n }), { expiresIn: PART_URL_SECONDS }) });
    }
    return { clipId: clip.id, filename, partSize, partCount, parts };
  }

  const clip = (await client.query(`SELECT * FROM "MultiCamClip" WHERE "id"=$1 AND "sessionId"=$2`, [String(body.clipId || ""), session.id])).rows[0];
  if (!clip) throw new Bad(404, "Upload not found");

  if (op === "complete-upload") {
    if (clip.status === "uploaded") return { clipId: clip.id, filename: clip.filename, status: "uploaded" };
    if (clip.status !== "uploading") throw new Bad(409, "This upload was cancelled");
    const parts = validParts(body.parts, clip.partCount);
    if (!parts) throw new Bad(400, "The upload is incomplete; some parts are missing");
    await ctx.s3.send(new CompleteMultipartUploadCommand({ Bucket: clip.bucket, Key: clip.s3Key, UploadId: clip.uploadId, MultipartUpload: { Parts: parts } }));
    const head = await ctx.s3.send(new HeadObjectCommand({ Bucket: clip.bucket, Key: clip.s3Key }));
    if (Number(head.ContentLength) !== Number(clip.sizeBytes)) throw new Bad(409, "Uploaded size does not match the file");
    await client.query(`UPDATE "MultiCamClip" SET "status"='uploaded',"completedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, [clip.id]);
    return { clipId: clip.id, filename: clip.filename, status: "uploaded", ...(await bandSummary(client, session)) };
  }

  if (op === "abort-upload") {
    if (clip.status === "uploading") {
      try { await ctx.s3.send(new AbortMultipartUploadCommand({ Bucket: clip.bucket, Key: clip.s3Key, UploadId: clip.uploadId })); } catch (e) { console.warn("[multicam] abort failed", e?.name); }
      await client.query(`UPDATE "MultiCamClip" SET "status"='aborted' WHERE "id"=$1`, [clip.id]);
    }
    return { clipId: clip.id, status: "aborted" };
  }
  throw new Bad(400, "Unknown MultiCam op");
}
