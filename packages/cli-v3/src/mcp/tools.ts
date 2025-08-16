import {
  ApiDeploymentListParams,
  GetOrgsResponseBody,
  GetProjectsResponseBody,
  MachinePresetName,
  RunStatus,
} from "@trigger.dev/core/v3/schemas";
import path, { dirname, join } from "path";
import { x } from "tinyexec";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { getPackageJson, tryResolveTriggerPackageVersion } from "../commands/update.js";
import { loadConfig } from "../config.js";
import { LoginResultOk } from "../utilities/session.js";
import { VERSION } from "../version.js";
import { createApiClientWithPublicJWT, mcpAuth } from "./auth.js";
import { hasRootsCapability } from "./capabilities.js";
import { McpContext } from "./context.js";
import { performSearch } from "./mintlifyClient.js";
import { ProjectRefSchema } from "./schemas.js";
import { respondWithError } from "./utils.js";
import { resolveSync as esmResolve } from "mlly";
import { tryCatch } from "@trigger.dev/core/utils";

export function registerListProjectsTool(context: McpContext) {
  context.server.registerTool(
    "list_projects",
    {
      description: "List all projects",
      outputSchema: {
        projects: GetProjectsResponseBody,
      },
    },
    async (_, extra) => {
      context.logger?.log("calling list_projects", { extra });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const roots = await context.server.server.listRoots();

      context.logger?.log("list_projects", { roots, extra, auth });

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

      const projects = await cliApiClient.getProjects();

      if (!projects.success) {
        return respondWithError(projects.error);
      }

      context.logger?.log("list_projects", { projects: projects.data });

      return {
        structuredContent: {
          projects: projects.data,
        },
        content: [
          {
            type: "text",
            text: JSON.stringify(projects.data, null, 2),
          },
        ],
      };
    }
  );
}

export function registerListOrgsTool(context: McpContext) {
  context.server.registerTool(
    "list_orgs",
    {
      description: "List all organizations",
      outputSchema: {
        orgs: GetOrgsResponseBody,
      },
    },
    async (_, extra) => {
      context.logger?.log("calling list_orgs", { extra });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const roots = await context.server.server.listRoots();

      context.logger?.log("list_orgs", { roots, extra, auth });

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

      const orgs = await cliApiClient.getOrgs();

      if (!orgs.success) {
        return respondWithError(orgs.error);
      }

      context.logger?.log("list_orgs", { orgs: orgs.data });

      return {
        structuredContent: {
          orgs: orgs.data,
        },
        content: [
          {
            type: "text",
            text: JSON.stringify(orgs.data, null, 2),
          },
        ],
      };
    }
  );
}

export function registerCreateProjectTool(context: McpContext) {
  context.server.registerTool(
    "create_project_in_org",
    {
      description: "Create a new project in an organization",
      inputSchema: {
        orgParam: z
          .string()
          .describe(
            "The organization to create the project in, can either be the organization slug or the ID. Use the list_orgs tool to get a list of organizations and ask the user to select one."
          ),
        name: z.string().describe("The name of the project to create."),
      },
    },
    async ({ orgParam, name }, extra) => {
      context.logger?.log("calling create_project_in_org", { extra, orgParam, name });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const roots = await context.server.server.listRoots();

      context.logger?.log("create_project_in_org", { roots, extra, auth });

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

      const project = await cliApiClient.createProject(orgParam, {
        name,
      });

      if (!project.success) {
        return respondWithError(project.error);
      }

      context.logger?.log("create_project_in_org", { project: project.data });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(project.data, null, 2),
          },
        ],
      };
    }
  );
}

export function registerSearchDocsTool(context: McpContext) {
  context.server.registerTool(
    "search_docs",
    {
      description:
        "Search across the Trigger.dev documentation to find relevant information, code examples, API references, and guides. Use this tool when you need to answer questions about Trigger.dev, find specific documentation, understand how features work, or locate implementation details. The search returns contextual content with titles and direct links to the documentation pages",
      inputSchema: {
        query: z.string(),
      },
    },
    async ({ query }) => {
      const results = await performSearch(query);

      context.logger?.log("search_docs", { query, results });

      return results.result;
    }
  );
}

