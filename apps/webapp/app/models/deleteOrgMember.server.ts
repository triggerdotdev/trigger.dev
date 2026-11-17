import type { PrismaClientOrTransaction, PrismaTransactionClient } from "@trigger.dev/database";
import type { AuditLogActor } from "@trigger.dev/plugins";
import {
  type MemberRemovalCredentials,
  saveRootApiKeyFingerprint,
} from "~/services/credentialFingerprints.server";
import { generateRootApiKey } from "~/utils/apiKeys";

/** New root keys for a member's development environments, by environment id. */
export type MemberRemovalKeys = ReadonlyMap<string, string>;

/**
 * Call before the removal transaction. Makes a new root key for each of the member's development
 * environments and saves its fingerprint. Throws when a save fails, so the removal fails before
 * anything changes. Pass the keys to `deleteOrgMember`, also when the transaction is retried.
 *
 * Callers check the removal is allowed first. A removal that still fails afterwards, e.g. a
 * concurrent removal of the same member, leaves fingerprints for keys that were never issued.
 * They never authenticate, so no event is attributed to them.
 */
export async function prepareMemberRemovalKeys(
  prismaClient: PrismaClientOrTransaction,
  member: { id: string; organizationId: string },
  createdBy: AuditLogActor | null
): Promise<MemberRemovalKeys> {
  const environments = await prismaClient.runtimeEnvironment.findMany({
    where: {
      organizationId: member.organizationId,
      orgMemberId: member.id,
      type: "DEVELOPMENT",
    },
    select: { id: true, projectId: true },
  });
  const keys = new Map(
    environments.map((environment) => [environment.id, generateRootApiKey("DEVELOPMENT").apiKey])
  );
  await Promise.all(
    environments.map((environment) =>
      saveRootApiKeyFingerprint(
        keys.get(environment.id)!,
        { ...environment, organizationId: member.organizationId },
        createdBy
      )
    )
  );
  return keys;
}

/**
 * Returns the deleted member and the credentials the removal rotated and revoked. Uses the keys
 * from `prepareMemberRemovalKeys`; an environment created since then gets a new key here, whose
 * fingerprint is saved after commit. Pass the credentials to `recordMemberRemovalCredentials`
 * after the transaction commits.
 */
export async function deleteOrgMember(
  tx: PrismaTransactionClient,
  member: { id: string; organizationId: string },
  newKeys: MemberRemovalKeys
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
    select: {
      id: true,
      projectId: true,
      apiKey: true,
      apiKeys: {
        where: { revokedAt: null },
        select: { id: true, name: true, lastFour: true, keyHash: true },
      },
    },
  });
  const credentials: MemberRemovalCredentials = {
    organizationId: member.organizationId,
    rotatedRootApiKeys: [],
    revokedApiKeys: [],
  };
  for (const environment of environments) {
    const preparedKey = newKeys.get(environment.id);
    const apiKey = preparedKey ?? generateRootApiKey("DEVELOPMENT").apiKey;
    await tx.runtimeEnvironment.update({
      where: { id: environment.id },
      data: {
        apiKey,
        apiKeys: {
          updateMany: { where: { revokedAt: null }, data: { revokedAt: new Date() } },
        },
      },
    });
    credentials.rotatedRootApiKeys.push({
      environmentId: environment.id,
      projectId: environment.projectId,
      previousApiKey: environment.apiKey,
      apiKey,
      fingerprintSaved: preparedKey !== undefined,
    });
    credentials.revokedApiKeys.push(
      ...environment.apiKeys.map((key) => ({
        ...key,
        environmentId: environment.id,
        projectId: environment.projectId,
      }))
    );
  }
  const deleted = await tx.orgMember.delete({
    where: { id: member.id, organizationId: member.organizationId },
  });
  return { member: deleted, credentials };
}
