import test from "node:test";
import assert from "node:assert/strict";
import {
  newSessionCode, normalizeCode, slug, cleanLabel, isoDate, yymmdd, clipExtension, partPlan, sessionFolder, clipFilename,
  clipKey, deliveryFolderName, sessionIsOpen, validParts, handleMultiCam, runMultiCamSetup, HOST_OPS, BAND_OPS,
  CODE_LENGTH, MIN_PART_BYTES, MAX_PARTS, LONG_TAKE_TITLE, LONG_TAKE_SLUG
} from "../services/dev-api-lambda/multicam.mjs";

const json = (status, body) => ({ status, body });

// ---------- pure helpers ----------

test("session codes are 10 unambiguous characters and normalize from what people type", () => {
  const code = newSessionCode();
  assert.equal(code.length, CODE_LENGTH);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]+$/);
  assert.equal(normalizeCode(code.toLowerCase()), code);
  assert.equal(normalizeCode("abcd-efgh-jk"), "ABCDEFGHJK");
  assert.equal(normalizeCode("ABCDEFGHJ0"), null); // 0 is never issued
  assert.equal(normalizeCode("SHORT"), null);
  assert.equal(normalizeCode(undefined), null);
});

test("names, dates and file types", () => {
  assert.equal(slug("Simple Twist of Fate!"), "simple-twist-of-fate");
  assert.equal(slug("Rock & Roll"), "rock-and-roll");
  assert.equal(slug("Café Señor"), "cafe-senor");
  assert.equal(cleanLabel("  Michael  ", 40), "Michael");
  assert.equal(cleanLabel("", 40), null);
  assert.equal(cleanLabel("!!!", 40), null);
  assert.equal(cleanLabel("x".repeat(41), 40), null);
  assert.equal(isoDate("2026-11-08"), "2026-11-08");
  assert.equal(isoDate("2026-02-30"), null);
  assert.equal(isoDate("261108"), null);
  assert.equal(yymmdd("2026-11-08"), "261108");
  assert.deepEqual(clipExtension("IMG_4821.MOV"), { ext: "mov", kind: "video" });
  assert.deepEqual(clipExtension("board.wav"), { ext: "wav", kind: "audio" });
  assert.equal(clipExtension("notes.pdf"), null);
  assert.equal(clipExtension("noext"), null);
});

test("part plan stays within S3 limits for small and huge files", () => {
  assert.deepEqual(partPlan(10), { partSize: MIN_PART_BYTES, partCount: 1 });
  assert.deepEqual(partPlan(MIN_PART_BYTES * 3 + 1), { partSize: MIN_PART_BYTES, partCount: 4 });
  const huge = partPlan(20 * 1024 ** 3);
  assert.ok(huge.partCount <= MAX_PARTS);
  assert.ok(huge.partSize >= MIN_PART_BYTES && huge.partSize % (1024 * 1024) === 0);
  const over = partPlan(300 * 1024 ** 3);
  assert.ok(over.partCount <= MAX_PARTS);
});

test("folders and file names follow Dean's YYMMDD convention", () => {
  const session = { id: "ab12cd34-0000-0000-0000-000000000000", sessionDate: "2026-11-08", location: "Studio One" };
  assert.equal(sessionFolder(session), "261108-studio-one-ab12cd34");
  const filename = clipFilename({ sessionDate: "2026-11-08", location: "Studio One", songTitle: "Simple Twist of Fate", contributor: "Michael", angle: "Drums", ext: "mp4", uniq: "x1y2z3" });
  assert.equal(filename, "261108_studio-one_simple-twist-of-fate_michael_drums_x1y2z3.mp4");
  assert.equal(clipKey({ brandSlug: "stashbox", session, songSlug: "simple-twist-of-fate", filename }),
    "multicam/stashbox/261108-studio-one-ab12cd34/simple-twist-of-fate/" + filename);
  assert.equal(deliveryFolderName(session, ["Dean", "Michael", "Dean", "David", "Ron"]), "261108-studio-one-dean-michael-david-ron");
});

test("a session is open only while status is open and it has not expired", () => {
  const now = new Date("2026-11-08T20:00:00Z");
  assert.equal(sessionIsOpen({ status: "open", expiresAt: "2026-11-09T02:00:00Z" }, now), true);
  assert.equal(sessionIsOpen({ status: "open", expiresAt: "2026-11-08T19:59:59Z" }, now), false);
  assert.equal(sessionIsOpen({ status: "closed", expiresAt: "2026-11-09T02:00:00Z" }, now), false);
  assert.equal(sessionIsOpen(null, now), false);
});

