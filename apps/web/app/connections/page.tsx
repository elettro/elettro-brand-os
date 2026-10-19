import { authenticated } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { YOUTUBE_BRANDS } from "@/lib/youtube-connect";
import { redirect } from "next/navigation";

const apiBaseUrl =
  process.env.BRAND_OS_API_BASE_URL ||
  process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL ||
  "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";

type Profile = { destination: string; handle: string | null; done: Record<string, number> };

// Which brands have a linked YouTube channel, from the same feed as elettro.com/dash.
async function youtubeStatus(): Promise<Record<string, string | null>> {
  try {
    const response = await fetch(`${apiBaseUrl}/status/connections`, { cache: "no-store" });
    const feed = await response.json() as { brands?: Array<{ slug: string; profiles: Profile[] }> };
    return Object.fromEntries((feed.brands || []).map((b) => {
      const yt = b.profiles.find((p) => p.destination === "youtube");
      return [b.slug, yt && yt.done.oauth >= 1 ? yt.handle : null];
    }));
  } catch {
    return {};
  }
}

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await authenticated())) redirect("/api/auth/login");
  const [{ brand, connected, error }, status] = await Promise.all([searchParams, youtubeStatus()]);
  const brands = brandConfigs.filter((b) => YOUTUBE_BRANDS.includes(b.id));
  return <main className="main">
    <div className="eyebrow">Publishing · Social connections</div>
    <h1>Connections</h1>
    <p className="muted">Connect each brand&apos;s YouTube channel to Elettro OS. Google asks which channel to use; pick the one that belongs to the brand.</p>
    {connected && <p className="card" style={{ marginTop: 16 }}>Connected <b>{connected}</b> to {brand}.</p>}
    {error && <p className="card" style={{ marginTop: 16 }}>Could not connect{brand ? ` ${brand}` : ""}: {error}</p>}
    <div className="grid" style={{ marginTop: 20 }}>
      {brands.map((b) => {
        const handle = status[b.id];
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
  </main>;
}
