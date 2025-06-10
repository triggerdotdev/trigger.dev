import type { TaskTriggerSource } from "@trigger.dev/database";
import { PrismaClientOrTransaction, sqlDatabaseSchema } from "~/db.server";

/**
 *
 * @param prisma An efficient query to get all task identifiers for a project.
 * It has indexes for fast performance.
 * It does NOT care about versions, so includes all tasks ever created.
 */
export function getAllTaskIdentifiers(prisma: PrismaClientOrTransaction, environmentId: string) {
  return prisma.$queryRaw<
    {
      slug: string;
      triggerSource: TaskTriggerSource;
    }[]
  >`
    SELECT DISTINCT(slug), "triggerSource"
    FROM ${sqlDatabaseSchema}."BackgroundWorkerTask"
    WHERE "runtimeEnvironmentId" = ${environmentId}
    ORDER BY slug ASC;`;
}
