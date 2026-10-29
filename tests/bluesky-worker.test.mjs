import test from "node:test";
import assert from "node:assert/strict";
import {
  graphemeLength, postText, facetsFor, postRequest, requestFromPost, postUrl, secretNameFor, account,
  publish, prepareImage, publishingTick, moveCountdowns, handler, IMAGE_BYTE_LIMIT, secretSessionStore, oauthClient, complianceProblems
} from "../services/bluesky-lambda/index.mjs";

const ROOT = "/1---elettro-brand-os/brands/stashbox/";
const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const record = { did: DID, handle: "@stashboxmusic.bsky.social", pds: "https://morel.us-east.host.bsky.network", brand: "stashbox", session: { tokenSet: {} }, expiresAt: "2027-04-01T00:00:00Z" };

// A fake OAuth session that records every XRPC call.
function fakeSession(handlers = {}) {
  const calls = [];
  return {
    calls,
    async fetchHandler(path, init) {
      calls.push({ path, init });
      const nsid = path.split("?")[0].replace("/xrpc/", "");
      const out = handlers[nsid] ? handlers[nsid](init, path) : {};
      return { ok: !out.__fail, status: out.__fail ? 400 : 200, json: async () => out };
    }
  };
}

test("text is cut at 300 graphemes and the one hashtag always survives", () => {
  assert.equal(graphemeLength("a\u{1F468}‍\u{1F469}‍\u{1F467}b"), 3);
  const long = "x".repeat(400);
  const out = postText(long, ["#Reggae", "other"]);
  assert.ok(graphemeLength(out) <= 300);
  assert.ok(out.endsWith("\n\n#Reggae"));
  assert.equal(postText("Hello", []), "Hello");
  assert.ok(graphemeLength(postText(long)) <= 300);
});

test("links and hashtags become facets at UTF-8 byte offsets, trailing punctuation excluded", () => {
  const text = "Café night \u{1F3B8} see https://stashbox.band/live. #Reggae";
  const facets = facetsFor(text);
  const bytes = new TextEncoder().encode(text);
  const slice = (f) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
  assert.equal(facets.length, 2);
  assert.equal(slice(facets[0]), "https://stashbox.band/live");
  assert.equal(facets[0].features[0].uri, "https://stashbox.band/live");
  assert.equal(slice(facets[1]), "#Reggae");
  assert.equal(facets[1].features[0].tag, "Reggae");
  assert.deepEqual(facetsFor("no links, 100% plain, #123"), []);
});

test("manual post requests: text, up to 4 images, or one video, never both", () => {
  assert.equal(postRequest({ brand: "stashbox", text: "hi" }).kind, "text");
  assert.equal(postRequest({ brand: "stashbox", dropboxPaths: [ROOT + "a.jpg", ROOT + "b.PNG"] }).kind, "images");
  assert.equal(postRequest({ brand: "stashbox", dropboxPath: ROOT + "clip.mp4" }).kind, "video");
  assert.throws(() => postRequest({ brand: "stashbox" }), /needs text/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPaths: Array(5).fill(ROOT + "a.jpg") }), /up to 4/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPaths: [ROOT + "a.jpg", ROOT + "c.mp4"] }), /not both/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: "/etc/passwd.jpg" }), /must be inside/);
  assert.throws(() => postRequest({ brand: "stashbox", dropboxPath: ROOT + "../x.jpg" }), /must be inside/);
  assert.throws(() => postRequest({ brand: "stashbox", text: "y".repeat(301) }), /300/);
});

test("planner posts map to images or a video, and a short carousel fails instead of posting fewer", () => {
  const base = { caption: "Live at the pier", hashtags: ["Reggae"], channelId: DID };
  const photo = requestFromPost({ ...base, placement: "post", dropboxPath: ROOT + "a.jpg" });
  assert.deepEqual([photo.kind, photo.paths.length, photo.userId], ["images", 1, DID]);
  const carousel = requestFromPost({ ...base, placement: "carousel", slides: [{ dropboxPath: ROOT + "a.jpg" }, { dropboxPath: ROOT + "b.jpg" }, { dropboxPath: ROOT + "c.jpg" }] });
  assert.equal(carousel.paths.length, 3);
  assert.throws(() => requestFromPost({ ...base, placement: "carousel", slides: [] }), /needs 2-4/);
  assert.throws(() => requestFromPost({ ...base, placement: "carousel", slides: Array(5).fill({ dropboxPath: ROOT + "a.jpg" }) }), /needs 2-4/);
  assert.equal(requestFromPost({ ...base, placement: "video", dropboxPath: ROOT + "v.mp4" }).kind, "video");
  assert.throws(() => requestFromPost({ ...base, placement: "post", dropboxPath: ROOT + "v.mp4" }), /photo post/);
});

