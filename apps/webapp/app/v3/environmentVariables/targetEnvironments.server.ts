import { boundedIn, type PrismaClientOrTransaction } from "@trigger.dev/database";

// The environments a submitted env var write targets, looked up from user-supplied ids.
// Archived environments (closed preview branches) are left out, so a submitted archived id is
// treated like an id that isn't in the project: findUnauthorizedEnvironmentId refuses it.
export function findTargetEnvironments(
  prisma: PrismaClientOrTransaction,
  projectId: string,
  environmentIds: string[]
) {
  return prisma.runtimeEnvironment.findMany({
    where: { projectId, id: { in: boundedIn(environmentIds) }, archivedAt: null },
    select: {
      id: true,
      type: true,
      branchName: true,
      orgMember: { select: { userId: true } },
    },
  });
}
