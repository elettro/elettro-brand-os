import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Google Business Profile publishing worker for Elettro OS. Runs outside the VPC (it needs
// mybusiness.googleapis.com) and is only invoked directly through IAM: no HTTP route points at it.
//   an EventBridge schedule (every 15 min)   the tick: claim the next due approved GBP post
//                                             (claim-due-posts) -> check it -> publish -> finish-post
// A post is a ScheduledPost on a profile's gmb SocialAccount: the caption is the post text, the asset is
// its one photo, and scoreBreakdown.gmb holds { pillar, topicType, cta, ... } (see postRequest below).
// Every rule in GMB_ASSET_SPEC.md (Dropbox/Claude Skills MD) is a hard gate: a post that breaks one is
// failed with the rule and the measured value, never pushed with a warning and never quietly fixed.
// Supported: Update (STANDARD) only (Dean 261031). Offers are parked (the Offer code below is kept for when they
// reopen) and Event waits for a real dated show; video posts, product posts and ALERT cannot be created through the API.
// Rules Dean set 261031: captions carry no URL or domain; exactly one button per post; a Shopify item uses SHOP with the
// product link, anything else LEARN_MORE with the brand site; the post is scheduled 9 AM-6 PM in the brand's time zone
// (a late send is fine); photos may be 4:3, 3:2 or 16:9.
// The refresh token for each profile was stored by /connections (elettro-brand-os-dev/gmb/<location number>).

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
const GOOGLE_SECRET = process.env.GOOGLE_OAUTH_SECRET_NAME || "elettro-brand-os-dev/google-oauth";
const TOKEN_PREFIX = process.env.GMB_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/gmb/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const API = "https://mybusiness.googleapis.com/v4";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
// One post per tick keeps a backlog from bursting onto the profile.
const POSTS_PER_TICK = 1;

// GMB_ASSET_SPEC.md section 3 and 9 limits. Google allows 1,500; Dean capped captions at 1,350 (261026).
export const SUMMARY_MAX = 1350;
// Only Updates for now (Dean 261031). postRequest takes { topicTypes } so the Offer path stays testable.
export const ALLOWED_TOPIC_TYPES = ["STANDARD"];
export const TITLE_MAX = 58;
export const PHOTO_MIN_BYTES = 10 * 1024;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
// Google's floor is 400x300 and it crops to about 4:3. Strict mode: 4:3, 3:2 or 16:9, at least 1200x800 (Dean 261031).
export const PHOTO_MIN_WIDTH = 1200;
export const PHOTO_MIN_HEIGHT = 800;
export const PHOTO_RATIO_TOLERANCE = 0.02;
export const PHOTO_RATIOS = [[4, 3, "4:3"], [3, 2, "3:2"], [16, 9, "16:9"]];
// Posting window (Dean 261031): 9:00 AM to 6:00 PM on the brand's own clock, every day of the week.
export const WINDOW_START_MINUTE = 9 * 60;
export const WINDOW_END_MINUTE = 18 * 60;
const GERMAN_BRANDS = ["solarmeister", "neckermann-strom"];
export const brandTimeZone = (slug) => (GERMAN_BRANDS.includes(String(slug || "").toLowerCase()) ? "Europe/Berlin" : "America/New_York");
export const MAX_EMOJIS = 2;
export const LOCATION_ID = /^accounts\/\d{5,30}\/locations\/(\d{5,30})$/;
export const PILLARS = {
  A: { business: true, cta: ["BOOK"] },
  B: { business: true, cta: ["LEARN_MORE", "SIGN_UP"] },
  C: { business: true, cta: ["LEARN_MORE"] },
  F: { business: false, cta: ["LEARN_MORE", "SHOP"] }
};
const CTA_TYPES = ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"];
const SHORTENERS = ["bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd", "rebrand.ly", "lnkd.in", "youtu.be", "cutt.ly", "t.ly", "shorturl.at"];
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const result = (statusCode, payload) => ({ statusCode, ...payload });

class Blocked extends Error {
  constructor(rule, measured) { super(`GMB spec blocked this post: ${rule}${measured === undefined ? "" : ` (${measured})`}`); }
}

// A phone number in the text gets the post rejected: 10+ digits in one run, or a 555-1234 style local number.
export const hasPhoneNumber = (text) => /(?:\+?\d[\s().-]?){10,}/.test(text) || /\b\d{3}[-.\s]\d{4}\b/.test(text);

// Captions carry no link or domain (Dean 261031): the button holds the link. The brand name "Reggae.Land" is the one
// written-out exception, since it is the brand's name.
const SCHEME_URL = /https?:\/\/\S+|\bwww\.\S+/i;
const BARE_DOMAIN = /\b[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|de|co|us|tv|fm|app|shop|radio|info|biz|me|ly|gg|xyz|online|site|store|link|page|dev|eu)\b/i;
export const findUrl = (text) => {
  const plain = String(text).replace(/Reggae\.Land/g, "Reggae Land");
  return (plain.match(SCHEME_URL) || plain.match(BARE_DOMAIN) || [null])[0];
};
export const hasUrl = (text) => findUrl(text) !== null;

// The post's scheduled time in the brand's time zone, as minutes since midnight.
export function localMinutes(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function checkLink(url, what) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw new Blocked(`${what} must be a full https link`, String(url).slice(0, 80)); }
  if (parsed.protocol !== "https:") throw new Blocked(`${what} must be https`, parsed.protocol);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (SHORTENERS.includes(host)) throw new Blocked(`${what} must not be a shortened link`, host);
  return parsed.toString();
}

