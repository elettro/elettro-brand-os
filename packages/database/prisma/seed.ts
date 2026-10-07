import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: "elettro" },
    update: {},
    create: { name: "Elettro", slug: "elettro" }
  });

  const brands = [
    ["SolarMeister", "solarmeister", "Europe/Berlin"],
    ["Stashbox", "stashbox", "America/New_York"],
    ["WeightLossDavie", "weightlossdavie", "America/New_York"],
    ["Neckermann Strom", "neckermann-strom", "Europe/Berlin"],
    ["Therasbox", "therasbox", "America/New_York"],
    ["Elettro", "elettro", "America/New_York"]
  ] as const;

  for (const [name, slug, timezone] of brands) {
    await prisma.brand.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug } },
      update: { name, timezone },
      create: { organizationId: org.id, name, slug, timezone }
    });
  }
}

main()
  .finally(async () => prisma.$disconnect());
