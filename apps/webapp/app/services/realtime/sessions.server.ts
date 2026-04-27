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
  if (isSessionFriendlyIdForm(idOrExternalId)) {
    return prisma.session.findFirst({
      where: { friendlyId: idOrExternalId, runtimeEnvironmentId },
    });
  }

  // `findFirst` rather than `findUnique` per the repo rule — `findUnique`'s
  // implicit DataLoader has open correctness bugs in Prisma 6.x that bite
  // hot-path lookups exactly like this one.
  return prisma.session.findFirst({
    where: { runtimeEnvironmentId, externalId: idOrExternalId },
  });
}

/** True for `session_*` friendlyId form, false for everything else. */
export function isSessionFriendlyIdForm(value: string): boolean {
  return value.startsWith(SESSION_FRIENDLY_ID_PREFIX);
}

/**
 * Canonicalise the addressing key used for everything stream-level: the
 * S2 stream path and the run-engine waitpoint cache key. `chat.agent`
 * and the rest of the operational surface always pass `externalId`, but
 * a public-API caller may legitimately address by `friendlyId` — and a
 * session created without an `externalId` only has a friendlyId at all.
 *
 * Rule:
 *   - If we have a Session row, the canonical key is `externalId` if
 *     set, else `friendlyId`. This way two callers addressing the same
 *     row via different forms always converge to the same S2 stream.
 *   - If we have no row (yet — chat.agent's transport may subscribe
 *     before the agent's bind-time upsert lands), the canonical key is
 *     whatever the URL had. Operationally that's always an externalId.
 *     Friendlyid-form callers without a matching row are rejected by
 *     the route handler before this is reached.
 */
export function canonicalSessionAddressingKey(
  row: Session | null,
  paramSession: string
): string {
  if (row) {
    return row.externalId ?? row.friendlyId;
  }
  return paramSession;
}

/**
 * Convert a Prisma `Session` row to the public {@link SessionItem} wire format.
 * Strips internal columns (project/environment/organization ids) and narrows
 * the `metadata` JSON to a record.
 *
 * Note: `currentRunId` is left as-is — Prisma stores the internal run id
 * (cuid), but `SessionItem.currentRunId` is the *friendly* form. Routes
 * that emit `SessionItem` are responsible for resolving the friendlyId
 * (typically via a separate TaskRun lookup) and overriding the field.
 * `serializeSession` returns it raw so list endpoints don't pay an N+1
 * lookup just to surface the friendly form.
 */
export function serializeSession(session: Session): SessionItem {
  return {
    id: session.friendlyId,
    externalId: session.externalId,
    type: session.type,
    taskIdentifier: session.taskIdentifier,
    triggerConfig: session.triggerConfig as SessionItem["triggerConfig"],
    currentRunId: session.currentRunId,
    tags: session.tags,
    metadata: (session.metadata ?? null) as SessionItem["metadata"],
    closedAt: session.closedAt,
    closedReason: session.closedReason,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
