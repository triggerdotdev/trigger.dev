import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { v3RunsPath } from "~/utils/pathBuilder";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { CommonProjectsInput } from "./schemas/common";
import { GetTaskSchemaInput } from "./schemas/tasks";

async function loadCurrentWorker(
  environment: Parameters<typeof findCurrentWorkerFromEnvironment>[0]
) {
  const worker = await findCurrentWorkerFromEnvironment(environment, $replica, "current");
  if (!worker) return null;

  const tasks = await $replica.backgroundWorkerTask.findMany({
    where: { workerId: worker.id },
    select: {
      slug: true,
      filePath: true,
      triggerSource: true,
      payloadSchema: true,
    },
    orderBy: { slug: "asc" },
  });

  return { worker, tasks };
}

const getCurrentWorker = defineReadTool({
  name: "get_current_worker",
  title: "Get Current Worker",
  description:
    "Get the current worker for the project, including version and registered task slugs. Use get_task_schema to get the payload schema for a specific task.",
  shape: CommonProjectsInput.shape,
  auth: { action: "read", subject: "deployments" },
  run: async (input, ctx) => {
    const environment = await resolveToolEnvironment(ctx);
    if (!environment) return errorResult("Environment not found");

    const current = await loadCurrentWorker(environment);
    if (!current) return errorResult("Worker not found");
    const { worker, tasks } = current;

    const runsUrl = `${env.APP_ORIGIN}${v3RunsPath(
      { slug: environment.organization.slug },
      { slug: environment.project.slug },
      { slug: environment.slug },
      { versions: [worker.version] }
    )}`;

    const contents = [
      `Current worker for ${input.environment} is ${worker.version} using ${worker.sdkVersion} of the SDK.`,
    ];

    if (tasks.length > 0) {
      contents.push(`The worker has ${tasks.length} tasks registered:`);

      for (const task of tasks) {
        const label = task.triggerSource === "AGENT" ? " [agent]" : "";
        contents.push(
          `- ${fenceUntrusted(task.slug, "task-slug")}${label} in ${fenceUntrusted(task.filePath, "task-file-path")}`
        );
      }

      contents.push("");
      contents.push("Use the `get_task_schema` tool with a task slug to get its payload schema.");
    } else {
      contents.push(`The worker has no tasks registered.`);
    }

    contents.push(`\n`);
    contents.push(`URLs:`);
    contents.push(`- Runs: ${runsUrl}`);
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

    return textResult(contents.join("\n"));
  },
});

const getTaskSchema = defineReadTool({
  name: "get_task_schema",
  title: "Get Task Schema",
  description:
    "Get the payload schema for a specific task. Use get_current_worker first to see available task slugs.",
  shape: GetTaskSchemaInput.shape,
  auth: { action: "read", subject: "deployments" },
  run: async (input, ctx) => {
    const environment = await resolveToolEnvironment(ctx);
    if (!environment) return errorResult("Environment not found");

    const current = await loadCurrentWorker(environment);
    if (!current) return errorResult("Worker not found");

    const task = current.tasks.find((t) => t.slug === input.taskSlug);

    if (!task) {
      const available = fenceUntrusted(current.tasks.map((t) => t.slug).join(", "), "task-slug");
      return errorResult(`Task "${input.taskSlug}" not found. Available tasks: ${available}`);
    }

    const content = [
      `## ${fenceUntrusted(task.slug, "task-slug")}`,
      "",
      `**File:** ${fenceUntrusted(task.filePath, "task-file-path")}`,
    ];

    if (task.payloadSchema) {
      content.push("");
      content.push("**Payload schema:**");
      content.push("```json");
      content.push(
        fenceUntrusted(JSON.stringify(task.payloadSchema, null, 2), "task-payload-schema")
      );
      content.push("```");
    } else {
      content.push("");
      content.push("No payload schema defined — this task accepts any payload.");
    }

    return textResult(content.join("\n"));
  },
});

export const tasksTools: McpToolDefinition[] = [getCurrentWorker, getTaskSchema];
