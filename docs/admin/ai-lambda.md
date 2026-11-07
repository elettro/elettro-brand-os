# AI Lambda (Bedrock relay for the dev-api)

Added 2026-11-07. Code: `services/ai-lambda`. Setup: `scripts/ai-lambda-setup.sh` (root profile, ask Dean first).

## Why it exists

The dev-api (`elettro-brand-os-dev-api`) runs **inside the VPC** so it can reach Postgres. That VPC has no NAT gateway
and no `bedrock-runtime` endpoint (checked 2026-11-07: its endpoints are S3, ECS, Secrets Manager and Lambda only), so the
dev-api cannot call Bedrock. Dean chose (2026-11-07) a small Lambda **outside** the VPC over a Bedrock interface endpoint,
to save the endpoint's ~$15/month idle cost.

```
dev-api (in VPC) --lambda:InvokeFunction, via the VPC's Lambda endpoint--> elettro-brand-os-dev-ai (no VPC) --> Bedrock Converse
```

- One action, IAM-only (no HTTP route, no Function URL): `{action:"converse-v1", modelId, system, user, maxTokens?, temperature?}`
  returns `{ok:true, text, stopReason, usage}` or `{ok:false, error}` (it never throws).
- Models are allow-listed: default `us.anthropic.claude-haiku-5-5` and `global.anthropic.claude-haiku-5-5`; override with the
  Lambda env `AI_ALLOWED_MODEL_IDS` (comma list). The role's IAM policy is the real limit: Haiku 5.5 only.
- The dev-api side is `bedrockInvoke` in `services/dev-api-lambda/curator.mjs` (used by the curator, the copywriter and
  Calendar swaps). With env `AI_FUNCTION_NAME` set it calls this Lambda; without it it calls Bedrock directly (local runs).
- Any failure throws in the dev-api, and the planner already falls back to rules-only picks and template captions.

## Turning it on

| Setting (dev-api env) | Effect |
|---|---|
| `AI_FUNCTION_NAME=elettro-brand-os-dev-ai` | route model calls through the AI Lambda (harmless on its own) |
| `EPE_BEDROCK_CURATOR_MODEL_ID=us.anthropic.claude-haiku-5-5` | **turns AI on**: AI picks + AI captions on every Plan, planner tick and Calendar swap |

`scripts/ai-lambda-setup.sh` does steps 1-4 (role, Lambda, dev-api invoke permission + `AI_FUNCTION_NAME`, smoke test) and
leaves AI off; `--enable` adds step 5 (`EPE_BEDROCK_CURATOR_MODEL_ID`). The script merges env variables (a plain
`update-function-configuration --environment` would wipe the dev-api's other variables). Turn AI off again by removing
`EPE_BEDROCK_CURATOR_MODEL_ID` (same merge, or the console).

## Facts checked 2026-11-07 (read-only, `stashbox-audit`)

- Bedrock: `get-foundation-model-availability anthropic.claude-haiku-5-5` = `AUTHORIZED`, agreement/entitlement/region `AVAILABLE`.
  Inference profiles `us.anthropic.claude-haiku-5-5` and `global.anthropic.claude-haiku-5-5` are `ACTIVE`. The model is
  cross-region only: call it by a profile ID, not the bare `anthropic.claude-haiku-5-5`.
- No Elettro OS Lambda had `EPE_BEDROCK_CURATOR_MODEL_ID` or `EPE_BEDROCK_VISION_MODEL_ID` set, and no role had Bedrock permissions.
- `claude-audit-only` is denied `bedrock:InvokeModel` (expected; it is not the runtime).

## Unknown / ask Dean (not verified)

- The setup script has not been run yet. The IAM resource list (profile ARNs + `foundation-model` in every region + the
  region-less ARN for the global profile) follows AWS's documented pattern but has not been tested against a real call.
- Whether the `aws-marketplace` actions are needed now that the model is already `AUTHORIZED` (kept to be safe).
- Latency and cost of a full week's planning with AI on (one curator call per account-week, one copy call per post, concurrency 6).
- The web app's asset enrichment (`apps/web/lib/asset-ai-enrichment.ts`, `EPE_BEDROCK_VISION_MODEL_ID`) runs on Amplify, not in
  the VPC, so it does not need this relay; it needs `bedrock:InvokeModel` on the Amplify compute role
  `elettro-brand-os-dev-amplify-compute` plus the env var on branch `develop`. Not set up by this script.
