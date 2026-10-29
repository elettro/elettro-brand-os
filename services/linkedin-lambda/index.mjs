import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// LinkedIn publishing worker for Elettro OS. Runs outside the VPC (it needs api.linkedin.com) and is
// only invoked directly through IAM: no HTTP route points at it. Way in:
//   an EventBridge schedule (every 15 min)   the tick: claim the next due approved LinkedIn post
//                                             (claim-due-posts) -> publish -> finish-post
// Posts go to the account connected on /connections: a member profile ("Elettro OS Personal": w_member_social, author
// urn:li:person:<id>) or a company page ("Elettro OS", Community Management API: w_organization_social, author
// urn:li:organization:<id>). A post is a photo or a video with its caption; images go up through the
// Images API, videos through the Videos API in 4 MB parts that are read from Dropbox one at a time,
// so a large video never has to fit in memory.
// A carousel (placement "carousel", 2-20 images) is a multi-image post: each image goes up through the Images API
// and the post lists them in order; the planner's claim-due-posts only hands carousels to a worker that asks.
// A document (placement "document", 3-20 images) is the same picks stitched into one PDF (pdf-lib), uploaded through the
// Documents API and posted as a swipeable document; LinkedIn uses the first page as the cover and requires a title.
// Member tokens last 60 days with no refresh token: when one expires the tick leaves approved posts alone until Dean
// reconnects (the Connections page counts the days down), instead of failing every post that comes due in the gap.
// Company-page tokens come with a refresh token (about a year): the worker renews the access token itself when it is
// within 7 days of expiry, stores the new pair, and moves the reconnect date on the SocialAccount.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
// The trailing slash keeps the app secret (elettro-brand-os-dev/linkedin-oauth) out of the list.
const TOKEN_PREFIX = process.env.LINKEDIN_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/linkedin/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
// App credentials of the "Elettro OS" LinkedIn app (company pages); needed only to renew a page token.
const PAGES_OAUTH_SECRET = process.env.LINKEDIN_PAGES_OAUTH_SECRET || "elettro-brand-os-dev/linkedin-pages-oauth";
const REFRESH_WITHIN_MS = 7 * 86_400_000;
// A post's author: a member profile or a company page.
const OWNER_URN = /^urn:li:(?:person:[A-Za-z0-9_-]{4,64}|organization:\d{1,20})$/;
const API = "https://api.linkedin.com/rest";
// Posts API version header (YYYYMM); keep in step with apps/web/lib/linkedin-connect.ts.
const API_VERSION = process.env.LINKEDIN_API_VERSION || "202608";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
const COMMENTARY_MAX = 3000;
const MAX_HASHTAGS = 3;
// Images per multi-image post.
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 20;
// The planner placements this worker publishes.
const PLACEMENTS = ["post", "carousel", "document"];
// One post per tick keeps a backlog from bursting onto the feed.
const POSTS_PER_TICK = 1;
// Video processing: poll every 5 s for up to 8 minutes (Lambda timeout 15 min).
const POLL_MS = 5000;
// A PDF over this size is refused before upload (LinkedIn's limit is 100 MB).
const PDF_MAX_BYTES = 90 * 1024 * 1024;
const POLL_LIMIT_MS = 480_000;

const result = (statusCode, payload) => ({ statusCode, ...payload });

