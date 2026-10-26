import test from "node:test";
import assert from "node:assert/strict";
import { hasPhoneNumber, mixAllows, postRequest, accessToken, checkMix, publish, publishingTick, handler } from "../services/gmb-lambda/index.mjs";

const LOCATION = "accounts/1234567890/locations/9876543210";
const ROOT = "/1---elettro-brand-os/brands/stashbox/";
const NOW = new Date("2026-10-26T12:00:00Z");
const post = (over = {}, gmb = {}) => ({
  id: "p1", placement: "update", caption: "Book Stashbox for your next corporate event, resort night or private party.",
  channelId: LOCATION, dropboxPath: ROOT + "gig.jpg", assetMime: "image/jpeg", assetBytes: "800000", assetWidth: 1200, assetHeight: 900,
  gmb: { pillar: "A", topicType: "STANDARD", cta: { actionType: "BOOK", url: "https://elettro.com/book" }, ...gmb }, ...over
});
const blocked = (p, pattern) => assert.throws(() => postRequest(p, NOW), pattern);

test("a good Update post becomes the localPosts body the spec shows", () => {
  const r = postRequest(post(), NOW);
  assert.equal(r.locationId, LOCATION);
  assert.equal(r.pillar, "A");
  assert.deepEqual(r.body, {
    languageCode: "en-US", topicType: "STANDARD",
    summary: "Book Stashbox for your next corporate event, resort night or private party.",
    callToAction: { actionType: "BOOK", url: "https://elettro.com/book" }
  });
});

test("an Offer needs a title, dates and a link that is not shortened", () => {
  const offer = { topicType: "OFFER", title: "Spring dates", start: "2026-11-01", end: "2026-12-15", offer: { couponCode: "SPRING", redeemOnlineUrl: "https://elettro.com/offer", termsConditions: "New bookings only." } };
  const r = postRequest(post({}, offer), NOW);
  assert.equal(r.body.event.title, "Spring dates");
  assert.deepEqual(r.body.event.schedule.startDate, { year: 2026, month: 11, day: 1 });
  assert.deepEqual(r.body.event.schedule.endTime, { hours: 23, minutes: 59 });
  assert.deepEqual(r.body.offer, { couponCode: "SPRING", redeemOnlineUrl: "https://elettro.com/offer", termsConditions: "New bookings only." });
  blocked(post({}, { ...offer, title: "" }), /needs a title/);
  blocked(post({}, { ...offer, title: "x".repeat(59) }), /over 58.*59/);
  blocked(post({}, { ...offer, start: "11/01/2026" }), /YYYY-MM-DD/);
  blocked(post({}, { ...offer, start: "2026-02-30" }), /YYYY-MM-DD/);
  blocked(post({}, { ...offer, end: "2026-10-31" }), /on or after/);
  blocked(post({}, { ...offer, start: "2026-09-01", end: "2026-10-01" }), /already ended/);
  blocked(post({}, { ...offer, offer: { redeemOnlineUrl: "https://bit.ly/x" } }), /shortened.*bit\.ly/);
});

test("Event, video and unknown post types are not built", () => {
  blocked(post({}, { topicType: "EVENT" }), /only Update.*EVENT/);
  blocked(post({}, { topicType: "ALERT" }), /only Update.*ALERT/);
});

test("every post needs one pillar and that pillar's button", () => {
  blocked(post({}, { pillar: "" }), /pillar tag.*none/);
  blocked(post({}, { pillar: "Z" }), /pillar tag.*Z/);
  blocked(post({ gmb: undefined }), /no GBP details/);
  blocked(post({}, { cta: { actionType: "LEARN_MORE", url: "https://elettro.com" } }), /pillar A must use BOOK/);
  assert.ok(postRequest(post({}, { pillar: "B", cta: { actionType: "SIGN_UP", url: "https://elettro.com/demo" } }), NOW));
  blocked(post({}, { pillar: "C", cta: { actionType: "BOOK", url: "https://elettro.com" } }), /pillar C must use LEARN_MORE/);
  blocked(post({}, { pillar: "A", cta: { actionType: "WATCH", url: "https://elettro.com" } }), /needs a button/);
});

