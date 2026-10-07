import { brandConfigs } from "./brand-config";

export const sprintOneBrands = brandConfigs.map(({ id, name, timezone }) => ({
  id,
  name,
  timezone
}));
