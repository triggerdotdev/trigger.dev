import { Tracer } from "@opentelemetry/api";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
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

      const runs = await this.prisma.taskRun.findMany({
        where: {
          createdAt: {
            gte: from,
            lte: to,
          },
          status: {
            in: FINAL_RUN_STATUSES,
          },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: {
          id: "asc",
        },
        take: batchSize,
      });

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

      // Return the last run ID to continue from
      return lastRun.id;
    });
  }
}
