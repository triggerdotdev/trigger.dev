import { Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";

/** Position of a `SessionRun` row in its session: `triggeredAt`, then `SessionRun.id`. */
export type SessionRunCursor = { triggeredAt: Date; id: string };

export type SessionRunRow = {
  id: string;
  runId: string;
  reason: string;
  triggeredAt: Date;
};

// Row comparisons on `(triggeredAt, id)` give one tight range on the
// `(sessionId, triggeredAt, id)` index. `triggeredAt` is a timestamp without zone, stored in UTC.
function cursorValue(cursor: SessionRunCursor) {
  return Prisma.sql`(${cursor.triggeredAt.toISOString()}::timestamp(3), ${cursor.id})`;
}

export function sessionRunsPageQuery(params: {
  sessionId: string;
  before?: SessionRunCursor;
  take: number;
}): Prisma.Sql {
  const beforeFilter = params.before
    ? Prisma.sql`AND ("triggeredAt", id) < ${cursorValue(params.before)}`
    : Prisma.empty;

  return Prisma.sql`
    SELECT id, "runId", reason, "triggeredAt"
    FROM "SessionRun"
    WHERE "sessionId" = ${params.sessionId} ${beforeFilter}
    ORDER BY "triggeredAt" DESC, id DESC
    LIMIT ${params.take}`;
}

export function sessionRunsAtOrBeforeCountQuery(params: {
  sessionId: string;
  cursor: SessionRunCursor;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS count
    FROM "SessionRun"
    WHERE "sessionId" = ${params.sessionId}
      AND ("triggeredAt", id) <= ${cursorValue(params.cursor)}`;
}

/** A page of a session's runs, newest first, strictly older than `before` when given. */
export function findSessionRunsPage(
  client: PrismaClientOrTransaction,
  params: { sessionId: string; before?: SessionRunCursor; take: number }
): Promise<SessionRunRow[]> {
  return client.$queryRaw<SessionRunRow[]>(sessionRunsPageQuery(params));
}

/** How many of the session's rows sort at or before `cursor`: the run number of that row. */
export async function countSessionRunsAtOrBefore(
  client: PrismaClientOrTransaction,
  params: { sessionId: string; cursor: SessionRunCursor }
): Promise<number> {
  const [row] = await client.$queryRaw<{ count: number }[]>(
    sessionRunsAtOrBeforeCountQuery(params)
  );
  return row?.count ?? 0;
}
