import { Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import { Result } from "neverthrow";
import { z } from "zod";

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

type SessionRunsPageParams = {
  sessionId: string;
  /** Rows strictly older than this position. */
  before?: SessionRunCursor;
  /** Rows at or older than this position. Ignored when `before` is set. */
  atOrBefore?: SessionRunCursor;
  take: number;
};

function positionFilter(params: SessionRunsPageParams): Prisma.Sql {
  if (params.before) {
    return Prisma.sql`AND ("triggeredAt", id) < ${cursorValue(params.before)}`;
  }
  if (params.atOrBefore) {
    return Prisma.sql`AND ("triggeredAt", id) <= ${cursorValue(params.atOrBefore)}`;
  }
  return Prisma.empty;
}

export function sessionRunsPageQuery(params: SessionRunsPageParams): Prisma.Sql {
  const beforeFilter = positionFilter(params);

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

/** A page of a session's runs, newest first, older than `before` or from `atOrBefore` when given. */
export function findSessionRunsPage(
  client: PrismaClientOrTransaction,
  params: SessionRunsPageParams
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

export async function countSessionRuns(
  client: PrismaClientOrTransaction,
  params: { sessionId: string }
): Promise<number> {
  const [row] = await client.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT count(*)::int AS count
    FROM "SessionRun"
    WHERE "sessionId" = ${params.sessionId}`);
  return row?.count ?? 0;
}

/** The position of a run in its session, or null when the run isn't in that session. */
export async function findSessionRunCursor(
  client: PrismaClientOrTransaction,
  params: { sessionId: string; runId: string }
): Promise<SessionRunCursor | null> {
  const [row] = await client.$queryRaw<SessionRunCursor[]>(Prisma.sql`
    SELECT id, "triggeredAt"
    FROM "SessionRun"
    WHERE "runId" = ${params.runId} AND "sessionId" = ${params.sessionId}`);
  return row ?? null;
}

const CursorPayload = z.object({ t: z.string().datetime(), id: z.string().min(1) });

export function encodeSessionRunCursor(cursor: SessionRunCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.triggeredAt.toISOString(), id: cursor.id })
  ).toString("base64url");
}

const parseCursorJson = Result.fromThrowable(
  (value: string): unknown => JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
  () => undefined
);

/** Undefined for anything that isn't a cursor this module encoded. */
export function decodeSessionRunCursor(value: string): SessionRunCursor | undefined {
  const json = parseCursorJson(value);
  if (json.isErr()) return undefined;

  const parsed = CursorPayload.safeParse(json.value);
  return parsed.success ? { triggeredAt: new Date(parsed.data.t), id: parsed.data.id } : undefined;
}
