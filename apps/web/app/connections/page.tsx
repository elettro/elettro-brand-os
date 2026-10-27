import { session } from "@/lib/cognito-auth";
import { visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { YOUTUBE_BRANDS } from "@/lib/youtube-connect";
import { LINKEDIN_BRANDS, calendarReminderUrl } from "@/lib/linkedin-connect";
import { GBP_BRANDS } from "@/lib/gbp-connect";
import { META_BRANDS } from "@/lib/meta-connect";
import { MetaTestPosts } from "@/components/meta-test-posts";
import { THREADS_BRANDS } from "@/lib/threads-connect";
import { TIKTOK_BRANDS } from "@/lib/tiktok-connect";
import { TiktokPost } from "@/components/tiktok-post";
import { TiktokDisconnect } from "@/components/tiktok-disconnect";
import { PINTEREST_BOARDS, PINTEREST_BRANDS } from "@/lib/pinterest-connect";
import { PinterestPost } from "@/components/pinterest-post";
import { ReconnectCountdown } from "@/components/reconnect-countdown";
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
  const [{ brand, connected, disconnected, error, network, expires, posted }, status] = await Promise.all([searchParams, connectionStatus()]);
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
  const tiktokBrands = brandConfigs.filter((b) => TIKTOK_BRANDS.includes(b.id) && inView(b.id));
  const tiktok = status.tiktok || {};
  const pinterestBrands = brandConfigs.filter((b) => PINTEREST_BRANDS.includes(b.id) && inView(b.id));
  const pinterest = status.pinterest || {};
  // The feed caches for 60s; right after a connect, trust the expiry the callback just reported.
  if (brand && connected && expires && !Number.isNaN(Date.parse(expires))) {
    if (network === "linkedin") linkedin[brand] = { handle: connected, expiresAt: expires };
    if (network === "threads") threads[brand] = { handle: connected, expiresAt: expires };
    if (network === "tiktok") tiktok[brand] = { handle: connected, expiresAt: expires };
    if (network === "pinterest") pinterest[brand] = { handle: connected, expiresAt: expires };
  }
  // Same cache after a disconnect: the brand is no longer linked even if the feed still says so.
  if (brand && disconnected && network === "tiktok") {
    delete tiktok[brand];
  }
  return <main className="main">
    <div className="eyebrow">Publishing · Social connections</div>
    <h1>Connections</h1>
    <p className="muted">Connect each brand&apos;s accounts to Elettro OS. Google asks which YouTube channel to use; pick the one that belongs to the brand. LinkedIn logins last 60 days, so each one counts down to its reconnect date.</p>
    {connected && <p className="card" style={{ marginTop: 16 }}>Connected <b>{connected}</b>{brandName ? <> to {brandName}</> : null}.</p>}
    {disconnected && <p className="card" style={{ marginTop: 16 }}>Disconnected <b>{disconnected}</b>{brandName ? <> from {brandName}</> : null}. Elettro OS no longer has access to it.</p>}
    {error && network !== "linkedin" && <p className="card" style={{ marginTop: 16 }}>Could not connect{brandName ? ` ${brandName}` : ""}: {error}</p>}
    {brands.length > 0 && <>
    <div className="grid" style={{ marginTop: 20 }}>
      {brands.map((b) => {
        const handle = youtube[b.id]?.handle;
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">YouTube</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {handle ? <>● Connected · <b>{handle}</b></> : "○ Not connected"}
            </p>
            <a className="status-chip" href={`/api/connections/youtube/start?brand=${b.id}`}>{handle ? "Reconnect" : "Connect YouTube"}</a>
          </article>
        );
      })}
    </div>
    </>}
    {inView("google-review") && <p className="muted" style={{ marginTop: 20 }}>Other networks (Instagram, Facebook, Threads, TikTok, LinkedIn, Pinterest, Google Business) are turned off for Google Review.</p>}
    {gbpBrands.length > 0 && <>
    <h2 style={{ marginTop: 32 }}>Google Business Profile</h2>
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
            <a className="status-chip" href={`/api/connections/gbp/start?brand=${b.id}`}>{profile ? "Reconnect" : "Connect Google Business Profile"}</a>
          </article>
        );
      })}
    </div>
    </>}
    {metaBrands.length > 0 && <>
    <h2 style={{ marginTop: 32 }}>Facebook + Instagram</h2>
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
            <a className="status-chip" href={`/api/connections/meta/start?brand=${b.id}`}>{page ? "Reconnect" : "Connect Facebook + Instagram"}</a>
            {page && <MetaTestPosts brand={b.id} page={page} instagram={ig || null} />}
          </article>
        );
      })}
    </div>
    </>}
    {threadsBrands.length > 0 && <>
    <h2 style={{ marginTop: 32 }}>Threads</h2>
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
            </div>
          </article>
        );
      })}
    </div>
    </>}
    {tiktokBrands.length > 0 && <>
    <h2 style={{ marginTop: 32 }}>TikTok</h2>
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
              {linked && <TiktokDisconnect brand={b.id} handle={linked.handle || "this account"} />}
            </div>
            {linked && <TiktokPost brand={b.id} />}
          </article>
        );
      })}
    </div>
    </>}
    {pinterestBrands.length > 0 && <>
    <h2 style={{ marginTop: 32 }}>Pinterest</h2>
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
            </div>
            {linked && <PinterestPost brand={b.id} boardName={PINTEREST_BOARDS[b.id] || b.name} />}
          </article>
        );
      })}
    </div>
    </>}
    {linkedinBrands.length > 0 && <>
    <h2 id="linkedin" style={{ marginTop: 32 }}>LinkedIn</h2>
    <p className="muted">Dean&apos;s personal profile, posting through the Elettro OS Personal app. LinkedIn gives no refresh token, so reconnect before the countdown runs out; company pages follow once LinkedIn approves Community Management.</p>
    {/* The result sits next to the form: the redirect lands on #linkedin, far down the page. */}
    {network === "linkedin" && posted && <p className="card" style={{ marginTop: 16 }}>Posted to LinkedIn. <a href={posted} target="_blank" rel="noreferrer">See the post</a></p>}
    {network === "linkedin" && error && <p className="card" style={{ marginTop: 16 }}>LinkedIn post not sent: {error}</p>}
    <div className="grid" style={{ marginTop: 20 }}>
      {linkedinBrands.map((b) => {
        const linked = linkedin[b.id];
        return (
          <article className="card" key={b.id}>
            <div className="eyebrow">LinkedIn · personal profile</div>
            <h2>{b.name}</h2>
            <p className="muted" style={{ margin: "0 0 12px" }}>
              {linked ? <>● Connected · <b>{linked.handle}</b></> : "○ Not connected"}
            </p>
            <div className="connect-row">
              <a className="status-chip" href={`/api/connections/linkedin/start?brand=${b.id}`}>{linked ? "Reconnect" : "Connect LinkedIn"}</a>
              {linked?.expiresAt && <ReconnectCountdown expiresAt={linked.expiresAt} />}
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
              </form>
            )}
          </article>
        );
      })}
    </div>
    </>}
  </main>;
}
