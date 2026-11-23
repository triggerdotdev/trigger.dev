import type { Prisma } from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "~/db.server";

/**
 * The git branches an environment's deployments were made from, for the deployments list's
 * Branch filter. Reads the git metadata of every deployment in the environment, so it runs when
 * the filter opens (from the replica), not with the list.
 */
export async function listDeploymentBranches(
  prisma: PrismaClientOrTransaction,
  /** The database schema the tables are in (`sqlDatabaseSchema`). */
  schema: Prisma.Sql,
  environmentId: string
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ branch: string }[]>`
    SELECT DISTINCT wd."git"->>'commitRef' AS branch
    FROM ${schema}."WorkerDeployment" AS wd
    WHERE wd."environmentId" = ${environmentId} AND wd."git"->>'commitRef' IS NOT NULL
    ORDER BY branch LIMIT 200`;
  return rows.map((row) => row.branch);
}
