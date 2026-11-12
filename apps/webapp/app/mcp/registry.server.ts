import type {
  CallToolResult,
  McpServer,
  ProtocolEra,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpIdentity } from "./types";
import { agentsTools } from "./tools/agents.server";
import { alertsTools } from "./tools/alerts.server";
import { dashboardsTools } from "./tools/dashboards.server";
import { deploysTools } from "./tools/deploys.server";
import { docsTools } from "./tools/docs.server";
import { orgsTools } from "./tools/orgs.server";
import { promptsTools } from "./tools/prompts.server";
import { queryTools } from "./tools/query.server";
import { reportTools } from "./tools/report.server";
import { runsTools } from "./tools/runs.server";
import { sessionsTools } from "./tools/sessions.server";
import { tasksTools } from "./tools/tasks.server";
import { webhooksTools } from "./tools/webhooks.server";

export type McpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (args: unknown, identity: McpIdentity, request: Request) => Promise<CallToolResult>;
};

export type McpToolContext = { identity: McpIdentity; request: Request; era: ProtocolEra };

function assertUniqueToolNames(tools: McpToolDefinition[]) {
  const seen = new Set<string>();
  for (const { name } of tools) {
    if (seen.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
    seen.add(name);
  }
  return tools;
}

export const mcpTools: McpToolDefinition[] = assertUniqueToolNames([
  ...orgsTools,
  ...tasksTools,
  ...runsTools,
  ...deploysTools,
  ...queryTools,
  ...dashboardsTools,
  ...promptsTools,
  ...agentsTools,
  ...sessionsTools,
  ...alertsTools,
  ...webhooksTools,
  ...reportTools,
  ...docsTools,
]);

export function registerMcpTools(
  server: McpServer,
  tools: McpToolDefinition[],
  ctx: McpToolContext
) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
        annotations: tool.annotations,
      },
      (args: unknown) => tool.handler(args, ctx.identity, ctx.request)
    );
  }
}