export function registerInitializeProjectTool(context: McpContext) {
  context.server.registerTool(
    "initialize_project",
    {
      description: "Initialize Trigger.dev in your project",
      inputSchema: {
        orgParam: z
          .string()
          .describe(
            "The organization to create the project in, can either be the organization slug or the ID. Use the list_orgs tool to get a list of organizations and ask the user to select one."
          ),
        projectRef: ProjectRefSchema,
        projectName: z
          .string()
          .describe(
            "The name of the project to create. If projectRef is not provided, we will use this name to create a new project in the organization you select."
          ),
        cwd: z.string().describe("The current working directory of the project"),
      },
    },
    async ({ orgParam, projectRef, projectName, cwd }, extra) => {
      context.logger?.log("calling initialize_project", {
        extra,
        orgParam,
        projectRef,
        projectName,
        cwd,
      });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const projectRefResult = await resolveProjectRef(
        context,
        auth,
        orgParam,
        projectName,
        cwd,
        projectRef
      );

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      if (projectRefResult.status === "existing") {
        return {
          content: [
            {
              type: "text",
              text: `We found an existing trigger.config.ts file in the current working directory. Skipping initialization.`,
            },
          ],
        };
      }

      // Get the manual setup guide markdown
      const manualSetupGuide = await getManualSetupGuide(projectRefResult.projectRef, auth);

      return {
        content: [{ type: "text", text: manualSetupGuide }],
      };
    }
  );
}

export function registerGetTasksTool(context: McpContext) {
  context.server.registerTool(
    "get_tasks",
    {
      description: "Get all tasks in the project",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["dev", "staging", "prod", "preview"])
          .describe("The environment to get tasks for")
          .default("dev"),
        branch: z
          .string()
          .describe("The branch to get tasks for, only used for preview environments")
          .optional(),
      },
    },
    async ({ projectRef, configPath, environment, branch }) => {
      context.logger?.log("calling get_tasks", { projectRef, configPath, environment, branch });

      if (context.options.devOnly && environment !== "dev") {
        return respondWithError(
          `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
        );
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("get_tasks projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken, branch);

      // TODO: support other tags and preview branches
      const worker = await cliApiClient.getWorkerByTag($projectRef, environment, "current");

      if (!worker.success) {
        return respondWithError(worker.error);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(worker.data, null, 2) }],
      };
    }
  );
}

export function registerTriggerTaskTool(context: McpContext) {
  context.server.registerTool(
    "trigger_task",
    {
      description: "Trigger a task",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["dev", "staging", "prod", "preview"])
          .describe("The environment to trigger the task in")
          .default("dev"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
        taskId: z
          .string()
          .describe(
            "The ID/slug of the task to trigger. Use the get_tasks tool to get a list of tasks and ask the user to select one if it's not clear which one to use."
          ),
        payload: z
          .string()
          .transform((val, ctx) => {
            try {
              return JSON.parse(val);
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "The payload must be a valid JSON string",
              });
              return z.NEVER;
            }
          })
          .describe("The payload to trigger the task with, must be a valid JSON string"),
        options: z
          .object({
            queue: z
              .object({
                name: z
                  .string()
                  .describe(
                    "The name of the queue to trigger the task in, by default will use the queue configured in the task"
                  ),
              })
              .optional(),
            delay: z
              .string()
              .or(z.coerce.date())
              .describe("The delay before the task run is executed")
              .optional(),
            idempotencyKey: z
              .string()
              .describe("The idempotency key to use for the task run")
              .optional(),
            machine: MachinePresetName.describe(
              "The machine preset to use for the task run"
            ).optional(),
            maxAttempts: z
              .number()
              .int()
              .describe("The maximum number of attempts to retry the task run")
              .optional(),
            maxDuration: z
              .number()
              .describe("The maximum duration in seconds of the task run")
              .optional(),
            tags: z
              .array(z.string())
              .describe(
                "Tags to add to the task run. Must be less than 128 characters and cannot have more than 5"
              )
              .optional(),
            ttl: z
              .string()
              .or(z.number().nonnegative().int())
              .describe(
                "The time to live of the task run. If the run doesn't start executing within this time, it will be automatically cancelled."
              )
              .default("10m"),
          })
          .optional(),
      },
    },
    async ({ projectRef, configPath, environment, branch, taskId, payload, options }) => {
      context.logger?.log("calling trigger_task", {
        projectRef,
        configPath,
        environment,
        branch,
        taskId,
        payload,
      });

      if (context.options.devOnly && environment !== "dev") {
        return respondWithError(
          `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
        );
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("trigger_task projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const apiClient = await createApiClientWithPublicJWT(
        auth,
        $projectRef,
        environment,
        ["write:tasks"],
        branch
      );

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      const result = await apiClient.triggerTask(taskId, {
        payload,
        options,
      });

      const taskRunUrl = `${auth.dashboardUrl}/projects/v3/${$projectRef}/runs/${result.id}`;

      if (environment === "dev") {
        const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

        const devStatus = await cliApiClient.getDevStatus($projectRef);
        const isConnected = devStatus.success ? devStatus.data.isConnected : false;
        const connectionMessage = isConnected
          ? undefined
          : "The dev CLI is not connected to this project, because it is not currently running. Make sure to run the dev command to execute triggered tasks.";

        if (connectionMessage) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ ...result, taskRunUrl }, null, 2) },
              { type: "text", text: connectionMessage },
            ],
          };
        } else {
          return {
            content: [{ type: "text", text: JSON.stringify({ ...result, taskRunUrl }, null, 2) }],
          };
        }
      } else {
        return {
          content: [{ type: "text", text: JSON.stringify({ ...result, taskRunUrl }, null, 2) }],
        };
      }
    }
  );
}

