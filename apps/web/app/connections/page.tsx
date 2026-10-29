import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { YOUTUBE_BRANDS } from "@/lib/youtube-connect";
import { LINKEDIN_BRANDS, LINKEDIN_PAGE_BRANDS, calendarReminderUrl } from "@/lib/linkedin-connect";
import { GBP_BRANDS } from "@/lib/gbp-connect";
import { META_BRANDS } from "@/lib/meta-connect";
import { MetaTestPosts } from "@/components/meta-test-posts";
import { THREADS_BRANDS } from "@/lib/threads-connect";
import { BLUESKY_BRANDS } from "@/lib/bluesky-connect";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { TiktokPost } from "@/components/tiktok-post";
import { ConnectionDisconnect } from "@/components/connection-disconnect";
import { PINTEREST_BOARDS, PINTEREST_BRANDS } from "@/lib/pinterest-connect";
import { PinterestPost } from "@/components/pinterest-post";
import { ReconnectCountdown } from "@/components/reconnect-countdown";
import { MASTODON_BRANDS, MASTODON_POST_LIMIT } from "@/lib/mastodon-connect";
import { redirect } from "next/navigation";

const TEST_POST = "Testing Elettro OS on LinkedIn. Our in-house publishing system now posts here directly; this one went out through the LinkedIn API. More from Elettro and Stashbox soon.";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

type Profile = { destination: string; handle: string | null; tokenExpiresAt?: string | null; done: Record<string, number> };
type Linked = { handle: string | null; expiresAt: string | null };