// LinkedIn commentary is "little text": these characters are markup unless escaped.
export const littleText = (text) => String(text).replace(/[\\|{}@[\]()<>#*_~]/g, (c) => "\\" + c);

// Planner caption plus up to three clickable hashtags, within LinkedIn's 3,000 characters.
export function commentaryFor(post) {
  const raw = String(post.caption || "").trim();
  if (!raw) throw new Error("the planned post has no caption");
  const seen = new Set();
  const tags = (post.hashtags || [])
    .map((h) => String(h).replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_HASHTAGS);
  const tagLine = tags.map((t) => `{hashtag|\\#|${t}}`).join(" ");
  const room = COMMENTARY_MAX - (tagLine ? tagLine.length + 2 : 0);
  let body = raw.slice(0, room);
  while (littleText(body).length > room) body = body.slice(0, -1);
  return tagLine ? `${littleText(body)}\n\n${tagLine}` : littleText(body);
}

// Validates a claimed post, or throws with a readable reason.
export function publishRequest(post) {
  const safePath = (raw) => {
    const path = String(raw || "").replace(/\\/g, "/");
    if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) {
      throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
    }
    return path;
  };
  if (post.placement === "carousel" || post.placement === "document") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < CAROUSEL_MIN || slides.length > CAROUSEL_MAX) {
      throw new Error(`a LinkedIn ${post.placement === "document" ? "document" : "multi-image post"} needs ${CAROUSEL_MIN}-${CAROUSEL_MAX} images; this one has ${slides.length}`);
    }
    const slidePaths = slides.map((slide) => safePath(slide.dropboxPath));
    for (const path of slidePaths) if (!/\.(jpe?g|png)$/i.test(path)) throw new Error("every carousel slide must be a .jpg or .png image");
    const channelId = String(post.channelId || "");
    if (!OWNER_URN.test(channelId)) throw new Error("the post has no LinkedIn member id or page id");
    const title = String(post.title || post.assetTitle || "").trim().slice(0, 200);
    return {
      kind: post.placement === "document" ? "document" : "carousel", dropboxPath: slidePaths[0], slidePaths, channelId,
      commentary: commentaryFor(post), title, altText: (title || String(post.assetTitle || "")).slice(0, 1000)
    };
  }
  const dropboxPath = safePath(post.dropboxPath);
  const kind = /\.(mp4|mov)$/i.test(dropboxPath) ? "video" : /\.(jpe?g|png|gif)$/i.test(dropboxPath) ? "image" : null;
  if (!kind) throw new Error("the clip must be an .mp4 or .mov video or a .jpg, .png or .gif image");
  const channelId = String(post.channelId || "");
  if (!OWNER_URN.test(channelId)) throw new Error("the post has no LinkedIn member id or page id");
  const title = String(post.title || post.assetTitle || "").trim().slice(0, 200);
  return { kind, dropboxPath, channelId, commentary: commentaryFor(post), title, altText: (title || String(post.assetTitle || "")).slice(0, 1000) };
}

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function tokenSecretNames() {
  const names = [];
  let NextToken;
  do {
    const page = await secrets.send(new ListSecretsCommand({ Filters: [{ Key: "name", Values: [TOKEN_PREFIX] }], NextToken }));
    for (const s of page.SecretList || []) if (s.Name?.startsWith(TOKEN_PREFIX)) names.push(s.Name);
    NextToken = page.NextToken;
  } while (NextToken);
  return names;
}

async function api(payload) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: API_FUNCTION, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = JSON.parse(Buffer.from(response.Payload || []).toString() || "{}");
  if (response.FunctionError) throw new Error(`${payload.action} crashed: ${out.errorMessage || response.FunctionError}`);
  return { statusCode: out.statusCode, ...JSON.parse(out.body || "{}") };
}

const expired = (record, now) => !(Date.parse(record.expiresAt || "") > now.getTime());
// A company-page login can be renewed while its refresh token lives.
const refreshable = (record, now) => Boolean(record.refreshToken) && Date.parse(record.refreshExpiresAt || "") > now.getTime();

// Secrets are stored per account: members by id, company pages as org-<id>.
export function secretKeyFor(urn) {
  const text = String(urn || "");
  const org = /^urn:li:organization:(\d{1,20})$/.exec(text);
  const id = org ? `org-${org[1]}` : text.replace(/^urn:li:person:/, "");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error("The post has no LinkedIn member id");
  return id;
}

// Trades the refresh token for a new access token (LinkedIn may also rotate the refresh token). Returns the new record.
export async function renewRecord(record, deps = {}) {
  const { appCredentials = () => secretJson(PAGES_OAUTH_SECRET), call = fetch, now = new Date() } = deps;
  const { clientId, clientSecret } = await appCredentials();
  if (!clientId || !clientSecret) throw new Error("LinkedIn app credentials for company pages are missing");
  const response = await call("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(30000)
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || !out.access_token) throw new Error(`LinkedIn would not renew the page login: ${out.error_description || out.error || response.status}`);
  const seconds = Number(out.expires_in) > 0 ? Number(out.expires_in) : 60 * 86_400;
  const refreshSeconds = Number(out.refresh_token_expires_in) > 0 ? Number(out.refresh_token_expires_in) : null;
  return {
    ...record,
    accessToken: out.access_token,
    expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    // A rotated refresh token starts a new clock; an unchanged one keeps the old expiry.
    ...(out.refresh_token && out.refresh_token !== record.refreshToken
      ? { refreshToken: out.refresh_token, refreshExpiresAt: new Date(now.getTime() + (refreshSeconds || 365 * 86_400) * 1000).toISOString() }
      : {}),
    renewedAt: now.toISOString()
  };
}

