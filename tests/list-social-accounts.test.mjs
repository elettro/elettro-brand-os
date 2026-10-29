import test from "node:test";
import assert from "node:assert/strict";
import { listSocialAccounts } from "../services/dev-api-lambda/connection-status.mjs";

const json = (statusCode, body) => ({ statusCode, body });

test("list-social-accounts rejects an unknown destination without touching the database", async () => {
  const noDatabase = async () => { throw new Error("database should not be reached"); };
  assert.equal((await listSocialAccounts({ destination: "myspace" }, noDatabase, json)).statusCode, 400);
});

test("list-social-accounts only reads and returns the linked rows", async () => {
  const queries = [];
  const rows = [{ brand: "weightlossdavie", destination: "threads", accountName: "@weightlossdavie", externalAccountId: "29003220952697496", status: "active", tokenExpiresAt: null }];
  const client = { async query(sql, params) { queries.push([sql, params]); return { rows: sql.trimStart().startsWith("SELECT") && sql.includes("JOIN") ? rows : [] }; }, async end() {} };
  const r = await listSocialAccounts({ destination: "Threads" }, async () => client, json);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.accounts, rows);
  const select = queries.find(([sql]) => sql.includes('JOIN "Brand"'));
  assert.deepEqual(select[1], ["threads"]);
  assert.ok(queries.every(([sql]) => !/^\s*(UPDATE|DELETE|INSERT)/i.test(sql) || /ALTER|CREATE/i.test(sql) === false));
});