test("secret names and post URLs", () => {
  assert.equal(secretNameFor("did:plc:abc"), "elettro-brand-os-dev/bluesky/did_plc_abc");
  assert.equal(postUrl("@a.bsky.social", "at://did:plc:abc/app.bsky.feed.post/3kxyz"), "https://bsky.app/profile/a.bsky.social/post/3kxyz");
});

test("a text post with a link creates one record with facets and no embed", async () => {
  const session = fakeSession({ "com.atproto.repo.createRecord": () => ({ uri: `at://${DID}/app.bsky.feed.post/3kabc`, cid: "c" }) });
  const sent = await publish(session, record, { kind: "text", text: "New video https://stashbox.band #Reggae", paths: [] });
  assert.equal(sent.url, "https://bsky.app/profile/stashboxmusic.bsky.social/post/3kabc");
  const body = JSON.parse(session.calls[0].init.body);
  assert.equal(body.repo, DID);
  assert.equal(body.collection, "app.bsky.feed.post");
  assert.equal(body.record.facets.length, 2);
  assert.equal(body.record.embed, undefined);
});

test("photos are re-encoded, uploaded in order with alt text and aspect ratio, then embedded", async () => {
  let n = 0;
  const session = fakeSession({
    "com.atproto.repo.uploadBlob": () => ({ blob: { $type: "blob", ref: { $link: "cid" + ++n }, mimeType: "image/jpeg", size: 10 } }),
    "com.atproto.repo.createRecord": () => ({ uri: `at://${DID}/app.bsky.feed.post/3kimg` })
  });
  const prepare = async () => ({ bytes: Buffer.from("jpg"), mime: "image/jpeg", width: 1600, height: 1200 });
  await publish(session, record, { kind: "images", text: "Two shots", paths: [ROOT + "a.jpg", ROOT + "b.jpg"], alt: "Band on stage" }, { download: async () => Buffer.from("raw"), prepare });
  const uploads = session.calls.filter((c) => c.path.includes("uploadBlob"));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].init.headers["content-type"], "image/jpeg");
  const embed = JSON.parse(session.calls.at(-1).init.body).record.embed;
  assert.equal(embed.$type, "app.bsky.embed.images");
  assert.deepEqual(embed.images.map((i) => i.image.ref.$link), ["cid1", "cid2"]);
  assert.deepEqual(embed.images[0], { image: embed.images[0].image, alt: "Band on stage", aspectRatio: { width: 1600, height: 1200 } });
});

test("a video goes through service auth, the video service and its job status, then embeds the blob", async () => {
  const session = fakeSession({
    "com.atproto.server.getServiceAuth": () => ({ token: "svc-token" }),
    "com.atproto.repo.createRecord": () => ({ uri: `at://${DID}/app.bsky.feed.post/3kvid` })
  });
  const seen = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    seen.push([String(url), init?.headers?.authorization]);
    if (String(url).includes("uploadVideo")) return { ok: true, status: 200, text: async () => JSON.stringify({ jobId: "job1", state: "JOB_STATE_CREATED" }) };
    polls += 1;
    return { ok: true, status: 200, json: async () => ({ jobStatus: polls < 2 ? { jobId: "job1", state: "JOB_STATE_PROCESSING" } : { jobId: "job1", state: "JOB_STATE_COMPLETED", blob: { $type: "blob", ref: { $link: "vid" }, mimeType: "video/mp4", size: 5 } } }) };
  };
  await publish(session, record, { kind: "video", text: "Clip", paths: [ROOT + "v.mp4"], alt: "" }, { download: async () => Buffer.from("mp4"), fetchImpl, wait: async () => {}, pollMs: 1 });
  const auth = new URLSearchParams(session.calls[0].path.split("?")[1]);
  assert.equal(auth.get("aud"), "did:web:morel.us-east.host.bsky.network");
  assert.equal(auth.get("lxm"), "com.atproto.repo.uploadBlob");
  assert.equal(seen[0][1], "Bearer svc-token");
  assert.ok(seen[0][0].startsWith("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?"));
  assert.equal(polls, 2);
  const embed = JSON.parse(session.calls.at(-1).init.body).record.embed;
  assert.equal(embed.$type, "app.bsky.embed.video");
  assert.equal(embed.video.ref.$link, "vid");
});

test("a refused video upload reports the status and what Bluesky said", async () => {
  const session = fakeSession({ "com.atproto.server.getServiceAuth": () => ({ token: "t" }) });
  const refused = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: "InvalidToken", message: "bad audience" }) });
  await assert.rejects(publish(session, record, { kind: "video", text: "", paths: [ROOT + "v.mp4"] }, { download: async () => Buffer.from("x"), fetchImpl: refused, wait: async () => {} }), /HTTP 401 InvalidToken bad audience/);
  const plain = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });
  await assert.rejects(publish(session, record, { kind: "video", text: "", paths: [ROOT + "v.mp4"] }, { download: async () => Buffer.from("x"), fetchImpl: plain, wait: async () => {} }), /HTTP 401 Unauthorized/);
});

