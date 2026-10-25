/**
 * Connect-key gate for the Lens admin API. Same pattern as services/dev-api-lambda/api-gate.mjs (copied, not
 * imported, so the two Lambdas deploy independently). The key is the shared CONNECTIONS_API_SHARED_SECRET, so the
 * Elettro OS web server's connectKeyHeaders() works unchanged. There are no public routes in this Lambda: scan
 * pages and manifests are served by CloudFront, and the public event ingest ships in a later PR.
 */
import { timingSafeEqual } from "node:crypto";

function keyMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns a 401 response unless the request carries the connect key. OPTIONS passes (no data is returned). */
export function gate(event, json, expected = process.env.CONNECTIONS_API_SHARED_SECRET || "") {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  if (method === "OPTIONS") return null;
  const headers = event?.headers || {};
  const key = headers["x-elettro-connect-key"] ?? headers["X-Elettro-Connect-Key"];
  return keyMatches(key, expected) ? null : json(401, { ok: false, error: "Connect key required" });
}