test("completed parts must be complete, in order and well-formed", () => {
  assert.deepEqual(validParts([{ partNumber: 1, etag: '"abc"' }, { partNumber: 2, etag: "def" }], 2),
    [{ PartNumber: 1, ETag: '"abc"' }, { PartNumber: 2, ETag: '"def"' }]);
  assert.equal(validParts([{ partNumber: 1, etag: "abc" }], 2), null);
  assert.equal(validParts([{ partNumber: 2, etag: "abc" }, { partNumber: 1, etag: "def" }], 2), null);
  assert.equal(validParts([{ partNumber: 1, etag: "bad etag<script>" }], 1), null);
  assert.equal(validParts("nope", 1), null);
});

test("host and band op lists do not overlap", () => {
  assert.equal(HOST_OPS.filter((op) => BAND_OPS.includes(op)).length, 0);
});

// ---------- ops against a fake database and S3 ----------

function fakeWorld({ status = "open", expiresAt = "2099-01-01T00:00:00Z" } = {}) {
  const brand = { id: "b1", slug: "stashbox", name: "Stashbox" };
  const session = { id: "5e551011-0000-4000-8000-000000000001", brandId: "b1", code: "ABCDEFGHJK", title: null, location: "Studio One", sessionDate: "2026-11-08", status, expiresAt, brandSlug: "stashbox", brandName: "Stashbox" };
  const songs = [{ id: "50000000-0000-4000-8000-000000000001", sessionId: session.id, title: "Simple Twist", slug: "simple-twist", position: 0, status: "collecting" }];
  const clips = [];
  const log = [];
  const client = {
    async query(sql, params = []) {
      log.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
      if (sql.includes('FROM "Brand"')) return { rows: params[0] === "stashbox" ? [brand] : [] };
      if (sql.includes('FROM "MultiCamSession" s JOIN "Brand"')) return { rows: params[0] === session.code ? [session] : [] };
      if (sql.includes('SELECT * FROM "MultiCamSession"')) return { rows: params[0] === session.id && params[1] === brand.id ? [session] : [] };
      if (sql.includes('INSERT INTO "MultiCamSession"')) { Object.assign(session, { code: params[1], location: params[3], sessionDate: params[4], expiresAt: params[5] }); return { rows: [session] }; }
      if (sql.includes('COUNT(*)::int AS n FROM "MultiCamSong"')) return { rows: [{ n: songs.length }] };
      if (sql.includes('FROM "MultiCamSong" WHERE "sessionId"=$1 AND "slug"=$2')) return { rows: songs.filter((s) => s.slug === params[1]) };
      if (sql.includes('INSERT INTO "MultiCamSong"')) { const s = { id: "song-" + songs.length, sessionId: params[0], title: params[1], slug: params[2], position: params[3], status: "collecting" }; songs.push(s); return { rows: [s] }; }
      if (sql.includes('FROM "MultiCamSong" WHERE "id"=$1 AND "sessionId"=$2')) return { rows: songs.filter((s) => s.id === params[0]) };
      if (sql.includes('FROM "MultiCamSong" WHERE "sessionId"=$1 ORDER BY')) return { rows: songs };
      if (sql.includes('UPDATE "MultiCamSong"')) { songs.find((s) => s.id === params[0]).status = "requested"; return { rows: [] }; }
      if (sql.includes('COUNT(*)::int AS n FROM "MultiCamClip" c JOIN')) {
        const longIds = songs.filter((g) => g.slug === params[2]).map((g) => g.id);
        return { rows: [{ n: clips.filter((c) => c.status === "uploaded" && (c.songId === params[0] || longIds.includes(c.songId))).length }] };
      }
      if (sql.includes('COUNT(*)::int AS n FROM "MultiCamClip"')) return { rows: [{ n: clips.length }] };
      if (sql.includes('INSERT INTO "MultiCamClip"')) {
        const c = { id: "clip-" + clips.length, sessionId: params[0], songId: params[1], contributor: params[2], angle: params[3], kind: params[4], filename: params[5], sizeBytes: params[8], partSize: params[9], partCount: params[10], bucket: params[11], s3Key: params[12], uploadId: params[13], status: "uploading" };
        clips.push(c); return { rows: [{ id: c.id }] };
      }
      if (sql.includes('SELECT * FROM "MultiCamClip" WHERE "id"=$1')) return { rows: clips.filter((c) => c.id === params[0] && (!sql.includes("'uploaded'") || c.status === "uploaded")) };
      if (sql.includes('UPDATE "MultiCamClip" SET "status"=\'uploaded\'')) { clips.find((c) => c.id === params[0]).status = "uploaded"; return { rows: [] }; }
      if (sql.includes('UPDATE "MultiCamClip" SET "status"=\'aborted\'')) { clips.find((c) => c.id === params[0]).status = "aborted"; return { rows: [] }; }
      if (sql.includes('FROM "MultiCamClip"')) return { rows: clips.filter((c) => c.status !== "aborted") };
      return { rows: [] };
    },
    async end() {}
  };
  const sent = [];
  const s3 = { async send(cmd) { sent.push(cmd.constructor.name); if (cmd.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "up-1" }; if (cmd.constructor.name === "HeadObjectCommand") return { ContentLength: clips[0]?.sizeBytes }; return {}; } };
  const deps = { s3, bucket: "test-bucket", presign: async (_c, cmd) => "https://s3.example/" + cmd.constructor.name + "?part=" + (cmd.input.PartNumber ?? ""), now: () => new Date("2026-11-08T20:00:00Z") };
  return { connect: async () => client, deps, session, songs, clips, sent, log };
}

