import type { PrismaClientOrTransaction } from "~/db.server";

/** Task slugs the current deploy has that the target deploy doesn't, sorted. */
export function tasksMissingFromTarget(currentSlugs: string[], targetSlugs: string[]): string[] {
  const target = new Set(targetSlugs);
  return [...new Set(currentSlugs)].filter((slug) => !target.has(slug)).sort();
}

/**
 * The deployment a rollback points at, for a member of the project's organization. Anyone else
 * gets null, the same rule the rollback action applies.
 */
export async function findRollbackTarget(
  prisma: PrismaClientOrTransaction,
  {
    projectId,
    deploymentShortCode,
    userId,
  }: { projectId: string; deploymentShortCode: string; userId: string }
) {
  return prisma.workerDeployment.findFirst({
    where: {
      projectId,
      shortCode: deploymentShortCode,
      project: { organization: { members: { some: { userId } } } },
    },
    select: { environmentId: true, workerId: true, version: true },
  });
}

/**
 * The tasks a rollback to `target` would drop: the environment's current deploy has them and
 * the target doesn't. Both lookups use BackgroundWorkerTask @@unique([workerId, slug]).
 */
export async function findTasksMissingFromTarget(
  prisma: PrismaClientOrTransaction,
  target: { environmentId: string; workerId: string | null }
): Promise<string[]> {
  if (!target.workerId) return [];

  const current = await prisma.workerDeploymentPromotion.findFirst({
    where: { environmentId: target.environmentId, label: "current" },
    select: { deployment: { select: { workerId: true } } },
  });
  const currentWorkerId = current?.deployment.workerId;
  if (!currentWorkerId || currentWorkerId === target.workerId) return [];

  const [currentTasks, targetTasks] = await Promise.all([
    prisma.backgroundWorkerTask.findMany({
      where: { workerId: currentWorkerId },
      select: { slug: true },
    }),
    prisma.backgroundWorkerTask.findMany({
      where: { workerId: target.workerId },
      select: { slug: true },
    }),
  ]);

  return tasksMissingFromTarget(
    currentTasks.map((t) => t.slug),
    targetTasks.map((t) => t.slug)
  );
}
