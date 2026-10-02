import type { PrismaTransactionClient } from "@trigger.dev/database";
import { generateRootApiKey } from "~/utils/apiKeys";

export async function deleteOrgMember(
  tx: PrismaTransactionClient,
  member: { id: string; organizationId: string }
) {
  // Prevent new development environments from being provisioned during removal.
  await tx.$queryRaw`
    SELECT "id" FROM "OrgMember"
    WHERE "id" = ${member.id} AND "organizationId" = ${member.organizationId}
    FOR UPDATE
  `;

  const environments = await tx.runtimeEnvironment.findMany({
    where: {
      organizationId: member.organizationId,
      orgMemberId: member.id,
      type: "DEVELOPMENT",
    },
    select: { id: true },
  });
  for (const environment of environments) {
    await tx.runtimeEnvironment.update({
      where: { id: environment.id },
      data: {
        apiKey: generateRootApiKey("DEVELOPMENT").apiKey,
        apiKeys: {
          updateMany: { where: { revokedAt: null }, data: { revokedAt: new Date() } },
        },
      },
    });
  }
  return tx.orgMember.delete({ where: { id: member.id, organizationId: member.organizationId } });
}
