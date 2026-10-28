import type { PrismaClientOrTransaction } from "~/db.server";
import type { SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";

const SESSION_START_SPAN_MESSAGE = "sessions.start()";

export type StartedSession = {
  friendlyId: string;
  externalId: string;
  status: SessionStatus;
  /** The trace already belongs to this session, so it isn't linked. */
  isCurrent: boolean;
};

/** The `externalId` of a `sessions.start()` span. The `session` attribute falls back to the type, so it isn't used. */
export function startedSessionExternalId(span: {
  message: string;
  properties: unknown;
}): string | undefined {
  if (span.message !== SESSION_START_SPAN_MESSAGE) return;
  if (!span.properties || typeof span.properties !== "object") return;

  const externalId = (span.properties as Record<string, unknown>).externalId;
  if (typeof externalId !== "string" || externalId.length === 0) return;

  return externalId;
}

/** Session runs start their own trace, so the root run says which session a trace is in. */
export function traceRootRunId(run: { id: string; rootTaskRunId: string | null }): string {
  return run.rootTaskRunId ?? run.id;
}

export async function findStartedSession(
  db: PrismaClientOrTransaction,
  {
    environmentId,
    externalId,
    rootRunId,
    userId,
  }: {
    environmentId: string;
    externalId: string;
    rootRunId: string;
    userId: string;
  }
): Promise<StartedSession | undefined> {
  const [session, viewableEnvironment, rootSessionRun] = await Promise.all([
    db.session.findFirst({
      where: { runtimeEnvironmentId: environmentId, externalId },
      select: { id: true, friendlyId: true, closedAt: true, expiresAt: true },
    }),
    // Same rule as the session page: dev environments are visible to their owner only.
    db.runtimeEnvironment.findFirst({
      where: {
        id: environmentId,
        OR: [{ type: { not: "DEVELOPMENT" } }, { orgMember: { userId } }],
      },
      select: { id: true },
    }),
    db.sessionRun.findFirst({
      where: { runId: rootRunId },
      select: { sessionId: true },
    }),
  ]);

  if (!session || !viewableEnvironment) return;

  return {
    friendlyId: session.friendlyId,
    externalId,
    status:
      session.closedAt != null
        ? "CLOSED"
        : session.expiresAt != null && session.expiresAt.getTime() < Date.now()
          ? "EXPIRED"
          : "ACTIVE",
    isCurrent: rootSessionRun?.sessionId === session.id,
  };
}