// Renews a company-page login that is expired or within 7 days of expiring; stores it and moves the reconnect date.
async function renewIfNeeded(record, secretId, urn, deps) {
  const { now = new Date(), renew = renewRecord, save, callApi = api } = deps;
  if (!refreshable(record, now) || !(Date.parse(record.expiresAt || "") - now.getTime() < REFRESH_WITHIN_MS)) return record;
  try {
    const next = await renew(record, deps);
    await (save || ((id, value) => secrets.send(new PutSecretValueCommand({ SecretId: id, SecretString: JSON.stringify(value) }))))(secretId, next);
    // The reconnect date of a page is when its refresh token dies; the access token is renewed here before that.
    await callApi({ action: "set-token-expiry", destination: "linkedin", externalAccountId: urn, tokenExpiresAt: next.refreshExpiresAt || next.expiresAt })
      .catch((error) => console.error("LinkedIn renewal stored, reconnect date not moved:", error?.message));
    return next;
  } catch (error) {
    console.error("LinkedIn page login renewal failed:", error?.message);
    if (expired(record, now)) throw error;
    return record;
  }
}

// The token record for a claimed post's author urn; a page login is renewed first when it is due.
export async function account(ownerUrn, deps = {}) {
  const { read = secretJson, now = new Date() } = deps;
  const secretId = TOKEN_PREFIX + secretKeyFor(ownerUrn);
  let record = await read(secretId);
  if (!record.accessToken) throw new Error(`No LinkedIn token stored for ${ownerUrn}`);
  record = await renewIfNeeded(record, secretId, ownerUrn, deps);
  if (expired(record, now)) throw new Error("The LinkedIn login has expired; reconnect it on /connections");
  return record;
}

// True when at least one stored LinkedIn login can still post (or be renewed).
export async function hasValidLogin(deps = {}) {
  const { names = tokenSecretNames, read = secretJson, now = new Date() } = deps;
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    if (record.accessToken && (!expired(record, now) || refreshable(record, now))) return true;
  }
  return false;
}

