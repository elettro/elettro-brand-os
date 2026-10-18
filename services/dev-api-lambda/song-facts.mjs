// Song facts for planning and copy: the Stashbox Radio catalog is the record for
// song titles and links. Library assets carry `song:<slug>` tags; this maps each
// slug to one catalog song so posts link to that song's own radio page.

export const slugify = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Match a library song slug to catalog songs. Exact title or `<slug>-stashbox`
 * key wins; otherwise versions whose key starts with the slug, most played first.
 * Returns { song, alternatives } or null.
 */
export function matchSong(slug, catalog) {
  const visible = catalog.filter((s) => (s.public_visibility || "visible") === "visible");
  const exact = visible.filter((s) => s.song_key === `${slug}-stashbox` || s.song_key === slug ||
    slugify(s.song_name) === slug || slugify(s.display_title) === slug)
    .sort((a, b) => Number([slug, `${slug}-stashbox`].includes(b.song_key)) - Number([slug, `${slug}-stashbox`].includes(a.song_key)));
  const versions = visible.filter((s) => String(s.song_key).startsWith(`${slug}-`));
  const ranked = [...new Set([...exact, ...versions.sort((a, b) => Number(b.total_plays || 0) - Number(a.total_plays || 0))])];
  return ranked.length ? { song: ranked[0], alternatives: ranked.slice(1).map((s) => s.song_key) } : null;
}

/** Build { slug: facts } for every song slug in the library. */
export function buildSongFacts(slugs, catalog, { radioBaseUrl = "https://stashbox.com/radio/", overrides = {} } = {}) {
  const facts = {};
  for (const slug of new Set(slugs)) {
    const forcedKey = overrides[slug];
    const match = forcedKey
      ? { song: catalog.find((s) => s.song_key === forcedKey), alternatives: [] }
      : matchSong(slug, catalog);
    if (!match?.song) { facts[slug] = { slug, inCatalog: false }; continue; }
    const s = match.song;
    const url = new URL(radioBaseUrl);
    url.searchParams.set("song", s.song_key);
    facts[slug] = {
      slug,
      inCatalog: true,
      songKey: s.song_key,
      title: s.display_title || s.song_name,
      artist: s.artist || null,
      album: s.album_name || null,
      origin: s.song_origin || null,
      radioUrl: url.toString(),
      spotifyUrl: s.spotify_url || null,
      appleMusicUrl: s.apple_music_url || null,
      youtubeMusicUrl: s.youtube_music_url || null,
      artworkUrl: s.resolved_artwork_url || s.song_artwork_url || null,
      otherVersions: match.alternatives
    };
  }
  return facts;
}

export async function fetchRadioCatalog(url, { timeoutMs = 10000 } = {}) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Radio catalog request failed: ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.songs)) throw new Error("Radio catalog response has no songs array");
  return data.songs;
}
