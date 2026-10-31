import test from "node:test";
import assert from "node:assert/strict";
import { imageInfo, measuredPost, hasUrl, brandTimeZone, localMinutes, hasPhoneNumber, mixAllows, postRequest, accessToken, checkMix, publish, publishingTick, handler } from "../services/gmb-lambda/index.mjs";

const LOCATION = "accounts/1234567890/locations/9876543210";
const ROOT = "/1---elettro-brand-os/brands/stashbox/";
const NOW = new Date("2026-10-26T12:00:00Z");
const post = (over = {}, gmb = {}) => ({
  id: "p1", placement: "update", brand: "stashbox", scheduledFor: "2026-10-26T15:00:00Z", caption: "Book Stashbox for your next corporate event, resort night or private party.",
  channelId: LOCATION, dropboxPath: ROOT + "gig.jpg", assetMime: "image/jpeg", assetBytes: "800000", assetWidth: 1200, assetHeight: 900,
  gmb: { pillar: "A", topicType: "STANDARD", cta: { actionType: "BOOK", url: "https://elettro.com/book" }, ...gmb }, ...over
});
const blocked = (p, pattern, options) => assert.throws(() => postRequest(p, NOW, options), pattern);
const OFFERS = { topicTypes: ["STANDARD", "OFFER"] };

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

test("Offers are parked, but the Offer path still validates a title, dates and a link that is not shortened", () => {
  blocked(post({}, { topicType: "OFFER" }), /only Update.*OFFER/);
  const offer = { topicType: "OFFER", title: "Spring dates", start: "2026-11-01", end: "2026-12-15", offer: { couponCode: "SPRING", redeemOnlineUrl: "https://elettro.com/offer", termsConditions: "New bookings only." } };
  const r = postRequest(post({}, offer), NOW, OFFERS);
  assert.equal(r.body.event.title, "Spring dates");
  assert.deepEqual(r.body.event.schedule.startDate, { year: 2026, month: 11, day: 1 });
  assert.deepEqual(r.body.event.schedule.endTime, { hours: 23, minutes: 59 });
  assert.deepEqual(r.body.offer, { couponCode: "SPRING", redeemOnlineUrl: "https://elettro.com/offer", termsConditions: "New bookings only." });
  blocked(post({}, { ...offer, title: "" }), /needs a title/, OFFERS);
  blocked(post({}, { ...offer, title: "x".repeat(59) }), /over 58.*59/, OFFERS);
  blocked(post({}, { ...offer, start: "11/01/2026" }), /YYYY-MM-DD/, OFFERS);
  blocked(post({}, { ...offer, start: "2026-02-30" }), /YYYY-MM-DD/, OFFERS);
  blocked(post({}, { ...offer, end: "2026-10-31" }), /on or after/, OFFERS);
  blocked(post({}, { ...offer, start: "2026-09-01", end: "2026-10-01" }), /already ended/, OFFERS);
  blocked(post({}, { ...offer, offer: { redeemOnlineUrl: "https://bit.ly/x" } }), /shortened.*bit\.ly/, OFFERS);
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
  assert.ok(postRequest(post({}, { pillar: "F", cta: { actionType: "SHOP", url: "https://stashbox.ai/products/tee" } }), NOW));
  blocked(post({}, { pillar: "A", cta: { actionType: "WATCH", url: "https://elettro.com" } }), /needs a button/);
});

test("the button link must be https, a real URL and not shortened", () => {
  blocked(post({}, { cta: { actionType: "BOOK" } }), /full https link/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "http://elettro.com/book" } }), /must be https/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://tinyurl.com/abc" } }), /shortened.*tinyurl/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://youtu.be/abc" } }), /shortened.*youtu\.be/);
  blocked(post({}, { cta: { actionType: "BOOK", url: "https://www.bit.ly/abc" } }), /shortened/);
});