export function registerGetRunDetailsTool(context: McpContext) {
  context.server.registerTool(
    "get_run_details",
    {
      description: "Get the details of a run",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["dev", "staging", "prod", "preview"])
          .describe("The environment to trigger the task in")
          .default("dev"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
        runId: z.string().describe("The ID of the run to get the details of, starts with run_"),
        debugMode: z
          .boolean()
          .describe(
            "Enable debug mode to get more detailed information about the run, including the entire trace (all logs and spans for the run and any child run). Set this to true if prompted to debug a run."
          )
          .optional(),
      },
    },
    async ({ projectRef, configPath, environment, branch, runId, debugMode }) => {
      context.logger?.log("calling get_run_details", {
        projectRef,
        configPath,
        environment,
        branch,
        runId,
        debugMode,
      });

      if (context.options.devOnly && environment !== "dev") {
        return respondWithError(
          `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
        );
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("get_run_details projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const apiClient = await createApiClientWithPublicJWT(
        auth,
        $projectRef,
        environment,
        [`read:runs:${runId}`],
        branch
      );

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      if (debugMode) {
        const [runResult, traceResult] = await Promise.all([
          apiClient.retrieveRun(runId),
          apiClient.retrieveRunTrace(runId),
        ]);

        const runUrl = `${auth.dashboardUrl}/projects/v3/${$projectRef}/runs/${runResult.id}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...runResult, runUrl, trace: traceResult }, null, 2),
            },
          ],
        };
      } else {
        const runResult = await apiClient.retrieveRun(runId);

        const runUrl = `${auth.dashboardUrl}/projects/v3/${$projectRef}/runs/${runResult.id}`;

        return {
          content: [{ type: "text", text: JSON.stringify({ ...runResult, runUrl }, null, 2) }],
        };
      }
    }
  );
}

