#!/usr/bin/env node
/**
 * One-time setup for the Elettro OS Bluesky OAuth app. Bluesky has no review step: the app is the public
 * client-metadata document the web app serves (/api/connections/bluesky/client-metadata) and this signing key.
 *
 *   node scripts/bluesky-oauth-setup.mjs --dry-run     generate a key and show only the public half
 *   node scripts/bluesky-oauth-setup.mjs               generate a key and store it as the secret below
 *
 * The private key is never printed. It is written straight to Secrets Manager as {"privateJwk": "<jwk>"}.
 * Re-running with an existing secret refuses to overwrite it (rotating the key signs everyone out of Bluesky).
 * Needs the `aws` CLI; pass --profile <name> (Dean's deploy profile is stashbox-audit).
 */
import { execFileSync } from "node:child_process";
import { JoseKey } from "@atproto/jwk-jose";

const SECRET = "elettro-brand-os-dev/bluesky-oauth";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : null;
const aws = (...a) => execFileSync("aws", [...a, "--region", "us-east-1", ...(profile ? ["--profile", profile] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const kid = "elettro-os-" + new Date().toISOString().slice(0, 10);
const key = await JoseKey.generate(["ES256"], kid);
const privateJwk = JSON.stringify(key.privateJwk);
console.log("Generated ES256 key", kid, "- public half:", JSON.stringify(key.publicJwk));
if (dryRun) { console.log("Dry run: nothing stored."); process.exit(0); }

let exists = true;
try { aws("secretsmanager", "describe-secret", "--secret-id", SECRET); } catch (e) {
  if (/ResourceNotFoundException/.test(String(e.stderr || e.message))) exists = false; else throw e;
}
if (exists) { console.error(`${SECRET} already exists; not overwriting it.`); process.exit(1); }
aws("secretsmanager", "create-secret", "--name", SECRET, "--description", "Elettro OS Bluesky OAuth signing key (ES256 private JWK)", "--secret-string", JSON.stringify({ privateJwk }));
console.log("Stored", SECRET);