test("a failed video job and an oversize video stop before any post is created", async () => {
  const session = fakeSession({ "com.atproto.server.getServiceAuth": () => ({ token: "t" }) });
  const failing = async (url) => String(url).includes("uploadVideo")
    ? { ok: true, status: 200, text: async () => JSON.stringify({ jobId: "j" }) }
    : { ok: true, status: 200, json: async () => ({ jobStatus: { state: "JOB_STATE_FAILED", error: "bad codec" } }) };
  await assert.rejects(publish(session, record, { kind: "video", text: "", paths: [ROOT + "v.mp4"] }, { download: async () => Buffer.from("x"), fetchImpl: failing, wait: async () => {} }), /bad codec/);
  assert.ok(!session.calls.some((c) => c.path.includes("createRecord")));
  await assert.rejects(publish(session, record, { kind: "video", text: "", paths: [ROOT + "v.mp4"] }, { download: async () => ({ length: 101 * 1024 * 1024 }) }), /100 MB/);
});

test("prepareImage steps quality and size down until the blob fits", async () => {
  const sizes = [];
  const sharp = () => {
    const chain = {
      rotate: () => chain, resize: (o) => { chain.edge = o.width; return chain; }, flatten: () => chain,
      jpeg: ({ quality }) => { chain.quality = quality; return chain; },
      toBuffer: async () => { const size = chain.quality > 70 ? 2_000_000 : 900_000; sizes.push(chain.quality); return { data: Buffer.alloc(size), info: { width: 1500, height: 1000 } }; }
    };
    return chain;
  };
  const out = await prepareImage(Buffer.from("x"), { sharp });
  assert.ok(out.bytes.length <= IMAGE_BYTE_LIMIT);
  assert.deepEqual([out.width, out.height, out.mime], [1500, 1000, "image/jpeg"]);
  assert.ok(sizes.length > 1);
});

test("account() finds the did's login, refuses a revoked or expired one", async () => {
  const names = async () => [secretNameFor(DID)];
  const now = new Date("2026-11-01T00:00:00Z");
  assert.equal((await account(null, DID, { names, read: async () => record, now })).did, DID);
  await assert.rejects(account(null, DID, { names, read: async () => ({ ...record, revokedAt: "2026-10-31" }), now }), /No Bluesky account/);
  await assert.rejects(account(null, DID, { names, read: async () => ({ ...record, expiresAt: "2026-10-01T00:00:00Z" }), now }), /expired/);
  await assert.rejects(account("elettro", null, { names, read: async () => record, now }), /No Bluesky account/);
});

test("the tick claims bluesky posts, publishes with the restored session, and reports every outcome", async () => {
  const calls = [];
  const callApi = async (payload) => {
    calls.push(payload);
    if (payload.action === "claim-due-posts") return { ok: true, missed: 0, stuck: 0, posts: [
      { id: "p1", placement: "post", caption: "One", hashtags: [], dropboxPath: ROOT + "a.jpg", channelId: DID },
      { id: "p2", placement: "carousel", caption: "Two", hashtags: [], slides: [], channelId: DID }
    ] };
    return { ok: true };
  };
  const restored = [];
  const getClient = async () => ({ client: { restore: async (did) => { restored.push(did); return "session"; } }, changed: new Set() });
  const send = async (session, rec, request) => ({ uri: `at://${DID}/app.bsky.feed.post/3k1`, url: "https://bsky.app/profile/x/post/3k1" });
  const out = await publishingTick({ callApi, getClient, find: async () => record, send, countdowns: async () => [] });
  assert.deepEqual(calls[0], { action: "claim-due-posts", destination: "bluesky", placements: ["post", "carousel", "video"], limit: 1 });
  assert.equal(out.published[0].externalPostId, `at://${DID}/app.bsky.feed.post/3k1`);
  assert.match(out.published[1].error, /needs 2-4/);
  assert.deepEqual(calls.filter((c) => c.action === "finish-post").map((c) => [c.id, Boolean(c.externalPostId), Boolean(c.error)]), [["p1", true, false], ["p2", false, true]]);
  assert.deepEqual(restored, [DID]);
});

