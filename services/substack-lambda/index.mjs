import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Substack worker for Elettro OS. Runs outside the VPC (it needs substack.com and Dropbox) and is only invoked
// directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   publish approved Substack posts whose time has come
//                                             (planner claim-due-posts / finish-post)
//   { action: "post", brand, title, text, dropboxPath?, send? }
//                                             publish now (live on the publication's web page)
//   { action: "check", brand }                confirm the stored login still works (no post)
//
// IMPORTANT: Substack has NO official API for publishing. This worker uses Substack's undocumented internal API
// (the same one the website uses, and the open-source `python-substack` package), authenticated with the browser
// session cookie of a logged-in owner. It can break without notice when Substack changes its endpoints, and the
// cookie expires: a 401/403 shows up as "reconnect Substack on /connections". Endpoints (POST /image, POST /drafts,
// POST /drafts/<id>/publish) were taken from python-substack's source and have NOT been run against the live service
// from this repo yet (see docs/admin/substack-connect.md, "Never verified").
//
// A published post is live on the web. It is only emailed to subscribers when `send` is true; scheduled posts never
// email (Brand-level opt-in is not built), so a bad post can be taken down but never un-sent.
//
// Auth: each publication's login lives in Secrets Manager (elettro-brand-os-dev/substack/<subdomain>, written by the
// dev-api's /connections/substack/complete): { cookie, subdomain, userId, handle, brand, connectedAt }.

const secrets = new SecretsManagerClient({});
const lambda = new LambdaClient({});
const API_FUNCTION = process.env.API_FUNCTION_NAME || "elettro-brand-os-dev-api";
const TOKEN_PREFIX = process.env.SUBSTACK_TOKEN_SECRET_PREFIX || "elettro-brand-os-dev/substack/";
const DROPBOX_SECRET = process.env.DROPBOX_SECRET_NAME || "elettro-brand-os-dev/dropbox";
const BRANDS_ROOT = "/1---elettro-brand-os/brands/";
export const MAX_TITLE = 150;
export const MAX_BODY = 8000;
export const IMAGE_BYTE_LIMIT = 10 * 1024 * 1024;
const PLACEMENTS = ["post"];
const POSTS_PER_TICK = 1;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
export const mimeOf = (path) => MIME[String(path).split(".").pop().toLowerCase()] || "application/octet-stream";

const result = (statusCode, payload) => ({ statusCode, ...payload });
const safePath = (value) => {
  const path = String(value || "").replace(/\\/g, "/");
  if (!path.toLowerCase().startsWith(BRANDS_ROOT) || path.split("/").some((p) => p === ".." || p === ".")) throw new Error(`dropboxPath must be inside ${BRANDS_ROOT}`);
  return path;
};

// ---------- text -> Substack document ----------

/** Title: the planner's title, else the first line of the caption, cut at a word. */
export function titleFor(post) {
  const raw = String(post.title || "").trim() || String(post.caption || "").trim().split(/\n/)[0] || "";
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TITLE) return clean;
  const cut = clean.slice(0, MAX_TITLE - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd() + "…";
}

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });

/** ProseMirror-style document Substack's editor uses: optional hero image, then the caption's paragraphs. */
export function buildDoc(text, imageUrl) {
  const content = [];
  if (imageUrl) {
    content.push({
      type: "captionedImage",
      content: [{ type: "image2", attrs: { src: imageUrl, fullscreen: null, imageSize: null, height: null, width: null, resizeWidth: null, bytes: null, alt: null, title: null, type: null, href: null, belowTheFold: false, internalRedirect: null } }]
    });
  }
  const paragraphs = String(text || "").split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  for (const p of paragraphs) content.push(paragraph(p));
  return { type: "doc", content };
}

// ---------- requests ----------

