import { toolsMetadata } from "../config.js";
import { CommonProjectsInput, TriggerTaskInput } from "../schemas.js";
import { ToolMeta } from "../types.js";
import { respondWithError, toolHandler } from "../utils.js";

export const getCurrentWorker = {
  name: toolsMetadata.get_current_worker.name,
  title: toolsMetadata.get_current_worker.title,
  description: toolsMetadata.get_current_worker.description,
  inputSchema: CommonProjectsInput.shape,
  handler: toolHandler(CommonProjectsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_current_worker", { input });

    if (!ctx.isEnvironmentAllowed(input.environment)) {
      return respondWithError(
        `Cannot access ${input.environment} environment. This MCP server is restricted to: ${ctx.getAllowedEnvironments()}`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const cliApiClient = await ctx.getCliApiClient(input.branch);

    const workerResult = await cliApiClient.getWorkerByTag(
      projectRef,
      input.environment,
      "current"
    );

    if (!workerResult.success) {
      return respondWithError(workerResult.error);
    }

    const { worker, urls } = workerResult.data;

    const contents = [
      `Current worker for ${input.environment} is ${worker.version} using ${worker.sdkVersion} of the SDK.`,
    ];

    if (worker.tasks.length > 0) {
      contents.push(`The worker has ${worker.tasks.length} tasks registered:`);

      for (const task of worker.tasks) {
        if (task.payloadSchema) {
          contents.push(
            `- ${task.slug} in ${task.filePath} (payload schema: ${JSON.stringify(
              task.payloadSchema
            )})`
          );
        } else {
          contents.push(`- ${task.slug} in ${task.filePath}`);
        }
      }
    } else {
      contents.push(`The worker has no tasks registered.`);
    }

    contents.push(`\n`);
    contents.push(`URLs:`);
    contents.push(`- Runs: ${urls.runs}`);
    contents.push(`\n`);
    contents.push(
      `You can use the list_runs tool with the version ${worker.version} to get the list of runs for this worker.`
    );

    if (
      typeof worker.sdkVersion === "string" &&
      typeof worker.cliVersion === "string" &&
      worker.sdkVersion !== worker.cliVersion
    ) {
      contents.push(
        `WARNING: The SDK version (${worker.sdkVersion}) is different from the CLI version (${worker.cliVersion}). This might cause issues with the task execution. Make sure to pin the CLI and the SDK versions to ${worker.sdkVersion}.`
      );
    }

    return {
      content: [{ type: "text", text: contents.join("\n") }],
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

    if (!ctx.isEnvironmentAllowed(input.environment)) {
      return respondWithError(
        `Cannot access ${input.environment} environment. This MCP server is restricted to: ${ctx.getAllowedEnvironments()}`
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

    ctx.logger?.log("triggering task", { input });

    let payload = input.payload;

    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        ctx.logger?.log("payload is not a valid JSON string, using as is", { payload });
      }
    }

    const result = await apiClient.triggerTask(input.taskId, {
      payload,
      options: input.options,
    });

    const taskRunUrl = await ctx.getDashboardUrl(`/projects/v3/${projectRef}/runs/${result.id}`);

    const contents = [
      `Task ${input.taskId} triggered and run with ID created: ${result.id}.`,
      `View the run in the dashboard: ${taskRunUrl}`,
      `Use the ${toolsMetadata.wait_for_run_to_complete.name} tool to wait for the run to complete and the ${toolsMetadata.get_run_details.name} tool to get the details of the run.`,
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
