/**
 * POST /ops/tick: fire a worker's publishing tick right now (Stream Deck keys, "release posts when I want").
 *
 * Body: { "worker": "meta" }  or  { "worker": "all" }
 *
 * A manual tick is exactly what the 15-minute EventBridge rule sends ({ action: "tick" }), so it publishes only posts
 * that are already due and approved. It does not pull future posts forward. Workers claim each post through the
 * dev-api's `claim-due-posts` (marks it 'publishing' first), so a manual press next to a scheduled tick cannot send a
 * post twice.
 *
 * Auth: its own token in the `x-elettro-deck-key` header (env OPS_TICK_TOKEN), NOT the shared connect key, so the
 * deck PC never holds a key that opens the rest of the dev-api. No token set = the route answers 503.
 *
 * Invoked asynchronously (InvocationType "Event"): video ticks can run for minutes, far past the gateway's 30 s limit,
 * so the answer means "sent", not "published". Every press is logged to CloudWatch.
 */
import { timingSafeEqual } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

/** Friendly name used on the deck -> Lambda function name. */
export const TICK_WORKERS = {
  meta: "elettro-brand-os-dev-meta",
  threads: "elettro-brand-os-dev-threads",
  tiktok: "elettro-brand-os-dev-tiktok",
  pinterest: "elettro-brand-os-dev-pinterest",
  youtube: "elettro-brand-os-dev-youtube-upload",
  linkedin: "elettro-brand-os-dev-linkedin",
  bluesky: "elettro-brand-os-dev-bluesky",
  mastodon: "elettro-brand-os-dev-mastodon",
  x: "elettro-brand-os-dev-x",
  snapchat: "elettro-brand-os-dev-snapchat",
  substack: "elettro-brand-os-dev-substack",
  gmb: "elettro-brand-os-dev-gmb",
};

/** A worker cannot be fired again within this window (a double press, or a held key). */
export const COOLDOWN_MS = 20_000;
const lastFired = new Map();

const lambda = new LambdaClient({});

export function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function resetCooldownsForTests() {
  lastFired.clear();
}

/**
 * @param event   API Gateway HTTP event
 * @param json    the dev-api's response helper: (status, body) => response
 * @param options { client, now, token } test hooks
 */
export async function handleOpsTick(event, json, options = {}) {
  const client = options.client || lambda;
  const now = options.now ? options.now() : Date.now();
  const expected = options.token !== undefined ? options.token : process.env.OPS_TICK_TOKEN || "";

  if (!expected) return json(503, { ok: false, error: "Manual tick is not set up (OPS_TICK_TOKEN is empty)" });
  const headers = event?.headers || {};
  const given = headers["x-elettro-deck-key"] ?? headers["X-Elettro-Deck-Key"];
  if (!tokenMatches(given, expected)) return json(401, { ok: false, error: "Deck key required" });
  if ((event?.requestContext?.http?.method || "") !== "POST") return json(405, { ok: false, error: "POST only" });

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "Body must be JSON" });
  }

  const worker = String(body?.worker || "").toLowerCase();
  const targets = worker === "all" ? Object.keys(TICK_WORKERS) : TICK_WORKERS[worker] ? [worker] : [];
  if (!targets.length) {
    return json(400, { ok: false, error: `Unknown worker "${worker}"`, workers: ["all", ...Object.keys(TICK_WORKERS)] });
  }

  const results = [];
  for (const name of targets) {
    const last = lastFired.get(name) || 0;
    if (now - last < COOLDOWN_MS) {
      results.push({ worker: name, status: "cooldown", retryInSeconds: Math.ceil((COOLDOWN_MS - (now - last)) / 1000) });
      continue;
    }
    lastFired.set(name, now);
    try {
      await client.send(
        new InvokeCommand({
          FunctionName: TICK_WORKERS[name],
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify({ action: "tick", source: "deck" })),
        }),
      );
      results.push({ worker: name, status: "sent" });
    } catch (error) {
      lastFired.delete(name);
      results.push({ worker: name, status: "error", error: String(error?.name || "InvokeFailed") });
    }
  }

  console.log(JSON.stringify({ ops: "tick", worker, results }));
  const failed = results.filter((r) => r.status === "error").length;
  return json(failed === results.length ? 502 : 200, { ok: failed === 0, worker, results });
}
