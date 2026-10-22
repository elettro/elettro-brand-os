import { DEV_ORIGIN } from "@/lib/cognito-auth";

// Google Cloud project elettro-os → Google Auth Platform → Clients. The client ID is public; its secret lives only in Secrets Manager for the Lambda.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "681265129321-sdkurubsl6a0jcvmscpsvpk4ngnp07fr.apps.googleusercontent.com";
export const YOUTUBE_CALLBACK = DEV_ORIGIN + "/api/connections/youtube/callback";
// Must match the scopes saved on the Google Auth Platform → Data access page (and the verification request).
// Only the two scopes Elettro OS uses today (upload + channel lookup). Add yt-analytics.readonly when the Analytics screen ships.
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];
export const YOUTUBE_STATE_COOKIE = "elettro_dev_yt_state";
// Brands that can connect a YouTube channel (slugs from brand-config / the Brand table).
export const YOUTUBE_BRANDS = ["stashbox", "elettro", "solarmeister", "therasbox", "weightlossdavie"];
