/**
 * Deny-by-default gate for the dev-api's HTTP routes.
 *
 * Only the two count-only status feeds (elettro.com/dash and the reconnect banner read them) are public.
 * Every other HTTP request needs the shared connect key, the same one the connect, planner and review routes
 * already check. IAM invokes (workers, MCP, one-offs) have no HTTP request context and never reach this.
 */
import { timingSafeEqual } from "node:crypto";

export const PUBLIC_HTTP_PATHS = ["/status/connections", "/status/posts"];

export function isHttpEvent(event) {
  return Boolean(event?.requestContext || event?.rawPath || event?.path);
}

function keyMatches(given) {
  const expected = process.env.CONNECTIONS_API_SHARED_SECRET || "";
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns a 401 response for a keyless HTTP request to a non-public path, else null. */
export function gateHttp(event, requestPath, json) {
  if (!isHttpEvent(event)) return null;
  const method = event?.requestContext?.http?.method || "GET";
  if (method === "GET" && PUBLIC_HTTP_PATHS.includes(requestPath)) return null;
  if (method === "OPTIONS") return null;
  const headers = event?.headers || {};
  const key = headers["x-elettro-connect-key"] ?? headers["X-Elettro-Connect-Key"];
  if (!keyMatches(key)) return json(401, { ok: false, error: "Connect key required" });
  return null;
}

/** The shared creative-assets library; `?shared=1` adds its assets to a brand-filtered /assets list. */
export const SHARED_LIBRARY_SLUG = "creative-assets";
export function includeShared(event) {
  return event?.queryStringParameters?.shared === "1";
}

/** Parses `?brands=a,b` into a clean slug list, or null when no filter was asked for. */
export function brandFilter(event) {
  const raw = event?.queryStringParameters?.brands;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const slugs = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9-]{1,60}$/.test(s));
  return slugs.length ? slugs : [];
}
