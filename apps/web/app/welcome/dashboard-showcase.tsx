"use client";

import { useEffect, useState } from "react";

const DASH_URL = "https://elettro.com/dash/";
const SNAPSHOT = "November 13, 2026";

const SLIDES = [
  {
    id: "race",
    eyebrow: "Publishing performance",
    title: "The 2,000 Post Race",
    description: "See real posts published across connected brands and networks, plus what is already approved and waiting in the queue.",
    takeaway: "Proof that the publishing engine runs beyond a single campaign.",
    stat: "1,502",
    statLabel: "published posts"
  },
  {
    id: "grandprix",
    eyebrow: "Network connectivity",
    title: "The Connection Grand Prix",
    description: "Follow each social network through connection, approval, first post, and autonomous publishing.",
    takeaway: "Know exactly where every platform stands.",
    stat: "12 / 13",
    statLabel: "network progress snapshot"
  },
  {
    id: "milestones",
    eyebrow: "Operational proof",
    title: "The Milestones",
    description: "Published posts, prepared creative, AR scans, and phone-remote triggers tell the story of a system already working.",
    takeaway: "See activity across Elettro's connected tools in one place.",
    stat: "5,153",
    statLabel: "assets in the system"
  },
  {
    id: "matrix",
    eyebrow: "Multi-brand management",
    title: "The Plug-In Matrix",
    description: "A brand-by-brand view of connected social profiles, pending integrations, and publishing readiness.",
    takeaway: "One operating system. Separate rules for every brand.",
    stat: "10",
    statLabel: "brands shown on the dashboard"
  },
  {
    id: "assets",
    eyebrow: "Centralized content engine",
    title: "The Ready Stack",
    description: "See approved images, video, and audio queued as reusable, brand-specific creative inventory.",
    takeaway: "Prep the asset library once. Keep the content calendar moving.",
    stat: "5,153",
    statLabel: "assets ready to post"
  },
  {
    id: "networks",
    eyebrow: "Cross-platform reach",
    title: "Publishing by Network",
    description: "Compare where posts are going, which destinations lead, and how brands distribute content across platforms.",
    takeaway: "Every network gets an intentional content cadence.",
    stat: "283",
    statLabel: "Instagram posts in the snapshot"
  },
  {
    id: "ar",
    eyebrow: "Real-world engagement",
    title: "The AR Scan Counter",
    description: "Track image-marker scans, button taps, participating brands, and which interactive experiences attract attention.",
    takeaway: "Connect printed and physical marketing to measurable digital actions.",
    stat: "192",
    statLabel: "tracked AR scans"
  },
  {
    id: "remote",
    eyebrow: "Interactive experiences",
    title: "The Remote Counter",
    description: "Watch mobile phones connect to interactive experiences and track how many screen actions those sessions generate.",
    takeaway: "Go beyond impressions. Count real interactions.",
    stat: "110",
    statLabel: "remote triggers"
  }
] as const;

type SlideId = (typeof SLIDES)[number]["id"];
const RACE_BARS = [13, 20, 28, 23, 37, 35, 47, 58, 56, 74, 69, 83, 97, 84, 92, 100];
const NETWORKS = [
  ["Instagram", 283], ["Facebook", 277], ["Mastodon", 168],
  ["Bluesky", 162], ["Pinterest", 154], ["Threads", 138], ["YouTube", 120]
] as const;