function ymd(value, what) {
  const m = YMD.exec(String(value || ""));
  const date = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!date || date.getUTCMonth() !== +m[2] - 1) throw new Blocked(`${what} must be a YYYY-MM-DD date`, String(value || "empty"));
  return { year: +m[1], month: +m[2], day: +m[3], iso: m[0] };
}

// Section 9: more than half of a profile's posts over 30 days must be business posts (pillars A, B, C).
// A fan/release (F) post is blocked when it would bring F to half or more.
export function mixAllows(pillar, counts) {
  if (PILLARS[pillar]?.business) return true;
  const total = (counts.A || 0) + (counts.B || 0) + (counts.C || 0) + (counts.F || 0);
  return ((counts.F || 0) + 1) / (total + 1) < 0.5;
}

// Validates a claimed post against the spec, or throws with the rule and the measured value.
export function postRequest(post, now = new Date(), { topicTypes = ALLOWED_TOPIC_TYPES } = {}) {
  const locationId = String(post.channelId || "");
  if (!LOCATION_ID.test(locationId)) throw new Blocked("the post has no Google Business Profile location id", locationId || "empty");
  const gmb = post.gmb;
  if (!gmb || typeof gmb !== "object") throw new Blocked("the post has no GBP details (pillar, post type, button)");
  const topicType = String(gmb.topicType || "STANDARD");
  if (!topicTypes.includes(topicType)) throw new Blocked("only Update (STANDARD) posts are supported for now", topicType);
  const pillar = String(gmb.pillar || "");
  if (!PILLARS[pillar]) throw new Blocked("every post needs exactly one pillar tag (A, B, C or F)", pillar || "none");

  const summary = String(post.caption || "").trim();
  if (!summary) throw new Blocked("the post has no text");
  if (summary.length > SUMMARY_MAX) throw new Blocked(`summary is over ${SUMMARY_MAX} characters`, summary.length);
  const found = findUrl(summary);
  if (found) throw new Blocked("no URLs or domains in the text; the button holds the link", found);
  if (hasPhoneNumber(summary)) throw new Blocked("no phone numbers in the text; use the CALL button");
  const shouting = summary.match(/\b[A-Z]{4,}\b/);
  if (shouting) throw new Blocked("no ALL CAPS words", shouting[0]);
  const emojis = (summary.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojis > MAX_EMOJIS) throw new Blocked(`no more than ${MAX_EMOJIS} emojis`, emojis);
  const gimmick = summary.match(/([!?*~#$%^&=+<>|])\1{1,}|[★☆✦✧❤♥→←]{2,}/u);
  if (gimmick) throw new Blocked("no gimmicky characters", gimmick[0]);

  if (Array.isArray(gmb.cta) || gmb.ctas || gmb.buttons) throw new Blocked("a post takes exactly one button");
  const actionType = String(gmb.cta?.actionType || "");
  if (!CTA_TYPES.includes(actionType)) throw new Blocked("the post needs a button (BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP or CALL)", actionType || "none");
  if (!PILLARS[pillar].cta.includes(actionType)) throw new Blocked(`pillar ${pillar} must use ${PILLARS[pillar].cta.join(" or ")}`, actionType);
  const callToAction = actionType === "CALL" ? { actionType } : { actionType, url: checkLink(gmb.cta?.url, "the button link") };
  // A Shopify item uses SHOP with the product's own link; anything else uses LEARN_MORE and the brand site (Dean 261031).
  const isProductLink = actionType !== "CALL" && /^\/products\//.test(new URL(callToAction.url).pathname);
  if (actionType === "SHOP" && !isProductLink) throw new Blocked("SHOP must link to a Shopify product (/products/...)", callToAction.url);
  if (isProductLink && actionType !== "SHOP") throw new Blocked("a Shopify product link must use the SHOP button", actionType);

  if (!post.scheduledFor || Number.isNaN(new Date(post.scheduledFor).getTime())) throw new Blocked("the post has no scheduled time");
  const zone = brandTimeZone(post.brand);
  const minute = localMinutes(new Date(post.scheduledFor), zone);
  if (minute < WINDOW_START_MINUTE || minute > WINDOW_END_MINUTE) throw new Blocked(`the post must be scheduled between 9:00 AM and 6:00 PM ${zone}`, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);

  const dropboxPath = String(post.dropboxPath || "").replace(/\\/g, "/");
  if (!dropboxPath.toLowerCase().startsWith(BRANDS_ROOT) || dropboxPath.split("/").some((p) => p === ".." || p === ".")) {
    throw new Blocked(`the photo must be inside ${BRANDS_ROOT}`, dropboxPath || "none");
  }
  const mime = String(post.assetMime || "").toLowerCase();
  if (!["image/jpeg", "image/png"].includes(mime)) throw new Blocked("the photo must be a JPG or PNG", mime || "unknown type");
  const bytes = Number(post.assetBytes);
  if (!(bytes >= PHOTO_MIN_BYTES && bytes <= PHOTO_MAX_BYTES)) throw new Blocked("the photo must be 10 KB to 5 MB", Number.isFinite(bytes) ? `${bytes} bytes` : "unknown size");
  const width = Number(post.assetWidth), height = Number(post.assetHeight);
  if (!(width >= PHOTO_MIN_WIDTH && height >= PHOTO_MIN_HEIGHT)) throw new Blocked(`the photo must be at least ${PHOTO_MIN_WIDTH}x${PHOTO_MIN_HEIGHT}`, `${width || "?"}x${height || "?"}`);
  if (!PHOTO_RATIOS.some(([w, h]) => Math.abs(width / height - w / h) <= (w / h) * PHOTO_RATIO_TOLERANCE)) {
    throw new Blocked(`the photo must be ${PHOTO_RATIOS.map((r) => r[2]).join(", ")}`, `${width}x${height}`);
  }

  const body = { languageCode: /^[a-z]{2}(-[A-Z]{2})?$/.test(String(gmb.languageCode || "")) ? gmb.languageCode : "en-US", topicType, summary, callToAction };
  if (topicType === "OFFER") {
    const title = String(gmb.title || "").trim();
    if (!title) throw new Blocked("an Offer needs a title");
    if (title.length > TITLE_MAX) throw new Blocked(`the Offer title is over ${TITLE_MAX} characters`, title.length);
    const start = ymd(gmb.start, "the Offer start date"), end = ymd(gmb.end, "the Offer end date");
    if (end.iso < start.iso) throw new Blocked("the Offer must end on or after it starts", `${start.iso} to ${end.iso}`);
    if (end.iso < now.toISOString().slice(0, 10)) throw new Blocked("the Offer has already ended", end.iso);
    body.event = {
      title,
      schedule: {
        startDate: { year: start.year, month: start.month, day: start.day }, startTime: { hours: 0, minutes: 0 },
        endDate: { year: end.year, month: end.month, day: end.day }, endTime: { hours: 23, minutes: 59 }
      }
    };
    const offer = {};
    if (gmb.offer?.couponCode) offer.couponCode = String(gmb.offer.couponCode).slice(0, 58);
    if (gmb.offer?.redeemOnlineUrl) offer.redeemOnlineUrl = checkLink(gmb.offer.redeemOnlineUrl, "the redeem link");
    if (gmb.offer?.termsConditions) offer.termsConditions = String(gmb.offer.termsConditions).slice(0, 5000);
    if (Object.keys(offer).length) body.offer = offer;
  }
  return { locationId, pillar, dropboxPath, body };
}

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

// A short-lived Google access token for one profile, from the refresh token /connections stored.
export async function accessToken(locationId, deps = {}) {
  const { read = secretJson, call = fetch } = deps;
  const number = LOCATION_ID.exec(locationId)?.[1];
  if (!number) throw new Error("The post has no Google Business Profile location id");
  const [client, token] = await Promise.all([read(GOOGLE_SECRET), read(TOKEN_PREFIX + number)]);
  if (!client.clientId || !client.clientSecret || !token.refreshToken) throw new Error("Google OAuth configuration is incomplete; reconnect the profile on /connections");
  const response = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: client.clientId, client_secret: client.clientSecret }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw new Error(`Google token refresh failed (HTTP ${response.status} ${body.error || ""})`.trim());
  return body.access_token;
}

async function dropboxAccessToken() {
  const config = await secretJson(DROPBOX_SECRET);
  const refreshToken = config.refresh_token || config.refreshToken;
  const appKey = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!refreshToken || !appKey || !appSecret) throw new Error("Dropbox OAuth refresh configuration is incomplete");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox refresh failed (HTTP ${response.status})`);
  return (await response.json()).access_token;
}

// A 4-hour public https link to the photo; Google fetches it from there (spec: link must live at least 1 hour).
async function dropboxLink(path) {
  const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${response.status}: ${(await response.text()).slice(0, 200)})`);
  return (await response.json()).link;
}

