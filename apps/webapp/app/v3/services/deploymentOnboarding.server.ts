import type { PrismaClient } from "~/db.server";

/** Selects the current first GitHub build, independently of pagination or client state. */
export async function findOnboardingDeployment(prisma: PrismaClient, environmentId: string) {
  const established = await prisma.workerDeployment.findFirst({
    where: {
      environmentId,
      OR: [
        { status: "DEPLOYED" },
        { triggeredVia: null },
        { triggeredVia: { not: "git_integration:github" } },
      ],
    },
    select: { id: true },
  });
  if (established) return { eligible: false as const };

  const deployment = await prisma.workerDeployment.findFirst({
    where: { environmentId, triggeredVia: "git_integration:github" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { shortCode: true, status: true },
  });
  if (deployment?.status === "DEPLOYED") return { eligible: false as const };
  return { eligible: true as const, shortCode: deployment?.shortCode };
}
