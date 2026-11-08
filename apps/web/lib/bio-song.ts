// The bio-link page's "song of the day" (runbook docs/admin/link-tracking.md). The dev-api runs in the VPC with no route to the
// internet, so THIS server reads the public Stashbox Radio catalog, picks one visible song per day, and asks the dev-api for
// its tracked link ({action:"bio-song"}). No imports on purpose: tests/link-tracking.test.mjs loads this file directly.

export type RadioSong = { song_key?: string; display_title?: string; song_name?: string; public_visibility?: string; resolved_artwork_url?: string; song_artwork_url?: string };
export type DaySong = { key: string; title: string; image: string | null };

const hash = (text: string): number => { let h = 2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const clean = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** One visible, well-formed catalog song per day: the same all day, a different one tomorrow. */
export function pickSong(catalog: unknown, day: string): DaySong | null {
  const songs = (Array.isArray(catalog) ? catalog as RadioSong[] : []).filter((x) => x && (x.public_visibility || "visible") === "visible"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(String(x.song_key || "")) && clean(x.display_title || x.song_name, 90));
  if (!songs.length) return null;
  const song = [...songs].sort((a, b) => hash(`song${day}${a.song_key}`) - hash(`song${day}${b.song_key}`))[0];
  const art = String(song.resolved_artwork_url || song.song_artwork_url || "");
  return { key: String(song.song_key), title: clean(song.display_title || song.song_name, 90) as string, image: /^https:\/\//.test(art) ? art : null };
}
