import { EngineServiceValidationError } from "@internal/run-engine";
import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { OutOfEntitlementError } from "~/v3/outOfEntitlementError.server";
import { MCP_REMOTE_TRIGGER_SOURCE } from "~/utils/triggerSource";
import { ServiceValidationError } from "~/v3/services/common.server";
import type { McpToolDefinition } from "../registry.server";
import { defineWriteTool, fencedError } from "./defineWrite.server";
import { dashboardUrl, resolveToolEnvironment, textResult } from "./define.server";
import { TriggerTaskInput } from "./schemas/write";

export type TasksWriteOptions = {
  triggerTask?: (
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    triggerSource: string
  ) => Promise<{ id: string } | undefined>;
  isDevConnected?: (environmentId: string) => Promise<boolean>;
};

const defaultTriggerTask: NonNullable<TasksWriteOptions["triggerTask"]> = async (
  taskId,
  environment,
  body,
  triggerSource
) => {
  const { TriggerTaskService } = await import("~/v3/services/triggerTask.server");
  const { determineRealtimeStreamsVersion } =
    await import("~/services/realtime/v1StreamsGlobal.server");

  const result = await new TriggerTaskService().call(taskId, environment, body, {
    traceContext: { external: {} },
    realtimeStreamsVersion: determineRealtimeStreamsVersion(
      undefined,
      environment.organization.streamBasinName
    ),
    triggerSource,
    triggerAction: "trigger",
  });
  return result ? { id: result.run.friendlyId } : undefined;
};

const defaultIsDevConnected = async (environmentId: string) => {
  const { devPresence } = await import("~/presenters/v3/DevPresence.server");
  return devPresence.isConnected(environmentId);
};

function parsePayload(payload: unknown) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export function createTasksWriteTools(options: TasksWriteOptions = {}): McpToolDefinition[] {
  const triggerTask = options.triggerTask ?? defaultTriggerTask;
  const isDevConnected = options.isDevConnected ?? defaultIsDevConnected;

  return [
    defineWriteTool({
      name: "trigger_task",
      title: "Trigger Task",
      description:
        "Trigger a task in the project. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use. The run executes in the background, so only wait for it to complete (with the wait_for_run_to_complete tool) if the user asked you to.",
      shape: TriggerTaskInput.shape,
      approval: "configurable",
      auth: {
        action: "trigger",
        subject: "tasks",
        resourceId: (input: { taskId: string }) => input.taskId,
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "trigger-error");

        const canTrigger = ctx.ability?.can("trigger", {
          type: "tasks",
          id: input.taskId,
          envType: environment.type,
        });
        if (!canTrigger) {
          return fencedError(
            `Triggering requires permission to trigger the ${input.taskId} task`,
            "trigger-error"
          );
        }

        const body = TriggerTaskRequestBody.safeParse({
          payload: parsePayload(input.payload),
          options: input.options,
        });
        if (!body.success) return fencedError(body.error.message, "trigger-error");

        let run: { id: string } | undefined;
        try {
          run = await triggerTask(input.taskId, environment, body.data, MCP_REMOTE_TRIGGER_SOURCE);
        } catch (error) {
          if (
            error instanceof ServiceValidationError ||
            error instanceof EngineServiceValidationError ||
            error instanceof OutOfEntitlementError
          ) {
            return fencedError(error.message, "trigger-error");
          }
          throw error;
        }
        if (!run) return fencedError("Task not found", "trigger-error");

        const contents = [
          `Task ${input.taskId} triggered and run with ID created: ${run.id}.`,
          `View the run in the dashboard: ${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${run.id}`)}`,
          `The run is now executing in the background. Do not wait for it to complete unless the user asked you to. If they did, use the wait_for_run_to_complete tool. Otherwise, use the get_run_details tool to check on it when needed.`,
        ];

        if (input.environment === "dev" && !(await isDevConnected(environment.id))) {
          contents.push(
            "The dev CLI is not connected to this project, because it is not currently running. Make sure to run the dev command to execute triggered tasks."
          );
        }

        return textResult(contents.join("\n"));
      },
    }),
  ];
}

export const tasksWriteTools: McpToolDefinition[] = createTasksWriteTools();
