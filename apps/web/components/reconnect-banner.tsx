"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { daysLeft, expiryLevel } from "@/lib/token-expiry";

const apiBaseUrl = process.env.NEXT_PUBLIC_BRAND_OS_API_BASE_URL || "https://zkjngy7rdd.execute-api.us-east-1.amazonaws.com";
const NETWORK: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", threads: "Threads", bluesky: "Bluesky" };

type Due = { network: string; brand: string; expiresAt: string };
type Feed = { brands?: Array<{ name: string; profiles: Array<{ destination: string; tokenExpiresAt?: string | null }> }> };

// App-wide reminder: any login that expires within 14 days (or already has) shows on every page until reconnected.
export function ReconnectBanner() {
  const [due, setDue] = useState<Due[]>([]);
  useEffect(() => {
    fetch(`${apiBaseUrl}/status/connections`, { cache: "no-store" })
      .then((r) => r.json() as Promise<Feed>)
      .then((feed) => setDue((feed.brands || []).flatMap((b) => b.profiles
        .filter((p) => p.tokenExpiresAt && expiryLevel(p.tokenExpiresAt) !== "ok")
        .map((p) => ({ network: NETWORK[p.destination] || p.destination, brand: b.name, expiresAt: p.tokenExpiresAt as string })))))
      .catch(() => setDue([]));
  }, []);
  if (!due.length) return null;
  return (
    <div className="reconnect-banner" role="status">
      {due.map((d) => {
        const level = expiryLevel(d.expiresAt);
        const days = daysLeft(d.expiresAt);
        return (
          <div key={d.network + d.brand} className={`reconnect-banner-row countdown-${level}`}>
            <b>{d.network} ({d.brand})</b>{" "}
            {level === "expired" ? "login has expired; posting is paused." : `login expires in ${days} day${days === 1 ? "" : "s"}.`}{" "}
            <Link href="/connections">Reconnect</Link>
          </div>
        );
      })}
    </div>
  );
}
