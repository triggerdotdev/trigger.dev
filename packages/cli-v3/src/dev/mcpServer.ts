import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { logger } from "../utilities/logger.js";
import { CliApiClient } from "../apiClient.js";
import { ApiClient } from "@trigger.dev/core/v3";
import polka from "polka";

let projectRef: string;
let dashboardUrl: string;
// there is some overlap between `ApiClient` and `CliApiClient` which is not ideal
// we can address in this in the future, but for now we need keep using both
// as `ApiClient` exposes most of the methods needed for the MCP tools
let sdkApiClient: ApiClient;

let mcpTransport: SSEServerTransport | null = null;

const server = new McpServer({
  name: "trigger.dev",
  version: "1.0.0",
});

server.tool(
  "trigger-task",
  "Trigger a task",
  {
    id: z.string().describe("The ID of the task to trigger"),
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
      .describe("The payload to pass to the task run, must be a valid JSON"),
  },
  async ({ id, payload }) => {
    const result = await sdkApiClient.triggerTask(id, {
      payload,
    });

    const taskRunUrl = `${dashboardUrl}/projects/v3/${projectRef}/runs/${result.id}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, taskRunUrl }, null, 2),
        },
      ],
    };
  }
);

const app = polka();
app.get("/sse", (_req, res) => {
  mcpTransport = new SSEServerTransport("/messages", res);
  server.connect(mcpTransport);
});
app.post("/messages", (req, res) => {
  if (mcpTransport) {
    mcpTransport.handlePostMessage(req, res);
  }
});

export const startMcpServer = async (options: {
  cliApiClient: CliApiClient;
  devSession: {
    dashboardUrl: string;
    projectRef: string;
  };
}) => {
  const { apiURL, accessToken } = options.cliApiClient;

  if (!accessToken) {
    logger.error("No access token found in the API client, failed to start the MCP server");
    return;
  }

  sdkApiClient = new ApiClient(apiURL, accessToken);
  projectRef = options.devSession.projectRef;
  dashboardUrl = options.devSession.dashboardUrl;

  // TODO: make the port configurable
  const port = 3333;
  app.listen(port, () => {
    logger.info(`Trigger.dev MCP Server is now running on port ${port} ✨`);
  });
};