// The post goes out only with the profile's 30-day mix in hand; if the mix cannot be read, nothing is posted.
export async function checkMix(request, callApi = api) {
  const mix = await callApi({ action: "gmb-mix", locationId: request.locationId });
  if (!mix.ok) throw new Error(`gmb-mix failed: ${mix.error}`);
  if (!mixAllows(request.pillar, mix.counts)) {
    const { A = 0, B = 0, C = 0, F = 0 } = mix.counts;
    throw new Blocked("fan/release posts must stay under half of the last 30 days; queue business posts first", `business ${A + B + C}, fan ${F}`);
  }
}

export async function publish(request, deps = {}) {
  const { token = accessToken, link = dropboxLink, call = fetch, callApi = api } = deps;
  await checkMix(request, callApi);
  const body = { ...request.body, media: [{ mediaFormat: "PHOTO", sourceUrl: await link(request.dropboxPath) }] };
  const response = await call(`${API}/${request.locationId}/localPosts`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token(request.locationId)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = response.status === 401 ? "the login was rejected; reconnect the profile on /connections" : out.error?.message || response.status;
    throw new Error(`Google Business Profile post failed: ${reason}`);
  }
  if (!out.name) throw new Error("Google returned no post id");
  return { postId: out.name, permalink: out.searchUrl || null };
}

