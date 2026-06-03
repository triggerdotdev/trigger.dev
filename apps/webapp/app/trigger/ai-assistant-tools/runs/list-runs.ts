import { tool } from "ai";
import { listRuns as listRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

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

export function createListRunsTool(ctx: ToolContext) {
  return tool({
    ...listRunsSchema,
    execute: async (params) => {
      // All imports inside execute() to avoid env.server.ts at CLI indexing time
      const dynamicImport = () => import("~/presenters/v3/NextRunListPresenter.server");

      try {
        const { NextRunListPresenter } = await dynamicImport();
        const { prisma } = await import("~/db.server");
        const { clickhouseFactory } = await import("~/services/clickhouse/clickhouseFactoryInstance.server");

        // Get the environment from context
        const environment = await prisma.runtimeEnvironment.findFirst({
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

        if (!environment) {
          return {
            runs: [],
            total: 0,
            error: "Environment not found",
          };
        }

        const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
          environment.organizationId,
          "standard"
        );
        const presenter = new NextRunListPresenter(prisma, clickhouse);

        // Convert period to ClickHouse time bounds
        const timeFilters = parsePeriod(params.period || "");

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
        const summarizedRuns = result.runs.map((run: any) => ({
          id: run.friendlyId,
          status: run.status,
          isFinished: run.hasFinished ?? false,
          startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : undefined,
          completedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
          duration:
            run.finishedAt && run.startedAt
              ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
              : undefined,
          parentRunId: (run as any).parentTaskRun?.friendlyId,
          rootRunId: (run as any).rootTaskRun?.friendlyId,
        }));

        return {
          runs: summarizedRuns,
          total: result.pagination?.total || 0,
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