export function postRequest(event) {
  const brand = String(event.brand || "");
  if (!/^[a-z0-9-]{2,40}$/.test(brand)) throw new Error("brand must be a brand slug such as elettro");
  const title = String(event.title || "").trim();
  const text = String(event.text || "").trim();
  if (!title) throw new Error("title is required");
  if (title.length > MAX_TITLE) throw new Error(`title allows up to ${MAX_TITLE} characters`);
  if (text.length > MAX_BODY) throw new Error(`text allows up to ${MAX_BODY} characters`);
  const path = event.dropboxPath ? safePath(event.dropboxPath) : null;
  if (path && !IMAGE.test(path)) throw new Error("the picture must be a .jpg, .png, .webp or .gif file");
  return { brand, title, text, path, send: event.send === true };
}

export function requestFromPost(post) {
  const subdomain = String(post.channelId || "");
  if (!SUBDOMAIN.test(subdomain)) throw new Error("This post's Substack publication is not linked (reconnect it on /connections)");
  const title = titleFor(post);
  if (!title) throw new Error("A Substack post needs a title or a caption");
  const text = String(post.caption || "").trim().slice(0, MAX_BODY);
  const path = safePath(post.dropboxPath);
  if (!IMAGE.test(path)) throw new Error("a Substack photo post needs a .jpg, .png, .webp or .gif image");
  // Scheduled posts never email subscribers.
  return { brand: "planner", title, text, path, send: false, subdomain };
}

// ---------- Secrets Manager + dev-api ----------

async function secretJson(SecretId) {
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId }));
  return JSON.parse(secret.SecretString || "{}");
}

async function secretNames() {
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

/** The stored login for a publication subdomain (planner posts) or a brand (manual posts). */
export async function account(brand, subdomain, deps = {}) {
  const { names = secretNames, read = secretJson } = deps;
  if (subdomain) {
    const record = await read(TOKEN_PREFIX + subdomain).catch(() => null);
    if (!record?.cookie || record.revokedAt) throw new Error(`No Substack login is stored for ${subdomain}; reconnect it on /connections`);
    return record;
  }
  for (const SecretId of await names()) {
    const record = await read(SecretId);
    if (record.revokedAt || !record.cookie || record.brand !== brand) continue;
    return record;
  }
  throw new Error(`No Substack publication is connected for ${brand}`);
}

// ---------- Dropbox ----------

async function dropboxAccessToken() {
  const config = await secretJson(DROPBOX_SECRET);
  const refreshToken = config.refresh_token || config.refreshToken;
  const appKey = config.app_key || config.appKey;
  const appSecret = config.app_secret || config.appSecret;
  if (!refreshToken || !appKey || !appSecret) throw new Error("Dropbox OAuth refresh configuration is incomplete");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: appKey, client_secret: appSecret }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Dropbox refresh failed (HTTP ${response.status})`);
  return (await response.json()).access_token;
}

async function dropboxBytes(path) {
  const linkResponse = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST", headers: { authorization: `Bearer ${await dropboxAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ path }), signal: AbortSignal.timeout(20000)
  });
  if (!linkResponse.ok) throw new Error(`Dropbox could not open ${path} (HTTP ${linkResponse.status})`);
  const file = await fetch((await linkResponse.json()).link, { signal: AbortSignal.timeout(120000) });
  if (!file.ok) throw new Error(`Dropbox download failed for ${path} (HTTP ${file.status})`);
  return Buffer.from(await file.arrayBuffer());
}

// ---------- Substack ----------

const origin = (record) => `https://${record.subdomain}.substack.com`;

