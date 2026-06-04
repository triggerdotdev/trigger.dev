import { tool } from "ai";
import { runTestTask as runTestTaskSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

type RunTestTaskParams = {
  taskIdentifier: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

export function createRunTestTaskTool(ctx: ToolContext) {
  return tool({
    ...runTestTaskSchema,
    execute: async (params: RunTestTaskParams) => {
      try {
        const { resolveTestEnvironment } = await import("./resolve-environment");
        const { TestTaskService } = await import("~/v3/services/testTask.server");

        const environment = await resolveTestEnvironment(ctx);

        const service = new TestTaskService();
        // TestTaskData is the *parsed* shape: payload/metadata are objects and
        // tags is a string[] (the zod transforms have already run).
        const run = await service.call(environment, {
          triggerSource: "STANDARD",
          taskIdentifier: params.taskIdentifier,
          environmentId: environment.id,
          payload: params.payload ?? {},
          metadata: params.metadata ?? {},
          tags: params.tags && params.tags.length > 0 ? params.tags.slice(0, 10) : undefined,
        });

        if (!run) {
          return {
            success: false,
            error: `Could not trigger a test run for "${params.taskIdentifier}"`,
          };
        }

        const { v3RunPath } = await import("~/utils/pathBuilder");
        const url = v3RunPath(ctx.org, ctx.project, ctx.env, { friendlyId: run.friendlyId });

        return {
          success: true,
          taskIdentifier: params.taskIdentifier,
          runId: run.friendlyId,
          url,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to run test task: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });
}
