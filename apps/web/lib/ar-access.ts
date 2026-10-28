// Pure helpers for the AR console (no Next.js imports so the plain Node tests can load them):
// who sees the AR section, and how the AR API's brand document becomes cards on the Experiences page.

export type ArAccess = { owner: boolean; brands: string[] };

export type ArTrigger = { id: string; name: string; status?: string; imageKey?: string; quality?: number; target?: { luminanceKey?: string } };
export type ArAction = { id: string; name: string; type: string; label?: string };
export type ArRule = { triggerId: string; actionIds?: string[]; order?: number };
export type ArSet = { id: string; name: string; slug: string; triggerIds?: string[] };
export type ArQr = { id: string; name: string; slug: string; mode: string; isMain?: boolean; url?: string; setId?: string; actionId?: string };
export type ArDoc = {
  entitlement?: { arEnabled?: boolean };
  triggers?: ArTrigger[];
  actions?: ArAction[];
  rules?: ArRule[];
  sets?: ArSet[];
  qrs?: ArQr[];
};

export type ExperienceCard = {
  id: string;
  name: string;
  live: boolean;
  thumbUrl: string | null;
  summary: string;
  hasActions: boolean;
  qualityBars: number;
  sets: string[];
};

// Owner: every brand (so AR can be switched on). A client: only their own brands that already have AR on.
export function arBrandsFor(access: ArAccess | null, allBrandIds: readonly string[], enabled: Record<string, boolean>): string[] {
  if (!access) return [];
  if (access.owner) return [...allBrandIds];
  return allBrandIds.filter((id) => access.brands.includes(id) && enabled[id] === true);
}

// Only the owner switches AR on or off for a brand; clients never see the toggle.
export const canToggleAr = (access: ArAccess | null): boolean => !!access?.owner;

// The brand a page shows: the ?brand= value when this user may see it, else Stashbox when allowed, else their first brand.
export function pickBrand(requested: string | undefined, visible: readonly string[], fallback = "stashbox"): string {
  if (requested && visible.includes(requested)) return requested;
  return visible.includes(fallback) ? fallback : visible[0] ?? "";
}

// 0-4 filled bars for the tracking-quality meter (quality is 0-100 from the image-target check).
export function qualityBars(quality: number | undefined): number {
  if (typeof quality !== "number" || !(quality > 0)) return 0;
  return quality >= 75 ? 4 : quality >= 50 ? 3 : quality >= 25 ? 2 : 1;
}

export function publicUrl(base: string, key: string | undefined): string | null {
  return key ? `${base.replace(/\/+$/, "")}/${key}` : null;
}

const actionLabel = (a: ArAction): string => (a.type === "video" ? "Video" : a.label?.trim() || a.name);

// One card per registered cover: what scanning it does, in the order the rules list the actions.
export function experienceCards(doc: ArDoc, publicBase: string): ExperienceCard[] {
  const actions = new Map((doc.actions || []).map((a) => [a.id, a]));
  const rules = doc.rules || [];
  return (doc.triggers || []).map((t) => {
    const ids = rules.filter((r) => r.triggerId === t.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).flatMap((r) => r.actionIds || []);
    const labels = ids.map((id) => actions.get(id)).filter((a): a is ArAction => !!a).map(actionLabel);
    return {
      id: t.id,
      name: t.name,
      live: t.status === "live",
      thumbUrl: publicUrl(publicBase, t.imageKey || t.target?.luminanceKey),
      summary: labels.length ? labels.join(" + ") : "No action attached",
      hasActions: labels.length > 0,
      qualityBars: qualityBars(t.quality),
      sets: (doc.sets || []).filter((s) => (s.triggerIds || []).includes(t.id)).map((s) => s.name)
    };
  });
}

export const QR_MODE_LABEL: Record<string, string> = { scanner: "Scanner", experience: "One experience", url: "Web link" };

// The brand's main printed code: the one marked main, else the one with slug "main".
export function mainQr(doc: ArDoc): ArQr | null {
  const qrs = doc.qrs || [];
  return qrs.find((q) => q.isMain) || qrs.find((q) => q.slug === "main") || null;
}
