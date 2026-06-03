import { tool } from "ai";
import { getErrorDetails as getErrorDetailsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetErrorDetailsTool(ctx: ToolContext) {
  return tool({
    ...getErrorDetailsSchema,
    execute: async (params: { fingerprint: string }) => {
      try {
        // Lazy import to avoid env validation issues at module load
        const { ErrorGroupPresenter } = await import("~/presenters/v3/ErrorGroupPresenter.server");
        const { summarizeErrorDetails } = await import("./error-formatters");
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
            error: "Environment not found",
            fingerprint: params.fingerprint,
            message: "",
            taskIdentifier: "",
            count: 0,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            affectedRuns: [],
          };
        }

        const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
          environment.organizationId,
          "standard"
        );
        const presenter = new ErrorGroupPresenter(prisma, clickhouse, clickhouse);

        const result = await presenter.call(environment.organizationId, {
          projectId: environment.project.id,
          userId: ctx.clientData.userId,
          fingerprint: params.fingerprint,
          runsPageSize: 5,
        });

        if (!result.errorGroup) {
          return {
            error: "Error group not found",
            fingerprint: params.fingerprint,
            message: "",
            taskIdentifier: "",
            count: 0,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            affectedRuns: [],
          };
        }

        // Get affected runs
        const affectedRuns = result.runs?.items
          ? result.runs.items.map((run: any) => ({
              friendlyId: run.friendlyId,
              status: run.status,
              createdAt: run.createdAt,
            }))
          : [];

        return summarizeErrorDetails(
          result.errorGroup.fingerprint,
          result.errorGroup.errorMessage,
          result.errorGroup.taskIdentifier,
          result.errorGroup.stackTrace || null,
          result.errorGroup.count,
          result.errorGroup.firstSeen,
          result.errorGroup.lastSeen,
          affectedRuns
        );
      } catch (error) {
        return {
          error: `Failed to get error details: ${error instanceof Error ? error.message : String(error)}`,
          fingerprint: params.fingerprint,
          message: "",
          taskIdentifier: "",
          count: 0,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          affectedRuns: [],
        };
      }
    },
  });
}
