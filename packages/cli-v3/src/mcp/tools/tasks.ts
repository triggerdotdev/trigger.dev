import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput, TriggerTaskInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

export const getCurrentWorker = {
  name: toolsMetadata.get_current_worker.name,
  title: toolsMetadata.get_current_worker.title,
  description: toolsMetadata.get_current_worker.description,
  inputSchema: CommonProjectsInput.shape,
  handler: toolHandler(CommonProjectsInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_current_worker", { input });

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
        contents.push(`- ${task.slug} in ${task.filePath}`);
      }

      contents.push("");
      contents.push(
        "Use the `get_task_schema` tool with a task slug to get its payload schema."
      );
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

const GetTaskSchemaInput = CommonProjectsInput.extend({
  taskSlug: z
    .string()
    .describe(
      "The task slug/identifier to get the payload schema for. Use get_current_worker to see available tasks."
    ),
});

export const getTaskSchemaTool = {
  name: toolsMetadata.get_task_schema.name,
  title: toolsMetadata.get_task_schema.title,
  description: toolsMetadata.get_task_schema.description,
  inputSchema: GetTaskSchemaInput.shape,
  handler: toolHandler(GetTaskSchemaInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_task_schema", { input });

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

    const workerResult = await cliApiClient.getWorkerByTag(
      projectRef,
      input.environment,
      "current"
    );

    if (!workerResult.success) {
      return respondWithError(workerResult.error);
    }

    const task = workerResult.data.worker.tasks.find((t) => t.slug === input.taskSlug);

    if (!task) {
      const available = workerResult.data.worker.tasks.map((t) => t.slug).join(", ");
      return respondWithError(
        `Task "${input.taskSlug}" not found. Available tasks: ${available}`
      );
    }

    const content = [
      `## ${task.slug}`,
      "",
      `**File:** ${task.filePath}`,
    ];

    if (task.payloadSchema) {
      content.push("");
      content.push("**Payload schema:**");
      content.push("```json");
      content.push(JSON.stringify(task.payloadSchema, null, 2));
      content.push("```");
    } else {
      content.push("");
      content.push("No payload schema defined — this task accepts any payload.");
    }

    return {
      content: [{ type: "text", text: content.join("\n") }],
    };
  }),
};
