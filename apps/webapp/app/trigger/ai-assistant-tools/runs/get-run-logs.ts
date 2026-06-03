import { tool } from "ai";
import { getRunLogs as getRunLogsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createGetRunLogsTool(ctx: ToolContext) {
  return tool({
    ...getRunLogsSchema,
    execute: async (params: { runFriendlyId: string; level?: string; limit?: number }) => {
      try {
        const { prisma } = await import("~/db.server");
        const { getTaskEventStoreTableForRun, TaskEventStore } = await import("~/v3/taskEventStore.server");
        const { $replica } = await import("~/db.server");

        // Fetch the run to get its ID and event store table
        const run = await prisma.taskRun.findFirst({
          where: {
            friendlyId: params.runFriendlyId,
            runtimeEnvironment: {
              slug: ctx.clientData.environmentSlug,
              project: {
                slug: ctx.clientData.projectSlug,
              },
            },
          },
          select: {
            id: true,
            taskEventStore: true,
            createdAt: true,
          },
        });

        if (!run) {
          return {
            error: `Run ${params.runFriendlyId} not found`,
            logs: [],
          };
        }

        const eventStore = new TaskEventStore(prisma, $replica);
        const table = getTaskEventStoreTableForRun(run);

        // Build the where clause for log filtering
        const where = {
          runId: run.id,
          kind: { in: ["LOG", "TASK"] },
          ...(params.level && { level: params.level.toUpperCase() }),
        };

        // Fetch log events
        const logEvents = await eventStore.findMany(
          table,
          where,
          run.createdAt,
          undefined,
          {
            message: true,
            level: true,
            startTime: true,
          },
          { startTime: "asc" },
          { limit: params.limit || 50 }
        );

        // Format for LLM
        const logs = logEvents.map((event: any) => {
          const timestamp = event.startTime
            ? new Date(Number(event.startTime) / 1000000).toISOString()
            : new Date().toISOString();
          const level = event.level || "INFO";
          return `[${level}] ${timestamp}: ${event.message || "(no message)"}`;
        });

        return {
          runFriendlyId: params.runFriendlyId,
          logs,
          total: logs.length,
        };
      } catch (error) {
        return {
          error: `Failed to get run logs: ${error instanceof Error ? error.message : String(error)}`,
          logs: [],
          runFriendlyId: params.runFriendlyId,
        };
      }
    },
  });
}
