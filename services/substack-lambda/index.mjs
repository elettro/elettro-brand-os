import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// Substack worker for Elettro OS. Runs outside the VPC (it needs substack.com and Dropbox) and is only invoked
// directly through IAM: no HTTP route points at it. Ways in:
//   an EventBridge schedule (every 15 min)   publish approved Substack posts whose time has come
//                                             (planner claim-due-posts / finish-post)
//   { action: "post", brand, title, text, dropboxPath? | dropboxPaths?, send? }
//                                             publish now (live on the publication's web page); dropboxPaths = a gallery of 2-20 pictures
//   { action: "check", brand }                confirm the stored login still works (no post)
//
// Manual posts ({action:"post"}) accept simple markdown in `text`: # headings, **bold**, *italic*, [links](https://...), > quotes, --- dividers.
// Scheduled planner posts stay plain text. Bullet lists and extra images are not built yet.
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
// post = one picture, carousel = a gallery (Review calls it Galleries): 2 to 20 pictures in one post.
const PLACEMENTS = ["post", "carousel"];
export const MIN_GALLERY = 2;
export const MAX_GALLERY = 20;
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

const textNode = (text, marks) => (marks.length ? { type: "text", text, marks } : { type: "text", text });
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/**
 * Inline markdown -> Substack text nodes: **bold**, *italic*, [text](https://link). Anything else stays literal text.
 * Mark names (strong, em, link with attrs.href) are the ones the open-source python-substack library sends.
 */
export function inlineNodes(input) {
  const nodes = [];
  const push = (text, marks) => { if (text) nodes.push(textNode(text, marks)); };
  const scan = (text, marks) => {
    const re = /\[([^\]]+)\]\((\S+?)\)|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index), marks);
      if (m[1] !== undefined) {
        if (SAFE_LINK.test(m[2])) scan(m[1], [...marks, { type: "link", attrs: { href: m[2] } }]); else push(m[0], marks);
      } else if (m[3] !== undefined) scan(m[3], [...marks, { type: "strong" }]);
      else scan(m[4], [...marks, { type: "em" }]);
      last = m.index + m[0].length;
    }
    push(text.slice(last), marks);
  };
  scan(String(input), []);
  return nodes;
}

const paragraph = (text, markdown) => ({ type: "paragraph", content: markdown ? inlineNodes(text) : [{ type: "text", text }] });

