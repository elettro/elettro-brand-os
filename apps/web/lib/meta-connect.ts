import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Meta for Developers → app "Elettro OS" (1186765853901766, Business type, verified Dean Palermo portfolio).
// The app ID is public; the app secret lives only in Secrets Manager (elettro-brand-os-dev/meta-oauth).
export const META_APP_ID = process.env.META_APP_ID || "1186765853901766";
export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
export const META_CALLBACK = DEV_ORIGIN + "/api/connections/meta/callback";
// Facebook Login (Instagram API with Facebook login + Pages API): publish and read insights.
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "read_insights",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights"
];
export const META_STATE_COOKIE = "elettro_dev_meta_state";
// Brands that can connect a Facebook Page (and the Instagram account linked to it).
export const META_BRANDS = ["stashbox", "elettro", "therasbox", "solarmeister", "weightlossdavie", "pianomusicsoothing"];
// Pinned Page per brand when Dean manages several look-alikes; others must grant exactly one Page.
// Stashbox = the "Stashbox" Page linked to @stashboxmusic, not "Stashbox.com".
// Dean's login now grants several Pages (Reggae.Land too), so every brand is pinned.
export const META_PAGES: Record<string, string> = {
  stashbox: "380791482028270",
  therasbox: "697827850080589",
  solarmeister: "1199724163224021",
  weightlossdavie: "123095134218070",
  elettro: "222151710680",
  pianomusicsoothing: "131849983336174"
};

export type MetaPage = { id: string; name: string; access_token?: string; instagram_business_account?: { id: string; username?: string } };

export function pickPage(pages: MetaPage[], brand: string): MetaPage {
  const pinned = META_PAGES[brand];
  if (pinned) {
    const page = pages.find((p) => p.id === pinned);
    if (!page) throw Error(`Facebook did not share the ${brand} Page; reconnect and tick it when Facebook asks`);
    return page;
  }
  if (pages.length !== 1) throw Error(`Facebook shared ${pages.length} Pages; reconnect and tick only the ${brand} Page`);
  return pages[0];
}
