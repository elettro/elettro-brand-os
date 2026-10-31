import test from "node:test";
import assert from "node:assert/strict";
import { createBrand } from "../services/dev-api-lambda/brand-create.mjs";

const json = (status, body) => ({ status, body });
function db({ existing = null, org = { id: "o1" } } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" "), params });
      if (sql.includes('FROM "Organization"')) return { rows: org ? [org] : [] };
      if (sql.includes('FROM "Brand"')) return { rows: existing ? [existing] : [] };
      if (sql.includes('INSERT INTO "Brand"')) return { rows: [{ id: "b1", name: params[1], slug: params[2], timezone: params[3], status: "active" }] };
      return { rows: [] };
    },
    async end() {}
  };
  return { log, connect: async () => client };
}

test("refuses an HTTP invocation and bad input", async () => {
  const d = db();
  assert.equal((await createBrand({ requestContext: {} }, d.connect, json)).status, 403);
  assert.equal((await createBrand({ slug: "Rompe!", name: "Rompe" }, d.connect, json)).status, 400);
  assert.equal((await createBrand({ slug: "rompe", name: "" }, d.connect, json)).status, 400);
  assert.equal((await createBrand({ slug: "rompe", name: "Rompe", timezone: "Mars/Base" }, d.connect, json)).status, 400);
});

test("dry run reports what it would create and writes nothing", async () => {
  const d = db();
  const r = await createBrand({ slug: "rompe", name: "Rompe" }, d.connect, json);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.would, { slug: "rompe", name: "Rompe", timezone: "America/New_York" });
  assert.ok(!d.log.some((q) => q.sql.startsWith("INSERT")));
});

test("apply inserts the brand; an existing slug is left alone", async () => {
  const d = db();
  const r = await createBrand({ slug: "rompe", name: "Rompe", timezone: "Europe/Madrid", mode: "apply" }, d.connect, json);
  assert.equal(r.body.created, true);
  assert.equal(r.body.brand.timezone, "Europe/Madrid");
  const again = db({ existing: { id: "b1", slug: "rompe" } });
  const r2 = await createBrand({ slug: "rompe", name: "Rompe", mode: "apply" }, again.connect, json);
  assert.equal(r2.body.created, false);
  assert.ok(!again.log.some((q) => q.sql.startsWith("INSERT")));
});