test("a login Bluesky rejects fails the post with a reconnect message", async () => {
  const callApi = async (p) => p.action === "claim-due-posts" ? { ok: true, posts: [{ id: "p1", placement: "post", caption: "x", dropboxPath: ROOT + "a.jpg", channelId: DID }] } : { ok: true };
  const getClient = async () => ({ client: { restore: async () => { throw new Error("invalid_grant"); } }, changed: new Set() });
  const out = await publishingTick({ callApi, getClient, find: async () => record, send: async () => { throw new Error("must not post"); }, countdowns: async () => [] });
  assert.match(out.published[0].error, /reconnect it on \/connections/);
});

test("refreshed logins move the reconnect countdown through set-token-expiry", async () => {
  const sent = [];
  const out = await moveCountdowns(new Set([DID]), async (p) => { sent.push(p); return { ok: true }; }, async () => record);
  assert.deepEqual(sent, [{ action: "set-token-expiry", destination: "bluesky", externalAccountId: DID, tokenExpiresAt: record.expiresAt }]);
  assert.deepEqual(out, [{ did: DID, ok: true }]);
});

test("the handler refuses HTTP callers and unknown or invalid actions", async () => {
  assert.equal((await handler({ requestContext: {} })).statusCode, 403);
  assert.equal((await handler({ action: "nope" })).statusCode, 400);
  assert.equal((await handler({ action: "post", brand: "stashbox" })).statusCode, 400);
});

test("the session store reads and writes the account's secret; a rotated token notes the did and the new reconnect date", async () => {
  const secrets = { [secretNameFor(DID)]: { brand: "stashbox", handle: "@stashboxmusic.bsky.social", connectedAt: "2026-10-30T00:00:00Z", session: { old: true } } };
  const changed = new Set();
  const NOW = new Date("2026-11-10T00:00:00Z");
  const store = secretSessionStore({ readSecret: async (id) => { if (!secrets[id]) throw new Error("nf"); return secrets[id]; }, writeSecret: async (id, r) => { secrets[id] = r; }, now: () => NOW, changed });
  assert.deepEqual(await store.get(DID), { old: true });
  await store.set(DID, { fresh: true });
  assert.deepEqual(secrets[secretNameFor(DID)].session, { fresh: true });
  assert.equal(secrets[secretNameFor(DID)].brand, "stashbox", "other fields are kept");
  assert.equal(secrets[secretNameFor(DID)].expiresAt, "2027-05-09T00:00:00.000Z");
  assert.deepEqual([...changed], [DID]);
  await store.del(DID);
  assert.equal(secrets[secretNameFor(DID)].session, undefined);
  assert.equal(secrets[secretNameFor(DID)].revokedAt, NOW.toISOString());
  assert.equal(await store.get("did:plc:unknown"), undefined);
});

test("the real OAuth client builds from the signing-key secret and can restore", async () => {
  const { JoseKey } = await import("@atproto/jwk-jose");
  const key = await JoseKey.generate(["ES256"], "k1");
  const { client } = await oauthClient({ readSecret: async () => ({ privateJwk: JSON.stringify(key.privateJwk) }), writeSecret: async () => {} });
  assert.equal(typeof client.restore, "function");
  assert.equal(client.clientMetadata.client_id, "https://os.elettro.com/api/connections/bluesky/client-metadata");
  await assert.rejects(oauthClient({ readSecret: async () => ({}), writeSecret: async () => {} }), /privateJwk/);
});

test("a cut never lands inside a link, so a long caption never ships a broken URL", () => {
  const url = "https://stashbox.band/live/very-long-path-" + "x".repeat(60);
  const text = postText("A".repeat(250) + " " + url + " wraps up the night", ["Reggae"]);
  assert.ok(graphemeLength(text) <= 300);
  assert.ok(!/https?:\/\/\S*$/.test(text.replace(/\n\n#Reggae$/, "")) || text.includes(url), "either the whole URL or none of it");
  const short = postText("Shows this month " + "https://stashbox.band/live", []);
  assert.ok(short.includes("https://stashbox.band/live"));
});

test("scheduled posts may carry one link and may not @mention anyone", () => {
  assert.deepEqual(complianceProblems("Live Friday https://stashbox.band/live #Reggae"), []);
  assert.deepEqual(complianceProblems("Write to booking@stashbox.band"), [], "an email address is not a mention");
  assert.match(complianceProblems("a https://a.example/x and https://b.example/y")[0], /1 link/);
  assert.match(complianceProblems("Thanks @someone.bsky.social for the love")[0], /@mention/);
  const base = { placement: "post", dropboxPath: ROOT + "a.jpg", channelId: DID, hashtags: [] };
  assert.throws(() => requestFromPost({ ...base, caption: "hey @friend.bsky.social" }), /@mention/);
  assert.throws(() => requestFromPost({ ...base, caption: "https://a.example https://b.example" }), /1 link/);
  assert.equal(requestFromPost({ ...base, caption: "Live Friday https://stashbox.band/live" }).kind, "images");
});
