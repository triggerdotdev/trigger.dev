import { Tracer } from "@opentelemetry/api";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { runStore } from "~/v3/runStore.server";
import { startSpan } from "~/v3/tracing.server";
import { FINAL_RUN_STATUSES } from "../v3/taskStatus";
import { Logger } from "@trigger.dev/core/logger";

export class RunsBackfillerService {
  private readonly prisma: PrismaClientOrTransaction;
  private readonly runsReplicationInstance: RunsReplicationService;
  private readonly tracer: Tracer;
  private readonly logger: Logger;

  constructor(opts: {
    prisma: PrismaClientOrTransaction;
    runsReplicationInstance: RunsReplicationService;
    tracer: Tracer;
    logLevel?: "log" | "error" | "warn" | "info" | "debug";
  }) {
    this.prisma = opts.prisma;
    this.runsReplicationInstance = opts.runsReplicationInstance;
    this.tracer = opts.tracer;
    this.logger = new Logger("RunsBackfillerService", opts.logLevel ?? "debug");
  }

  public async call({
    from,
    to,
    cursor,
    batchSize,
  }: {
    from: Date;
    to: Date;
    cursor?: string;
    batchSize?: number;
  }): Promise<string | undefined> {
    return await startSpan(this.tracer, "RunsBackfillerService.call()", async (span) => {
      span.setAttribute("from", from.toISOString());
      span.setAttribute("to", to.toISOString());
      span.setAttribute("cursor", cursor ?? "");
      span.setAttribute("batchSize", batchSize ?? 0);

      // Keyset on (createdAt, id). Runs now live across two physical tables
      // (legacy TaskRun with cuid ids, task_run_v2 with ksuid ids), and `id`
      // alone is not a valid order across them: cuid and ksuid sort in
      // different ranges. RunStore merges the two tables only on a time-based
      // key, so order by createdAt and tiebreak on id within a timestamp.
      const keyset = cursor ? decodeBackfillCursor(cursor) : undefined;

      const runs = await runStore.findRuns(
        {
          where: {
            createdAt: {
              gte: from,
              lte: to,
            },
            status: {
              in: FINAL_RUN_STATUSES,
            },
            ...(keyset
              ? {
                  OR: [
                    { createdAt: { gt: keyset.createdAt } },
                    { createdAt: keyset.createdAt, id: { gt: keyset.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: batchSize,
        },
        this.prisma
      );

      if (runs.length === 0) {
        this.logger.info("No runs to backfill", { from, to, cursor });

        return;
      }

      this.logger.info("Backfilling runs", {
        from,
        to,
        cursor,
        batchSize,
        runCount: runs.length,
        firstCreatedAt: runs[0].createdAt,
        lastCreatedAt: runs[runs.length - 1].createdAt,
      });

      await this.runsReplicationInstance.backfill(
        runs.map((run) => ({
          ...run,
          masterQueue: run.workerQueue,
        }))
      );

      const lastRun = runs[runs.length - 1];

      this.logger.info("Backfilled runs", {
        from,
        to,
        cursor,
        batchSize,
        lastRunId: lastRun.id,
      });

      // Return a (createdAt, id) cursor to continue from on the next batch.
      return encodeBackfillCursor(lastRun.createdAt, lastRun.id);
    });
  }
}

// The backfill cursor is an opaque "<createdAt ISO>_<id>" string. The admin
// worker passes it back verbatim across batches; only this service interprets
// it. An ISO timestamp contains no "_" and run ids are base62/base36, so the
// first "_" cleanly splits the two halves.
const BACKFILL_CURSOR_SEPARATOR = "_";

export function encodeBackfillCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}${BACKFILL_CURSOR_SEPARATOR}${id}`;
}

export function decodeBackfillCursor(cursor: string): { createdAt: Date; id: string } {
  const separatorIndex = cursor.indexOf(BACKFILL_CURSOR_SEPARATOR);
  const createdAt = separatorIndex === -1 ? new Date(NaN) : new Date(cursor.slice(0, separatorIndex));
  const id = separatorIndex === -1 ? "" : cursor.slice(separatorIndex + 1);

  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new Error(
      `RunsBackfillerService: malformed cursor "${cursor}" (expected "<createdAt>_<id>")`
    );
  }

  return { createdAt, id };
}
