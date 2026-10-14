# Step 9 — Connect ChatGPT to Elettro securely via Cognito OAuth (DEV only)

**State: Code prepared on `develop`; not authenticated, configured, or accepted live.**
The owner confirmed successful live read-only MCP connections from Claude Code and Claude.ai with access to all six brands. The ChatGPT custom MCP form supports OAuth, not a static Authorization request header. **Do not create the ChatGPT plugin before the steps below pass.**

## Existing infrastructure to protect

- Server: `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`.
- Existing Amazon Cognito login domain: `https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com`.
- Existing owner dashboard OAuth app client: `34u0cdg0b3tl2mv6qti19e09oq` — **DO NOT modify or reuse as the ChatGPT client.**
- Existing SecureString: `/amplify/d2k28tehm1a8zw/develop-branch-b11b55647b/ELETTRO_AI_MCP_CLIENTS_JSON`. Its **two Claude clients must remain identical**.
- Existing AWS Amplify SSR compute role: `elettro-brand-os-dev-amplify-compute`. Existing inline policy `ElettroDevMcpCredentialsRead` already permits `ssm:GetParameter` on exactly that parameter.
- Production app, media assets, PostgreSQL schema, stock libraries, Dropbox tokens and Lambda remain untouched.

## OAuth architecture

ChatGPT → separate Cognito **public app client** → Authorization Code + PKCE S256 → OAuth access token bound to Elettro DEV MCP resource → Next.js MCP endpoint validates Cognito `RS256` signature via issuer JWKS, fixed issuer, fixed app-client ID, `access` token_use, exact `aud` (resource), expiration and `elettro-mcp/read` scope → Cognito UserInfo checks verified owner email and matching `sub` → six-brand **read-only** tool manifest.

The existing opaque Claude bearer tokens continue through their existing SSM hash / brand grant logic. JWTs are never accepted as Claude tokens; OAuth is disabled until the separate `chatgptOauth` configuration is explicitly enabled in SSM.

- Protected-resource discovery URL: `https://develop.d2k28tehm1a8zw.amplifyapp.com/.well-known/oauth-protected-resource`.
- Resource URL / JWT audience: `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`.
- Custom Cognito OAuth scope: **`elettro-mcp/read`**.
- Other requested OAuth scopes: **`openid`**, **`email`** (needed for owner identity confirmation through UserInfo).
- Exactly six read-only tools; no writes, uploads, new registrations, folder creation, publishing or stock operations.
- No ChatGPT password, static tokens, Cognito client secret, or owner session cookies are shared in ChatGPT.

## Step A — Inspect the EXISTING Cognito user pool (safest first click)

AWS Console → Region **us-east-1** → **Amazon Cognito → User pools**.

Find the **existing user pool** whose app client powers `https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com` and whose current dashboard OAuth client ID is `34u0cdg0b3tl2mv6qti19e09oq`. Do not create a new user pool. Verify the user-pool ID, domain, and existing owner user.

Record its `us-east-1_...` user-pool ID. This ID is not a password, but don't reveal private user data, sessions, tokens, or the user's subject ID in screenshots.

**Stop and confirm the pool before adding any AWS resources.**

## Step B — Add one narrow resource scope (no legacy client edits)

Within the verified Cognito user pool:

1. Find **Resource servers** (under Domain/Branding depending on AWS console version).
2. Create a NEW resource server:
   - **Name:** `Elettro MCP DEV`
   - **Identifier:** `elettro-mcp`
   - **Scope name:** `read`
   - **Scope description:** `Read existing Elettro brand assets and Dropbox folder metadata`
3. Verify the custom scope appears as **`elettro-mcp/read`**.
4. Do not define write or admin scopes.

## Step C — Create a dedicated PUBLIC OAuth app client for ChatGPT

In the SAME Cognito user pool, **App clients → Create app client**:

1. **Application name:** `elettro-chatgpt-dev-readonly`.
2. **Application type:** Public client / Single-page application (no client secret; UI may call it SPA).
3. **OAuth flow:** Authorization code grant **with PKCE S256**, not implicit or client credentials.
4. **Callback URL:** Copy the exact **Callback URL** shown in ChatGPT's **Add custom MCP server → Advanced OAuth settings → User-Defined OAuth Client**. Paste it unchanged into the Cognito callback URLs. The example shown in screenshots is truncated and must NOT be copied from documentation.
5. **Allowed OAuth scopes:** `openid`, `email`, and `elettro-mcp/read`.
6. Only enable Cognito identity providers that should sign in the existing owner. Do not enable self-sign-up/open registration on account of this integration.
7. Save; record the new (public) **App client ID**. Do **NOT** modify the existing dashboard client ID `34u0cdg0b3tl2mv6qti19e09oq`.

