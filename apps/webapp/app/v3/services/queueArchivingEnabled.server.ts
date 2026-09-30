import { type Prisma } from "@trigger.dev/database";
import { fromPromise } from "neverthrow";
import { $replica, type PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

type OrgFlags = { featureFlags: Prisma.JsonValue } | null;

/** Per-org gate for archiving queues. Off unless the org override or the global flag turns it on. */
export async function queueArchivingEnabled(
  organizationId: string,
  {
    client = $replica,
    orgFeatureFlags,
  }: {
    client?: PrismaClientOrTransaction;
    /** The org's feature flags, when the caller already loaded them, to skip the org read. */
    orgFeatureFlags?: Prisma.JsonValue;
  } = {}
): Promise<boolean> {
  const organization: Promise<OrgFlags> =
    orgFeatureFlags !== undefined
      ? Promise.resolve({ featureFlags: orgFeatureFlags })
      : client.organization.findFirst({
          where: { id: organizationId },
          select: { featureFlags: true },
        });

  const result = await fromPromise(
    organization.then((organization) => {
      if (!organization) return false;
      const flags = organization.featureFlags;
      return makeFlag(client)({
        key: FEATURE_FLAG.queueArchivingEnabled,
        defaultValue: false,
        overrides: flags && typeof flags === "object" && !Array.isArray(flags) ? flags : undefined,
      });
    }),
    (error) => error
  );

  if (result.isErr()) {
    logger.warn("Queue archiving flag unavailable; treating as disabled", {
      organizationId,
      error: result.error,
    });
    return false;
  }

  return result.value;
}
