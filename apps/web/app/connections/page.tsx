import { authenticated } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { YOUTUBE_BRANDS } from "@/lib/youtube-connect";
import { LINKEDIN_BRANDS, calendarReminderUrl } from "@/lib/linkedin-connect";
import { ReconnectCountdown } from "@/components/reconnect-countdown";
import { redirect } from "next/navigation";

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
  if (!(await authenticated())) redirect("/api/auth/login");
  const [{ brand, connected, error, network, expires }, status] = await Promise.all([searchParams, connectionStatus()]);
  const brands = brandConfigs.filter((b) => YOUTUBE_BRANDS.includes(b.id));
  const linkedinBrands = brandConfigs.filter((b) => LINKEDIN_BRANDS.includes(b.id));
  const youtube = status.youtube || {};
  const linkedin = status.linkedin || {};
  // The feed caches for 60s; right after a connect, trust the expiry the callback just reported.
  if (network === "linkedin" && brand && connected && expires && !Number.isNaN(Date.parse(expires))) linkedin[brand] = { handle: connected, expiresAt: expires };
  return <main className="main">
    <div className="eyebrow">Publishing · Social connections</div>
    <h1>Connections</h1>
    <p className="muted">Connect each brand&apos;s accounts to Elettro OS. Google asks which YouTube channel to use; pick the one that belongs to the brand. LinkedIn logins last 60 days, so each one counts down to its reconnect date.</p>
    {connected && <p className="card" style={{ marginTop: 16 }}>Connected <b>{connected}</b> to {brand}.</p>}
    {error && <p className="card" style={{ marginTop: 16 }}>Could not connect{brand ? ` ${brand}` : ""}: {error}</p>}
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
    <h2 style={{ marginTop: 32 }}>LinkedIn</h2>
    <p className="muted">Dean&apos;s personal profile, posting through the Elettro OS Personal app. LinkedIn gives no refresh token, so reconnect before the countdown runs out; company pages follow once LinkedIn approves Community Management.</p>
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
          </article>
        );
      })}
    </div>
  </main>;
}