## Step D — Enable the OAuth client in the existing encrypted SSM config

Use the **existing local hash-only JSON** on the owner's Windows PC. Do not regenerate Claude tokens, delete the SSM parameter, or paste raw tokens into a conversation.

A safe local helper is at `scripts/step9-chatgpt-oauth-config.ps1` in `develop`. It accepts the verified Cognito user-pool ID and **new public app client ID** and appends only:

```json
"chatgptOauth": {
  "enabled": true,
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_YOUR_EXISTING_POOL_ID",
  "clientId": "THE_NEW_PUBLIC_CHATGPT_APP_CLIENT_ID"
}
```

It verifies the two existing six-brand read-only Claude credential entries and makes a local backup before writing. The actual Claude bearer tokens and their hashes remain unchanged. Command template (after replacing placeholders locally):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\step9-chatgpt-oauth-config.ps1" -UserPoolId "us-east-1_YOUR_POOL_ID" -PublicClientId "NEW_PUBLIC_APP_CLIENT_ID"
```

Then use the previously downloaded `step9-readonly-clients.ps1 -Action CopyAwsJson` command to copy **hash-only** settings and carefully **edit** (not create) the existing `ELETTRO_AI_MCP_CLIENTS_JSON` SecureString Value in AWS SSM. Never show its contents in screenshots. Do not alter existing IAM permissions.

## Step E — Validate discovery before using ChatGPT

Verify GitHub CI success and Amplify `develop` deployment of the OAuth compatibility layer. Only after SSM is updated:

1. `GET https://develop.d2k28tehm1a8zw.amplifyapp.com/.well-known/oauth-protected-resource` should respond HTTP 200 and include the fixed MCP `resource`, the configured Cognito issuer in `authorization_servers`, and `elettro-mcp/read` in `scopes_supported`.
2. Requests to `POST /api/mcp` without credentials must still return HTTP **401**, with `WWW-Authenticate` indicating the protected-resource metadata. Do not disable authentication.
3. The same six-brand smoke tests should still pass for both separate Claude credentials.
4. The ChatGPT OAuth token path is not certified until ChatGPT actually signs in and successfully calls a read-only MCP tool. JWT verification must reject wrong issuer/client/audience/scope, expired token, unsigned token, unverified email, nonowner user.

## Step F — Complete the ChatGPT advanced OAuth form

Return to ChatGPT → Plugins → Add custom MCP server:

- **Name:** `Elettro Publishing Engine`.
- **Description:** `Secure, read-only access to Elettro's six-brand asset registry.`
- **Server URL:** `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`.
- **Authentication:** OAuth.
- **Registration method:** **User-Defined OAuth Client**.
- **OAuth Client ID:** **NEW** public Cognito app client ID from Step C.
- **OAuth Client secret:** leave blank.
- **Token endpoint auth method:** `none`.
- **Default scopes:** one per line `openid`, `email`, `elettro-mcp/read`.
- **Base scopes:** leave blank initially.
- **Auth URL:** `https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com/oauth2/authorize`.
- **Token URL:** `https://us-east-1ydbehb7ps.auth.us-east-1.amazoncognito.com/oauth2/token`.
- **Registration URL:** leave blank (user-defined client, no dynamic client registration).
- **Authorization server base:** `https://cognito-idp.us-east-1.amazonaws.com/<VERIFIED_USER_POOL_ID>`.
- **Resource:** `https://develop.d2k28tehm1a8zw.amplifyapp.com/api/mcp`.
- **OIDC enabled:** leave unchecked initially; our server uses UserInfo for server-side owner authorization regardless of this UI toggle.

Acknowledge ChatGPT's custom-server safety prompt only after the above validations. When ChatGPT requests sign-in, authenticate as the existing authorized Cognito owner; do not provide any credentials in chat messages. Then confirm six **read-only** tools are available and perform the familiar `SE53F9~1.MP4` asset identity check.

## October 14 ChatGPT plugin-creation compatibility fix (deployed and verified)

The ChatGPT **Add custom MCP server** UI initially rejected the form with: “Some app settings were rejected. Check the server URL or tunnel ID, icon, and authentication settings, then try again.”

