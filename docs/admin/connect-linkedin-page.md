# Connect a LinkedIn company page to a brand

Built 2026-10-29. One page per brand (`LINKEDIN_PAGE_BRANDS` in `apps/web/lib/linkedin-connect.ts`: elettro, stashbox, solarmeister,
neckermann-strom, reggaeland). The Dean Palermo brand is a personal profile and uses the older member flow. **Status: code merged
does not mean live; nothing below was run against the real LinkedIn app until the first connect.**

## How it works

- Connections card: "Connect company page" -> `/api/connections/linkedin/start?brand=<id>&kind=page` -> LinkedIn login with the
  "Elettro OS" app (client `77ookctxp1cedr`, Community Management API, scopes `r_organization_social`, `w_organization_social`,
  `rw_organization_admin`) -> `/api/connections/linkedin/callback`.
- The web app trades the code, lists the pages the login administers (`organizationAcls`), and connects the page. With several pages
  it shows a picker (`/api/connections/linkedin/pick`, tokens wait in a signed httpOnly cookie for 10 minutes).
- `POST /connections/linkedin/complete` (dev-api) stores the tokens in `elettro-brand-os-dev/linkedin/org-<pageId>` and links the
  brand's LinkedIn `SocialAccount` to `urn:li:organization:<pageId>`. A page **replaces** a personal profile that was linked to the
  brand. The reconnect date is when the refresh token dies (about a year).
- The linkedin worker posts with `author: urn:li:organization:<id>`; when the access token is within 7 days of expiring it renews it
  from the refresh token, stores the new pair and moves the reconnect date (`set-token-expiry`).

## AWS steps after merge (Dean pastes IAM; Claude cannot)

1. **Secret** `elettro-brand-os-dev/linkedin-pages-oauth` (us-east-1), JSON `{"clientId":"77ookctxp1cedr","clientSecret":"<from the LinkedIn app's Auth tab>"}`.
2. **Amplify compute role** `elettro-brand-os-dev-amplify-compute`: allow `secretsmanager:GetSecretValue` on `...:secret:elettro-brand-os-dev/linkedin-pages-oauth-*` (the web callback reads it).
3. **linkedin worker role**: allow `GetSecretValue` on the same secret, and `PutSecretValue` on `elettro-brand-os-dev/linkedin/*` (renewal writes the new token).
4. Upload the dev-api zip ([deploy-dev-api-lambda.md](deploy-dev-api-lambda.md)) and the **Build LinkedIn Lambda** artifact to `elettro-brand-os-dev-linkedin`.
5. LinkedIn Developers -> Elettro OS app -> Auth: the redirect `https://os.elettro.com/api/connections/linkedin/callback` is set (done 2026-10-29).

## First connect

Connections -> the brand's LinkedIn card -> Connect company page -> approve. The card shows the page name and a reconnect date about a year out.
Then use the card's test post (it prefers the page token over an older profile login) before enabling LinkedIn posts/day on Review.

## Unknown / not verified

- Whether the Development tier caps how many pages or calls the app can use; Standard tier may be needed for other brands' pages.
- The `organizationAcls` / `organizations` response shapes and the refresh-token fields were written from LinkedIn's documentation, not
  from a live response. If the first connect fails at "page lookup" or "renew", record it in `docs/bug-fix/` and fix the parser.
- Whether LinkedIn returns a refresh token for this app in practice (the worker then falls back to reconnecting every 60 days).
