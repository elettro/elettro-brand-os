import { redirect } from "next/navigation";
import { session } from "@/lib/cognito-auth";
import { canAccessBrand, visibleBrands } from "@/lib/brand-access";
import { brandConfigs } from "@/lib/brand-config";
import { REVIEW_BRANDS, type ReviewList, reviewCall } from "@/lib/planner-review";
import { ReviewClient } from "./review-client";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const who = await session();
  if (!who) redirect("/api/auth/login");
  const { brand: requested } = await searchParams;
  const reviewable = REVIEW_BRANDS.filter((id) => canAccessBrand(who, id));
  // A user with none of the reviewable brands (e.g. only Neckermann Strom today) has nothing to review.
  const brand = reviewable.includes(requested || "") ? requested! : reviewable[0] ?? "";
  let list: ReviewList | null = null;
  let error: string | null = null;
  if (!brand) {
    error = "None of your brands are on the Review page yet";
  } else {
    try {
      const { data } = await reviewCall<ReviewList>({ brand, action: "list", weeks: 9 });
      if (data.ok) list = data; else error = data.error || "The planner did not answer";
    } catch {
      error = "Elettro OS could not reach the planner";
    }
  }
  const brands = visibleBrands(who, brandConfigs.filter((b) => REVIEW_BRANDS.includes(b.id))).map((b) => ({ id: b.id, name: b.name }));
  return <main className="main">
    <div className="eyebrow">Publishing · Review</div>
    <h1>Review</h1>
    <p className="muted">This week and the next two months of posts on every network. Click a week&apos;s strip to open or close it. Approve week once and every post in it goes out at its time, including posts added to that week later; skip, fix a caption or swap a clip only where you want to. TikTok posts are approved together in each week&apos;s TikTok box, where you choose TikTok&apos;s settings once, as TikTok requires. Nothing posts until it is approved.</p>
    <nav className="review-brands" aria-label="Brand">
      {brands.map((b) => <a key={b.id} href={`/review?brand=${b.id}`} className={b.id === brand ? "active" : undefined}>{b.name}</a>)}
    </nav>
    {error && <p className="card" style={{ marginTop: 16 }}>Could not load the plan: {error}</p>}
    {list && <ReviewClient initial={list} />}
  </main>;
}
