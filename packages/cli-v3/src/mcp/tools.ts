import { GetOrgsResponseBody, GetProjectsResponseBody } from "@trigger.dev/core/v3/schemas";
import { CliApiClient } from "../apiClient.js";
import { mcpAuth } from "./auth.js";
import { McpContext } from "./context.js";
import { ProjectRefSchema } from "./schemas.js";
import { respondWithError } from "./utils.js";
import { z } from "zod";
import { performSearch } from "./mintlifyClient.js";

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