// LinkedIn call; answers { status, headers, body }. LinkedIn errors carry { message }.
export async function linkedin(accessToken, method, path, body, what, call = fetch) {
  const response = await call(path.startsWith("https://") ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "linkedin-version": API_VERSION,
      "x-restli-protocol-version": "2.0.0",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = response.status === 401 ? "the login was rejected; reconnect LinkedIn on /connections" : out.message || response.status;
    throw new Error(`LinkedIn ${what} failed: ${reason}`);
  }
  return { status: response.status, headers: response.headers, body: out };
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

async function dropboxPost(endpoint, body) {
  const response = await fetch(`https://api.dropboxapi.com/2/files/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox could not open ${body.path} (HTTP ${response.status}: ${(await response.text()).slice(0, 200)})`);
  return response.json();
}

// A 4-hour public link to the file, and its size in bytes.
const dropboxLink = async (path) => (await dropboxPost("get_temporary_link", { path })).link;
const dropboxSize = async (path) => Number((await dropboxPost("get_metadata", { path })).size);

// A photo: ask LinkedIn for an upload slot, send the bytes, and the image urn is ready for the post.
async function uploadImage(token, request, deps) {
  const { call = (method, path, body, what) => linkedin(token.accessToken, method, path, body, what), link = dropboxLink } = deps;
  const slot = (await call("POST", "/images?action=initializeUpload", { initializeUploadRequest: { owner: request.channelId } }, "image upload")).body.value;
  if (!slot?.uploadUrl || !slot.image) throw new Error("LinkedIn returned no image upload slot");
  const source = await fetch(await link(request.dropboxPath), { signal: AbortSignal.timeout(120000) });
  if (!source.ok) throw new Error(`Dropbox download failed (HTTP ${source.status})`);
  const sent = await fetch(slot.uploadUrl, {
    method: "PUT", headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/octet-stream" },
    body: Buffer.from(await source.arrayBuffer()), signal: AbortSignal.timeout(120000)
  });
  if (!sent.ok) throw new Error(`LinkedIn image upload failed (HTTP ${sent.status})`);
  return slot.image;
}

// A video: register it, send each part (read from Dropbox by byte range), finish, wait until it is AVAILABLE.
async function uploadVideo(token, request, deps) {
  const { call = (method, path, body, what) => linkedin(token.accessToken, method, path, body, what), link = dropboxLink, size = dropboxSize,
    fetchPart = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  const bytes = await size(request.dropboxPath);
  if (!(bytes > 0)) throw new Error("Dropbox reports an empty video");
  const init = (await call("POST", "/videos?action=initializeUpload", {
    initializeUploadRequest: { owner: request.channelId, fileSizeBytes: bytes, uploadCaptions: false, uploadThumbnail: false }
  }, "video upload")).body.value;
  if (!init?.video || !init.uploadInstructions?.length) throw new Error("LinkedIn returned no video upload slot");
  // A fresh link per video; each part is a ranged read of it, so only one 4 MB part is in memory at a time.
  const url = await link(request.dropboxPath);
  const partIds = [];
  for (const part of init.uploadInstructions) {
    const piece = await fetchPart(url, { headers: { range: `bytes=${part.firstByte}-${part.lastByte}` }, signal: AbortSignal.timeout(120000) });
    if (!piece.ok) throw new Error(`Dropbox download failed (HTTP ${piece.status})`);
    const sent = await fetchPart(part.uploadUrl, {
      method: "PUT", headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/octet-stream" },
      body: Buffer.from(await piece.arrayBuffer()), signal: AbortSignal.timeout(120000)
    });
    if (!sent.ok) throw new Error(`LinkedIn video upload failed (HTTP ${sent.status})`);
    const etag = sent.headers.get("etag");
    if (!etag) throw new Error("LinkedIn returned no part id for a video part");
    partIds.push(etag.replace(/"/g, ""));
  }
  await call("POST", "/videos?action=finalizeUpload", {
    finalizeUploadRequest: { video: init.video, uploadToken: init.uploadToken || "", uploadedPartIds: partIds }
  }, "video finish");
  for (let waited = 0; ; waited += pollMs) {
    const state = (await call("GET", `/videos/${encodeURIComponent(init.video)}`, null, "video status")).body;
    if (state.status === "AVAILABLE") return init.video;
    if (state.status === "PROCESSING_FAILED") throw new Error("LinkedIn could not process the video");
    if (waited >= limitMs) throw new Error(`LinkedIn was still processing the video after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
}

// Stitches images (jpg/png bytes, in order) into one PDF, one page per image at its own proportions. pdf-lib is loaded on
// demand so the tests and the other formats do not need it.
export async function pdfFromImages(buffers) {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const bytes of buffers) {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    // Pages are 1080 points wide (LinkedIn shows documents at screen size); the image keeps full resolution inside.
    const width = 1080, height = Math.round((image.height / image.width) * width);
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  pdf.setTitle("Elettro OS document");
  return Buffer.from(await pdf.save());
}

// A document: build the PDF from the slide images, ask LinkedIn for an upload slot, send it, wait until it is AVAILABLE.
async function uploadDocument(token, request, deps) {
  const { call = (method, path, body, what) => linkedin(token.accessToken, method, path, body, what), link = dropboxLink, buildPdf = pdfFromImages,
    fetchBytes = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`Dropbox download failed (HTTP ${r.status})`); return Buffer.from(await r.arrayBuffer()); },
    putFile = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, limitMs = POLL_LIMIT_MS } = deps;
  const images = [];
  for (const path of request.slidePaths) images.push(await fetchBytes(await link(path)));
  const pdf = await buildPdf(images);
  if (!pdf?.length) throw new Error("the PDF came out empty");
  if (pdf.length > PDF_MAX_BYTES) throw new Error(`the PDF is ${Math.round(pdf.length / 1048576)} MB; LinkedIn allows 100 MB, so use fewer or smaller images`);
  const slot = (await call("POST", "/documents?action=initializeUpload", { initializeUploadRequest: { owner: request.channelId } }, "document upload")).body.value;
  if (!slot?.uploadUrl || !slot.document) throw new Error("LinkedIn returned no document upload slot");
  const sent = await putFile(slot.uploadUrl, {
    method: "PUT", headers: { authorization: `Bearer ${token.accessToken}`, "content-type": "application/octet-stream" },
    body: pdf, signal: AbortSignal.timeout(120000)
  });
  if (!sent.ok) throw new Error(`LinkedIn document upload failed (HTTP ${sent.status})`);
  for (let waited = 0; ; waited += pollMs) {
    const state = (await call("GET", `/documents/${encodeURIComponent(slot.document)}`, null, "document status")).body;
    // LinkedIn reports PROCESSING / AVAILABLE / PROCESSING_FAILED; a body without a status is treated as ready.
    if (!state.status || state.status === "AVAILABLE") return slot.document;
    if (state.status === "PROCESSING_FAILED") throw new Error("LinkedIn could not process the PDF");
    if (waited >= limitMs) throw new Error(`LinkedIn was still processing the PDF after ${Math.round(limitMs / 1000)} s`);
    await wait(pollMs);
  }
}

export async function publish(record, post, deps = {}) {
  const { call = (method, path, body, what) => linkedin(record.accessToken, method, path, body, what), upload } = deps;
  const request = publishRequest(post);
  if (request.kind === "document") {
    const documentId = await (upload?.document || uploadDocument)(record, request, deps);
    const made = await call("POST", "/posts", {
      author: request.channelId,
      commentary: request.commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title: request.title || "Document", id: documentId } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    }, "document post");
    const documentUrn = made.headers?.get?.("x-restli-id") || "";
    if (!documentUrn) throw new Error("LinkedIn returned no post id");
    return { postId: documentUrn, permalink: `https://www.linkedin.com/feed/update/${documentUrn}/` };
  }
  if (request.kind === "carousel") {
    // One upload per image, in order; any failure stops before the post is created.
    const images = [];
    for (const path of request.slidePaths) {
      images.push({ id: await (upload?.image || uploadImage)(record, { ...request, kind: "image", dropboxPath: path }, deps), ...(request.altText ? { altText: request.altText } : {}) });
    }
    const made = await call("POST", "/posts", {
      author: request.channelId,
      commentary: request.commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { multiImage: { images } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false
    }, "multi-image post");
    const postUrn = made.headers?.get?.("x-restli-id") || "";
    if (!postUrn) throw new Error("LinkedIn returned no post id");
    return { postId: postUrn, permalink: `https://www.linkedin.com/feed/update/${postUrn}/` };
  }
  const mediaId = request.kind === "video" ? await (upload?.video || uploadVideo)(record, request, deps) : await (upload?.image || uploadImage)(record, request, deps);
  const created = await call("POST", "/posts", {
    author: request.channelId,
    commentary: request.commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { id: mediaId, ...(request.kind === "video" ? (request.title ? { title: request.title } : {}) : request.altText ? { altText: request.altText } : {}) } },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  }, "post");
  const urn = created.headers?.get?.("x-restli-id") || "";
  if (!urn) throw new Error("LinkedIn returned no post id");
  return { postId: urn, permalink: `https://www.linkedin.com/feed/update/${urn}/` };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, publishOne = async (post) => publish(await account(post.channelId), post), loginOk = hasValidLogin } = deps;
  // An expired login means every post that comes due would fail; leave them approved until it is reconnected.
  if (!(await loginOk())) {
    console.error("LinkedIn login missing or expired; reconnect it on /connections. Approved posts are waiting.");
    return { missed: 0, stuck: 0, published: [], skipped: "No valid LinkedIn login; reconnect it on /connections" };
  }
  const claimed = await callApi({ action: "claim-due-posts", destination: "linkedin", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const sent = await publishOne(post);
      outcome = { externalPostId: sent.postId, externalUrl: sent.permalink };
    } catch (error) {
      console.error("Scheduled LinkedIn post failed:", post.id, error?.message);
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
      console.log("LinkedIn tick", JSON.stringify(tick));
      return result(200, { ok: !tick.skipped, ...tick });
    } catch (error) {
      console.error("LinkedIn tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
