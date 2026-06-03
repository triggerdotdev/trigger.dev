import { tool } from "ai";
import { listErrors as listErrorsSchema } from "~/lib/ai-assistant/tool-schemas";
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

export function createListErrorsTool(ctx: ToolContext) {
  return tool({
    ...listErrorsSchema,
    execute: async (params: { period?: string; taskIdentifier?: string; limit?: number }) => {
      try {
        // Lazy import to avoid env validation issues at module load
        const { ErrorsListPresenter } = await import("~/presenters/v3/ErrorsListPresenter.server");
        const { summarizeErrorGroup } = await import("./error-formatters");
        const { prisma } = await import("~/db.server");
        const { clickhouseFactory } = await import("~/services/clickhouse/clickhouseFactoryInstance.server");

        // Get the environment and project IDs
        const environment = await prisma.runtimeEnvironment.findFirst({
          where: {
            slug: ctx.clientData.environmentSlug,
            project: {
              slug: ctx.clientData.projectSlug,
            },
          },
          select: {
            id: true,
            organizationId: true,
            project: {
              select: {
                id: true,
              },
            },
          },
        });

        if (!environment) {
          return {
            errors: [],
            total: 0,
            error: "Environment not found",
          };
        }

        const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
          environment.organizationId,
          "standard"
        );
        const presenter = new ErrorsListPresenter(prisma, clickhouse);

        // Convert period to time bounds
        const timeFilters = params.period
          ? parsePeriod(params.period)
          : { from: Date.now() - 86400000, to: Date.now() }; // default 24h

        const result = await presenter.call(environment.organizationId, environment.id, {
          projectId: environment.project.id,
          userId: ctx.clientData.userId,
          tasks: params.taskIdentifier ? [params.taskIdentifier] : undefined,
          from: timeFilters.from,
          to: timeFilters.to,
          pageSize: params.limit || 20,
        });

        // Summarize error groups for LLM
        const summaries = result.errorGroups.map((eg: any) => summarizeErrorGroup(eg));

        return {
          errors: summaries,
          total: result.pagination?.total || 0,
        };
      } catch (error) {
        return {
          errors: [],
          total: 0,
          error: `Failed to list errors: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
