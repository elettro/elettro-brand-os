// Planning runs + their live status (Review page). 2026-11-07.
//
// A week is planned ONE NETWORK PER INVOCATION, ONE AFTER ANOTHER: startPlanRun() writes a status record and
// async-invokes plan-week for the first network with the rest as `chain`; each plan-week starts the next when it ends
// (success or failure). With AI captions on, one network can take 2+ minutes and a whole brand in one invocation ran
// past the dev-api's 300 s limit. Networks are not run in parallel because the AWS account allows only 10 concurrent
// Lambda executions in total (checked 2026-11-07), shared with the posting workers.
// Each plan-week reports its steps into Brand.settings.planRuns.<weekStart>.networks.<network>, and the Review page
// polls that while anything is queued or running.
//
// Status record:  planRuns: { "<weekStart>": { runId, startedAt, source, networks: { "<network>": NetworkStatus } } }
// NetworkStatus:  { state: "queued"|"running"|"done"|"failed", step?: "loading"|"picking"|"writing"|"saving",
//                   done?, total?, posts?, ai?, template?, gaps?, error?, updatedAt }
// A run with no status update at all for STALE_MS is dead (Lambda timeout or crash broke the chain): its queued and
// running networks are shown as "stalled". Plan again to retry.
import { randomUUID } from "node:crypto";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

export const STALE_MS = 7 * 60000;
const KEEP_DAYS = 21;
const PROGRESS_EVERY_MS = 3000;

let lambda;
export const selfInvoke = (payload) => {
  lambda = lambda || new LambdaClient({});
  return lambda.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload))
  }));
};

const ymdMinusDays = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

/**
 * Write a fresh status record for the week and start the chain (first network now, the rest one after another).
 * Returns { runId, destinations }. If the first invoke fails, every network is marked failed.
 */
export async function startPlanRun(client, brand, { weekStart, destinations, replacePlanned = true, invoke = selfInvoke, now = new Date(), source = "review" }) {
  const runId = randomUUID();
  const at = new Date(now).toISOString();
  const run = { runId, startedAt: at, source, networks: Object.fromEntries(destinations.map((d) => [d, { state: "queued", updatedAt: at }])) };
  const old = Object.keys(brand.settings?.planRuns || {}).filter((w) => w < ymdMinusDays(weekStart, KEEP_DAYS) && w !== weekStart);
  await client.query(
    `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings",'{}'::jsonb), '{planRuns}',
       (COALESCE("settings"->'planRuns','{}'::jsonb) - $4::text[]) || jsonb_build_object($2::text, $3::jsonb), true)
     WHERE "id" = $1`, [brand.id, weekStart, JSON.stringify(run), old]);
  if (!destinations.length) return { runId, destinations };
  try {
    await invoke(planWeekPayload({ brandSlug: brand.slug, weekStart, replacePlanned, runId }, destinations));
  } catch (error) {
    console.error("[plan-runs] invoke failed", brand.slug, weekStart, error?.message);
    for (const destination of destinations) {
      await writeNetwork(client, { brandId: brand.id, weekStart, runId, destination },
        { state: "failed", error: "Could not start planning", updatedAt: new Date().toISOString() });
    }
  }
  return { runId, destinations };
}

/** plan-week for the first network of `destinations`, carrying the rest as its chain. */
export function planWeekPayload({ brandSlug, weekStart, replacePlanned, runId }, destinations) {
  return { action: "plan-week", brandSlug, weekStart, mode: "apply", replacePlanned, destinations: [destinations[0]], runId, chain: destinations.slice(1) };
}

/** Called by plan-week when it ends: start the next network of the chain, if any. Never throws. */
export async function continueChain(event, invoke = selfInvoke) {
  const chain = Array.isArray(event?.chain) ? event.chain.map(String).filter(Boolean) : [];
  if (!event?.runId || !chain.length) return false;
  try {
    await invoke(planWeekPayload({ brandSlug: event.brandSlug, weekStart: event.weekStart, replacePlanned: event.replacePlanned === true, runId: event.runId }, chain));
    return true;
  } catch (error) {
    console.error("[plan-runs] could not start the next network", event.brandSlug, chain[0], error?.message);
    return false;
  }
}

/** Replace one network's status, only if the week's record still belongs to this run (a newer Plan click wins). */
export async function writeNetwork(client, { brandId, brandSlug, weekStart, runId, destination }, status) {
  const where = brandId ? `"id" = $1` : `"slug" = $1`;
  await client.query(
    `UPDATE "Brand" SET "settings" = jsonb_set("settings", ARRAY['planRuns', $2::text, 'networks', $3::text], $4::jsonb, true)
     WHERE ${where} AND "settings" #>> ARRAY['planRuns', $2::text, 'runId'] = $5`,
    [brandId || brandSlug, weekStart, destination, JSON.stringify(status), runId]);
}

/**
 * Status writer for one plan-week invocation. Writes are queued one after another on the given client and
 * never throw (status must not break planning). progress() is throttled; call flush() before ending the client.
 */
export function makeReporter(client, key, { now = () => Date.now() } = {}) {
  let chain = Promise.resolve();
  let current = { state: "running" };
  let lastProgress = 0;
  const write = () => {
    const status = { ...current, updatedAt: new Date(now()).toISOString() };
    chain = chain.then(() => writeNetwork(client, key, status)).catch((error) => console.error("[plan-runs] status write failed", error?.message));
    return chain;
  };
  return {
    step(step, extra = {}) { current = { state: "running", step, ...extra }; return write(); },
    progress(done, total) {
      current = { state: "running", step: "writing", done, total };
      if (done === total || now() - lastProgress >= PROGRESS_EVERY_MS) { lastProgress = now(); write(); }
    },
    done(summary) { current = { state: "done", ...summary }; return write(); },
    failed(error) { current = { state: "failed", error: String(error || "Planning failed").slice(0, 200) }; return write(); },
    flush() { return chain; }
  };
}

/** What Review shows: the record per week, with stale queued/running networks turned into "stalled". */
export function planStatusOf(settings, now = new Date()) {
  const out = {};
  for (const [week, run] of Object.entries(settings?.planRuns || {})) {
    const all = Object.values(run?.networks || {});
    const lastUpdate = Math.max(Date.parse(run?.startedAt || 0) || 0, ...all.map((n) => Date.parse(n?.updatedAt || 0) || 0));
    const dead = now.getTime() - lastUpdate > STALE_MS;
    const networks = {};
    for (const [d, n] of Object.entries(run?.networks || {})) {
      const open = n?.state === "queued" || n?.state === "running";
      networks[d] = open && dead ? { ...n, state: "stalled" } : n;
    }
    const states = Object.values(networks).map((n) => n.state);
    out[week] = { runId: run.runId, startedAt: run.startedAt, source: run.source || null, networks,
      running: states.some((s) => s === "queued" || s === "running"),
      finished: states.filter((s) => s === "done" || s === "failed" || s === "stalled").length, total: states.length };
  }
  return out;
}
