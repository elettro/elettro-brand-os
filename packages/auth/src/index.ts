export type BrandRole =
  | "owner"
  | "admin"
  | "editor"
  | "approver"
  | "viewer";

export type BrandAction =
  | "view"
  | "manage_assets"
  | "approve_assets"
  | "manage_calendar"
  | "publish"
  | "manage_connections"
  | "manage_members";

const grants: Record<BrandRole, BrandAction[]> = {
  owner: [
    "view",
    "manage_assets",
    "approve_assets",
    "manage_calendar",
    "publish",
    "manage_connections",
    "manage_members"
  ],
  admin: [
    "view",
    "manage_assets",
    "approve_assets",
    "manage_calendar",
    "publish",
    "manage_connections"
  ],
  editor: ["view", "manage_assets", "manage_calendar"],
  approver: ["view", "approve_assets"],
  viewer: ["view"]
};

export function can(role: BrandRole, action: BrandAction) {
  return grants[role].includes(action);
}
