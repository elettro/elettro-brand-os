import { authenticated } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { YOUTUBE_BRANDS } from "@/lib/youtube-connect";
import { redirect } from "next/navigation";

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await authenticated())) redirect("/api/auth/login");
  const { brand, connected, error } = await searchParams;
  const brands = brandConfigs.filter((b) => YOUTUBE_BRANDS.includes(b.id));
  return <main className="main">
    <div className="eyebrow">Publishing · Social connections</div>
    <h1>Connections</h1>
    <p className="muted">Connect each brand&apos;s YouTube channel to Elettro OS. Google asks which channel to use; pick the one that belongs to the brand.</p>
    {connected && <p className="card" style={{ marginTop: 16 }}>Connected <b>{connected}</b> to {brand}.</p>}
    {error && <p className="card" style={{ marginTop: 16 }}>Could not connect{brand ? ` ${brand}` : ""}: {error}</p>}
    <div className="grid" style={{ marginTop: 20 }}>
      {brands.map((b) => (
        <article className="card" key={b.id}>
          <div className="eyebrow">YouTube</div>
          <h2>{b.name}</h2>
          <a className="status-chip" href={`/api/connections/youtube/start?brand=${b.id}`}>Connect YouTube</a>
        </article>
      ))}
    </div>
  </main>;
}
