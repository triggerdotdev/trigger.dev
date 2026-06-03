import { tool } from "ai";
import { applyRunFilters as applyRunFiltersSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createApplyRunFiltersTool(ctx: ToolContext) {
  return tool({
    ...applyRunFiltersSchema,
    execute: async (params: { description: string }) => {
      try {
        const { AIRunFilterService, type: QueryTagsType } = await import(
          "~/v3/services/aiRunFilterService.server"
        );
        const { prisma } = await import("~/db.server");

        // Fetch the environment to get its ID
        const environment = await prisma.runtimeEnvironment.findFirst({
          where: {
            slug: ctx.clientData.environmentSlug,
            project: {
              slug: ctx.clientData.projectSlug,
            },
          },
          select: {
            id: true,
          },
        });

        if (!environment) {
          return {
            success: false,
            error: "Environment not found",
          };
        }

        // Create query functions that fetch from the database
        const queryTags = {
          query: async (search?: string) => {
            const tags = await prisma.taskRunTag.findMany({
              where: {
                taskRun: {
                  runtimeEnvironment: {
                    id: environment.id,
                  },
                },
                ...(search && { name: { contains: search } }),
              },
              select: { name: true },
              distinct: ["name"],
              take: 50,
            });
            return { tags: tags.map((t) => t.name) };
          },
        };

        const queryVersions = {
          query: async (versionPrefix?: string, isCurrent?: boolean) => {
            const versions = await prisma.backgroundWorkerVersion.findMany({
              where: {
                runtimeEnvironment: {
                  id: environment.id,
                },
                ...(versionPrefix && { friendlyId: { contains: versionPrefix } }),
                ...(isCurrent && { isDeployed: true }),
              },
              select: { friendlyId: true },
              orderBy: { createdAt: "desc" },
              take: isCurrent ? 1 : 20,
            });

            if (isCurrent && versions.length > 0) {
              return { version: versions[0].friendlyId };
            }
            return { versions: versions.map((v) => v.friendlyId) };
          },
        };

        const queryQueues = {
          query: async (search?: string, type?: "task" | "custom") => {
            const queues = await prisma.taskQueue.findMany({
              where: {
                runtimeEnvironment: {
                  id: environment.id,
                },
                ...(search && { friendlyId: { contains: search } }),
                ...(type === "task" && { name: null }),
                ...(type === "custom" && { name: { not: null } }),
              },
              select: { friendlyId: true },
              take: 50,
            });
            return { queues: queues.map((q) => q.friendlyId) };
          },
        };

        const queryTasks = {
          query: async () => {
            const tasks = await prisma.backgroundWorkerTask.findMany({
              where: {
                runtimeEnvironment: {
                  id: environment.id,
                },
              },
              select: {
                slug: true,
                triggerSource: true,
              },
              take: 100,
            });
            return { tasks };
          },
        };

        const service = new AIRunFilterService({
          queryTags,
          queryVersions,
          queryQueues,
          queryTasks,
        });

        const result = await service.call(params.description, environment.id);

        if (result.success) {
          return {
            success: true,
            filters: result.filters,
          };
        } else {
          return {
            success: false,
            error: result.error,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to apply filters: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