test("unknown ops are refused before touching the database", async () => {
  const w = fakeWorld();
  const r = await handleMultiCam({ op: "drop-tables" }, w.connect, json, w.deps);
  assert.equal(r.status, 400);
  assert.equal(w.log.length, 0);
});

test("band ops need a valid, open session code", async () => {
  let w = fakeWorld();
  assert.equal((await handleMultiCam({ op: "join", code: "nope" }, w.connect, json, w.deps)).status, 404);
  assert.equal((await handleMultiCam({ op: "join", code: "ZZZZZZZZZZ" }, w.connect, json, w.deps)).status, 404);
  w = fakeWorld({ status: "closed" });
  assert.equal((await handleMultiCam({ op: "join", code: "ABCDEFGHJK" }, w.connect, json, w.deps)).status, 410);
  w = fakeWorld({ expiresAt: "2026-11-08T19:00:00Z" });
  assert.equal((await handleMultiCam({ op: "join", code: "abcde-fghjk" }, w.connect, json, w.deps)).status, 410);
  w = fakeWorld();
  const ok = await handleMultiCam({ op: "join", code: "abcde-fghjk" }, w.connect, json, w.deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.brandName, "Stashbox");
  assert.equal(ok.body.songs[0].title, "Simple Twist");
  assert.equal(ok.body.session.code, undefined, "the band never gets the code back or brand ids");
});

test("a band upload goes start → complete, named and keyed per session and song", async () => {
  const w = fakeWorld();
  const size = MIN_PART_BYTES * 2 + 5;
  const start = await handleMultiCam({ op: "start-upload", code: "ABCDEFGHJK", songId: w.songs[0].id, contributor: "Michael", angle: "Drums", filename: "IMG_1.MOV", size, contentType: "video/quicktime" }, w.connect, json, w.deps);
  assert.equal(start.status, 200);
  assert.equal(start.body.partCount, 3);
  assert.equal(start.body.parts.length, 3);
  assert.match(start.body.filename, /^261108_studio-one_simple-twist_michael_drums_[0-9a-f]{6}\.mov$/);
  assert.match(w.clips[0].s3Key, /^multicam\/stashbox\/261108-studio-one-5e551011\/simple-twist\//);
  assert.deepEqual(w.sent, ["CreateMultipartUploadCommand"]);

  const missing = await handleMultiCam({ op: "complete-upload", code: "ABCDEFGHJK", clipId: start.body.clipId, parts: [{ partNumber: 1, etag: "a" }] }, w.connect, json, w.deps);
  assert.equal(missing.status, 400);

  const parts = [1, 2, 3].map((n) => ({ partNumber: n, etag: "e" + n }));
  const done = await handleMultiCam({ op: "complete-upload", code: "ABCDEFGHJK", clipId: start.body.clipId, parts }, w.connect, json, w.deps);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "uploaded");
  assert.deepEqual(w.sent.slice(1), ["CompleteMultipartUploadCommand", "HeadObjectCommand"]);
  assert.equal(done.body.songs[0].angles[0].angle, "Drums");
});