test("the button link must be https, a real URL and not shortened", () => {
  blocked(post({}, { cta: { actionType: "BOOK" } }), /full https link/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "http://elettro.com/book" } }), /must be https/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://tinyurl.com/abc" } }), /shortened.*tinyurl/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://youtu.be/abc" } }), /shortened.*youtu\.be/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://www.bit.ly/abc" } }), /shortened/);
});

test("the text: 1,500 characters, no phone numbers, no shouting, few emojis, no gimmicks", () => {
  blocked(post({ caption: "  " }), /no text/);
  blocked(post({ caption: "x ".repeat(751) }), /over 1500.*1501/);
  assert.ok(postRequest(post({ caption: "y".repeat(1500) }), NOW));
  blocked(post({ caption: "Call us at (954) 555-1234 today" }), /phone/);
  blocked(post({ caption: "Call 954.555.1234" }), /phone/);
  blocked(post({ caption: "Ring 555-1234" }), /phone/);
  assert.ok(postRequest(post({ caption: "Now booking 2026-2027 dates" }), NOW));
  blocked(post({ caption: "Book our BEST band now" }), /ALL CAPS.*BEST/);
  assert.ok(postRequest(post({ caption: "A DJ and a PA for the USA" }), NOW));
  blocked(post({ caption: "Live music \u{1F3B8}\u{1F3B6}\u{1F525} for you" }), /no more than 2 emojis.*3/);
  assert.ok(postRequest(post({ caption: "Live music \u{1F3B8}\u{1F3B6} for you" }), NOW));
  blocked(post({ caption: "Book now!!! Amazing" }), /gimmicky.*!!!/);
});

test("the photo: JPG or PNG, 10 KB to 5 MB, at least 1200x900 and 4:3, inside the brand folder", () => {
  assert.ok(postRequest(post({ assetMime: "image/png", assetWidth: 1600, assetHeight: 1200 }), NOW));
  blocked(post({ assetMime: "image/gif" }), /JPG or PNG.*image\/gif/);
  blocked(post({ assetMime: null }), /JPG or PNG.*unknown/);
  blocked(post({ assetBytes: "9000" }), /10 KB to 5 MB.*9000/);
  blocked(post({ assetBytes: String(6 * 1024 * 1024) }), /10 KB to 5 MB/);
  blocked(post({ assetBytes: null }), /10 KB to 5 MB/);
  blocked(post({ assetWidth: 800, assetHeight: 600 }), /at least 1200x900.*800x600/);
  blocked(post({ assetWidth: 1920, assetHeight: 1080 }), /4:3.*1920x1080/);
  blocked(post({ assetWidth: null, assetHeight: null }), /at least 1200x900/);
  blocked(post({ dropboxPath: "/other/gig.jpg" }), /inside/);
  blocked(post({ dropboxPath: ROOT + "../x.jpg" }), /inside/);
  blocked(post({ channelId: "12345" }), /location id/);
});

test("phone detection ignores years and prices", () => {
  assert.equal(hasPhoneNumber("2026-2027 season, from $1,500"), false);
  assert.equal(hasPhoneNumber("+1 954 555 1234"), true);
});

test("the content mix: a fan post is allowed only while it keeps fan under half", () => {
  assert.equal(mixAllows("A", { F: 9 }), true);
  // Fan stays strictly under half of the 30 days, counting the post being checked.
  assert.equal(mixAllows("F", {}), false);
  assert.equal(mixAllows("F", { A: 1 }), false);
  assert.equal(mixAllows("F", { A: 2 }), true);
  assert.equal(mixAllows("F", { A: 2, F: 1 }), false);
  assert.equal(mixAllows("F", { A: 3, F: 1 }), true);
  assert.equal(mixAllows("F", { A: 3, B: 1, C: 1, F: 4 }), false);
  assert.equal(mixAllows("F", { A: 5, F: 3 }), true);
});

