import {
  GetOrgsResponseBody,
  GetProjectsResponseBody,
  MachinePresetName,
} from "@trigger.dev/core/v3/schemas";
import { CliApiClient } from "../apiClient.js";
import { createApiClientWithPublicJWT, mcpAuth } from "./auth.js";
import { McpContext } from "./context.js";
import { ProjectRefSchema } from "./schemas.js";
import { respondWithError } from "./utils.js";
import { z } from "zod";
import { performSearch } from "./mintlifyClient.js";
import { LoginResultOk } from "../utilities/session.js";
import { loadConfig } from "../config.js";
import path from "path";

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
          .enum(["dev", "staging", "preview", "production"])
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

      const cliApiClient = new CliApiClient(auth.auth.apiUrl, auth.auth.accessToken);

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
          .enum(["dev", "staging", "preview", "production"])
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

      const apiClient = await createApiClientWithPublicJWT(auth, $projectRef, environment, [
        "write:tasks",
      ]);

      if (!apiClient) {
        return respondWithError("Failed to create API client with public JWT");
      }

      const result = await apiClient.triggerTask(taskId, {
        payload,
        options,
      });

      const taskRunUrl = `${auth.dashboardUrl}/projects/v3/${$projectRef}/runs/${result.id}`;

      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, taskRunUrl }, null, 2) }],
      };
    }
  );
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

  let $cwd = cwd;

  function isRelativePath(path: string) {
    return !path.startsWith("/");
  }

  if (!cwd) {
    $cwd = await resolveCwd(context);
  } else if (isRelativePath(cwd)) {
    const resolvedCwd = await resolveCwd(context);

    if (!resolvedCwd) {
      return {
        status: "error",
        error: "No current working directory found. Please provide a projectRef or a cwd.",
      };
    }

    $cwd = path.resolve(resolvedCwd, cwd);
  }

  if (!$cwd) {
    return {
      status: "error",
      error: "No current working directory found. Please provide a projectRef or a cwd.",
    };
  }

  // Try to load the config file
  const config = await safeLoadConfig($cwd);

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
