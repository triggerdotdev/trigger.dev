import type { PrismaClient, Session } from "@trigger.dev/database";
import type { SessionItem } from "@trigger.dev/core/v3";
import { $replica, prisma } from "~/db.server";

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

/**
 * Replica-first session resolution with a writer fallback on miss. For the
 * hot realtime routes (append / SSE subscribe / end-and-continue): a fresh
 * session's first append or subscribe can arrive inside the replica's apply
 * window, and a bare replica miss there surfaces as a 404 (or a subscribe
 * that never finds its session) for a session that exists on the writer.
 */
export async function resolveSessionWithWriterFallback(
  runtimeEnvironmentId: string,
  idOrExternalId: string
): Promise<Session | null> {
  const row = await resolveSessionByIdOrExternalId($replica, runtimeEnvironmentId, idOrExternalId);
  if (row) return row;
  return resolveSessionByIdOrExternalId(prisma, runtimeEnvironmentId, idOrExternalId);
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
 * that emit `SessionItem`s must translate: single-row endpoints via
 * {@link serializeSessionWithFriendlyRunId}, list endpoints via the
 * batched {@link serializeSessionsWithFriendlyRunIds}. Never put this
 * raw form on the wire directly.
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

/**
 * Same as {@link serializeSession} but resolves `currentRunId` from the
 * internal cuid to the public `run_*` friendlyId via a TaskRun lookup.
 * Single-row endpoints (`POST/GET/PATCH/close /api/v1/sessions/:s`) use
 * this so the wire-side `currentRunId` is consistent with the rest of
 * the public API (which only accepts friendlyIds for run lookups).
 *
 * Skips the lookup when `currentRunId` is null. The read goes through
 * `$replica` — a TaskRun's `friendlyId` is immutable so replica lag is
 * harmless, and serializing on the writer would just add hot-path load.
 */
export async function serializeSessionWithFriendlyRunId(
  session: Session
): Promise<SessionItem> {
  const base = serializeSession(session);
  if (!session.currentRunId) return base;

  const run = await $replica.taskRun.findFirst({
    where: { id: session.currentRunId },
    select: { friendlyId: true },
  });

  return {
    ...base,
    currentRunId: run?.friendlyId ?? null,
  };
}

/**
 * Batched form of {@link serializeSessionWithFriendlyRunId} for list
 * endpoints: one `IN` lookup per page instead of N+1. `currentRunId` on
 * the wire is always the public `run_*` friendlyId — the raw
 * {@link serializeSession} form leaks the internal cuid, which customers
 * can't use with `runs.retrieve(...)`.
 */
export async function serializeSessionsWithFriendlyRunIds(
  sessions: Session[],
  scope: { projectId: string; runtimeEnvironmentId: string }
): Promise<SessionItem[]> {
  const runIds = [...new Set(sessions.map((s) => s.currentRunId).filter((id): id is string => !!id))];

  // `currentRunId` is a plain string pointer (no FK), so scope the lookup to
  // the caller's tenant — a stale value must not resolve a run in another env.
  const runs = runIds.length
    ? await $replica.taskRun.findMany({
        where: {
          id: { in: runIds },
          projectId: scope.projectId,
          runtimeEnvironmentId: scope.runtimeEnvironmentId,
        },
        select: { id: true, friendlyId: true },
      })
    : [];
  const friendlyIdByRunId = new Map(runs.map((run) => [run.id, run.friendlyId]));

  return sessions.map((session) => ({
    ...serializeSession(session),
    currentRunId: session.currentRunId
      ? friendlyIdByRunId.get(session.currentRunId) ?? null
      : null,
  }));
}
