// Database wiring for Planner V2. IAM-only actions (see index.mjs):
//   configure-planner-brand  write Brand.settings.planner + SocialAccount/CadenceRule rows
//   plan-week                preview (default) or apply a Mon–Sun plan as ScheduledPost rows
//   approve-week             flip a week's planned posts to approved in one action
//   plan-month/approve-month the same for 4 consecutive weeks (Stashbox's approval unit)
import { planWeek, resolvePlannerSettings, songKeyOf, nextWeekStart, ymdInTimeZone, addDaysToYmd, localDateTimeToUtc, PLANNER_VERSION } from "./planner-v2.mjs";
import { curateWeek, bedrockInvoke } from "./curator.mjs";
import { buildSongFacts, fetchRadioCatalog } from "./song-facts.mjs";
import { writeWeekCopy } from "./copywriter.mjs";
import { PLANNABLE_DESTINATIONS } from "./publishing-formats.mjs";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

export async function withClient(connectDatabase, json, label, fn) {
  let client;
  try {
    client = await connectDatabase();
    return await fn(client);
  } catch (error) {
    console.error(`[${label}] failed`, error);
    return json(500, { ok: false, error: error instanceof Error ? error.message : `Unknown ${label} error` });
  } finally {
    if (client) { try { await client.end(); } catch {} }
  }
}

export async function loadBrand(client, brandSlug) {
  const result = await client.query(
    'SELECT "id","slug","timezone","settings" FROM "Brand" WHERE "slug" = $1 AND "status" = \'active\' LIMIT 1', [brandSlug]);
  return result.rows[0] || null;
}

export function weekWindow(brand, weekStartInput, weeks = 1) {
  const timeZone = brand.timezone || "America/New_York";
  const weekStart = YMD.test(String(weekStartInput || "")) ? weekStartInput : nextWeekStart(ymdInTimeZone(new Date(), timeZone));
  return {
    timeZone,
    weekStart,
    from: localDateTimeToUtc(weekStart, "00:00", timeZone),
    to: localDateTimeToUtc(addDaysToYmd(weekStart, 7 * weeks), "00:00", timeZone)
  };
}

const MAX_WEEKS = 4;
const weeksOf = (event) => Math.min(MAX_WEEKS, Math.max(1, Math.floor(Number(event.weeks) || 1)));

