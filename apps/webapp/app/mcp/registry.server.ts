import {
  inputRequired,
  inputResponse,
  UrlElicitationRequiredError,
  type CallToolResult,
  type McpServer,
  type ProtocolEra,
  type ScopeChallengeHandler,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { MCP_SCOPES } from "~/services/oauth/metadata.server";
import type { McpRequestExtra, McpToolAuth } from "./gate/types";
import { missingScopes } from "./gate/withMcpToolAuth.server";
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
import { agentChatTools } from "./tools/agentChat.server";
import { alertsWriteTools } from "./tools/alertsWrite.server";
import { dashboardsWriteTools } from "./tools/dashboardsWrite.server";
import { feedbackTools } from "./tools/feedback.server";
import { orgsWriteTools } from "./tools/orgsWrite.server";
import { promptsWriteTools } from "./tools/promptsWrite.server";
import { runsWriteTools } from "./tools/runsWrite.server";
import { sessionsWriteTools } from "./tools/sessionsWrite.server";
import { tasksWriteTools } from "./tools/tasksWrite.server";
import { webhooksWriteTools } from "./tools/webhooksWrite.server";

export type McpApprovalClass = "required" | "configurable" | "none";

export type McpToolDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: ToolAnnotations;
  /** The gate holds the call for user confirmation. */
  confirm?: boolean;
  approval?: McpApprovalClass;
  auth?: McpToolAuth;
  handler: (
    args: unknown,
    identity: McpIdentity,
    request: Request,
    extra?: McpRequestExtra
  ) => Promise<CallToolResult>;
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
  ...agentChatTools,
  ...alertsWriteTools,
  ...dashboardsWriteTools,
  ...feedbackTools,
  ...orgsWriteTools,
  ...promptsWriteTools,
  ...runsWriteTools,
  ...sessionsWriteTools,
  ...tasksWriteTools,
  ...webhooksWriteTools,
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
        scopeChallenge:
          ctx.era === "modern" && tool.auth
            ? scopeChallengeFor(tool.name, tool.auth, ctx.identity)
            : undefined,
      },
      async (args: unknown, extra) => {
        try {
          return await tool.handler(args, ctx.identity, ctx.request, {
            signal: extra.mcpReq.signal,
            requestId: extra.mcpReq.id,
            era: ctx.era,
          });
        } catch (error) {
          if (ctx.era === "modern" && error instanceof UrlElicitationRequiredError) {
            const response = inputResponse(
              extra.mcpReq.inputResponses,
              error.elicitations[0].elicitationId
            );
            if (response.kind === "elicit" && response.action !== "accept") {
              return confirmationToolError(error);
            }
            return server.server.getClientCapabilities()?.elicitation?.url
              ? urlElicitationInputRequired(error)
              : confirmationToolError(error);
          }
          throw error;
        }
      }
    );
  }
}

function scopeChallengeFor(
  tool: string,
  auth: McpToolAuth,
  identity: McpIdentity
): ScopeChallengeHandler {
  return () => {
    const [first, ...rest] = missingScopes(auth, identity);
    if (!first || identity.kind !== "uat") return undefined;
    logger.info("mcp.tool", {
      userId: identity.userId,
      tokenKind: identity.kind,
      tokenId: identity.sourceTokenId,
      clientId: identity.clientId,
      tool,
      outcome: "insufficient_scope",
      denyReason: "scope",
    });
    const held = (identity.cap ?? []).filter((s) => MCP_SCOPES.includes(s));
    return { scopes: [...new Set([...held, first, ...rest])] as [string, ...string[]] };
  };
}

function urlElicitationInputRequired(error: UrlElicitationRequiredError) {
  const [{ elicitationId, url, message }] = error.elicitations;
  return inputRequired({
    inputRequests: { [elicitationId]: inputRequired.elicitUrl({ url, message }) },
  });
}

// -32042 cannot be sent on 2026-07-28, so clients without URL elicitation get the tool-error shape.
function confirmationToolError(error: UrlElicitationRequiredError): CallToolResult {
  return { content: [{ type: "text", text: error.elicitations[0].message }], isError: true };
}
