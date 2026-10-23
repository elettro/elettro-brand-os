"use client";

import { useEffect, useRef, useState } from "react";
import { SHEETS, SHEET_GROUPS, type Sheet } from "@/lib/sheets";

export function SheetGallery() {
  const [group, setGroup] = useState<string>("all");
  const [open, setOpen] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const shown: Sheet[] = group === "all" ? SHEETS : SHEETS.filter((s) => s.group === group);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open !== null && !d.open) d.showModal();
    if (open === null && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setOpen((i) => (i === null ? i : (i + 1) % shown.length));
      if (e.key === "ArrowLeft") setOpen((i) => (i === null ? i : (i - 1 + shown.length) % shown.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shown.length]);

  const current = open !== null ? shown[open] : null;

  return (
    <>
      <div className="pub-tabs" role="tablist" aria-label="Sheet type">
        {SHEET_GROUPS.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={group === g.id}
            className={group === g.id ? "on" : ""}
            onClick={() => { setGroup(g.id); setOpen(null); }}
          >
            {g.label}
          </button>
        ))}
      </div>
      <ul className="pub-grid">
        {shown.map((s, i) => (
          <li key={s.slug}>
            <button className="pub-sheet" onClick={() => setOpen(i)} aria-label={`Open: ${s.title}`}>
              <img src={`/sheets/${s.slug}.webp`} alt={s.title} width={s.w} height={s.h} loading="lazy" decoding="async" />
              {s.soon && <span className="pub-soon">Coming soon</span>}
              <span className="pub-cap">{s.title}</span>
            </button>
          </li>
        ))}
      </ul>
      <dialog
        ref={dialog}
        className="pub-lightbox"
        onClose={() => setOpen(null)}
        onClick={(e) => { if (e.target === dialog.current) setOpen(null); }}
      >
        {current && (
          <div className="pub-lb-body">
            <img src={`/sheets/${current.slug}.webp`} alt={current.title} />
            <div className="pub-lb-bar">
              <button onClick={() => setOpen((open! - 1 + shown.length) % shown.length)} aria-label="Previous sheet">&larr;</button>
              <span>{current.title}{current.soon ? " (coming soon)" : ""}</span>
              <button onClick={() => setOpen((open! + 1) % shown.length)} aria-label="Next sheet">&rarr;</button>
              <button onClick={() => setOpen(null)} aria-label="Close">Close</button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