export async function configurePlannerBrand(event, connectDatabase, json) {
  const brandSlug = String(event.brandSlug || "").trim();
  const settings = event.settings;
  const accounts = Array.isArray(event.accounts) ? event.accounts : [];
  if (!brandSlug || !settings || typeof settings !== "object" || !Array.isArray(settings.sectors)) {
    return json(400, { ok: false, error: "brandSlug and settings (with sectors) are required" });
  }
  for (const a of accounts) {
    if (!a.destination || !a.accountName || !a.placement || !(Number(a.postsPerWeek) >= 0) ||
        (a.preferredStartTime && !HHMM.test(a.preferredStartTime)) || (a.preferredEndTime && !HHMM.test(a.preferredEndTime))) {
      return json(400, { ok: false, error: "Each account needs destination, accountName, placement, postsPerWeek and HH:MM times" });
    }
  }
  return withClient(connectDatabase, json, "configure-planner-brand", async (client) => {
    const brand = await loadBrand(client, brandSlug);
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE "Brand" SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{planner}', $2::jsonb, true),
                "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [brand.id, JSON.stringify(settings)]);
      const configured = [];
      for (const a of accounts) {
        const destination = String(a.destination).toLowerCase();
        const mode = a.publishingMode || "approval";
        let account = (await client.query(
          'SELECT "id" FROM "SocialAccount" WHERE "brandId" = $1 AND "destination" = $2 AND "accountName" = $3 LIMIT 1',
          [brand.id, destination, a.accountName])).rows[0];
        if (account) {
          await client.query(
            `UPDATE "SocialAccount" SET "publishingMode" = $2, "timezone" = $3, "status" = 'active', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
            [account.id, mode, brand.timezone || "America/New_York"]);
        } else {
          account = (await client.query(
            `INSERT INTO "SocialAccount" ("brandId","destination","accountName","publishingMode","timezone","status","updatedAt")
             VALUES ($1,$2,$3,$4,$5,'active',CURRENT_TIMESTAMP) RETURNING "id"`,
            [brand.id, destination, a.accountName, mode, brand.timezone || "America/New_York"])).rows[0];
        }
        const rule = (await client.query(
          'SELECT "id" FROM "CadenceRule" WHERE "socialAccountId" = $1 AND "placement" = $2 LIMIT 1', [account.id, a.placement])).rows[0];
        const values = [Number(a.postsPerWeek), Array.isArray(a.preferredDays) ? a.preferredDays : [], a.preferredStartTime || "12:00", a.preferredEndTime || null];
        if (rule) {
          await client.query(
            `UPDATE "CadenceRule" SET "postsPerWeek" = $2, "preferredDays" = $3, "preferredStartTime" = $4, "preferredEndTime" = $5,
                    "active" = TRUE, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [rule.id, ...values]);
        } else {
          await client.query(
            `INSERT INTO "CadenceRule" ("socialAccountId","placement","postsPerWeek","preferredDays","preferredStartTime","preferredEndTime","active","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,CURRENT_TIMESTAMP)`, [account.id, a.placement, ...values]);
        }
        configured.push({ socialAccountId: account.id, destination, accountName: a.accountName, placement: a.placement, postsPerWeek: values[0] });
      }
      // The seed is the whole cadence: rules it no longer lists (an old "shorts" placement, say) stop planning.
      if (accounts.length) {
        await client.query(
          `UPDATE "CadenceRule" cr SET "active" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
           FROM "SocialAccount" sa
           WHERE sa."id" = cr."socialAccountId" AND sa."brandId" = $1 AND cr."active" = TRUE
             AND NOT ((cr."socialAccountId"::text || ':' || cr."placement") = ANY($2::text[]))`,
          [brand.id, configured.map((c) => `${c.socialAccountId}:${c.placement}`)]);
      }
      await client.query("COMMIT");
      return json(200, { ok: true, brandSlug, settingsVersion: settings.version ?? null, accounts: configured });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

// Slots this close to now (or earlier) are left out: the week may already be under way.
const PAST_SLOT_LEAD_MS = 15 * 60000;

export async function runPlanWeek(event, connectDatabase, json, { modelId = process.env.EPE_BEDROCK_CURATOR_MODEL_ID, now = new Date() } = {}) {
  const brandSlug = String(event.brandSlug || "").trim();
  const apply = event.mode === "apply";
  if (!brandSlug) return json(400, { ok: false, error: "brandSlug is required" });
  // Optional scope (the Review page plans only instagram + facebook); other destinations' posts stay untouched.
  const destinations = Array.isArray(event.destinations) && event.destinations.length ? event.destinations.map((d) => String(d).toLowerCase()) : null;

  return withClient(connectDatabase, json, "plan-week", async (client) => {
    const brand = await loadBrand(client, brandSlug);
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const settings = resolvePlannerSettings(brand.settings);
    if (!settings.sectors.length) return json(409, { ok: false, error: "Brand has no planner settings; run configure-planner-brand first" });
    const { timeZone, weekStart, from, to } = weekWindow(brand, event.weekStart);
    // In a week that has started, only slots from here on are planned or replaced.
    const notBefore = new Date(Math.max(new Date(from).getTime(), new Date(now).getTime() + PAST_SLOT_LEAD_MS));

    const accounts = (await client.query(
      `SELECT sa."id" AS "socialAccountId", sa."destination", sa."accountName", sa."publishingMode", sa."timezone",
              cr."id" AS "cadenceRuleId", cr."placement", cr."postsPerWeek", cr."preferredDays", cr."preferredStartTime", cr."preferredEndTime"
       FROM "CadenceRule" cr JOIN "SocialAccount" sa ON sa."id" = cr."socialAccountId"
       WHERE sa."brandId" = $1 AND sa."status" = 'active' AND cr."active" = TRUE AND cr."postsPerWeek" > 0
         AND ($2::text[] IS NULL OR sa."destination" = ANY($2::text[]))
       ORDER BY sa."destination", cr."placement"`, [brand.id, destinations])).rows
      // A network with no plannable format yet (X, Google Business, Reddit) keeps its settings but gets no posts.
      .filter((a) => PLANNABLE_DESTINATIONS.includes(a.destination));
    if (!accounts.length) return json(409, { ok: false, error: "No active social accounts with cadence rules" });

    const assets = (await client.query(
      `SELECT "id","filename","kind","aspectRatioLabel","durationMs","tags","title","topic","contentGroup","creativeFamily",
              "creativeNotes","priority","eligibilityType","eligibleFrom","eligibleUntil","annualFromMmdd","annualUntilMmdd",
              "allowedDestinations","excludedDestinations","shopifyProductId","createdAt"
       FROM "Asset"
       WHERE "brandId" = $1 AND "approvalStatus" = 'approved' AND "ingestStatus" = 'ready' AND "retiredAt" IS NULL
         AND ("sourcePath" IS NOT NULL OR "sourceUrl" IS NOT NULL)`, [brand.id])).rows;

    // Everything that counts against cooldowns: published history plus posts already scheduled.
    // With replacePlanned, this week's still-unapproved posts are about to be replaced, so they don't count.
    const replacePlanned = apply && event.replacePlanned === true;
    const used = (await client.query(
      `SELECT pl."socialAccountId", pl."assetId", pl."publishedAt" AS "at", a."tags", a."contentGroup", a."shopifyProductId", a."filename"
       FROM "PublicationLedger" pl JOIN "Asset" a ON a."id" = pl."assetId"
       WHERE pl."brandId" = $1 AND pl."publishedAt" >= $2::timestamp - INTERVAL '90 days'
       UNION ALL
       SELECT sp."socialAccountId", sp."assetId", sp."scheduledFor" AS "at", a."tags", a."contentGroup", a."shopifyProductId", a."filename"
       FROM "ScheduledPost" sp JOIN "Asset" a ON a."id" = sp."assetId"
       WHERE sp."brandId" = $1 AND sp."status" IN ('planned','approved','queued','publishing','processing')
         AND sp."scheduledFor" >= $2::timestamp - INTERVAL '90 days' AND sp."scheduledFor" < $3::timestamp + INTERVAL '90 days'
         AND NOT ($4::boolean AND sp."status" = 'planned' AND sp."scheduledFor" >= $5 AND sp."scheduledFor" < $3)`,
      [brand.id, from, to, replacePlanned, notBefore])).rows;
    const uses = used.map((u) => ({ socialAccountId: u.socialAccountId, assetId: u.assetId, at: new Date(u.at).toISOString(),
      songKey: songKeyOf(u), contentGroup: u.contentGroup, shopifyProductId: u.shopifyProductId, filename: u.filename }));
    // In a multi-week preview, the earlier weeks' picks exist only in memory; they count like scheduled posts.
    if (Array.isArray(event.priorUses)) uses.push(...event.priorUses);

    // Song records (titles, radio pages, streaming links) gate the radio/streaming sectors and feed captions.
    let catalogStatus = { songs: 0 };
    let catalog = [];
    if (settings.sources?.radioSongsUrl) {
      try {
        catalog = await fetchRadioCatalog(settings.sources.radioSongsUrl);
        catalogStatus = { songs: catalog.length };
      } catch (error) {
        catalogStatus = { songs: 0, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const songFacts = buildSongFacts(assets.map(songKeyOf).filter(Boolean), catalog, {
      radioBaseUrl: settings.sources?.radioBaseUrl, overrides: settings.sources?.songOverrides || {}
    });

    // planWeek marks past slots against `now`; without it, it read the real clock instead of the caller's.
    // What already went out today, per account and format: a replan tops today up to its daily count.
    const todayStart = localDateTimeToUtc(ymdInTimeZone(now, timeZone), "00:00", timeZone);
    const doneToday = Object.fromEntries((await client.query(
      `SELECT "socialAccountId", "placement", COUNT(*)::int AS n FROM "PublicationLedger"
       WHERE "brandId" = $1 AND "publishedAt" >= $2 AND "publishedAt" <= $3 GROUP BY 1, 2`,
      [brand.id, todayStart, now])).rows.map((r) => [`${r.socialAccountId}:${r.placement}`, r.n]));
    const input = { assets, accounts, settings, weekStart, timeZone, uses, songFacts, now, doneToday };
    let plan = planWeek(input);
    let curator = { enabled: false, reason: !modelId ? "EPE_BEDROCK_CURATOR_MODEL_ID not set" : "disabled in settings or request" };
    if (modelId && settings.curator?.enabled !== false && event.curator !== false) {
      const recentByAccount = Object.fromEntries(accounts.map((a) => [a.socialAccountId, uses
        .filter((u) => u.socialAccountId === a.socialAccountId && new Date(u.at) < from)
        .sort((x, y) => y.at.localeCompare(x.at)).slice(0, 10)
        .map((u) => ({ at: u.at, filename: u.filename, song: u.songKey, contentGroup: u.contentGroup }))]));
      const curated = await curateWeek({ plan, brandSlug, accounts, recentByAccount, modelId });
      plan = planWeek({ ...input, preferences: curated.preferences });
      curator = { enabled: true, modelId, runs: curated.runs };
    }

    // Existing posts in the week (not being replaced) keep their slot.
    const existing = (await client.query(
      `SELECT "socialAccountId","placement","scheduledFor" FROM "ScheduledPost"
       WHERE "brandId" = $1 AND "scheduledFor" >= $2 AND "scheduledFor" < $3
         AND "status" IN ('planned','approved','queued','publishing','processing','published')
         AND NOT ($4::boolean AND "status" = 'planned' AND "scheduledFor" >= $5)`, [brand.id, from, to, replacePlanned, notBefore])).rows;
    const occupied = (slot) => existing.some((e) => e.socialAccountId === slot.socialAccountId &&
      Math.abs(new Date(e.scheduledFor).getTime() - new Date(slot.scheduledFor).getTime()) < 30 * 60000);
    for (const slot of plan.slots) {
      if (new Date(slot.scheduledFor) < notBefore) slot.status = "past";
      else if (occupied(slot)) slot.status = "exists";
    }
    // Kept posts (approved, queued, published...) count toward their day's posts-per-day, so a replan
    // after a cadence change never stacks new posts on top of approved ones.
    const dayKey = (socialAccountId, placement, ymd) => `${socialAccountId}:${String(placement).toLowerCase()}:${ymd}`;
    const tzOf = new Map(accounts.map((a) => [a.socialAccountId, a.timezone || timeZone]));
    const kept = new Map();
    for (const e of existing) {
      if (!tzOf.has(e.socialAccountId)) continue;
      const key = dayKey(e.socialAccountId, e.placement, ymdInTimeZone(new Date(e.scheduledFor), tzOf.get(e.socialAccountId)));
      kept.set(key, (kept.get(key) || 0) + 1);
    }
    const target = new Map();
    for (const slot of plan.slots) {
      const key = dayKey(slot.socialAccountId, slot.placement, slot.ymd);
      target.set(key, (target.get(key) || 0) + 1);
    }
    const room = new Map([...target].map(([key, n]) => [key, Math.max(0, n - (kept.get(key) || 0))]));
    for (const slot of plan.slots) {
      if (slot.status !== "planned") continue;
      const key = dayKey(slot.socialAccountId, slot.placement, slot.ymd);
      if (room.get(key) > 0) room.set(key, room.get(key) - 1);
      else slot.status = "covered";
    }

    // Captions for every slot that will be written.
    const copyModel = settings.copy?.enabled === false || event.copyAi === false ? null : modelId;
    const recentCaptions = (await client.query(
      `SELECT "socialAccountId", COALESCE("generatedCaption","generatedTitle") AS "text" FROM "ScheduledPost"
       WHERE "brandId" = $1 AND "scheduledFor" < $2 AND COALESCE("generatedCaption","generatedTitle") IS NOT NULL
       ORDER BY "scheduledFor" DESC LIMIT 200`, [brand.id, from])).rows;
    const recentCaptionsByAccount = {};
    for (const r of recentCaptions.reverse()) (recentCaptionsByAccount[r.socialAccountId] = recentCaptionsByAccount[r.socialAccountId] || []).push(r.text);
    const copies = await writeWeekCopy({
      slots: plan.slots.filter((s) => s.status === "planned"), assetsById: new Map(assets.map((a) => [a.id, a])),
      songFacts, links: settings.links || {}, brandSlug, modelId: copyModel, invoke: copyModel ? bedrockInvoke : null,
      recentCaptionsByAccount, concurrency: settings.copy?.concurrency || 6, promotionalMaxShare: { bluesky: 0.25, ...(settings.promotionalMaxShare || {}) }
    });
    const copyBySlot = new Map(copies.map((c) => [c.slotId, c.copy]));
    for (const slot of plan.slots) slot.copy = copyBySlot.get(slot.slotId) || null;

    const response = {
      ok: true, mode: apply ? "apply" : "preview", brand: brand.slug, weekStart, weekEnd: plan.weekEnd,
      plannerVersion: PLANNER_VERSION, eligibleAssets: assets.length, curator, radioCatalog: catalogStatus,
      copyWriter: { model: copyModel || null, ai: copies.filter((c) => c.copy.source === "ai").length,
        template: copies.filter((c) => c.copy.source === "template").length,
        blocked: copies.filter((c) => c.copy.status !== "ready").length },
      songsWithoutRadioPage: Object.values(songFacts).filter((f) => !f.inCatalog).map((f) => f.slug),
      summary: plan.summary, gaps: plan.gaps, sectorsWaitingForContent: plan.sectorsWaitingForContent,
      slots: plan.slots.map(({ candidates, ...s }) => ({ ...s, candidateIds: (candidates || []).map((c) => c.assetId) }))
    };
    if (!apply) return json(200, response);

    const runFor = (id) => (curator.runs || []).find((r) => r.socialAccountId === id) || null;
    await client.query("BEGIN");
    try {
      let removed = 0;
      if (replacePlanned) {
        removed = (await client.query(
          `DELETE FROM "ScheduledPost" WHERE "brandId" = $1 AND "status" = 'planned' AND "scheduledFor" >= $2 AND "scheduledFor" < $3
             AND "socialAccountId" = ANY($4::uuid[])`,
          [brand.id, notBefore, to, [...new Set(accounts.map((a) => a.socialAccountId))]])).rowCount;
      }
      let inserted = 0;
      // A week the owner already approved (Review → Approve week) takes new posts as approved, except
      // TikTok (TikTok wants the creator's choices on each post) and posts whose caption isn't ready.
      const weekApproved = Array.isArray(brand.settings?.approvedWeeks) && brand.settings.approvedWeeks.includes(weekStart);
      const destinationOf = new Map(accounts.map((a) => [a.socialAccountId, a.destination]));
      for (const slot of plan.slots.filter((s) => s.status === "planned")) {
        const run = runFor(slot.socialAccountId);
        const copy = slot.copy?.status === "ready" ? slot.copy : null;
        const status = weekApproved && copy && destinationOf.get(slot.socialAccountId) !== "tiktok" ? "approved" : "planned";
        await client.query(
          `INSERT INTO "ScheduledPost" ("brandId","socialAccountId","assetId","placement","scheduledFor","status",
             "selectionReason","scoreBreakdown","publishingMode","generatedTitle","generatedCaption","generatedHashtags","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$12,$6,$7::jsonb,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
          [brand.id, slot.socialAccountId, slot.assetId, slot.placement, slot.scheduledFor,
           slot.curatorReason ? `${slot.curatorReason} (${slot.reason})` : slot.reason,
           JSON.stringify({
             plannerVersion: PLANNER_VERSION, weekStart, sector: slot.sector, sectorFallbackFrom: slot.sectorFallbackFrom,
             exploration: slot.exploration, songKey: slot.songKey, syntheticDisclosure: slot.synthetic,
             selectedBy: slot.selectedBy, curatorOverridden: slot.curatorOverridden, score: slot.score, breakdown: slot.breakdown,
             candidateIds: (slot.candidates || []).map((c) => c.assetId),
             ...(slot.slideIds ? { slideIds: slot.slideIds } : {}),
             curator: run && !run.error ? { modelId: run.modelId, intelligenceVersion: run.intelligenceVersion, files: run.intelligenceFiles } : null,
             copy: slot.copy ? {
               source: slot.copy.source, status: slot.copy.status, angle: slot.copy.angle || null, primaryLink: slot.copy.primaryLink || null,
               description: slot.copy.description || null, onScreenText: slot.copy.onScreenText || null,
               intelligenceVersion: slot.copy.intelligenceVersion || null, missing: slot.copy.missing || [],
               aiRejected: slot.copy.aiRejected || null, aiError: slot.copy.aiError || null
             } : null
           }),
           slot.publishingMode || "approval",
           copy?.title || null, copy?.caption || copy?.description || null, copy?.hashtags || [], status]);
        inserted += 1;
      }
      await client.query("COMMIT");
      return json(200, { ...response, removedPlanned: removed, inserted });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Plan several consecutive weeks (the brand's approval unit, e.g. Stashbox reviews a month).
 * Weeks run in order; each one counts the earlier weeks' picks against cooldowns, from the
 * database in apply mode and from memory in preview mode.
 */
export async function runPlanWeeks(event, connectDatabase, json, options) {
  const weeks = weeksOf(event);
  const raw = (status, body) => ({ status, body });
  const firstWeek = YMD.test(String(event.weekStart || "")) ? event.weekStart : null;
  const results = [];
  const priorUses = [];
  let weekStart = firstWeek;
  for (let i = 0; i < weeks; i++) {
    const r = await runPlanWeek({ ...event, weekStart, priorUses: event.mode === "apply" ? undefined : priorUses }, connectDatabase, raw, options);
    if (r.status !== 200) return json(r.status, { ...r.body, failedWeek: i + 1, completedWeeks: results.map((w) => w.weekStart) });
    results.push(r.body);
    for (const s of r.body.slots.filter((x) => x.status === "planned")) {
      priorUses.push({ socialAccountId: s.socialAccountId, assetId: s.assetId, at: s.scheduledFor, songKey: s.songKey,
        contentGroup: s.contentGroup || null, shopifyProductId: null, filename: s.filename });
    }
    weekStart = addDaysToYmd(r.body.weekStart, 7);
  }
  return json(200, {
    ok: true, mode: results[0].mode, brand: results[0].brand, weeks, weekStart: results[0].weekStart, weekEnd: results.at(-1).weekEnd,
    planned: results.reduce((n, w) => n + w.slots.filter((s) => s.status === "planned").length, 0),
    gaps: results.reduce((n, w) => n + w.gaps.length, 0),
    inserted: results.reduce((n, w) => n + (w.inserted || 0), 0),
    perWeek: results
  });
}

export async function approvePlannerWeek(event, connectDatabase, json) {
  const brandSlug = String(event.brandSlug || "").trim();
  if (!brandSlug || !YMD.test(String(event.weekStart || ""))) {
    return json(400, { ok: false, error: "brandSlug and weekStart (YYYY-MM-DD) are required" });
  }
  return withClient(connectDatabase, json, "approve-week", async (client) => {
    const brand = await loadBrand(client, brandSlug);
    if (!brand) return json(404, { ok: false, error: "Active brand not found" });
    const weeks = weeksOf(event);
    const { weekStart, from, to } = weekWindow(brand, event.weekStart, weeks);
    const result = await client.query(
      `UPDATE "ScheduledPost" SET "status" = 'approved', "updatedAt" = CURRENT_TIMESTAMP
       WHERE "brandId" = $1 AND "status" = 'planned' AND "scheduledFor" >= $2 AND "scheduledFor" < $3
       RETURNING "id"`, [brand.id, from, to]);
    return json(200, { ok: true, brand: brand.slug, weekStart, weeks, approved: result.rowCount });
  });
}
