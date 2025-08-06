import { GetProjectsResponseBody } from "@trigger.dev/core/v3/schemas";
import { CliApiClient } from "../apiClient.js";
import { mcpAuth } from "./auth.js";
import { McpContext } from "./context.js";
import { ProjectRefSchema } from "./schemas.js";
import { respondWithError } from "./utils.js";

export function registerGetProjectDetailsTool(context: McpContext) {
  context.server.registerTool(
    "get_project_details",
    {
      description: "Get the details of the project",
      inputSchema: {
        projectRef: ProjectRefSchema,
      },
    },
    async ({ projectRef }, extra) => {
      const auth = await mcpAuth({
        server: context.server,
        defaultApiUrl: context.options.apiUrl,
        profile: context.options.profile,
        context,
      });

      if (!auth.ok) {
        throw new Error(auth.error);
      }

      const roots = await context.server.server.listRoots();

      context.logger?.log("get_project_details", { roots, projectRef, extra, auth });

      return {
        content: [{ type: "text", text: "Not implemented" }],
      };
    }
  );
}

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