/** One blank-line separated block -> a heading, divider, quote or paragraph (markdown mode), else a plain paragraph. */
function blockNode(block, markdown) {
  const oneLine = block.replace(/\s*\n\s*/g, " ").trim();
  if (!markdown) return paragraph(oneLine, false);
  if (/^(-{3,}|\*{3,})$/.test(block.trim())) return { type: "horizontal_rule" };
  const heading = /^(#{1,4})\s+(.+)$/.exec(block.trim());
  if (heading && !block.includes("\n")) return { type: "heading", attrs: { level: heading[1].length }, content: inlineNodes(heading[2].trim()) };
  if (block.split("\n").every((l) => /^>\s?/.test(l))) {
    const quoted = block.split("\n").map((l) => l.replace(/^>\s?/, "")).join(" ").trim();
    return { type: "blockquote", content: [paragraph(quoted, true)] };
  }
  return paragraph(oneLine, true);
}

/**
 * Substack document: optional hero image, then the text's blocks. `markdown` turns on headings (# to ####), **bold**, *italic*,
 * [links](https://...), > quotes and --- dividers; without it every block is plain text (planner captions, which may contain stray * or #).
 */
export function buildDoc(text, images, { markdown = false, imagesAfterText = false } = {}) {
  const urls = (Array.isArray(images) ? images : images ? [images] : []).filter(Boolean);
  const pictures = urls.map((src) => ({
    type: "captionedImage",
    content: [{ type: "image2", attrs: { src, fullscreen: null, imageSize: null, height: null, width: null, resizeWidth: null, bytes: null, alt: null, title: null, type: null, href: null, belowTheFold: false, internalRedirect: null } }]
  }));
  const blocks = String(text || "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).map((b) => blockNode(b, markdown));
  // A single picture leads the post; a gallery opens with its intro text and then lists the pictures in order.
  return { type: "doc", content: imagesAfterText ? [...blocks, ...pictures] : [...pictures, ...blocks] };
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
  // One picture (dropboxPath) or a gallery (dropboxPaths, 2 to 20).
  const given = Array.isArray(event.dropboxPaths) ? event.dropboxPaths : event.dropboxPath ? [event.dropboxPath] : [];
  const paths = given.map(safePath);
  if (paths.some((p) => !IMAGE.test(p))) throw new Error("every picture must be a .jpg, .png, .webp or .gif file");
  if (paths.length > MAX_GALLERY) throw new Error(`a gallery holds up to ${MAX_GALLERY} pictures`);
  if (Array.isArray(event.dropboxPaths) && paths.length < MIN_GALLERY) throw new Error(`a gallery needs at least ${MIN_GALLERY} pictures (use dropboxPath for one)`);
  return { brand, title, text, paths, path: paths[0] || null, gallery: Array.isArray(event.dropboxPaths), send: event.send === true, markdown: true };
}

export function requestFromPost(post) {
  const subdomain = String(post.channelId || "");
  if (!SUBDOMAIN.test(subdomain)) throw new Error("This post's Substack publication is not linked (reconnect it on /connections)");
  const title = titleFor(post);
  if (!title) throw new Error("A Substack post needs a title or a caption");
  const text = String(post.caption || "").trim().slice(0, MAX_BODY);
  // Scheduled posts never email subscribers.
  if (post.placement === "carousel") {
    const slides = Array.isArray(post.slides) ? post.slides : [];
    if (slides.length < MIN_GALLERY || slides.length > MAX_GALLERY) throw new Error(`a Substack gallery needs ${MIN_GALLERY}-${MAX_GALLERY} pictures; this one has ${slides.length}`);
    const paths = slides.map((s) => safePath(s.dropboxPath));
    if (paths.some((p) => !IMAGE.test(p))) throw new Error("every gallery picture must be a .jpg, .png, .webp or .gif image");
    return { brand: "planner", title, text, paths, path: paths[0], gallery: true, send: false, subdomain, markdown: false };
  }
  const path = safePath(post.dropboxPath);
  if (!IMAGE.test(path)) throw new Error("a Substack photo post needs a .jpg, .png, .webp or .gif image");
  return { brand: "planner", title, text, paths: [path], path, gallery: false, send: false, subdomain, markdown: false };
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

/** Tells a real "please sign in" answer from a block page (Cloudflare, bot check, wrong domain). */
export function rejectionDetail(response, raw) {
  const text = String(raw || "");
  const server = String(response.headers?.get?.("server") || "");
  const snippet = text.replace(/s+/g, " ").slice(0, 200);
  const json = text.trim().startsWith("{");
  if (response.status === 401 || (json && /sign in/i.test(text))) return { kind: "sign-in", snippet };
  if (/cloudflare|just a moment|captcha|challenge/i.test(text + " " + server)) return { kind: "blocked by Cloudflare or a bot check", snippet };
  return { kind: json ? "refused with a JSON error" : "refused without a sign-in message", snippet };
}

async function substack(record, method, path, { json, form, fetchImpl = fetch } = {}) {
  const headers = { cookie: record.cookie, accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; ElettroOS/1.0)" };
  const init = { method, headers, signal: AbortSignal.timeout(60000) };
  if (json !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(json); }
  if (form) init.body = form;
  const response = await fetchImpl(origin(record) + "/api/v1" + path, init);
  const raw = await response.text().catch(() => "");
  let out = {};
  try { out = JSON.parse(raw); } catch { /* not JSON (for example a Cloudflare page) */ }
  if (response.status === 401 || response.status === 403) {
    const detail = rejectionDetail(response, raw);
    console.error(`Substack ${method} ${path} -> HTTP ${response.status} (${detail.kind}) ${detail.snippet}`);
    if (detail.kind === "sign-in") {
      throw new Error(`Substack rejected the login for ${record.subdomain}.substack.com (the session cookie probably expired); reconnect it on /connections`);
    }
    throw new Error(`Substack refused ${method} ${path} for ${record.subdomain}.substack.com with HTTP ${response.status} (${detail.kind}); this is not a plain expired cookie`);
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
  // Pictures upload one at a time (a gallery of 20 is a few minutes at most); the draft is only made once all of them are hosted.
  const paths = Array.isArray(request.paths) ? request.paths : request.path ? [request.path] : [];
  const imageUrls = [];
  for (const path of paths) imageUrls.push(await uploadImage(record, await download(path), path, { fetchImpl }));
  const doc = buildDoc(request.text, imageUrls, { markdown: request.markdown === true, imagesAfterText: request.gallery === true });
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
