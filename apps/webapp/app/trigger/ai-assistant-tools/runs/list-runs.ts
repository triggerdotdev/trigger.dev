import { tool } from "ai";
import { listRuns as listRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, RunSummary } from "../types";

export function createListRunsTool(ctx: ToolContext) {
  return tool({
    ...listRunsSchema,
    execute: async (params) => {
      try {
        const { NextRunListPresenter } = await import("~/presenters/v3/NextRunListPresenter.server");
        const { prisma } = await import("~/db.server");
        const { clickhouseClient } = await import("~/v3/clickhouse.server");

        const presenter = new NextRunListPresenter(prisma, clickhouseClient);

        // Get the environment from context (we need to fetch it to get IDs)
        const { environment } = await prisma.runtimeEnvironment.findFirstOrThrow({
          where: {
            project: { slug: ctx.clientData.projectSlug },
            slug: ctx.clientData.environmentSlug,
          },
          select: {
            id: true,
            organizationId: true,
            project: { select: { id: true } },
          },
        });

        // Convert period to ClickHouse time bounds
        const timeFilters = params.period
          ? parsePeriod(params.period)
          : { from: Date.now() - 86400000, to: Date.now() }; // default 24h

        const result = await presenter.call(
          environment.organizationId,
          environment.id,
          {
            projectId: environment.project.id,
            tasks: params.taskIdentifier ? [params.taskIdentifier] : undefined,
            statuses: params.status ? (params.status as any[]) : undefined,
            tags: params.tags,
            from: timeFilters.from,
            to: timeFilters.to,
            pageSize: params.limit || 20,
          }
        );

        // Summarize runs for LLM consumption
        const summarizedRuns: RunSummary[] = result.runs.map((run) => ({
          id: run.friendlyId,
          status: run.status,
          isFinished: run.isFinished,
          startedAt: run.startedAt?.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          duration:
            run.completedAt && run.startedAt
              ? `${Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 1000)}s`
              : undefined,
          parentRunId: (run as any).parentTaskRun?.friendlyId,
          rootRunId: (run as any).rootTaskRun?.friendlyId,
        }));

        return {
          runs: summarizedRuns,
          total: result.pagination.total,
        };
      } catch (error) {
        return {
          runs: [],
          total: 0,
          error: `Failed to list runs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}

function parsePeriod(period: string): { from: number; to: number } {
  const now = Date.now();
  const units: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const match = period.match(/^(\d+)([mhd])$/);
  if (!match) return { from: now - 86400000, to: now }; // default 24h

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const milliseconds = value * (units[unit] || units.h);

  return { from: now - milliseconds, to: now };
}
