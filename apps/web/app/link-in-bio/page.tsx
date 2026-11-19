import { session } from "@/lib/cognito-auth";
import { redirect } from "next/navigation";
import { brandConfigs } from "@/lib/brand-config";
import BioEditor from "./bio-editor";

export default async function LinkInBioPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  const who = await session();
  if (!who) redirect("/welcome");
  const brands = brandConfigs.filter(b => who.owner || who.brands.includes(b.id)).map(b => ({ id: b.id, name: b.name }));
  const requested = (await searchParams).brand;
  const first = brands.find(b => b.id === requested)?.id ?? brands[0]?.id;
  if (!first) return <main className="main"><h1>Link In Bio</h1><p>No accessible brands.</p></main>;
  return <BioEditor allowedBrands={brands} initialBrand={first} />;
}
