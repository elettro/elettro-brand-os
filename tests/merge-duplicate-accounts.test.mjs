import test from "node:test";
import assert from "node:assert/strict";
import { mergeDuplicateAccounts } from "../services/dev-api-lambda/connection-disconnect.mjs";

const json = (status, body) => ({ status, body });
const old = { id: "A", brand: "stashbox", destination: "tiktok", accountName: "@stashboxmusic", externalAccountId: "id-old", tokenExpiresAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", rules: [], unsent: 3 };
const fresh = { id: "B", brand: "stashbox", destination: "tiktok", accountName: "@StashboxMusic", externalAccountId: "id-new", tokenExpiresAt: "2027-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", rules: [], unsent: 0 };
const other = { id: "C", brand: "stashbox", destination: "threads", accountName: "@stashboxmusic", externalAccountId: "t1", tokenExpiresAt: null, updatedAt: "2026-10-30T00:00:00Z", rules: [], unsent: 0 };

function fakeClient(log) {
  return { async query(sql, params) {
    log.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" "), params });
    if (sql.includes("FROM \"SocialAccount\" sa JOIN \"Brand\"")) return { rows: [old, fresh, other] };
    if (sql.includes('SELECT "placement" FROM "CadenceRule"')) return { rows: [] };
    if (sql.includes('SELECT "id","placement" FROM "CadenceRule"')) return { rows: [{ id: "r1", placement: "video" }] };
    return { rows: [], rowCount: 3 };
  }, async end() {} };
}

test("refuses an HTTP invocation", async () => {
  const r = await mergeDuplicateAccounts({ requestContext: {} }, async () => fakeClient([]), json);
  assert.equal(r.status, 403);
});

test("dry run lists the duplicate (same handle, any case) with the newest token as keeper, and writes nothing", async () => {
  const log = [];
  const r = await mergeDuplicateAccounts({}, async () => fakeClient(log), json);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "dry-run");
  assert.equal(r.body.plan.length, 1, "threads row is a different network, not a duplicate");
  assert.deepEqual([r.body.plan[0].keeper, r.body.plan[0].merge], ["B", ["A"]]);
  assert.ok(!log.some((q) => /^(UPDATE|BEGIN|COMMIT)/.test(q.sql)));
});

test("apply moves the old row's rule and unsent posts to the keeper and unlinks the old row", async () => {
  const log = [];
  const r = await mergeDuplicateAccounts({ mode: "apply" }, async () => fakeClient(log), json);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.merged, [{ keeper: "B", unlinked: "A", rulesMoved: ["video"], rulesSwitchedOff: [], postsMoved: 3 }]);
  const sqls = log.map((q) => q.sql);
  assert.ok(sqls.includes("BEGIN") && sqls.includes("COMMIT"));
  assert.ok(log.some((q) => q.sql.startsWith("UPDATE") && q.params?.[0] === "A" && q.params?.length === 1), "old row unlinked");
});