test("a blocked fan post names the measured mix, and a mix that cannot be read stops the post", async () => {
  const request = postRequest(post({}, { pillar: "F", cta: { actionType: "LEARN_MORE", url: "https://youtube.com/x" } }), NOW);
  await assert.rejects(checkMix(request, async () => ({ ok: true, counts: { A: 1, F: 1 } })), /under half.*business 1, fan 1/);
  await checkMix(request, async () => ({ ok: true, counts: { A: 4, F: 1 } }));
  await assert.rejects(checkMix(request, async () => ({ ok: false, error: "db down" })), /gmb-mix failed: db down/);
});

test("the access token comes from the profile's refresh token", async () => {
  const reads = [];
  const read = async (id) => { reads.push(id); return id.endsWith("google-oauth") ? { clientId: "c", clientSecret: "s" } : { refreshToken: "r" }; };
  let sent;
  const call = async (url, init) => { sent = { url, body: init.body.toString() }; return { ok: true, json: async () => ({ access_token: "at" }) }; };
  assert.equal(await accessToken(LOCATION, { read, call }), "at");
  assert.ok(reads.includes("elettro-brand-os-dev/gmb/9876543210"));
  assert.match(sent.body, /grant_type=refresh_token/);
  await assert.rejects(accessToken(LOCATION, { read: async () => ({}), call }), /incomplete/);
  await assert.rejects(accessToken(LOCATION, { read, call: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }) }), /refresh failed.*invalid_grant/);
  await assert.rejects(accessToken("nope", { read, call }), /location id/);
});

test("publishing sends the body with the Dropbox photo link and returns Google's post id", async () => {
  const request = postRequest(post(), NOW);
  let sent;
  const out = await publish(request, {
    callApi: async () => ({ ok: true, counts: { A: 1 } }),
    link: async () => "https://dl.dropboxusercontent.com/t/abc",
    token: async () => "at",
    call: async (url, init) => { sent = { url, init }; return { ok: true, json: async () => ({ name: LOCATION + "/localPosts/42", searchUrl: "https://local.google.com/place?x" }) }; }
  });
  assert.deepEqual(out, { postId: LOCATION + "/localPosts/42", permalink: "https://local.google.com/place?x" });
  assert.equal(sent.url, `https://mybusiness.googleapis.com/v4/${LOCATION}/localPosts`);
  assert.equal(sent.init.headers.authorization, "Bearer at");
  assert.deepEqual(JSON.parse(sent.init.body).media, [{ mediaFormat: "PHOTO", sourceUrl: "https://dl.dropboxusercontent.com/t/abc" }]);
  const failing = (status, body) => ({ callApi: async () => ({ ok: true, counts: {} }), link: async () => "https://x", token: async () => "at", call: async () => ({ ok: false, status, json: async () => body }) });
  await assert.rejects(publish(request, failing(401, {})), /login was rejected/);
  await assert.rejects(publish(request, failing(400, { error: { message: "Invalid media" } })), /Invalid media/);
  await assert.rejects(publish(request, { ...failing(200, {}), call: async () => ({ ok: true, json: async () => ({}) }) }), /no post id/);
});

test("the tick claims gmb posts, finishes each one, and a blocked post fails with its reason", async () => {
  const calls = [];
  const callApi = async (p) => {
    calls.push(p);
    if (p.action === "claim-due-posts") return { ok: true, missed: 0, stuck: 0, posts: [post({ id: "good" }), post({ id: "bad", caption: "SHOUTING LOUDLY" })] };
    return { ok: true };
  };
  const tick = await publishingTick({ callApi, publishOne: async (p) => { const r = postRequest(p, NOW); return { postId: "gp-" + p.id, permalink: null, r }; } });
  assert.deepEqual(calls[0], { action: "claim-due-posts", destination: "gmb", limit: 1 });
  assert.equal(tick.published[0].externalPostId, "gp-good");
  assert.match(tick.published[1].error, /ALL CAPS.*SHOUTING/);
  assert.deepEqual(calls.filter((c) => c.action === "finish-post").map((c) => c.id), ["good", "bad"]);
  await assert.rejects(publishingTick({ callApi: async () => ({ ok: false, error: "no" }) }), /claim-due-posts failed: no/);
});

test("the handler answers only direct tick invokes", async () => {
  assert.equal((await handler({ rawPath: "/x" })).statusCode, 403);
  assert.equal((await handler({ action: "nope" })).statusCode, 400);
});
