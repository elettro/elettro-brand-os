import { redirect } from "next/navigation";
import { authenticated } from "@/lib/cognito-auth";
import { brandConfigs } from "@/lib/brand-config";
import { REVIEW_BRANDS, type ReviewList, reviewCall } from "@/lib/planner-review";
import { ReviewClient } from "./review-client";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await authenticated())) redirect("/api/auth/login");
  const { brand: requested } = await searchParams;
  const brand = REVIEW_BRANDS.includes(requested || "") ? requested! : "stashbox";
  let list: ReviewList | null = null;
  let error: string | null = null;
  try {
    const { data } = await reviewCall<ReviewList>({ brand, action: "list", weeks: 4 });
    if (data.ok) list = data; else error = data.error || "The planner did not answer";
  } catch {
    error = "Elettro OS could not reach the planner";
  }
  const brands = brandConfigs.filter((b) => REVIEW_BRANDS.includes(b.id)).map((b) => ({ id: b.id, name: b.name }));
  return <main className="main">
    <div className="eyebrow">Publishing · Review</div>
    <h1>Review</h1>
    <p className="muted">The next four weeks of Facebook and Instagram posts. Approve what should go out, skip what shouldn&apos;t, fix captions or swap a clip. Nothing posts until it is approved, and only the next seven days are ever handed to the publisher.</p>
    <nav className="review-brands" aria-label="Brand">
      {brands.map((b) => <a key={b.id} href={`/review?brand=${b.id}`} className={b.id === brand ? "active" : undefined}>{b.name}</a>)}
    </nav>
    {error && <p className="card" style={{ marginTop: 16 }}>Could not load the plan: {error}</p>}
    {list && <ReviewClient initial={list} />}
  </main>;
}