function MiniDashboard({ kind }: { kind: SlideId }) {
  if (kind === "race") {
    return (
      <>
        <div className="dbs-mini-kpis"><div><b>1,502</b><span>Published</span></div><div><b>938</b><span>Approved + scheduled</span></div><div><b>2,000</b><span>Next finish line</span></div></div>
        <div className="dbs-chart" aria-hidden="true">{RACE_BARS.map((v, i) => <i key={i} style={{ height: v + "%" }} />)}</div>
        <div className="dbs-mini-foot"><span>Stashbox · 990 posts</span><span>SolarMeister · 377 posts</span></div>
      </>
    );
  }
  if (kind === "grandprix") {
    return (
      <>
        <div className="dbs-mini-kpis"><div><b>95%</b><span>Whole grid average</span></div><div><b>12 / 13</b><span>Live networks shown</span></div></div>
        <div className="dbs-rails">{[["Bluesky",100],["Instagram",100],["Facebook",100],["LinkedIn",100],["TikTok",66],["Snapchat",65]].map(([name,v])=><div className="dbs-rail" key={name}><span>{name}</span><i><b style={{width:v+"%"}} /></i><strong>{v}%</strong></div>)}</div>
      </>
    );
  }
  if (kind === "milestones") {
    return (
      <div className="dbs-milestone-grid">
        {[[ "1,504", "Posts published" ], ["5,153", "Assets prepared"],["192","AR scans"],["110","Remote triggers"]].map(([n,label])=><div key={label}><b>{n}</b><span>{label}</span><i /></div>)}
      </div>
    );
  }
  if (kind === "matrix") {
    return (
      <div className="dbs-matrix">
        <div className="dbs-matrix-head"><span>Brand</span>{["YT","IG","FB","LI","TH","X","GB","SS"].map(x=><b key={x}>{x}</b>)}</div>
        {[
          ["Stashbox",[1,1,1,1,1,1,1,1]],
          ["SolarMeister",[1,1,1,1,1,1,1,1]],
          ["Elettro",[1,1,1,1,1,1,1,1]],
          ["Neckermann",[1,0,0,0,0,1,1,1]]
        ].map(([name,flags])=><div className="dbs-matrix-row" key={name as string}><strong>{name as string}</strong>{(flags as number[]).map((f,i)=><i key={i} className={f ? "ready" : "pending"} />)}</div>)}
        <p>Connected and in-progress profiles by brand</p>
      </div>
    );
  }
  if (kind === "assets") {
    return (
      <>
        <div className="dbs-mini-kpis"><div><b>1,986</b><span>Images</span></div><div><b>1,990</b><span>Videos</span></div><div><b>1,177</b><span>Audio</span></div></div>
        <div className="dbs-asset-bars">{[["Stashbox",1925],["SolarMeister",1445],["Stock gallery",1521],["Neckermann",159]].map(([name,n])=><div key={name}><span>{name}</span><i><b style={{width:(Number(n)/1925*100)+"%"}} /></i><strong>{n.toLocaleString()}</strong></div>)}</div>
      </>
    );
  }
  if (kind === "networks") {
    return (
      <div className="dbs-network-bars">{NETWORKS.map(([name,n])=><div key={name}><span>{name}</span><i><b style={{width:(n/283*100)+"%"}} /></i><strong>{n}</strong></div>)}</div>
    );
  }
  if (kind === "ar") {
    return (
      <>
        <div className="dbs-mini-kpis"><div><b>192</b><span>Marker scans</span></div><div><b>20</b><span>Button taps</span></div><div><b>21 / 23</b><span>Markers activated</span></div></div>
        <div className="dbs-chart dbs-chart-ar" aria-hidden="true">{[75,5,80,7,4,3,4,100,3,9,12,21,11,7].map((v,i)=><i key={i} style={{height:v+"%"}} />)}</div>
        <div className="dbs-mini-foot"><span>Experience scans</span><span>No resident identities collected</span></div>
      </>
    );
  }
  return (
    <>
      <div className="dbs-mini-kpis"><div><b>110</b><span>Phone triggers</span></div><div><b>289</b><span>Screens opened</span></div></div>
      <div className="dbs-remote-flow"><div><b>QR</b><span>Scan</span></div><i aria-hidden="true">→</i><div><b>PHONE</b><span>Connect</span></div><i aria-hidden="true">→</i><div><b>SCREEN</b><span>Interact</span></div></div>
      <div className="dbs-mini-foot"><span>Live trigger activity</span><span>Measured interactions</span></div>
    </>
  );
}

export function DashboardShowcase() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(true);
  const active = SLIDES[index];

  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (paused || still) return;
    const timer = window.setInterval(() => setIndex((n) => (n + 1) % SLIDES.length), 7000);
    return () => window.clearInterval(timer);
  }, [paused, still]);

  const move = (delta: number) => setIndex((n) => (n + delta + SLIDES.length) % SLIDES.length);

  return (
    <div
      className="dbs"
      role="region"
      aria-roledescription="carousel"
      aria-label="Explore the Elettro live dashboard"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); move(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); } }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="dbs-feature">
        <div className="dbs-copy" key={active.id}>
          <div className="dbs-kicker"><span className="dbs-live-dot" /> LIVE DASHBOARD TOUR <span className="dbs-kicker-count">{String(index + 1).padStart(2,"0")} / {String(SLIDES.length).padStart(2,"0")}</span></div>
          <p className="dbs-category">{active.eyebrow}</p>
          <h3>{active.title}</h3>
          <p className="dbs-description">{active.description}</p>
          <p className="dbs-takeaway">{active.takeaway}</p>
          <div className="dbs-spotlight"><strong>{active.stat}</strong><span>{active.statLabel}<small>Dashboard snapshot · {SNAPSHOT}</small></span></div>
          <a className="dbs-open" href={DASH_URL} target="_blank" rel="noopener noreferrer">Explore the live dashboard <span aria-hidden="true">↗</span></a>
        </div>
        <div className="dbs-monitor" aria-label={active.title + " dashboard preview"}>
          <div className="dbs-monitor-top"><span><i /> <i /> <i /></span><strong>ELETTRO / DASH</strong><em>PREVIEW</em></div>
          <div className="dbs-monitor-main">
            <div className="dbs-screen-eyebrow">ELETTRO OS / METRICS / {active.eyebrow.toUpperCase()}</div>
            <h4>{active.title}</h4>
            <MiniDashboard kind={active.id} />
          </div>
          <div className="dbs-monitor-bottom"><span>Dashboard snapshot · {SNAPSHOT}</span><span>Live at elettro.com/dash</span></div>
        </div>
      </div>
      <div className="dbs-nav">
        <button className="dbs-arrow" type="button" aria-label="Previous dashboard" onClick={() => move(-1)}>←</button>
        <div className="dbs-tabs" aria-label="Select dashboard">
          {SLIDES.map((s,i)=><button key={s.id} type="button" aria-label={"Show " + s.title} aria-current={i===index ? "true" : undefined} className={i===index?"active":""} onClick={() => setIndex(i)}><span>{String(i+1).padStart(2,"0")}</span><strong>{s.title}</strong></button>)}
        </div>
        <button className="dbs-arrow" type="button" aria-label="Next dashboard" onClick={() => move(1)}>→</button>
      </div>
      <div className="dbs-bottom-cta"><p><strong>Stop guessing whether your marketing is moving.</strong> See the publishing, creative inventory, connections, and engagement tracked in one place.</p><a href={DASH_URL} target="_blank" rel="noopener noreferrer">View all dashboards <span aria-hidden="true">↗</span></a></div>
    </div>
  );
}
