import { toolsMetadata } from "../config.js";
import { CommonProjectsInput, TriggerTaskInput } from "../schemas.js";
import { ToolMeta } from "../types.js";
import { respondWithError, toolHandler } from "../utils.js";

export const getTasksTool = {
  name: toolsMetadata.get_tasks.name,
  title: toolsMetadata.get_tasks.title,
  description: toolsMetadata.get_tasks.description,
  inputSchema: CommonProjectsInput.shape,
  handler: toolHandler(CommonProjectsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_tasks", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);

    const worker = await cliApiClient.getWorkerByTag(projectRef, input.environment, "current");

    if (!worker.success) {
      return respondWithError(worker.error);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(worker.data, null, 2) }],
    };
  }),
};

export const triggerTaskTool = {
  name: toolsMetadata.trigger_task.name,
  title: toolsMetadata.trigger_task.title,
  description: toolsMetadata.trigger_task.description,
  inputSchema: TriggerTaskInput.shape,
  handler: toolHandler(TriggerTaskInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling trigger_task", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:tasks"],
      branch: input.branch,
    });

    const result = await apiClient.triggerTask(input.taskId, {
      payload: input.payload,
      options: input.options,
    });

    const taskRunUrl = await ctx.getDashboardUrl(`/projects/v3/${projectRef}/runs/${result.id}`);

    const contents = [
      `Task ${input.taskId} triggered and run with ID created: ${result.id}.`,
      `View the run in the dashboard: ${taskRunUrl}`,
      `You can also use the get_run_details tool to get the details of the run.`,
    ];

    if (input.environment === "dev") {
      const cliApiClient = await ctx.getCliApiClient(input.branch);
      const devStatus = await cliApiClient.getDevStatus(projectRef);
      const isConnected = devStatus.success ? devStatus.data.isConnected : false;
      const connectionMessage = isConnected
        ? undefined
        : "The dev CLI is not connected to this project, because it is not currently running. Make sure to run the dev command to execute triggered tasks.";

      if (connectionMessage) {
        contents.push(connectionMessage);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: contents.join("\n"),
        },
      ],
    };
  }),
};