// The library does not store pixel sizes for synced images, so the publisher measures the photo itself: the type and size
// are read from the file's own header (JPEG start-of-frame or the PNG header). Anything it cannot read stays unmeasured and
// postRequest then blocks the post, as before.
export function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: "image/jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export async function measuredPost(post, deps = {}) {
  const { link = dropboxLink, call = fetch } = deps;
  if (Number(post.assetWidth) > 0 && Number(post.assetHeight) > 0 && post.assetMime) return post;
  const path = String(post.dropboxPath || "").replace(/\\/g, "/");
  if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) return post;   // postRequest blocks it
  if (Number(post.assetBytes) > PHOTO_MAX_BYTES) return post;
  const response = await call(await link(path), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not read the photo to measure it (HTTP ${response.status})`);
  const buf = Buffer.from(await response.arrayBuffer());
  const info = imageInfo(buf);
  if (!info) return post;
  return { ...post, assetMime: info.mime, assetWidth: info.width, assetHeight: info.height, assetBytes: post.assetBytes || buf.length };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, publishOne = async (post) => publish(postRequest(await measuredPost(post))) } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "gmb", limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const sent = await publishOne(post);
      outcome = { externalPostId: sent.postId, externalUrl: sent.permalink };
    } catch (error) {
      console.error("Scheduled GBP post failed:", post.id, error?.message);
      outcome = { error: error?.message || "Post failed" };
    }
    await callApi({ action: "finish-post", id: post.id, ...outcome });
    published.push({ id: post.id, ...outcome });
  }
  return { missed: claimed.missed, stuck: claimed.stuck, published };
}

export async function handler(event = {}) {
  if (event.requestContext || event.rawPath) return result(403, { ok: false, error: "Direct invoke only" });
  if (event.source === "aws.events" || event.action === "tick") {
    try {
      const tick = await publishingTick();
      console.log("GBP tick", JSON.stringify(tick));
      return result(200, { ok: true, ...tick });
    } catch (error) {
      console.error("GBP tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
