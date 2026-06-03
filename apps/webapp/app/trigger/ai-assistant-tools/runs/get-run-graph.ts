import { tool } from "ai";
import { getRunGraph as getRunGraphSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, RunSummary } from "../types";
import { getRunForLLM } from "./run-presenter-adapter";

export function createGetRunGraphTool(ctx: ToolContext) {
  return tool({
    ...getRunGraphSchema,
    execute: async (params: { runFriendlyId: string }) => {
      try {
        const runWithTrace = await getRunForLLM(ctx, params.runFriendlyId);

        if (!runWithTrace) {
          return {
            error: `Run ${params.runFriendlyId} not found`,
            root: null,
            children: [],
          };
        }

        const { run } = runWithTrace;

        // Build a graph structure showing parent/child relationships
        const graph = {
          root: run,
          parent: run.parentRunId ? { id: run.parentRunId } : null,
          ancestorChain: [] as string[],
          children: [] as RunSummary[],
        };

        // If we have root run info, that's the top of the chain
        if (run.rootRunId && run.rootRunId !== run.id) {
          graph.ancestorChain.push(run.rootRunId);
        }

        // Fetch child runs if this is the root
        if (!run.parentRunId) {
          try {
            const { prisma } = await import("~/db.server");

            const childRuns = await prisma.taskRun.findMany({
              where: {
                parentRunId: { not: null },
                rootTaskRunId: run.id,
                runtimeEnvironment: {
                  slug: ctx.clientData.environmentSlug,
                  project: {
                    slug: ctx.clientData.projectSlug,
                  },
                },
              },
              select: {
                friendlyId: true,
                status: true,
                isFinished: true,
                startedAt: true,
                completedAt: true,
              },
              orderBy: { createdAt: "asc" },
              take: 20,
            });

            graph.children = childRuns.map((child) => ({
              id: child.friendlyId,
              status: child.status,
              isFinished: child.isFinished,
              startedAt: child.startedAt?.toISOString(),
              completedAt: child.completedAt?.toISOString(),
            }));
          } catch {
            // If we can't fetch children, just return the root
          }
        }

        return graph;
      } catch (error) {
        return {
          error: `Failed to get run graph: ${error instanceof Error ? error.message : String(error)}`,
          root: null,
          children: [],
        };
      }
    },
  });
}