test("start-upload refuses bad names, file types and sizes", async () => {
  const w = fakeWorld();
  const base = { op: "start-upload", code: "ABCDEFGHJK", songId: w.songs[0].id, contributor: "Ron", angle: "Wide", filename: "a.mp4", size: 100 };
  assert.equal((await handleMultiCam({ ...base, contributor: "" }, w.connect, json, w.deps)).status, 400);
  assert.equal((await handleMultiCam({ ...base, filename: "a.exe" }, w.connect, json, w.deps)).status, 400);
  assert.equal((await handleMultiCam({ ...base, size: 0 }, w.connect, json, w.deps)).status, 400);
  assert.equal((await handleMultiCam({ ...base, size: 50 * 1024 ** 3 }, w.connect, json, w.deps)).status, 400);
  assert.equal((await handleMultiCam({ ...base, songId: "other" }, w.connect, json, w.deps)).status, 404);
  assert.equal(w.sent.length, 0);
});

test("host: Make it needs at least one finished clip, then records the request", async () => {
  const w = fakeWorld();
  const req = { op: "request-make", brand: "stashbox", sessionId: w.session.id, songId: w.songs[0].id, requestedBy: "dean@example.com" };
  assert.equal((await handleMultiCam(req, w.connect, json, w.deps)).status, 400);
  w.clips.push({ id: "c1", songId: w.songs[0].id, status: "uploaded", contributor: "Dean", angle: "Singer", sizeBytes: 5 });
  const r = await handleMultiCam(req, w.connect, json, w.deps);
  assert.equal(r.status, 200);
  assert.equal(w.songs[0].status, "requested");
  assert.equal(r.body.session.code, "ABCDEFGHJK", "the host does get the code back to show the QR again");
});

test("host ops are scoped to the brand", async () => {
  const w = fakeWorld();
  assert.equal((await handleMultiCam({ op: "get-session", brand: "solarmeister", sessionId: w.session.id }, w.connect, json, w.deps)).status, 404);
  assert.equal((await handleMultiCam({ op: "get-session", brand: "stashbox", sessionId: "not-a-uuid" }, w.connect, json, w.deps)).status, 400);
});

test("host: create-session validates and seeds songs", async () => {
  const w = fakeWorld();
  w.songs.length = 0;
  assert.equal((await handleMultiCam({ op: "create-session", brand: "stashbox", location: "", sessionDate: "2026-11-08" }, w.connect, json, w.deps)).status, 400);
  const r = await handleMultiCam({ op: "create-session", brand: "stashbox", location: "Studio One", sessionDate: "2026-11-08", songs: ["Lovesick", "Simple Twist", ""] }, w.connect, json, w.deps);
  assert.equal(r.status, 200);
  assert.equal(w.songs.length, 2);
  assert.match(r.body.session.code, /^[A-Z2-9]{10}$/);
});

test("setup action is IAM-only and a dry run by default", async () => {
  const queries = [];
  const connect = async () => ({ async query(sql) { queries.push(sql); return { rows: [] }; }, async end() {} });
  assert.equal((await runMultiCamSetup({ requestContext: {} }, connect, json)).status, 403);
  const dry = await runMultiCamSetup({}, connect, json);
  assert.equal(dry.body.mode, "dry-run");
  assert.ok(!queries.some((q) => q.includes("CREATE TABLE")));
  const applied = await runMultiCamSetup({ mode: "apply" }, connect, json);
  assert.deepEqual(applied.body.created, ["MultiCamSession", "MultiCamSong", "MultiCamClip"]);
  assert.ok(queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "MultiCamClip"')));
});

test("a long take (several songs in one file) counts for every song's Make it", async () => {
  assert.equal(slug(LONG_TAKE_TITLE), LONG_TAKE_SLUG);
  const w = fakeWorld();
  w.songs.push({ id: "50000000-0000-4000-8000-000000000002", sessionId: w.session.id, title: LONG_TAKE_TITLE, slug: LONG_TAKE_SLUG, position: 1, status: "collecting" });
  w.clips.push({ id: "c9", songId: w.songs[1].id, status: "uploaded", contributor: "Ron", angle: "Wide", sizeBytes: 9 });
  const r = await handleMultiCam({ op: "request-make", brand: "stashbox", sessionId: w.session.id, songId: w.songs[0].id }, w.connect, json, w.deps);
  assert.equal(r.status, 200);
  assert.equal(w.songs[0].status, "requested");
  const own = await handleMultiCam({ op: "request-make", brand: "stashbox", sessionId: w.session.id, songId: w.songs[1].id }, w.connect, json, w.deps);
  assert.equal(own.status, 400, "the long-take bucket itself is not a song to make");
  const joined = await handleMultiCam({ op: "join", code: "ABCDEFGHJK" }, w.connect, json, w.deps);
  assert.equal(joined.body.longTakeTitle, LONG_TAKE_TITLE);
  assert.equal(joined.body.songs.find((x) => x.longTake).title, LONG_TAKE_TITLE);
});
