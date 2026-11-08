import type { PostWhy } from "@/lib/planner-review";

// "Why this post?" (2026-11-08): the planner's stored reasons for a pick (services/dev-api-lambda/post-why.mjs), shown on Review and
// Calendar. Collapsed by default; tags stay visible. Until results feed the planner every pick is "rules only", weights v1.
const TAG_LABEL: Record<string, string> = { "rules-only": "Rules only", exploring: "Exploring", boosted: "Results boost" };

export function WhyThisPost({ why, analyticsHref }: { why: PostWhy | null | undefined; analyticsHref?: string }) {
  if (!why) return null;
  return <details className="why-post">
    <summary>
      <span className="why-label">Why this post?</span>
      {why.tags.map((t) => <span key={t} className={`why-tag why-${t}`}>{TAG_LABEL[t] || t}</span>)}
    </summary>
    <p className="why-summary">{why.summary}</p>
    {why.parts.length > 0 && <dl className="why-parts">
      {why.parts.map((p) => <div key={p.key}><dt>{p.label}</dt><dd className={p.points < 0 ? "neg" : undefined}>{p.points > 0 ? "+" : ""}{p.points}</dd></div>)}
      {why.score !== null && <div className="why-total"><dt>Score</dt><dd>{why.score}</dd></div>}
    </dl>}
    <p className="muted why-foot">
      {why.sector ? `Pillar: ${why.sector.replace(/[-_]+/g, " ")}. ` : ""}
      {why.selectedBy === "curator" ? "Chosen by the AI curator from the planner's shortlist. " : ""}
      Planner weights {why.weightsVersion}. Approvals, date windows, cooldowns and format rules were checked first and are never changed by analytics.
      {analyticsHref && <> <a href={analyticsHref}>See the numbers</a></>}
    </p>
  </details>;
}