export function registerCancelRunTool(context: McpContext) {
  context.server.registerTool(
    "cancel_run",
    {
      description: "Cancel a run",
      inputSchema: {
        runId: z.string().describe("The ID of the run to cancel, starts with run_"),
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["dev", "staging", "prod", "preview"])
          .describe("The environment to trigger the task in")
          .default("dev"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
      },
    },
    async ({ projectRef, configPath, environment, branch, runId }) => {
      context.logger?.log("calling cancel_run", {
        projectRef,
        configPath,
        environment,
        branch,
        runId,
      });

      if (context.options.devOnly && environment !== "dev") {
        return respondWithError(
          `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
        );
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("cancel_run projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const apiClient = await createApiClientWithPublicJWT(
        auth,
        $projectRef,
        environment,
        [`write:runs:${runId}`, `read:runs:${runId}`],
        branch
      );

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      const [cancelError] = await tryCatch(apiClient.cancelRun(runId));

      if (cancelError) {
        return respondWithError(cancelError.message);
      }

      const retrieveResult = await apiClient.retrieveRun(runId);

      const runUrl = `${auth.dashboardUrl}/projects/v3/${$projectRef}/runs/${runId}`;

      return {
        content: [{ type: "text", text: JSON.stringify({ ...retrieveResult, runUrl }, null, 2) }],
      };
    }
  );
}

export function registerListRunsTool(context: McpContext) {
  context.server.registerTool(
    "list_runs",
    {
      description: "List all runs for a project",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["dev", "staging", "prod", "preview"])
          .describe("The environment to trigger the task in")
          .default("dev"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
        cursor: z
          .string()
          .describe("The cursor to use for pagination, starts with run_")
          .optional(),
        limit: z
          .number()
          .int()
          .describe("The number of runs to list in a single page. Up to 100")
          .optional(),
        status: RunStatus.describe("Filter for runs with this run status").optional(),
        taskIdentifier: z
          .string()
          .describe("Filter for runs that match this task identifier")
          .optional(),
        version: z
          .string()
          .describe("Filter for runs that match this version, e.g. 20250808.3")
          .optional(),
        tag: z.string().describe("Filter for runs that include this tag").optional(),
        from: z
          .string()
          .describe("Filter for runs created after this ISO 8601 timestamp")
          .optional(),
        to: z
          .string()
          .describe("Filter for runs created before this ISO 8601 timestamp")
          .optional(),
        period: z
          .string()
          .describe("Filter for runs created in the last N time period. e.g. 7d, 30d, 365d")
          .optional(),
        machine: MachinePresetName.describe(
          "Filter for runs that match this machine preset"
        ).optional(),
      },
    },
    async ({
      projectRef,
      configPath,
      environment,
      branch,
      cursor,
      limit,
      status,
      taskIdentifier,
      version,
      tag,
      from,
      to,
      period,
      machine,
    }) => {
      context.logger?.log("calling list_runs", {
        projectRef,
        configPath,
        environment,
        branch,
        cursor,
        limit,
        status,
        taskIdentifier,
        version,
        tag,
        from,
        to,
        period,
        machine,
      });

      if (context.options.devOnly && environment !== "dev") {
        return respondWithError(
          `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
        );
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("list_runs projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const apiClient = await createApiClientWithPublicJWT(
        auth,
        $projectRef,
        environment,
        ["read:runs"],
        branch
      );

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      const $from = typeof from === "string" ? new Date(from) : undefined;
      const $to = typeof to === "string" ? new Date(to) : undefined;

      const result = await apiClient.listRuns({
        after: cursor,
        limit,
        status,
        taskIdentifier,
        version,
        tag,
        from: $from,
        to: $to,
        period,
        machine,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

export function registerDeployTool(context: McpContext) {
  context.server.registerTool(
    "deploy",
    {
      description: "Deploy a project",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["staging", "prod", "preview"])
          .describe("The environment to trigger the task in")
          .default("prod"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
        skipPromotion: z
          .boolean()
          .describe("Skip promoting the deployment to the current deployment for the environment")
          .optional(),
        skipSyncEnvVars: z
          .boolean()
          .describe("Skip syncing environment variables when using the syncEnvVars extension")
          .optional(),
        skipUpdateCheck: z
          .boolean()
          .describe("Skip checking for @trigger.dev package updates")
          .optional(),
      },
    },
    async ({
      projectRef,
      configPath,
      environment,
      branch,
      skipPromotion,
      skipSyncEnvVars,
      skipUpdateCheck,
    }) => {
      context.logger?.log("calling deploy", {
        projectRef,
        configPath,
        environment,
        branch,
        env: process.env,
        argv: process.argv,
        execArgv: process.execArgv,
        execPath: process.execPath,
      });

      if (context.options.devOnly) {
        return respondWithError(
          `This MCP server is only available for the dev environment. The deploy command is not allowed with the --dev-only flag.`
        );
      }

      const cwdResult = await resolveProjectDir(context, configPath);

      if (!cwdResult.ok) {
        return respondWithError(cwdResult.error);
      }

      context.logger?.log("deploy cwdResult", { cwdResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      // TODO: Spawn the deploy command using process.argv[0] for the executable and process.argv[1] for the command
      const args = ["deploy", "--env", environment, "--api-url", auth.auth.apiUrl];

      if (environment === "preview" && branch) {
        args.push("--branch", branch);
      }

      if (context.options.profile) {
        args.push("--profile", context.options.profile);
      }

      if (skipPromotion) {
        args.push("--skip-promotion");
      }

      if (skipSyncEnvVars) {
        args.push("--skip-sync-env-vars");
      }

      if (skipUpdateCheck) {
        args.push("--skip-update-check");
      }

      const [nodePath, cliPath] = await resolveCLIExec(context, cwdResult.cwd);

      context.logger?.log("deploy process args", {
        nodePath,
        cliPath,
        args,
      });

      const deployProcess = x(nodePath, [cliPath, ...args], {
        nodeOptions: {
          cwd: cwdResult.cwd,
          env: {
            TRIGGER_MCP_SERVER: "1",
          },
        },
      });

      const logs = [];

      for await (const line of deployProcess) {
        logs.push(line);
      }

      context.logger?.log("deploy deployProcess", {
        logs,
      });

      if (deployProcess.exitCode !== 0) {
        return respondWithError(logs.join("\n"));
      }

      return {
        content: [{ type: "text", text: logs.join("\n") }],
      };
    }
  );
}

export function registerListDeploymentsTool(context: McpContext) {
  context.server.registerTool(
    "list_deployments",
    {
      description: "List deployments for a project",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
        environment: z
          .enum(["staging", "prod", "preview"])
          .describe("The environment to list deployments for")
          .default("prod"),
        branch: z
          .string()
          .describe("The branch to trigger the task in, only used for preview environments")
          .optional(),
        ...ApiDeploymentListParams,
      },
    },
    async ({
      projectRef,
      configPath,
      environment,
      branch,
      cursor,
      limit,
      status,
      from,
      to,
      period,
    }) => {
      context.logger?.log("calling list_deployments", {
        projectRef,
        configPath,
        environment,
        branch,
        cursor,
        limit,
        status,
        from,
        to,
        period,
      });

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("list_deployments projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const apiClient = await createApiClientWithPublicJWT(
        auth,
        $projectRef,
        environment,
        ["read:deployments"],
        branch
      );

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      const result = await apiClient.listDeployments({
        cursor: cursor,
        limit,
        status,
        from,
        to,
        period,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

export function registerListPreviewBranchesTool(context: McpContext) {
  context.server.registerTool(
    "list_preview_branches",
    {
      description: "List all preview branches in the project",
      inputSchema: {
        projectRef: ProjectRefSchema,
        configPath: z
          .string()
          .describe(
            "The path to the trigger.config.ts file. Only used when the trigger.config.ts file is not at the root dir (like in a monorepo setup). If not provided, we will try to find the config file in the current working directory"
          )
          .optional(),
      },
    },
    async ({ projectRef, configPath }) => {
      context.logger?.log("calling list_preview_branches", { projectRef, configPath });

      if (context.options.devOnly) {
        return respondWithError(`This MCP server is only available for the dev environment. `);
      }

      const projectRefResult = await resolveExistingProjectRef(context, projectRef, configPath);

      if (projectRefResult.status === "error") {
        return respondWithError(projectRefResult.error);
      }

      const $projectRef = projectRefResult.projectRef;

      context.logger?.log("list_preview_branches projectRefResult", { projectRefResult });

      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        return respondWithError(auth.error);
      }

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

      const branches = await cliApiClient.listBranches($projectRef);

      if (!branches.success) {
        return respondWithError(branches.error);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(branches.data, null, 2) }],
      };
    }
  );
}

async function resolveCLIExec(context: McpContext, cwd: string): Promise<[string, string]> {
  // Lets first try to get the version of the CLI package
  const installedCLI = await tryResolveTriggerCLIPath(context, cwd);

  if (installedCLI) {
    context.logger?.log("resolve_cli_exec installedCLI", { installedCLI });

    return [process.argv[0] ?? "node", installedCLI.path];
  }

  const sdkVersion = await tryResolveTriggerPackageVersion("@trigger.dev/sdk", cwd);

  if (!sdkVersion) {
    context.logger?.log("resolve_cli_exec no sdk version found", { cwd });

    return [process.argv[0] ?? "npx", process.argv[1] ?? "trigger.dev@latest"];
  }

  if (sdkVersion === VERSION) {
    context.logger?.log("resolve_cli_exec sdk version is the same as the current version", {
      sdkVersion,
    });

    return [process.argv[0] ?? "npx", process.argv[1] ?? "trigger.dev@latest"];
  }

  return ["npx", `trigger.dev@${sdkVersion}`];
}

async function tryResolveTriggerCLIPath(
  context: McpContext,
  basedir: string
): Promise<
  | {
      path: string;
      version: string;
    }
  | undefined
> {
  try {
    const resolvedPathFileURI = esmResolve("trigger.dev", {
      url: basedir,
    });

    const resolvedPath = fileUriToPath(resolvedPathFileURI);

    context.logger?.log("resolve_cli_exec resolvedPathFileURI", { resolvedPathFileURI });

    const { packageJson } = await getPackageJson(resolvedPath, {
      test: (filePath) => {
        // We need to skip any type-marker files
        if (filePath.includes("dist/commonjs")) {
          return false;
        }

        if (filePath.includes("dist/esm")) {
          return false;
        }

        return true;
      },
    });

    if (packageJson.version) {
      context.logger?.log("resolve_cli_exec packageJson", { packageJson });

      return { path: resolvedPath, version: packageJson.version };
    }

    return;
  } catch (error) {
    context.logger?.log("resolve_cli_exec error", { error });
    return undefined;
  }
}

async function resolveCwd(context: McpContext) {
  const response = await context.server.server.listRoots();

  if (response.roots.length >= 1) {
    return response.roots[0]?.uri ? fileUriToPath(response.roots[0].uri) : undefined;
  }

  return undefined;
}

function fileUriToPath(uri: string) {
  return uri.replace("file://", "");
}

type ProjectRefResult =
  | {
      status: "argument";
      projectRef: string;
    }
  | {
      status: "existing";
      projectRef: string;
    }
  | {
      status: "new";
      projectRef: string;
    }
  | {
      status: "error";
      error: string;
    };

async function resolveProjectRef(
  context: McpContext,
  auth: LoginResultOk,
  orgParam: string,
  projectName: string,
  cwd?: string,
  projectRef?: string
): Promise<ProjectRefResult> {
  if (projectRef) {
    return {
      status: "argument",
      projectRef,
    };
  }

  const $cwd = cwd ?? (await resolveCwd(context));

  if (!$cwd) {
    return {
      status: "error",
      error: "No current working directory found. Please provide a projectRef or a cwd.",
    };
  }

  // Try to load the config file
  const config = await safeLoadConfig($cwd);

  if (config?.configFile) {
    if (typeof config.project === "string" && config.project.startsWith("proj_")) {
      context.logger?.log("resolve_project_ref existing project", {
        config,
        projectRef: config.project,
      });

      return {
        status: "existing",
        projectRef: config.project,
      };
    } else {
      return {
        status: "error",
        error: "Could not find the project ref in the config file. Please provide a projectRef.",
      };
    }
  }

  // Okay now we will create a new project
  const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

  const project = await cliApiClient.createProject(orgParam, {
    name: projectName,
  });

  if (!project.success) {
    return {
      status: "error",
      error: `Failed to create project ${projectName} in organization ${orgParam}: ${project.error}`,
    };
  }

  context.logger?.log("resolve_project_ref new project", {
    project: project.data,
  });

  return {
    status: "new",
    projectRef: project.data.externalRef,
  };
}

async function resolveExistingProjectRef(
  context: McpContext,
  projectRef?: string,
  cwd?: string
): Promise<ProjectRefResult> {
  if (projectRef) {
    return {
      status: "argument",
      projectRef,
    };
  }

  const cwdResult = await resolveProjectDir(context, cwd);

  if (!cwdResult.ok) {
    return {
      status: "error",
      error: cwdResult.error,
    };
  }

  // Try to load the config file
  const config = await safeLoadConfig(cwdResult.cwd);

  if (
    config?.configFile &&
    typeof config.project === "string" &&
    config.project.startsWith("proj_")
  ) {
    context.logger?.log("resolve_project_ref existing project", {
      config,
      projectRef: config.project,
    });

    return {
      status: "existing",
      projectRef: config.project,
    };
  }

  return {
    status: "error",
    error: "No existing project found. Please provide a projectRef or a cwd.",
  };
}

type ResolveProjectDirResult =
  | {
      ok: true;
      cwd: string;
    }
  | {
      ok: false;
      error: string;
    };

async function resolveProjectDir(
  context: McpContext,
  cwd?: string
): Promise<ResolveProjectDirResult> {
  // If cwd is a path to the actual trigger.config.ts file, then we should set the cwd to the directory of the file
  let $cwd = cwd ? (path.extname(cwd) !== "" ? path.dirname(cwd) : cwd) : undefined;

  function isRelativePath(path: string) {
    return !path.startsWith("/");
  }

  if (!cwd) {
    if (!hasRootsCapability(context)) {
      return {
        ok: false,
        error:
          "The current MCP server does not support the roots capability, so please call the tool again with a projectRef or an absolute path as cwd parameter",
      };
    }

    $cwd = await resolveCwd(context);
  } else if (isRelativePath(cwd)) {
    if (!hasRootsCapability(context)) {
      return {
        ok: false,
        error:
          "The current MCP server does not support the roots capability, so please call the tool again with a projectRef or an absolute path as cwd parameter",
      };
    }

    const resolvedCwd = await resolveCwd(context);

    if (!resolvedCwd) {
      return {
        ok: false,
        error: "No current working directory found. Please provide a projectRef or a cwd.",
      };
    }

    $cwd = path.resolve(resolvedCwd, cwd);
  }

  if (!$cwd) {
    return {
      ok: false,
      error: "No current working directory found. Please provide a projectRef or a cwd.",
    };
  }

  return {
    ok: true,
    cwd: $cwd,
  };
}

async function safeLoadConfig(cwd: string) {
  try {
    return await loadConfig({ cwd });
  } catch (e) {
    return;
  }
}

async function getManualSetupGuide(projectRef: string, auth: LoginResultOk) {
  const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

  const projectEnv = await cliApiClient.getProjectEnv({
    projectRef,
    env: "dev",
  });

  const response = await fetch("https://trigger.dev/docs/manual-setup.md");
  let text = await response.text();

  text = text.replace("<your-project-ref>", projectRef);

  if (projectEnv.success) {
    text = text.replace("tr_dev_xxxxxxxxxx", projectEnv.data.apiKey);
    text = text.replace("https://your-trigger-instance.com", projectEnv.data.apiUrl);
  }

  return `
Use the following manual setup guide to initialize Trigger.dev in your project. Make sure to use the correct project ref: ${projectRef}, and the following environment variables:

TRIGGER_PROJECT_REF=${projectRef}
TRIGGER_SECRET_KEY=${projectEnv.success ? projectEnv.data.apiKey : "tr_dev_xxxxxxxxxx"}
${projectEnv.success ? `TRIGGER_API_URL=${projectEnv.data.apiUrl}` : ""}

To view the project dashboard, visit: ${auth.dashboardUrl}/projects/v3/${projectRef}

${text}`;
}
