import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Same Google Cloud project and OAuth client as YouTube (elettro-os); the GBP API allowlist covers the whole project.
export const GBP_CALLBACK = DEV_ORIGIN + "/api/connections/gbp/callback";
// Must match the scope saved on Google Auth Platform → Data access.
export const GBP_SCOPES = ["https://www.googleapis.com/auth/business.manage"];
export const GBP_STATE_COOKIE = "elettro_dev_gbp_state";
// Brands that can link a Google Business Profile, with the title pattern that picks the right profile out of the ones the signed-in account manages.
// Stashbox + Elettro first (Dean 261020), WeightLossDavie, SolarMeister and Neckermann Strom added 261025 as connect only. The other managed profiles need their own content policy before they are added here.
export const GBP_LOCATION_TITLES: Record<string, RegExp> = {
  stashbox: /^stashbox$/i,
  elettro: /elettro/i,
  weightlossdavie: /^weight\s*loss\s*davie$/i,
  solarmeister: /solar\s*meister/i,
  "neckermann-strom": /neckermann/i
};
export const GBP_BRANDS = Object.keys(GBP_LOCATION_TITLES);
