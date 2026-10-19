import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Clears the build env vars envelope of one page of deployments created before the cutoff. */
export function clearExpiredBuildEnvVarsPage(
  prisma: PrismaClientOrTransaction,
  cutoff: Date,
  batchSize: number
): Promise<number> {
  // Prisma cannot express FOR UPDATE SKIP LOCKED; concurrent sweeps take disjoint pages.
  return prisma.$executeRaw`
    WITH page AS (
      SELECT id FROM "WorkerDeployment"
      WHERE "buildEnvVars" IS NOT NULL AND "createdAt" < ${cutoff}
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "WorkerDeployment" d SET "buildEnvVars" = NULL
    FROM page WHERE d.id = page.id
  `;
}

/** Retention matches redeploy eligibility: both key on createdAt and the redeploy window. */
export async function sweepExpiredBuildEnvVars(
  prisma: PrismaClientOrTransaction,
  options: { windowDays: number; batchSize: number; now?: Date }
): Promise<{ cleared: number; pages: number }> {
  const { windowDays, batchSize, now = new Date() } = options;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid build env vars sweep batch size: ${batchSize}`);
  }

  const cutoff = new Date(now.getTime() - windowDays * DAY_MS);
  let cleared = 0;
  let pages = 0;

  while (true) {
    const count = await clearExpiredBuildEnvVarsPage(prisma, cutoff, batchSize);
    pages++;
    cleared += count;
    if (count < batchSize) break;
  }

  if (cleared > 0) {
    logger.info("Cleared expired deployment build env vars", { cleared, pages, cutoff });
  }

  return { cleared, pages };
}
