import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Pinterest Developers → app "Elettro OS" (1627333), owned by business account pinterest.com/elettro.
// The app ID is public; the secret lives only in Secrets Manager (elettro-brand-os-dev/pinterest-oauth).
export const PINTEREST_APP_ID = process.env.PINTEREST_APP_ID || "1627333";
export const PINTEREST_CALLBACK = DEV_ORIGIN + "/api/connections/pinterest/callback";
// Publish Pins to the account's own boards and read its own Pins, boards and analytics.
export const PINTEREST_SCOPES = ["user_accounts:read", "boards:read", "boards:write", "pins:read", "pins:write"];
export const PINTEREST_STATE_COOKIE = "elettro_dev_pinterest_state";
// One Pinterest account for now (Dean, 261020): pinterest.com/elettro under the Elettro brand.
// While the app has Trial access, Pins it creates are visible only to that account.
export const PINTEREST_BRANDS = ["elettro"];
export const PINTEREST_OAUTH_SECRET = "elettro-brand-os-dev/pinterest-oauth";
