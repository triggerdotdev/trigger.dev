import type { RunStore } from "@internal/run-store";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";

/**
 * Resolve the BatchTaskRun id for `batchId` (accepting either the friendlyId or
 * the internal id) only if `userId` is a member of the batch's owning
 * organization. Returns null otherwise. Batch lookup goes through runStore so
 * batches resident in either run-store database are visible.
 */
export async function findBatchRunIdForUser(
  prisma: PrismaClientOrTransaction,
  store: RunStore,
  batchId: string,
  userId: string
): Promise<string | null> {
  const batchRunId = toBatchRunId(batchId);
  if (!batchRunId) return null;

  const batchRun = await store.findBatchTaskRunById(batchRunId);
  if (!batchRun) return null;

  return (await userCanAccessEnvironment(prisma, batchRun.runtimeEnvironmentId, userId))
    ? batchRun.id
    : null;
}

function toBatchRunId(batchId: string): string | null {
  try {
    return BatchId.toId(batchId);
  } catch {
    return null;
  }
}

async function userCanAccessEnvironment(
  prisma: PrismaClientOrTransaction,
  runtimeEnvironmentId: string,
  userId: string
): Promise<boolean> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: runtimeEnvironmentId,
      organization: { members: { some: { userId } } },
    },
    select: { id: true },
  });

  return !!environment;
}
