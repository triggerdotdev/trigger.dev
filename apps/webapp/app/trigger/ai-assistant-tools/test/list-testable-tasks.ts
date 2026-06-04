import { tool } from "ai";
import { listTestableTasks as listTestableTasksSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

const MAX_TASKS = 50;

export function createListTestableTasksTool(ctx: ToolContext) {
  return tool({
    ...listTestableTasksSchema,
    execute: async ({ query }: { query?: string }) => {
      try {
        const { resolveTestEnvironment } = await import("./resolve-environment");
        const { TestPresenter } = await import("~/presenters/v3/TestPresenter.server");

        const environment = await resolveTestEnvironment(ctx);

        const presenter = new TestPresenter();
        const { tasks } = await presenter.call({
          userId: ctx.clientData.userId,
          projectId: environment.projectId,
          environmentId: environment.id,
          environmentType: environment.type,
        });

        const needle = query?.trim().toLowerCase();
        const filtered = (needle
          ? tasks.filter((t) => t.taskIdentifier.toLowerCase().includes(needle))
          : tasks
        ).slice(0, MAX_TASKS);

        return {
          tasks: filtered.map((t) => ({
            taskIdentifier: t.taskIdentifier,
            triggerSource: t.triggerSource,
            filePath: t.filePath,
          })),
          total: tasks.length,
          truncated: tasks.length > filtered.length,
        };
      } catch (error) {
        return {
          error: `Failed to list testable tasks: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  });
}
