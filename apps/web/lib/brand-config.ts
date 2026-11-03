export const brandConfigs = [
  { id: "solarmeister", name: "SolarMeister", timezone: "Europe/Berlin", dropboxRoot: "/1---elettro-brand-os/brands/solarmeister" },
  { id: "stashbox", name: "Stashbox", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/stashbox" },
  { id: "weightlossdavie", name: "WeightLossDavie", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/weightlossdavie" },
  { id: "neckermann-strom", name: "Neckermann Strom", timezone: "Europe/Berlin", dropboxRoot: "/1---elettro-brand-os/brands/neckermann-strom" },
  { id: "therasbox", name: "Therasbox", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/therasbox" },
  { id: "elettro", name: "Elettro", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/elettro" },
  { id: "pianomusicsoothing", name: "Piano Music Soothing", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/pianomusicsoothing" },
  { id: "deanpalermo", name: "Dean Palermo", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/deanpalermo" },
  { id: "rompe", name: "Rompe", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/rompe" },
  { id: "reggaeland", name: "Reggae.Land", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/reggaeland" },
  { id: "google-review", name: "Google Review", timezone: "America/New_York", dropboxRoot: "/1---elettro-brand-os/brands/google-review" }
] as const;

/**
 * The shared creative-assets library (stock graphics, audio). It is not a brand: it stays out of `brandConfigs`
 * (brand switchers, planner, Review) but the AI/MCP gateway treats it as a peer of the brand folders, so
 * search, read, tag, upload and folder tools reach it exactly as they reach a brand.
 */
export const SHARED_LIBRARY_ID = "creative-assets";
export const sharedLibraryConfig = {
  id: SHARED_LIBRARY_ID, name: "Creative Assets (shared)", timezone: "America/New_York",
  dropboxRoot: "/1---elettro-brand-os/creative-assets"
};
export const gatewayBrandConfigs = [...brandConfigs, sharedLibraryConfig];
