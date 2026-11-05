// Substack has no OAuth and no official publishing API. Connecting means pasting the browser session cookie of a
// logged-in Substack account; the web server checks it against substack.com, then the dev-api keeps it in Secrets Manager
// (elettro-brand-os-dev/substack/<subdomain>). The calls below use Substack's undocumented internal API (the one the
// website and the open-source python-substack package use). They can change without notice and have not been run
// against the live service from this repo yet (docs/admin/substack-connect.md, "Never verified").
export const SUBSTACK_BRANDS = ["elettro", "solarmeister"];
export const SUBSTACK_TITLE_LIMIT = 150;
export const SUBSTACK_BODY_LIMIT = 8000;
export const SUBSTACK_SECRET_PREFIX = "elettro-brand-os-dev/substack/";

const UA = "Mozilla/5.0 (compatible; ElettroOS/1.0)";
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Accepts "something.substack.com", a full https URL, or the bare subdomain. Returns the subdomain or null. */
export function parseSubdomain(input: string): string | null {
  const raw = String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^@/, "").split(/[/?#]/)[0];
  const sub = raw.endsWith(".substack.com") ? raw.slice(0, -".substack.com".length) : raw;
  return SUBDOMAIN.test(sub) ? sub : null;
}

/** Turns a pasted value into a Cookie header: a bare substack.sid value, or the whole "name=value; ..." string. */
export function cookieHeader(input: string): string | null {
  const raw = String(input || "").trim().replace(/^cookie:\s*/i, "");
  if (raw.length < 20 || raw.length > 8000 || /[\r\n]/.test(raw)) return null;
  return raw.includes("=") ? raw : `substack.sid=${raw}`;
}

export type SubstackProfile = { userId: string; handle: string | null; publications: string[] | null };

/** Confirms the cookie is a live Substack login and reads who it belongs to. */
export async function substackProfile(cookie: string): Promise<SubstackProfile> {
  const response = await fetch("https://substack.com/api/v1/user/profile/self", { headers: { cookie, accept: "application/json", "user-agent": UA }, cache: "no-store" });
  if (response.status === 401 || response.status === 403) throw Error("Substack rejected that cookie. Log in to Substack again and copy a fresh substack.sid");
  const body = await response.json().catch(() => ({})) as { id?: number | string; handle?: string; publicationUsers?: Array<{ publication?: { subdomain?: string } }> };
  if (!response.ok || !body.id) throw Error(`Substack profile lookup failed (HTTP ${response.status})`);
  const publications = Array.isArray(body.publicationUsers)
    ? body.publicationUsers.map((p) => String(p.publication?.subdomain || "").toLowerCase()).filter(Boolean) : null;
  return { userId: String(body.id), handle: body.handle || null, publications };
}

type Mark = { type: string; attrs?: { href: string } };
type Node = { type: string; text?: string; marks?: Mark[]; attrs?: { level: number }; content?: Node[] };
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

/** Inline markdown -> Substack text nodes: **bold**, *italic*, [text](https://link). Same reader as services/substack-lambda. */
export function inlineNodes(input: string): Node[] {
  const nodes: Node[] = [];
  const push = (text: string, marks: Mark[]) => { if (text) nodes.push(marks.length ? { type: "text", text, marks } : { type: "text", text }); };
  const scan = (text: string, marks: Mark[]) => {
    const re = /\[([^\]]+)\]\((\S+?)\)|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index), marks);
      if (m[1] !== undefined) { if (SAFE_LINK.test(m[2])) scan(m[1], [...marks, { type: "link", attrs: { href: m[2] } }]); else push(m[0], marks); }
      else if (m[3] !== undefined) scan(m[3], [...marks, { type: "strong" }]);
      else scan(m[4], [...marks, { type: "em" }]);
      last = m.index + m[0].length;
    }
    push(text.slice(last), marks);
  };
  scan(input, []);
  return nodes;
}

/** Blank-line separated blocks: # headings (1-4), --- dividers, > quotes, else paragraphs with inline marks. */
export function markdownDoc(text: string) {
  const content: Node[] = [];
  for (const block of text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    const oneLine = block.replace(/\s*\n\s*/g, " ").trim();
    const heading = /^(#{1,4})\s+(.+)$/.exec(block);
    if (/^(-{3,}|\*{3,})$/.test(block)) content.push({ type: "horizontal_rule" });
    else if (heading && !block.includes("\n")) content.push({ type: "heading", attrs: { level: heading[1].length }, content: inlineNodes(heading[2].trim()) });
    else if (block.split("\n").every((l) => /^>\s?/.test(l))) content.push({ type: "blockquote", content: [{ type: "paragraph", content: inlineNodes(block.split("\n").map((l) => l.replace(/^>\s?/, "")).join(" ").trim()) }] });
    else content.push({ type: "paragraph", content: inlineNodes(oneLine) });
  }
  return { type: "doc", content };
}

/** A live post: one draft, then publish, web only (never emailed). Used by the Connections test post. */
export async function substackPublish(cookie: string, subdomain: string, userId: string, title: string, text: string) {
  const base = `https://${subdomain}.substack.com/api/v1`;
  const headers = { cookie, accept: "application/json", "content-type": "application/json", "user-agent": UA };
  const doc = markdownDoc(text);
  const draft = await fetch(`${base}/drafts`, { method: "POST", headers, cache: "no-store", body: JSON.stringify({
    draft_title: title, draft_subtitle: "", draft_body: JSON.stringify(doc), draft_bylines: [{ id: Number(userId), is_guest: false }],
    audience: "everyone", type: "newsletter", write_comment_permissions: "everyone" }) });
  const made = await draft.json().catch(() => ({})) as { id?: number; slug?: string };
  if (!draft.ok || !made.id) throw Error(`Substack refused the draft (HTTP ${draft.status})`);
  const sent = await fetch(`${base}/drafts/${made.id}/publish`, { method: "POST", headers, cache: "no-store", body: JSON.stringify({ send: false, share_automatically: false }) });
  const out = await sent.json().catch(() => ({})) as { slug?: string };
  if (!sent.ok) {
    await fetch(`${base}/drafts/${made.id}`, { method: "DELETE", headers, cache: "no-store" }).catch(() => {});
    throw Error(`Substack refused to publish (HTTP ${sent.status})`);
  }
  const slug = out.slug || made.slug;
  return slug ? `https://${subdomain}.substack.com/p/${slug}` : `https://${subdomain}.substack.com/publish/posts/published`;
}
