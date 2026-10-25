// Over HTTP these routes are for the signed-in web app only: it sends the shared connect key
// (x-elettro-connect-key). Invokes with no HTTP request context (workers, IAM-only actions) are not HTTP and pass.
import { keyMatches } from "./youtube-connect.mjs";

const KEYED_HTTP_ROUTES = [
  ["GET", "/brands"],
  ["GET", "/dashboard"],
  ["GET", "/assets"],
  ["GET", "/content-pool"],
  ["POST", "/assets/bulk-update"]
];

export function needsKey(event) {
  const http = event?.requestContext?.http;
  if (!http) return false;
  const method = String(http.method || "").toUpperCase();
  const path = event?.rawPath || http.path || "";
  return KEYED_HTTP_ROUTES.some(([m, p]) => m === method && p === path);
}

// Returns an HTTP response to send back when the key is missing or wrong, otherwise null.
export function guardResponse(event, json) {
  if (!needsKey(event)) return null;
  const headers = event?.headers || {};
  const given = headers["x-elettro-connect-key"] ?? headers["X-Elettro-Connect-Key"];
  return keyMatches(given) ? null : json(401, { ok: false, error: "Connect key required" });
}