test("the text: 1,350 characters, no phone numbers, no shouting, few emojis, no gimmicks", () => {
  blocked(post({ caption: "  " }), /no text/);
  blocked(post({ caption: "y".repeat(1351) }), /over 1350.*1351/);
  assert.ok(postRequest(post({ caption: "y".repeat(1350) }), NOW));
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

test("the photo: JPG or PNG, 10 KB to 5 MB, at least 1200x800 and 4:3, 3:2 or 16:9, inside the brand folder", () => {
  assert.ok(postRequest(post({ assetMime: "image/png", assetWidth: 1600, assetHeight: 1200 }), NOW));
  blocked(post({ assetMime: "image/gif" }), /JPG or PNG.*image\/gif/);
  blocked(post({ assetMime: null }), /JPG or PNG.*unknown/);
  blocked(post({ assetBytes: "9000" }), /10 KB to 5 MB.*9000/);
  blocked(post({ assetBytes: String(6 * 1024 * 1024) }), /10 KB to 5 MB/);
  blocked(post({ assetBytes: null }), /10 KB to 5 MB/);
  blocked(post({ assetWidth: 800, assetHeight: 600 }), /at least 1200x800.*800x600/);
  assert.ok(postRequest(post({ assetWidth: 1920, assetHeight: 1080 }), NOW));
  assert.ok(postRequest(post({ assetWidth: 1800, assetHeight: 1200 }), NOW));
  blocked(post({ assetWidth: 1600, assetHeight: 1600 }), /4:3, 3:2, 16:9.*1600x1600/);
  blocked(post({ assetWidth: 1200, assetHeight: 2000 }), /4:3, 3:2, 16:9/);
  blocked(post({ assetWidth: null, assetHeight: null }), /at least 1200x800/);
  blocked(post({ dropboxPath: "/other/gig.jpg" }), /inside/);
  blocked(post({ dropboxPath: ROOT + "../x.jpg" }), /inside/);
  blocked(post({ channelId: "12345" }), /location id/);
});

test("no URLs or domains in the text; Reggae.Land is the one name that may be written out", () => {
  for (const text of ["Shop at stashbox.ai today", "Visit https://stashbox.com/radio", "See www.elettro.com", "Hear it on stashbox.com/radio"]) {
    assert.equal(hasUrl(text), true, text);
    blocked(post({ caption: text }), /no URLs or domains/);
  }
  for (const text of ["Stashbox Shop is open", "Stashbox Radio plays all day", "Reggae.Land plays live for resorts", "A DJ, e.g. for a gala. Next week"]) assert.equal(hasUrl(text), false, text);
  assert.ok(postRequest(post({ caption: "Reggae.Land plays live reggae for your resort" }), NOW));
});

test("a post takes exactly one button; SHOP goes with a Shopify product link and nothing else does", () => {
  blocked(post({}, { cta: [{ actionType: "BOOK", url: "https://stashbox.com/booking" }] }), /exactly one button/);
  blocked(post({}, { buttons: [] }), /exactly one button/);
  blocked(post({}, { cta: undefined }), /needs a button/);
  assert.ok(postRequest(post({}, { pillar: "F", cta: { actionType: "SHOP", url: "https://stashbox.ai/products/tee" } }), NOW));
  blocked(post({}, { pillar: "F", cta: { actionType: "SHOP", url: "https://stashbox.ai/" } }), /SHOP must link to a Shopify product/);
  blocked(post({}, { pillar: "F", cta: { actionType: "LEARN_MORE", url: "https://stashbox.ai/products/tee" } }), /must use the SHOP button/);
  assert.ok(postRequest(post({}, { pillar: "F", cta: { actionType: "LEARN_MORE", url: "https://stashbox.com/radio/?song=house-on-the-hill-stashbox" } }), NOW));
});

test("posts are scheduled 9 AM to 6 PM on the brand's clock, any day; a late send is not checked", () => {
  assert.equal(brandTimeZone("stashbox"), "America/New_York");
  assert.equal(brandTimeZone("reggaeland"), "America/New_York");
  assert.equal(brandTimeZone("solarmeister"), "Europe/Berlin");
  assert.equal(brandTimeZone("neckermann-strom"), "Europe/Berlin");
  assert.equal(localMinutes(new Date("2026-10-26T13:00:00Z"), "America/New_York"), 9 * 60); // EDT
  assert.equal(localMinutes(new Date("2026-12-14T14:00:00Z"), "America/New_York"), 9 * 60); // EST
  assert.equal(localMinutes(new Date("2026-10-26T08:00:00Z"), "Europe/Berlin"), 9 * 60); // CET after the clocks change
  assert.ok(postRequest(post({ scheduledFor: "2026-10-26T13:00:00Z" }), NOW));
  assert.ok(postRequest(post({ scheduledFor: "2026-10-26T22:00:00Z" }), NOW));
  assert.ok(postRequest(post({ scheduledFor: "2026-10-31T16:00:00Z" }), NOW)); // a Saturday
  assert.ok(postRequest(post({ scheduledFor: "2026-12-13T15:00:00Z" }), NOW)); // a Sunday
  blocked(post({ scheduledFor: "2026-10-26T12:59:00Z" }), /9:00 AM and 6:00 PM America\/New_York.*08:59/);
  blocked(post({ scheduledFor: "2026-10-26T22:01:00Z" }), /6:00 PM.*18:01/);
  blocked(post({ scheduledFor: null }), /no scheduled time/);
  assert.ok(postRequest(post({ brand: "solarmeister", scheduledFor: "2026-10-26T08:00:00Z" }), NOW)); // 09:00 CET
  blocked(post({ brand: "solarmeister", scheduledFor: "2026-10-26T06:00:00Z" }), /Europe\/Berlin.*07:00/);
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

test("the publisher reads a photo's real size from its own header, JPEG and PNG", async () => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.alloc(33); header.copy(png); png.writeUInt32BE(1600, 16); png.writeUInt32BE(1200, 20);
  assert.deepEqual(imageInfo(png), { mime: "image/png", width: 1600, height: 1200 });
  // JPEG: SOI, an APP0 segment to skip, then a baseline start-of-frame 1920x1080
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(1080, 5); sof.writeUInt16BE(1920, 7);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(40)]);
  assert.deepEqual(imageInfo(jpg), { mime: "image/jpeg", width: 1920, height: 1080 });
  assert.equal(imageInfo(Buffer.from("GIF89a....................")), null);

  const bare = post({ assetMime: null, assetWidth: null, assetHeight: null });
  const calls = [];
  const measured = await measuredPost(bare, { link: async (p) => { calls.push(p); return "https://dl.example/x"; }, call: async () => ({ ok: true, arrayBuffer: async () => jpg }) });
  assert.equal(measured.assetWidth, 1920); assert.equal(measured.assetHeight, 1080); assert.equal(measured.assetMime, "image/jpeg");
  assert.ok(postRequest(measured, NOW), "a measured 16:9 photo passes");
  assert.deepEqual(calls, [ROOT + "gig.jpg"]);
  // a measured square photo is then blocked by the normal rule
  const square = Buffer.alloc(33); header.copy(square); square.writeUInt32BE(1600, 16); square.writeUInt32BE(1600, 20);
  const sq = await measuredPost(bare, { link: async () => "https://x", call: async () => ({ ok: true, arrayBuffer: async () => square }) });
  blocked(sq, /4:3, 3:2, 16:9.*1600x1600/);
  // already measured: no download
  const again = await measuredPost(post(), { link: async () => { throw new Error("should not download"); }, call: async () => { throw new Error("no"); } });
  assert.equal(again.assetWidth, 1200);
  // outside the brand folder: left for postRequest to block, nothing downloaded
  const outside = post({ assetMime: null, assetWidth: null, assetHeight: null, dropboxPath: "/other/x.jpg" });
  assert.equal((await measuredPost(outside, { link: async () => { throw new Error("no"); } })).assetWidth, null);
  await assert.rejects(measuredPost(bare, { link: async () => "https://x", call: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});