// Which brands have a linked account per network, from the same feed as elettro.com/dash.
async function connectionStatus(): Promise<Record<string, Record<string, Linked>>> {
  try {
    const response = await fetch(`${apiBaseUrl}/status/connections`, { cache: "no-store" });
    const feed = await response.json() as { brands?: Array<{ slug: string; profiles: Profile[] }> };
    const out: Record<string, Record<string, Linked>> = {};
    for (const b of feed.brands || []) {
      for (const p of b.profiles) {
        if (p.done.oauth < 1) continue;
        (out[p.destination] ||= {})[b.slug] = { handle: p.handle, expiresAt: p.tokenExpiresAt || null };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  // Owner or a brand-scoped user: the page below only lists the brands this session may see.
  if (!(await session())) redirect("/api/auth/login");
  const [{ brand, connected, disconnected, error, network, expires, posted, at }, status] = await Promise.all([searchParams, connectionStatus()]);
  // The header dropdown drives ?brand=: one brand shows only its connections, "All brands" (no param) shows every brand this user may see.
  const accessible: string[] = visibleBrands(await session(), brandConfigs).map((b) => b.id);
  const picked = brand && accessible.includes(brand) ? brand : null;
  const inView = (id: string) => accessible.includes(id) && (!picked || id === picked);
  const brandName = brandConfigs.find((b) => b.id === brand)?.name || "";
  const brands = brandConfigs.filter((b) => YOUTUBE_BRANDS.includes(b.id) && inView(b.id));
  const linkedinBrands = brandConfigs.filter((b) => LINKEDIN_BRANDS.includes(b.id) && inView(b.id));
  const metaBrands = brandConfigs.filter((b) => META_BRANDS.includes(b.id) && inView(b.id));
  const threadsBrands = brandConfigs.filter((b) => THREADS_BRANDS.includes(b.id) && inView(b.id));
  const gbpBrands = brandConfigs.filter((b) => GBP_BRANDS.includes(b.id) && inView(b.id));
  const gmb = status.gmb || {};
  const youtube = status.youtube || {};
  const linkedin = status.linkedin || {};
  const facebook = status.facebook || {};
  const instagram = status.instagram || {};
  const threads = status.threads || {};
  const blueskyBrands = brandConfigs.filter((b) => BLUESKY_BRANDS.includes(b.id) && inView(b.id));
  const bluesky = status.bluesky || {};
  const tiktokBrands = brandConfigs.filter((b) => TIKTOK_BRANDS.includes(b.id) && inView(b.id));
  const tiktok = status.tiktok || {};
  const pinterestBrands = brandConfigs.filter((b) => PINTEREST_BRANDS.includes(b.id) && inView(b.id));
  const pinterest = status.pinterest || {};
  const mastodonBrands = brandConfigs.filter((b) => MASTODON_BRANDS.includes(b.id) && inView(b.id));
  const mastodon = status.mastodon || {};
  // Mastodon tokens never expire, so the callback reports no expiry; same 60s cache applies.
  if (brand && connected && network === "mastodon") mastodon[brand] = { handle: connected, expiresAt: null };
  // The feed caches for 60s; right after a connect, trust the expiry the callback just reported.
  if (brand && connected && expires && !Number.isNaN(Date.parse(expires))) {
    if (network === "linkedin") linkedin[brand] = { handle: connected, expiresAt: expires };
    if (network === "threads") threads[brand] = { handle: connected, expiresAt: expires };
    if (network === "bluesky") bluesky[brand] = { handle: connected, expiresAt: expires };
    if (network === "tiktok") tiktok[brand] = { handle: connected, expiresAt: expires };
    if (network === "pinterest") pinterest[brand] = { handle: connected, expiresAt: expires };
  }
  // Same cache after a disconnect: the brand is no longer linked even if the feed still says so.
  if (brand && disconnected) {
    const feeds: Record<string, Array<Record<string, Linked>>> = {
      youtube: [youtube], gmb: [gmb], linkedin: [linkedin], threads: [threads], bluesky: [bluesky], tiktok: [tiktok], pinterest: [pinterest], meta: [facebook, instagram], mastodon: [mastodon]
    };
    for (const feed of feeds[network || ""] || []) delete feed[brand];
  }
  return <main className="main">
    <div className="eyebrow">Publishing · Social connections</div>
    <h1>Connections</h1>
    <p className="muted">Connect each brand&apos;s accounts to Elettro OS. Google asks which YouTube channel to use; pick the one that belongs to the brand. LinkedIn logins last 60 days, so each one counts down to its reconnect date.</p>
    {connected && <p className="card" style={{ marginTop: 16 }}>Connected <b>{connected}</b>{brandName ? <> to {brandName}</> : null}.</p>}
    {disconnected && <p className="card" style={{ marginTop: 16 }}>Disconnected <b>{disconnected}</b>{brandName ? <> from {brandName}</> : null}. Elettro OS will not post to it, and posts already approved for it are back to planned. To also remove its permission, use the account&apos;s own security settings (for Google, myaccount.google.com/permissions).</p>}
    {error && network !== "linkedin" && network !== "mastodon" && <p className="card" style={{ marginTop: 16 }}>Could not connect{brandName ? ` ${brandName}` : ""}: {error}</p>}
    {brands.length > 0 && <>
    <div className="grid" id="youtube" style={{ marginTop: 20 }}>
      {brands.map((b) => {
        const handle = youtube[b.id]?.handle;
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">YouTube</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {handle ? <>● Connected · <b>{handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/youtube/start?brand=${b.id}`}>{handle ? "Reconnect" : "Connect YouTube"}</a>
              {handle && <ConnectionDisconnect brand={b.id} network="youtube" handle={handle} />}
            </div>
          </article>
        );
      })}
    </div>
    </>}
    {inView("google-review") && (picked === "google-review" || accessible.length === 1) && <p className="muted" style={{ marginTop: 20 }}>Other networks (Instagram, Facebook, Threads, TikTok, LinkedIn, Pinterest, Google Business) are turned off for Google Review.</p>}
    {gbpBrands.length > 0 && <>
    <h2 id="gmb" style={{ marginTop: 32 }}>Google Business Profile</h2>
    <p className="muted">Sign in with the Google account that manages the profile. Elettro OS picks the brand&apos;s profile automatically; nothing is posted until the business-content rules are in place.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {gbpBrands.map((b) => {
        const profile = gmb[b.id]?.handle;
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Google Business Profile</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {profile ? <>● Connected · <b>{profile}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/gbp/start?brand=${b.id}`}>{profile ? "Reconnect" : "Connect Google Business Profile"}</a>
              {profile && <ConnectionDisconnect brand={b.id} network="gmb" handle={profile} />}
            </div>
          </article>
        );
      })}
    </div>
    </>}
    {metaBrands.length > 0 && <>
    <h2 id="meta" style={{ marginTop: 32 }}>Facebook + Instagram</h2>
    <p className="muted">One Meta login per brand: Facebook asks which Pages and Instagram accounts Elettro OS may use; tick only the brand&apos;s Page and the Instagram account linked to it. Page tokens do not expire.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {metaBrands.map((b) => {
        const page = facebook[b.id]?.handle;
        const ig = instagram[b.id]?.handle;
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Meta · Facebook Page + Instagram</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {page ? <>● Facebook · <b>{page}</b>{ig ? <><br />● Instagram · <b>{ig}</b></> : <><br />○ No Instagram linked to this Page</>}</> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/meta/start?brand=${b.id}`}>{page ? "Reconnect" : "Connect Facebook + Instagram"}</a>
              {page && <ConnectionDisconnect brand={b.id} network="meta" handle={page} />}
            </div>
            {page && <MetaTestPosts brand={b.id} page={page} instagram={ig || null} />}
          </article>
        );
      })}
    </div>
    </>}
    {threadsBrands.length > 0 && <>
    <h2 id="threads" style={{ marginTop: 32 }}>Threads</h2>
    <p className="muted">Threads has its own login, separate from Facebook. Sign in to the brand&apos;s Threads profile when asked. Logins last 60 days, so each one counts down to its reconnect date.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {threadsBrands.map((b) => {
        const linked = threads[b.id];
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Threads</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/threads/start?brand=${b.id}`}>{linked ? "Reconnect" : "Connect Threads"}</a>
              {linked?.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
              {linked && <ConnectionDisconnect brand={b.id} network="threads" handle={linked.handle || "this account"} />}
            </div>
          </article>
        );
      })}
    </div>
    </>}
    {blueskyBrands.length > 0 && <>
    <h2 id="bluesky" style={{ marginTop: 32 }}>Bluesky</h2>
    <p className="muted">Type the brand&apos;s Bluesky handle (like yourname.bsky.social), or leave it blank to pick the account on Bluesky&apos;s own sign-in page. Elettro OS never sees the password. The login renews itself while posts go out; the date shows when it would lapse if nothing used it.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {blueskyBrands.map((b) => {
        const linked = bluesky[b.id];
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Bluesky</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <form className="connect-row" action="/api/connections/bluesky/start" method="get">
              <input type="hidden" name="brand" value={b.id} />
              <input name="handle" placeholder="handle.bsky.social" aria-label={`${b.name} Bluesky handle`} autoComplete="off" spellCheck={false} style={{ minWidth: 0, flex: "1 1 160px" }} />
              <button className="status-chip" type="submit">{linked ? "Reconnect" : "Connect Bluesky"}</button>
            </form>
            {linked && <div className="connect-row" style={{ marginTop: 8 }}>
              {linked.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
              <ConnectionDisconnect brand={b.id} network="bluesky" handle={linked.handle || "this account"} />
            </div>}
          </article>
        );
      })}
    </div>
    </>}
    {tiktokBrands.length > 0 && <>
    <h2 id="tiktok" style={{ marginTop: 32 }}>TikTok</h2>
    <p className="muted">Sign in to the brand&apos;s TikTok account when asked. Until TikTok approves the Elettro OS app, only sandbox target users can connect and posts go out private. A login lasts a year, so each one counts down to its reconnect date.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {tiktokBrands.map((b) => {
        // A TikTok link always carries its reconnect date; without one the brand was disconnected.
        const linked = tiktok[b.id]?.expiresAt ? tiktok[b.id] : undefined;
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">TikTok</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/tiktok/start?brand=${b.id}`}>{linked ? "Reconnect" : "Connect TikTok"}</a>
              {linked?.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
              {linked && <ConnectionDisconnect brand={b.id} network="tiktok" handle={linked.handle || "this account"} />}
            </div>
            {linked && <TiktokPost brand={b.id} />}
          </article>
        );
      })}
    </div>
    </>}
    {pinterestBrands.length > 0 && <>
    <h2 id="pinterest" style={{ marginTop: 32 }}>Pinterest</h2>
    <p className="muted">One Pinterest business account, pinterest.com/elettro, for Elettro and Stashbox: connect it under each brand (same login); Stashbox Pins go to the Stashbox board. While the Elettro OS app has Trial access, Pins it creates are visible only to that account. The login renews itself each time it is used; the countdown shows when it lapses if unused.</p>
    <div className="grid" style={{ marginTop: 20 }}>
      {pinterestBrands.map((b) => {
        const linked = pinterest[b.id];
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Pinterest</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/pinterest/start?brand=${b.id}`}>{linked ? "Reconnect" : "Connect Pinterest"}</a>
              {linked?.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
              {linked && <ConnectionDisconnect brand={b.id} network="pinterest" handle={linked.handle || "this account"} />}
            </div>
            {linked && <PinterestPost brand={b.id} boardName={PINTEREST_BOARDS[b.id] || b.name} />}
          </article>
        );
      })}
    </div>
    </>}
    {linkedinBrands.length > 0 && <>
    <h2 id="linkedin" style={{ marginTop: 32 }}>LinkedIn</h2>
    <p className="muted">Each brand posts to its company page (one per brand); the Dean Palermo brand is Dean&apos;s personal profile. A personal-profile login lasts 60 days with no refresh, so reconnect before the countdown runs out. A company-page login renews itself; its countdown is the date LinkedIn&apos;s renewal runs out.</p>
    {/* A result for a brand shows under that brand's Post button; one with no brand (bad login, unknown brand) shows here. */}
    {network === "linkedin" && !brand && error && <p className="card" style={{ marginTop: 16 }}>LinkedIn post not sent: {error}</p>}
    <div className="grid" style={{ marginTop: 20 }}>
      {linkedinBrands.map((b) => {
        const linked = linkedin[b.id];
        return (
          <article className="card" key={b.id} id={`li-${b.id}`} style={{ scrollMarginTop: 16 }}>
            <div className="eyebrow">LinkedIn · {LINKEDIN_PAGE_BRANDS.includes(b.id) ? "company page" : "personal profile"}</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/linkedin/start?brand=${b.id}${LINKEDIN_PAGE_BRANDS.includes(b.id) ? "&kind=page" : ""}`}>{linked ? "Reconnect" : LINKEDIN_PAGE_BRANDS.includes(b.id) ? "Connect company page" : "Connect LinkedIn"}</a>
              {linked?.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
              {linked && <ConnectionDisconnect brand={b.id} network="linkedin" handle={linked.handle || "this account"} />}
            </div>
            {linked?.expiresAt && (
              <p className="muted" style={{ margin: "12px 0 0" }}>
                Expires {new Date(linked.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/New_York" })} ·{" "}
                <a href={calendarReminderUrl(linked.expiresAt)} target="_blank" rel="noreferrer">Add reminder to Google Calendar</a>
              </p>
            )}
            {linked && (
              <form method="post" action="/api/connections/linkedin/test-post" className="test-post">
                <input type="hidden" name="brand" value={b.id} />
                <label className="muted" htmlFor={`li-text-${b.id}`}>Test post (goes live on LinkedIn when you click)</label>
                <textarea id={`li-text-${b.id}`} name="text" rows={4} maxLength={3000} required defaultValue={TEST_POST} />
                <button type="submit" className="status-chip">Post to LinkedIn now</button>
                {network === "linkedin" && brand === b.id && (posted || error) && (
                  <p role="status" className={`post-result ${posted ? "ok" : "bad"}`}>
                    {posted
                      ? <><b>✓ Posted to LinkedIn</b>{at ? ` at ${new Date(at).toLocaleTimeString("en-US", { timeStyle: "short", timeZone: "America/New_York" })} ET` : ""}. <a href={posted} target="_blank" rel="noreferrer">View the post</a></>
                      : <><b>✗ Not posted.</b> {error}</>}
                  </p>
                )}
              </form>
            )}
          </article>
        );
      })}
    </div>
    </>}
    {mastodonBrands.length > 0 && <>
    <h2 id="mastodon" style={{ marginTop: 32 }}>Mastodon</h2>
    <p className="muted">Each brand posts from its own profile on mastodon.social. Sign in with the brand&apos;s profile when Mastodon asks (not your own). Tokens do not expire, so there is no reconnect countdown. Mark the profile as an automated account in its Mastodon settings.</p>
    {network === "mastodon" && posted && <p className="card" style={{ marginTop: 16 }}>Posted to Mastodon. <a href={posted} target="_blank" rel="noreferrer">See the post</a></p>}
    {network === "mastodon" && error && <p className="card" style={{ marginTop: 16 }}>Mastodon: {error}</p>}
    <div className="grid" style={{ marginTop: 20 }}>
      {mastodonBrands.map((b) => {
        const linked = mastodon[b.id];
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">Mastodon · mastodon.social</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/mastodon/start?brand=${b.id}`}>{linked ? "Reconnect" : "Connect Mastodon"}</a>
              {linked && <ConnectionDisconnect brand={b.id} network="mastodon" handle={linked.handle || "this account"} />}
            </div>
            {linked && (
              <form method="post" action="/api/connections/mastodon/test-post" className="test-post">
                <input type="hidden" name="brand" value={b.id} />
                <label className="muted" htmlFor={`ma-text-${b.id}`}>Test post (goes live on Mastodon when you click)</label>
                <textarea id={`ma-text-${b.id}`} name="text" rows={4} maxLength={MASTODON_POST_LIMIT} required />
                <button type="submit" className="status-chip">Post to Mastodon now</button>
              </form>
            )}
          </article>
        );
      })}
    </div>
    </>}
  </main>;
}
