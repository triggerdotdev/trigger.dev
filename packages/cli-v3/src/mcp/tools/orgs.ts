import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GetProjectsResponseBody } from "@trigger.dev/core/v3";
import { toolsMetadata } from "../config.js";
import { CreateProjectInOrgInput, InitializeProjectInput } from "../schemas.js";
import { ToolMeta } from "../types.js";
import { respondWithError, toolHandler } from "../utils.js";
import { loadConfig } from "../../config.js";
import { tryCatch } from "@trigger.dev/core/utils";

export const listOrgsTool = {
  name: toolsMetadata.list_orgs.name,
  title: toolsMetadata.list_orgs.title,
  description: toolsMetadata.list_orgs.description,
  inputSchema: {},
  handler: async (input: unknown, { ctx }: ToolMeta): Promise<CallToolResult> => {
    ctx.logger?.log("calling list_orgs", { input });

    const cliApiClient = await ctx.getCliApiClient();

    const orgs = await cliApiClient.getOrgs();

    if (!orgs.success) {
      return respondWithError(orgs.error);
    }

    ctx.logger?.log("list_orgs", { orgs: orgs.data });

    const contents = orgs.data.map((org) => {
      return `- ${org.title} (id=${org.id}) (slug=${org.slug}) (createdAt=${org.createdAt})`;
    });

    return {
      content: [{ type: "text", text: contents.join("\n") }],
    };
  },
};

export const listProjectsTool = {
  name: toolsMetadata.list_projects.name,
  title: toolsMetadata.list_projects.title,
  description: toolsMetadata.list_projects.description,
  inputSchema: {},
  handler: async (input: unknown, { ctx }: ToolMeta): Promise<CallToolResult> => {
    ctx.logger?.log("calling list_projects", { input });

    const cliApiClient = await ctx.getCliApiClient();

    const projects = await cliApiClient.getProjects();

    if (!projects.success) {
      return respondWithError(projects.error);
    }

    ctx.logger?.log("list_projects", { projects: projects.data });

    const groupedByOrg = projects.data.reduce(
      (acc, project) => {
        if (!project.organization) {
          return acc;
        }

        acc[project.organization.id] = acc[project.organization.id] || {
          organization: project.organization,
          projects: [],
        };
        acc[project.organization.id]!.projects.push(project);

        return acc;
      },
      {} as Record<
        string,
        {
          organization: GetProjectsResponseBody[number]["organization"];
          projects: GetProjectsResponseBody[number][];
        }
      >
    );

    const contents = Object.values(groupedByOrg)
      .map((org) => {
        const parts = [
          `## Organization ${org.organization.title} (id=${org.organization.id}) (slug=${org.organization.slug}) projects:`,
        ];

        for (const project of org.projects) {
          parts.push(
            `- ${project.name} (projectRef=${project.externalRef}) (slug=${project.slug}) (createdAt=${project.createdAt})`
          );
        }

        return parts.join("\n");
      })
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: contents,
        },
      ],
    };
  },
};

export const createProjectInOrgTool = {
  name: toolsMetadata.create_project_in_org.name,
  title: toolsMetadata.create_project_in_org.title,
  description: toolsMetadata.create_project_in_org.description,
  inputSchema: CreateProjectInOrgInput.shape,
  handler: toolHandler(CreateProjectInOrgInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling create_project_in_org", { input });

    const cliApiClient = await ctx.getCliApiClient();

    const project = await cliApiClient.createProject(input.orgParam, {
      name: input.name,
    });

    if (!project.success) {
      return respondWithError(project.error);
    }

    ctx.logger?.log("create_project_in_org", { project: project.data });

    const contents = [
      `Project created successfully: ${project.data.name} (projectRef=${project.data.externalRef}) (slug=${project.data.slug}) (createdAt=${project.data.createdAt})`,
    ];

    return {
      content: [{ type: "text", text: contents.join("\n") }],
    };
  }),
};

export const initializeProjectTool = {
  name: toolsMetadata.initialize_project.name,
  title: toolsMetadata.initialize_project.title,
  description: toolsMetadata.initialize_project.description,
  inputSchema: InitializeProjectInput.shape,
  handler: toolHandler(InitializeProjectInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling initialize_project", { input });

    let projectRef: string | undefined = input.projectRef;

    if (!projectRef) {
      const cwd = input.cwd ?? (await ctx.getCwd());

      if (!cwd) {
        return respondWithError(
          "No current working directory found. Please provide a projectRef or a cwd."
        );
      }

      // Try to load the config file
      const [_, config] = await tryCatch(loadConfig({ cwd }));

      if (config?.configFile) {
        if (typeof config.project === "string" && config.project.startsWith("proj_")) {
          ctx.logger?.log("initialize_project existing project", {
            config,
            projectRef: config.project,
          });

          return {
            content: [
              {
                type: "text",
                text: `We found an existing trigger.config.ts file in the current working directory. Skipping initialization.`,
              },
            ],
          };
        } else {
          return respondWithError(
            "Could not find the project ref in the config file. Please provide a projectRef."
          );
        }
      }

      const cliApiClient = await ctx.getCliApiClient();

      const project = await cliApiClient.createProject(input.orgParam, {
        name: input.projectName,
      });

      if (!project.success) {
        return respondWithError(
          `Failed to create project ${input.projectName} in organization ${input.orgParam}: ${project.error}`
        );
      }

      ctx.logger?.log("initialize_project new project", {
        project: project.data,
      });

      projectRef = project.data.externalRef;
    }

    const cliApiClient = await ctx.getCliApiClient();

    const projectEnv = await cliApiClient.getProjectEnv({
      projectRef: projectRef,
      env: "dev",
    });

    const manualSetupGuide = await getManualSetupGuide(
      projectRef,
      projectEnv.success ? projectEnv.data.apiKey : undefined,
      projectEnv.success ? projectEnv.data.apiUrl : undefined
    );

    return {
      content: [
        {
          type: "text",
          text: manualSetupGuide,
        },
      ],
    };
  }),
};

async function getManualSetupGuide(projectRef: string, apiKey?: string, apiUrl?: string) {
  const response = await fetch("https://trigger.dev/docs/manual-setup.md");
  let text = await response.text();

  text = text.replace("<your-project-ref>", projectRef);

  text = text.replace("tr_dev_xxxxxxxxxx", apiKey ?? "tr_dev_xxxxxxxxxx");
  text = text.replace(
    "https://your-trigger-instance.com",
    apiUrl ?? "https://your-trigger-instance.com"
  );

  return `
Use the following manual setup guide to initialize Trigger.dev in your project. Make sure to use the correct project ref: ${projectRef}, and the following environment variables:

TRIGGER_PROJECT_REF=${projectRef}
TRIGGER_SECRET_KEY=${apiKey ?? "tr_dev_xxxxxxxxxx"}
${apiUrl ? `TRIGGER_API_URL=${apiUrl}` : ""}

${text}`;
}
