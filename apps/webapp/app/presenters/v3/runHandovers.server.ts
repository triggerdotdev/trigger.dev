import { boundedIn, Prisma, type PrismaClientOrTransaction } from "@trigger.dev/database";
import {
  type HandoverRun,
  handoverRun,
  parseSessionRunHandover,
  type SessionHandover,
  sessionHandover,
} from "~/components/sessions/v1/sessionHandoverData";
import { runStore } from "~/v3/runStore.server";

type RunSessionHandovers = {
  session: { friendlyId: string; externalId: string | null };
  handedOverTo?: SessionHandover;
  continuedFrom?: SessionHandover;
};

/**
 * The session an agent run belongs to and the mid-turn moves on either side of it. One indexed
 * SessionRun read, then two more only when the run belongs to a session.
 */
export async function findRunSessionHandovers(
  replica: PrismaClientOrTransaction,
  runId: string,
  self: HandoverRun
): Promise<RunSessionHandovers | undefined> {
  const row = await replica.sessionRun.findFirst({
    where: { runId },
    select: {
      id: true,
      sessionId: true,
      reason: true,
      triggeredAt: true,
      handover: true,
      session: { select: { friendlyId: true, externalId: true } },
    },
  });
  if (!row) return undefined;
  return { session: row.session, ...(await findRunHandovers(replica, row, self)) };
}

/**
 * Whether a session's run handed its reply over to the next run mid-turn, or continued one the
 * previous run handed over. Both read the session's run history next to this run's row.
 */
export async function findRunHandovers(
  replica: PrismaClientOrTransaction,
  row: { id: string; sessionId: string; reason: string; triggeredAt: Date; handover: unknown },
  self: HandoverRun
): Promise<{ handedOverTo?: SessionHandover; continuedFrom?: SessionHandover }> {
  const position = Prisma.sql`(${row.triggeredAt.toISOString()}::timestamp(3), ${row.id})`;
  const [next, previous] = await Promise.all([
    replica.$queryRaw<{ runId: string; reason: string; triggeredAt: Date; handover: unknown }[]>`
      SELECT "runId", reason, "triggeredAt", handover FROM "SessionRun"
      WHERE "sessionId" = ${row.sessionId} AND ("triggeredAt", id) > ${position}
      ORDER BY "triggeredAt", id LIMIT 1`,
    row.handover == null
      ? Promise.resolve([])
      : replica.$queryRaw<{ runId: string }[]>`
      SELECT "runId" FROM "SessionRun"
      WHERE "sessionId" = ${row.sessionId} AND ("triggeredAt", id) < ${position}
      ORDER BY "triggeredAt" DESC, id DESC LIMIT 1`,
  ]);
  const ownHandover = parseSessionRunHandover(row.handover);
  const nextHandover = next[0] ? parseSessionRunHandover(next[0].handover) : undefined;
  if (!ownHandover && !nextHandover) return {};

  const runIds = [next[0]?.runId, previous[0]?.runId].filter((id): id is string => !!id);
  const runs = await runStore.findRuns(
    {
      where: { id: { in: boundedIn(runIds) } },
      select: { id: true, friendlyId: true, taskVersion: true },
    },
    replica
  );
  const runOf = (id: string) =>
    handoverRun(
      id,
      runs.find((r) => r.id === id)
    );

  return {
    ...(nextHandover && next[0]
      ? { handedOverTo: sessionHandover(nextHandover, next[0], self, runOf(next[0].runId)) }
      : {}),
    ...(ownHandover
      ? {
          continuedFrom: sessionHandover(
            ownHandover,
            row,
            previous[0] ? runOf(previous[0].runId) : null,
            self
          ),
        }
      : {}),
  };
}
