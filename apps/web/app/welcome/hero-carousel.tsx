"use client";

import { useEffect, useState } from "react";
import { SHEETS } from "@/lib/sheets";

// Live one-sheets only, ordered so neighbouring slides come from different groups.
const SLUGS = [
  "restaurant-brunch",
  "video-what-it-can-do",
  "venues-event-calendar",
  "hotels-direct-bookings",
  "growth-step-1",
  "restaurant-rooftop",
  "video-concept-to-content",
  "venues-full-calendars",
  "growth-step-2",
  "restaurant-happy-hour",
  "video-social-campaigns",
  "restaurant-reservations"
];
const SLIDES = SLUGS.map((slug) => SHEETS.find((s) => s.slug === slug && !s.soon)).filter((s): s is NonNullable<typeof s> => !!s);
const INTERVAL_MS = 4500;

export function HeroCarousel() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (paused || still) return;
    const t = window.setInterval(() => setI((n) => (n + 1) % SLIDES.length), INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [paused, still]);

  return (
    <div
      className="pub-carousel"
      role="region"
      aria-roledescription="carousel"
      aria-label="Elettro one-sheets"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <a className="pub-slides" href="#sheets" aria-label="See all one-sheets">
        {SLIDES.map((s, n) => (
          <img
            key={s.slug}
            className={n === i ? "on" : ""}
            src={`/sheets/${s.slug}.webp`}
            alt={n === i ? s.title : ""}
            aria-hidden={n !== i}
            width={s.w}
            height={s.h}
            loading={n < 2 ? "eager" : "lazy"}
            decoding="async"
          />
        ))}
      </a>
      <p className="pub-slide-title" aria-live="off">{SLIDES[i].title}</p>
      <div className="pub-dots">
        {SLIDES.map((s, n) => (
          <button key={s.slug} className={n === i ? "on" : ""} onClick={() => setI(n)} aria-label={`Show sheet ${n + 1}: ${s.title}`} aria-current={n === i} />
        ))}
      </div>
    </div>
  );
}
