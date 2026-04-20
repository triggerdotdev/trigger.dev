import type { PrismaClient, Session } from "@trigger.dev/database";
import type { SessionItem } from "@trigger.dev/core/v3";

/**
 * Prefix that {@link SessionId.generate} attaches to every Session friendlyId.
 * Used to distinguish friendlyId lookups (`session_abc...`) from externalId
 * lookups on the public `GET /api/v1/sessions/:session` route.
 */
const SESSION_FRIENDLY_ID_PREFIX = "session_";

/**
 * Resolve a session from a URL path parameter that may contain either a
 * friendlyId (`session_abc...`) or a user-supplied externalId.
 *
 * Disambiguated by prefix: values starting with `session_` are treated as
 * friendlyIds, anything else is looked up against `externalId` scoped to
 * the caller's environment.
 */
export async function resolveSessionByIdOrExternalId(
  prisma: Pick<PrismaClient, "session">,
  runtimeEnvironmentId: string,
  idOrExternalId: string
): Promise<Session | null> {
  if (idOrExternalId.startsWith(SESSION_FRIENDLY_ID_PREFIX)) {
    return prisma.session.findFirst({
      where: { friendlyId: idOrExternalId, runtimeEnvironmentId },
    });
  }

  return prisma.session.findUnique({
    where: {
      runtimeEnvironmentId_externalId: {
        runtimeEnvironmentId,
        externalId: idOrExternalId,
      },
    },
  });
}

/**
 * Convert a Prisma `Session` row to the public {@link SessionItem} wire format.
 * Strips internal columns (project/environment/organization ids) and narrows
 * the `metadata` JSON to a record.
 */
export function serializeSession(session: Session): SessionItem {
  return {
    id: session.friendlyId,
    externalId: session.externalId,
    type: session.type,
    taskIdentifier: session.taskIdentifier,
    tags: session.tags,
    metadata: (session.metadata ?? null) as SessionItem["metadata"],
    closedAt: session.closedAt,
    closedReason: session.closedReason,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
