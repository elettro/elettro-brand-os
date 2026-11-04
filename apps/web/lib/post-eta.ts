// Workers tick every 15 minutes, so an approved post goes out on the first tick after its time: at the latest 15 minutes later.
export const TICK_MS = 15 * 60 * 1000;
// "in 3 min", "in 2 h 5 min", "in 4 days 12 h". Past times return null.
export function countdown(targetMs: number, nowMs: number): string | null {
  const diff = targetMs - nowMs;
  if (diff <= 0) return null;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "in under a minute";
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `in ${d} day${d === 1 ? "" : "s"} ${h % 24} h`;
}

