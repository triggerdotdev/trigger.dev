import { boundedIn, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { getImpersonationState } from "~/services/impersonation.server";

/**
 * Whether this request may turn Agent Vault off: a platform admin, or one impersonating a
 * customer, which is how support reaches a customer's project. During impersonation the session
 * user is the customer, so this reads the impersonation state rather than the role.
 */
export async function canDisableProjectVault(
  request: Request,
  user: { id: string; admin: boolean }
) {
  if (!env.ADMIN_DASHBOARD_ENABLED) return false;
  if (user.admin) return true;
  return (await getImpersonationState(request, user.id)).isImpersonating;
}

/**
 * Call inside any transaction that puts a value into Agent Vault. Takes a shared lock on the
 * project row and checks Vault is still on, so it can't interleave with `disableProjectVault`:
 * either the disable sees this write's Vault value and refuses, or this write sees Vault off.
 * FOR KEY SHARE, so ordinary updates to the project row don't wait on it.
 *
 * Also refuses Development: the proxy never serves it, so a Vault value there would stop every
 * run in that environment from starting.
 */
export async function assertProjectVaultEnabled(
  db: PrismaClientOrTransaction,
  projectId: string,
  environmentIds: string[]
) {
  const [project] = await db.$queryRaw<Array<{ secretProxyEnabled: boolean }>>`
    SELECT "secretProxyEnabled" FROM "Project" WHERE id = ${projectId} FOR KEY SHARE`;
  if (!project?.secretProxyEnabled) {
    throw new Error("Agent Vault isn't enabled for this project.");
  }
  const development = await db.runtimeEnvironment.count({
    where: { projectId, id: { in: boundedIn(environmentIds) }, type: "DEVELOPMENT" },
  });
  if (development > 0) {
    throw new Error("Agent Vault isn't available in Development.");
  }
}

/** Whether any value in the project is in Agent Vault. */
export async function projectHasVaultValues(db: PrismaClientOrTransaction, projectId: string) {
  const value = await db.environmentVariableValue.findFirst({
    where: { isProxyOnly: true, variable: { projectId } },
    select: { id: true },
  });
  return value !== null;
}

/**
 * Turns Agent Vault off for a project that has no Vault values. Locks the project row first, so a
 * Vault write either committed before the count (and the disable refuses) or waits and then sees
 * Vault off (and refuses).
 */
export async function disableProjectVault(
  projectId: string,
  db: PrismaClientOrTransaction = prisma
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await $transaction(db, "disable project vault", async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
    if (await projectHasVaultValues(tx, projectId)) {
      return { success: false as const, error: "Delete this project's Agent Vault values first." };
    }
    await tx.project.update({ where: { id: projectId }, data: { secretProxyEnabled: false } });
    return { success: true as const };
  });
  return result ?? { success: false, error: "Something went wrong" };
}
