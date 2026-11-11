import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import type { PrismaClient } from "@trigger.dev/database";

export async function findTrustedPreviewBranch(
  prisma: PrismaClient,
  root: { id: string; projectId: string },
  branch: string
) {
  const branchName = sanitizeBranchName(branch);
  if (!branchName) return null;

  return prisma.runtimeEnvironment.findFirst({
    where: {
      parentEnvironmentId: root.id,
      projectId: root.projectId,
      type: "PREVIEW",
      branchName,
      archivedAt: null,
    },
    select: { id: true },
  });
}
