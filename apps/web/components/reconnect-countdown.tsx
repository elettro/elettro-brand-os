"use client";

import { useEffect, useState } from "react";
import { expiryLevel } from "@/lib/token-expiry";

const pad = (n: number) => String(n).padStart(2, "0");

// Live "59d 23:59:12 left" next to a Connect button; turns amber at 14 days, red at 3, then "Expired".
export function ReconnectCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const end = new Date(expiresAt);
  const level = expiryLevel(end, now ?? Date.now());
  const left = Math.max(0, end.getTime() - (now ?? Date.now()));
  const s = Math.floor(left / 1000);
  const label = level === "expired"
    ? "Expired: reconnect to keep posting"
    : `${Math.floor(s / 86400)}d ${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)} left`;

  return (
    <span className={`countdown countdown-${level}`} title={`Login expires ${end.toLocaleString()}`} suppressHydrationWarning>
      {now === null ? "…" : label}
    </span>
  );
}