async function substack(record, method, path, { json, form, fetchImpl = fetch } = {}) {
  const headers = { cookie: record.cookie, accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; ElettroOS/1.0)" };
  const init = { method, headers, signal: AbortSignal.timeout(60000) };
  if (json !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(json); }
  if (form) init.body = form;
  const response = await fetchImpl(origin(record) + "/api/v1" + path, init);
  const out = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Substack rejected the login for ${record.subdomain}.substack.com (the session cookie probably expired); reconnect it on /connections`);
  }
  return { status: response.status, ok: response.ok, out };
}

/** Upload a picture to Substack's image host; returns its public URL. */
export async function uploadImage(record, bytes, path, deps = {}) {
  if (bytes.length > IMAGE_BYTE_LIMIT) throw new Error(`This image is ${(bytes.length / 1048576).toFixed(0)} MB; the limit here is 10 MB`);
  const form = new URLSearchParams({ image: `data:${mimeOf(path)};base64,${Buffer.from(bytes).toString("base64")}` });
  const up = await substack(record, "POST", "/image", { form, fetchImpl: deps.fetchImpl });
  if (!up.ok || !up.out.url) throw new Error(`Substack image upload failed (HTTP ${up.status})`);
  return up.out.url;
}

/** Create the draft, then publish it. On a failed publish the orphan draft is deleted (best effort). */
export async function publish(record, request, deps = {}) {
  const { download = dropboxBytes, fetchImpl = fetch } = deps;
  if (!request.title || request.title.length > MAX_TITLE) throw new Error(`title must be 1-${MAX_TITLE} characters`);
  const imageUrl = request.path ? await uploadImage(record, await download(request.path), request.path, { fetchImpl }) : null;
  const doc = buildDoc(request.text, imageUrl);
  const draft = await substack(record, "POST", "/drafts", { fetchImpl, json: {
    draft_title: request.title, draft_subtitle: "", draft_body: JSON.stringify(doc),
    draft_bylines: record.userId ? [{ id: Number(record.userId), is_guest: false }] : [],
    audience: "everyone", type: "newsletter", write_comment_permissions: "everyone"
  } });
  if (!draft.ok || !draft.out.id) throw new Error(`Substack refused the draft (HTTP ${draft.status})`);
  const sent = await substack(record, "POST", `/drafts/${draft.out.id}/publish`, { fetchImpl, json: { send: request.send === true, share_automatically: false } });
  if (!sent.ok) {
    await substack(record, "DELETE", `/drafts/${draft.out.id}`, { fetchImpl }).catch(() => {});
    throw new Error(`Substack refused to publish (HTTP ${sent.status})`);
  }
  const slug = sent.out.slug || draft.out.slug || null;
  return { id: String(draft.out.id), url: slug ? `${origin(record)}/p/${slug}` : `${origin(record)}/publish/posts/published`, handle: `${record.subdomain}.substack.com` };
}

/** Is the stored login still accepted? Reads the profile only; posts nothing. */
export async function check(record, deps = {}) {
  const res = await substack(record, "GET", "/user/profile/self", { fetchImpl: deps.fetchImpl });
  if (!res.ok || !res.out.id) throw new Error(`Substack login check failed (HTTP ${res.status})`);
  return { userId: String(res.out.id), handle: res.out.handle || null };
}

export async function publishingTick(deps = {}) {
  const { callApi = api, find = account, send = publish } = deps;
  const claimed = await callApi({ action: "claim-due-posts", destination: "substack", placements: PLACEMENTS, limit: POSTS_PER_TICK });
  if (!claimed.ok) throw new Error(`claim-due-posts failed: ${claimed.error}`);
  const published = [];
  for (const post of claimed.posts) {
    let outcome;
    try {
      const request = requestFromPost(post);
      const record = await find(null, request.subdomain);
      const sent = await send(record, request);
      outcome = { externalPostId: sent.id, externalUrl: sent.url };
    } catch (error) {
      console.error("Scheduled Substack post failed:", post.id, error?.message);
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
      console.log("Substack tick", JSON.stringify(tick));
      return result(200, { ok: true, ...tick });
    } catch (error) {
      console.error("Substack tick failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Tick failed" });
    }
  }
  if (event.action === "check") {
    try {
      const record = await account(String(event.brand || ""));
      return result(200, { ok: true, ...(await check(record)) });
    } catch (error) { return result(502, { ok: false, error: error?.message || "Check failed" }); }
  }
  if (event.action === "post") {
    let request;
    try { request = postRequest(event); } catch (error) { return result(400, { ok: false, error: error.message }); }
    try {
      const record = await account(request.brand);
      const posted = await publish(record, request);
      console.log("Substack post", JSON.stringify(posted));
      return result(200, { ok: true, ...posted });
    } catch (error) {
      console.error("Substack post failed:", error?.message);
      return result(502, { ok: false, error: error?.message || "Post failed" });
    }
  }
  return result(400, { ok: false, error: "Unknown action" });
}
