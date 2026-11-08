import { headers } from "next/headers";
import { LINK_HOSTS, linksCall } from "@/lib/link-tracking";

// Instagram bio-link page (go.stashbox.ai/bio, rewritten here by middleware.ts). Public, no login, no client script:
// every button and tile is a plain link to the brand's tracked short link (/<code>), so a tap is counted per post.
// Instagram captions cannot hold clickable links; this page is what the profile's link points at.
export const dynamic = "force-dynamic";
export const metadata = { title: "Links", robots: { index: false, follow: false } };

type Bio = { ok?: boolean; title?: string | null; tagline?: string | null; heading?: string | null; buttons?: { label: string; code: string }[]; featured?: { label: string; title: string; code: string } | null; tiles?: { code: string; title: string }[] };

export default async function LinkBioPage() {
  const h = await headers();
  const host = (h.get("x-forwarded-host") || h.get("host") || "").toLowerCase().split(":")[0];
  const entry = LINK_HOSTS[host];
  let bio: Bio | null = null;
  if (entry?.bio) {
    try {
      const { data } = await linksCall<Bio>({ action: "bio", brandSlug: entry.brand });
      if (data?.ok) bio = data;
    } catch (error) { console.error("Bio page failed", error instanceof Error ? error.name : "UnknownError"); }
  }
  if (!bio || !entry) {
    return <main className="bio"><p className="bio-tagline">Nothing here yet.</p><style>{css}</style></main>;
  }
  return (
    <main className="bio">
      <h1>{bio.title || entry.brand}</h1>
      {bio.tagline ? <p className="bio-tagline">{bio.tagline}</p> : null}
      {(bio.buttons || []).map((b, i) => <a key={b.code} className={i === 0 ? "bio-btn primary" : "bio-btn"} href={`/${b.code}`}>{b.label}</a>)}
      {bio.featured ? (
        <>
          <h2>{bio.featured.label}</h2>
          <a className="bio-tile feature" href={`/${bio.featured.code}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/bio-img/${bio.featured.code}`} alt={bio.featured.title} width={400} height={400} />
            <span>{bio.featured.title}</span>
          </a>
        </>
      ) : null}
      {bio.tiles?.length ? <h2>{bio.heading || "From our latest posts"}</h2> : null}
      <div className="bio-grid">
        {(bio.tiles || []).map((t) => (
          <a key={t.code} className="bio-tile" href={`/${t.code}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/bio-img/${t.code}`} alt={t.title} loading="lazy" width={400} height={400} />
            <span>{t.title}</span>
          </a>
        ))}
      </div>
      <style>{css}</style>
    </main>
  );
}

const css = `
body{background:#0e0d12!important}
.bio{max-width:480px;margin:0 auto;padding:28px 16px 48px;color:#f4efe6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0e0d12;min-height:100vh}
.bio h1{text-align:center;font-size:22px;margin:8px 0 4px}
.bio-tagline{text-align:center;color:#9b94a8;font-size:14px;margin:0 0 18px}
.bio h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9b94a8;margin:24px 0 10px}
.bio-btn{display:block;text-align:center;padding:14px;border-radius:14px;background:#1a1822;color:#f4efe6;border:1px solid #2e2a3a;font-weight:700;text-decoration:none;margin-bottom:10px}
.bio-btn.primary{background:#ff8a3d;color:#1b1208;border-color:#ff8a3d}
.bio-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
.bio-tile{background:#1a1822;border:1px solid #2e2a3a;border-radius:14px;overflow:hidden;text-decoration:none;color:#f4efe6;display:block}
.bio-tile img{display:block;width:100%;height:auto;background:#26232f}
.bio-tile.feature{margin-bottom:2px;max-width:320px;margin-left:auto;margin-right:auto}
.bio-tile span{display:block;padding:9px 10px 11px;font-size:13px;line-height:1.25}
`;