Authenticated Claude Code and Claude.ai remained working; the newly configured Cognito resource server `elettro-mcp` and the dedicated ChatGPT public app client remained intact. External public-only diagnostics (GitHub Actions, no credentials) found:
- **Before fix:** `GET /api/mcp` returned HTTP 405 without an OAuth challenge; path-aware `GET /.well-known/oauth-protected-resource/api/mcp` returned HTTP 404.
- **After fix:** unauthenticated `GET /api/mcp` returns **401** with an explicit `WWW-Authenticate` protected-resource challenge; `GET /.well-known/oauth-protected-resource/api/mcp` returns **200** with the same JSON as the root well-known route. Proper authenticated GET still returns spec-permitted HTTP 405 because SSE is unsupported. POST still requires authentication; OAuth JWT and Claude opaque-token paths are unchanged.
- GitHub **CI passed** at `8638f25ad08`. External live probe passed from GitHub Actions run **38596950896**, including 401 challenge and 200 path-aware metadata. The backend compatibility repairs are committed on `develop`.
- Do **not** claim ChatGPT plugin connected until the UI creates the plugin and the first Cognito-authorized read-only tool call succeeds.

If recreating the ChatGPT form, verify the **new form's callback URL** matches the URL already allowlisted on the dedicated Cognito app client. Do not create another Cognito app client or disable authentication just to make validation pass.

## October 14 — Confirmed remaining ChatGPT OAuth provider incompatibility (BLOCKER)

The owner retried the ChatGPT **Create as a plugin** screen after the path-aware resource metadata / 401 challenge fix and after correctly configuring `elettro-mcp/read`, `openid`, and `email`; the plugin UI continued to reject settings with its generic message.

An **external credential-free GitHub Actions diagnostic** (run `38600808470`, UTC 2026-10-14 16:45) fetched the **live existing AWS Cognito user pool** OIDC document at `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_YDBehB7ps/.well-known/openid-configuration` and confirmed:
- `code_challenge_methods_supported`: **MISSING** (does not advertise `S256`).
- `token_endpoint_auth_methods_supported`: **[\"client_secret_basic\", \"client_secret_post\"]** (does not advertise `none` for the previously configured public SPA client).
- `grant_types_supported`: MISSING.
- `authorization_response_iss_parameter_supported`: MISSING.
- `authorization_endpoint`, `token_endpoint`, and `userinfo_endpoint`: present and publicly reachable.
- DEV MCP `GET /api/mcp` properly returns 401 OAuth challenge; both protected-resource metadata paths return 200; those repairs **did not resolve registration**.

**Root incompatibility:** OpenAI MCP authorization spec expressly requires the advertised S256 PKCE support, and its client registration must select supported token endpoint authentication. Cognito supports the PKCE flow but its OIDC discovery currently omits the required declaration. This is independently discussed in AWS re:Post articles, including `https://repost.aws/questions/QUYn3BAUkrRaqNQs7mcsTRYw/amazon-cognito-missing-pkce-s256-in-oidc-discovery-metadata-breaks-mcp-oauth-integration`. The exact error reason from ChatGPT is not exposed to the UI, so document this as a **confirmed protocol blocker**, not a complete enumeration of all possible issues.

**DO NOT** keep retrying the same UI fields, create another Cognito app client, turn off MCP authentication, insert static credentials into public client metadata, or pretend another issuer produced Cognito-issued JWTs. A proper solution requires an OAuth authorization server/provider that truthfully advertises compliant PKCE S256/public-client token endpoint methods (e.g. dedicated compliant provider or a correctly implemented AWS-hosted authorization broker with its own issuer and token signing), while retaining the current six-brand read-only MCP protection. Prefer security review and explicit owner approval before making new auth-provider or infrastructure changes. The earlier Step F instructions are blocked by this finding until the authorization-server compatibility is resolved.

## Troubleshooting / risk notes

- **503 from discovery:** OAuth `chatgptOauth` config is not provisioned or AWS SSM/IAM is unavailable; do not make the endpoint unauthenticated.
- **OAuth login redirects but token requests fail:** verify the exact callback URL and that the Cognito app client has authorization-code flow, PKCE and the correct allowed scopes.
- **OAuth works but tools fail 401:** verify access-token `aud` matches the resource URI; Cognito supports an explicit OAuth `resource` parameter that sets the access token's `aud`.
- **403 owner mismatch:** verify the authorized existing owner user signed in and the UserInfo `email_verified` flag is true. Do not relax the owner check.
- **Claude no longer works:** restore the pre-ChatGPT SSM hash-only JSON backup; do not rotate Claude tokens or alter the previous duplicate-protection migration.
- Cognito and ChatGPT must both support the OAuth `resource` and PKCE parameters end-to-end; real runtime acceptance is essential.
- The ChatGPT custom connector may have account-specific UI behavior; inspect actual errors rather than guessing.
- Do not enable metadata writing, file registration, or publishing via this integration until separate acceptance gates.

Official reference docs:
- OpenAI OAuth MCP: https://developers.openai.com/plugins/build/auth
- AWS Cognito Resource Scopes / Resource Binding: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html
